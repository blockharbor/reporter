/**
 * Audit model specs — the per-model table the backstop drives on — and the ONE
 * source of truth for redaction.
 *
 * Two halves. The first (the redaction table and the list-item reference
 * helpers) is what services/audit.ts imports: the hand-written intent entries
 * redact through the same table the backstop does. The second is `MODEL_SPECS`,
 * which the Prisma client extension in extension.ts consults on every write:
 * what a model is called in the log, which columns may appear in a diff, which
 * are redacted, how a row is labelled and which engagement it belongs to. A
 * model with no spec is NOT audited — there is no "every scalar minus a denylist"
 * fallback, because a secret column added in two years must fail closed, not
 * leak through a generic diff. `UNAUDITED_MODELS` names every such model with
 * the reason, and the two tables together are total over `Prisma.ModelName`:
 * adding a model to schema.prisma is a compile error here until it is placed.
 *
 * Why the redaction table lives here and not beside the diff helpers: there are
 * two write paths into one table — the hand-written intent entries and the
 * automatic backstop — and the only handler that ever touches an inline-base64
 * column (the engagement PUT, for the threat-model diagrams) runs under
 * `withIntent`, where the backstop's own list never fires. A column protected on
 * one path and not the other is a leak; one table imported by both is not.
 *
 * Two kinds of redaction, because they answer different questions:
 *
 *  - `secret` — credential material. Replaced by `{ $opaque: 'secret' }` with no
 *    length, because even the length of a hash is a tell. In practice the
 *    credential MODELS are excluded from the backstop wholesale and never pass
 *    through a generic diff, so these names are belt-and-braces.
 *  - `blob` — inline binary that is not secret but must never land in a log row:
 *    a report logo, a diagram image, the verbatim proposal import. Replaced by
 *    `{ $opaque: 'blob', chars }`, so a diff still reads "120 KB -> 130 KB".
 *
 * List columns are never stored as values at all: `diffList` records each item
 * as a `{ label, hash }` reference, and the per-column `refOf` decides how the
 * hash is taken. The default hashes the whole item. `threatDiagramRefOf` does
 * not — `threatDiagramSchema.imageDataUri` is capped at 2.8 MB and the column at
 * 12 items, so hashing whole items on an autosave tick would block the event
 * loop for hundreds of milliseconds; it hashes the caption, the length and the
 * last 64 chars of the URI instead, which still detects a replaced image and
 * never reads the body.
 *
 * THE SPEC TABLE, and what each part is for:
 *
 *  - `fields` is a POSITIVE allowlist of scalar columns. Only these are read in
 *    the pre-read SELECT and only these can appear in a change. `ignore` is the
 *    documented complement — timestamps, blob keys, derived numbers, "who edited"
 *    stamps that duplicate the actor — kept as a list rather than implied so a
 *    reader can see the decision, and checked by test against the schema so a
 *    column that is in neither list is a failing test, not a silent omission.
 *    A write that changes only ignored columns produces NO entry at all.
 *  - `redacted` names the columns in `fields` whose values are replaced through
 *    `REDACTED_FIELDS`; listing them here is a cross-check (a test asserts every
 *    one is in the table), not a second mechanism.
 *  - `lists` are JSON array columns diffed as refs through the named `RefOf`;
 *    `structured` are JSON object columns diffed by a dedicated differ in
 *    diff.ts (today only the report-config shape). `diff: 'engagement'` hands
 *    the whole row to `diffEngagement`, the same differ the intent path uses, so
 *    the 30-column save reads identically whichever path recorded it.
 *  - `describe` resolves the row's label and its engagement, with one lookup at
 *    most, memoised per request through `Lookups.memo` so a bulk write under one
 *    parent resolves it once.
 *  - `cascadeCounts` (Engagement only) are the relation counts pre-read on a
 *    delete, because DB-level cascades are invisible to the extension and the
 *    log should still say "and 212 evidence, 14 findings, 9 tags went with it".
 *
 * Three KINDS of spec, because join rows are not entities of their own:
 *
 *  - `row`: an ordinary entity with a public id.
 *  - `link`: GoalEvidence, GoalFinding and EvidenceFinding. Recorded as
 *    `link`/`unlink` on the OWNING entity (the goal, or the finding), with the
 *    linked thing as an `items` change. EvidenceFinding additionally carries
 *    content of its own (caption, attack-path bucket, position), so an UPDATE of
 *    the link row is an `update` on entity type `finding_evidence`.
 *  - `ownerTags`: EvidenceTag and FindingTag. Not links at all — applying a tag
 *    is an edit of the owner's `tags` list, recorded as a `list` change on the
 *    evidence or finding so it folds alongside the other edits in the same save.
 */
import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { AuditEntityType, AuditListItemRef, AuditOpaqueValue } from '@reporter/shared';
import type { AuditModel } from './context.js';
import type { EngagementRef } from '../services/audit.js';

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

export type RedactionKind = 'secret' | 'blob';

/**
 * Column name -> how its value is hidden. Keyed by bare column name: the
 * intent-side diff helpers only ever name the columns they diff, and the
 * backstop's per-model allowlists consult this through `redactedValue`.
 */
export const REDACTED_FIELDS: ReadonlyMap<string, RedactionKind> = new Map<string, RedactionKind>([
  // Credential columns (AuthIdentity, ApiKey, RecoveryCode, WebauthnCredential, Session).
  ['passwordHash', 'secret'],
  ['totpSecret', 'secret'],
  ['secretKey', 'secret'],
  ['codeHash', 'secret'],
  ['credentialId', 'secret'],
  ['publicKey', 'secret'],
  ['data', 'secret'],
  // Inline binary (ReportSettings.logoDataUri, threatModelDiagrams[].imageDataUri,
  // Engagement.proposalImport).
  ['logoDataUri', 'blob'],
  ['imageDataUri', 'blob'],
  ['proposalImport', 'blob'],
]);

/** The number a `blob` marker carries: characters of text, or of the JSON form. */
function sizeOf(value: unknown): number {
  if (typeof value === 'string') return value.length;
  if (Buffer.isBuffer(value)) return value.length;
  return JSON.stringify(value)?.length ?? 0;
}

/**
 * The stand-in to store for `field`, or undefined when the column is not
 * redacted — or when the value is null, since there is nothing to hide in a
 * cleared column and "cleared" is worth showing.
 */
export function redactedValue(field: string, value: unknown): AuditOpaqueValue | undefined {
  const kind = REDACTED_FIELDS.get(field);
  if (!kind || value == null) return undefined;
  return kind === 'secret' ? { $opaque: 'secret' } : { $opaque: 'blob', chars: sizeOf(value) };
}

/** A short content hash: 16 hex chars of sha256, plenty to tell two items apart. */
export function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

/** How a list column turns one item into the `{ label, hash }` ref the log stores. */
export type RefOf = (item: unknown, index: number) => AuditListItemRef;

/** Labels are bounded by `auditListItemRefSchema`; clamp rather than fail. */
const LIST_LABEL_MAX_CHARS = 255;

/**
 * The default ref: the caller's label plus a hash of the whole item, so an edit
 * anywhere in the item (same label, new hash) is detected.
 */
export function refOf(label: (item: any, index: number) => string): RefOf {
  return (item, index) => ({
    label: String(label(item, index) ?? '').slice(0, LIST_LABEL_MAX_CHARS),
    hash: shortHash(JSON.stringify(item) ?? ''),
  });
}

/**
 * The cheap discriminator for `Engagement.threatModelDiagrams` — see the module
 * header. The image body is never read in full and never stored.
 */
export const threatDiagramRefOf: RefOf = (item, index) => {
  const d = (item ?? {}) as { caption?: unknown; imageDataUri?: unknown };
  const caption = typeof d.caption === 'string' ? d.caption : '';
  const uri = typeof d.imageDataUri === 'string' ? d.imageDataUri : '';
  return {
    label: (caption || `Diagram ${index + 1}`).slice(0, LIST_LABEL_MAX_CHARS),
    hash: shortHash(`${caption}|${uri.length}|${uri.slice(-64)}`),
  };
};

// ---------------------------------------------------------------------------
// Spec table — types
// ---------------------------------------------------------------------------

/** A row as the backstop sees it: whatever the pre-read SELECT or the write returned. */
export type AuditRow = Record<string, unknown>;

/**
 * What a `describe`/owner resolver gets to work with: the UNEXTENDED client (so
 * the backstop's own reads never re-enter the extension) and a per-request memo.
 */
export interface Lookups {
  db: PrismaClient;
  /** `memo('Engagement:3', () => …)`: resolved once per request, nulls included. */
  memo<T>(key: string, fn: () => Promise<T>): Promise<T>;
}

/** The entity a link row or a tag application is recorded against. */
export interface Owner {
  entityType: AuditEntityType;
  noun: string;
  /** The owner's public id — its uuid where it has one, else String(id). */
  id: string;
  label: string;
  engagement: EngagementRef | null;
}

export type WriteKind = 'create' | 'update' | 'delete';

export interface RowSpec {
  kind: 'row';
  entityType: AuditEntityType;
  /** Glossary noun for summaries: "Created tag …", "Deleted finding …". */
  noun: string;
  /** `engagement` rows carry an engagement ref; `site` rows never do. */
  scope: 'engagement' | 'site';
  /** The primary-key column(s). */
  idFields: readonly string[];
  /** POSITIVE allowlist of scalar columns that may appear in a change. */
  fields: readonly string[];
  /** JSON array columns, each with the ref its items are stored as. */
  lists: Readonly<Record<string, RefOf>>;
  /** JSON object columns diffed by a dedicated differ (diff.ts STRUCTURED_DIFFS). */
  structured: Readonly<Record<string, 'reportConfig'>>;
  /** Columns a change to which alone produces no entry. Documentation + tested. */
  ignore: readonly string[];
  /** Columns in `fields` whose values are replaced via REDACTED_FIELDS (cross-check). */
  redacted: readonly string[];
  /** Extra columns the resolvers need (FKs, uuid, slug), read but never diffed. */
  reads: readonly string[];
  /** Which write kinds the backstop records; default all three. */
  ops: readonly WriteKind[];
  /** Hand the whole row to a dedicated differ instead of the generic one. */
  diff?: 'engagement';
  /**
   * Engagement only: relation -> singular glossary noun, pre-read as `_count` on
   * delete and written as one `count` change per non-empty relation.
   */
  cascadeCounts?: Readonly<Record<string, string>>;
  /** Every column the pre-read selects: fields + lists + structured + ids + reads. */
  select: readonly string[];
  entityId: (row: AuditRow) => string | null;
  describe: (
    row: AuditRow,
    l: Lookups,
  ) => Promise<{ label: string; engagement: EngagementRef | null }>;
}

export interface LinkSpec {
  kind: 'link';
  /** The FK naming the owner, and the FK naming the thing linked to it. */
  ownerKey: string;
  targetKey: string;
  /** The `items` change label ("Evidence", "Findings") and the summary noun. */
  targetLabel: string;
  targetNoun: string;
  owner: (id: number, l: Lookups) => Promise<Owner | null>;
  target: (id: number, l: Lookups) => Promise<{ id: string; label: string } | null>;
  /** EvidenceFinding only: the link row has editable content of its own. */
  row?: {
    entityType: AuditEntityType;
    noun: string;
    fields: readonly string[];
    entityId: (owner: Owner, target: { id: string }) => string;
    label: (owner: Owner, target: { label: string }) => string;
  };
}

export interface OwnerTagsSpec {
  kind: 'ownerTags';
  ownerKey: string;
  /** The owner's entity type and noun, for the one summary a bulk write past the row cap leaves. */
  entityType: AuditEntityType;
  noun: string;
  /** The owner with its current tag names, read fresh (never memoised) before and after. */
  owner: (id: number, l: Lookups) => Promise<(Owner & { tags: string[] }) | null>;
}

export type ModelSpec = RowSpec | LinkSpec | OwnerTagsSpec;

// ---------------------------------------------------------------------------
// Resolvers
// ---------------------------------------------------------------------------

const REF_SELECT = { id: true, slug: true, name: true } as const;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);

/** The engagement ref by id, memoised; null when the FK is null or the row is gone. */
export function engagementRef(id: unknown, l: Lookups): Promise<EngagementRef | null> {
  const n = num(id);
  if (n === null) return Promise.resolve(null);
  return l.memo(`Engagement:${n}`, () =>
    l.db.engagement.findUnique({ where: { id: n }, select: REF_SELECT }),
  );
}

const goalOwner = (id: number, l: Lookups): Promise<Owner | null> =>
  l.memo(`ActivityGoal:${id}:owner`, async () => {
    const g = await l.db.activityGoal.findUnique({
      where: { id },
      select: {
        id: true,
        title: true,
        activity: { select: { target: { select: { engagement: { select: REF_SELECT } } } } },
      },
    });
    return g
      ? {
          entityType: 'goal',
          noun: 'goal',
          id: String(g.id),
          label: g.title,
          engagement: g.activity.target.engagement,
        }
      : null;
  });

const findingOwner = (id: number, l: Lookups): Promise<Owner | null> =>
  l.memo(`Finding:${id}:owner`, async () => {
    const f = await l.db.finding.findUnique({
      where: { id },
      select: { uuid: true, title: true, engagement: { select: REF_SELECT } },
    });
    return f
      ? {
          entityType: 'finding',
          noun: 'finding',
          id: f.uuid,
          label: f.title,
          engagement: f.engagement,
        }
      : null;
  });

const evidenceTarget = (id: number, l: Lookups) =>
  l.memo(`Evidence:${id}:target`, async () => {
    const e = await l.db.evidence.findUnique({
      where: { id },
      select: { uuid: true, title: true },
    });
    return e ? { id: e.uuid, label: e.title } : null;
  });

const findingTarget = (id: number, l: Lookups) =>
  l.memo(`Finding:${id}:target`, async () => {
    const f = await l.db.finding.findUnique({ where: { id }, select: { uuid: true, title: true } });
    return f ? { id: f.uuid, label: f.title } : null;
  });

const TAGS_SELECT = { select: { tag: { select: { name: true } } } } as const;

/** Not memoised: the whole point is to read the tag list before AND after. */
const evidenceWithTags = async (id: number, l: Lookups) => {
  const e = await l.db.evidence.findUnique({
    where: { id },
    select: { uuid: true, title: true, engagement: { select: REF_SELECT }, tags: TAGS_SELECT },
  });
  return e
    ? {
        entityType: 'evidence' as const,
        noun: 'evidence',
        id: e.uuid,
        label: e.title,
        engagement: e.engagement,
        tags: e.tags.map((t) => t.tag.name),
      }
    : null;
};

const findingWithTags = async (id: number, l: Lookups) => {
  const f = await l.db.finding.findUnique({
    where: { id },
    select: { uuid: true, title: true, engagement: { select: REF_SELECT }, tags: TAGS_SELECT },
  });
  return f
    ? {
        entityType: 'finding' as const,
        noun: 'finding',
        id: f.uuid,
        label: f.title,
        engagement: f.engagement,
        tags: f.tags.map((t) => t.tag.name),
      }
    : null;
};

// ---------------------------------------------------------------------------
// Spec table — builders
// ---------------------------------------------------------------------------

interface RowDef {
  entityType: AuditEntityType;
  noun: string;
  scope?: 'engagement' | 'site';
  idFields?: readonly string[];
  fields: readonly string[];
  lists?: Readonly<Record<string, RefOf>>;
  structured?: Readonly<Record<string, 'reportConfig'>>;
  ignore?: readonly string[];
  redacted?: readonly string[];
  reads?: readonly string[];
  ops?: readonly WriteKind[];
  diff?: 'engagement';
  cascadeCounts?: Readonly<Record<string, string>>;
  /** `uuid` / `id` / a custom public-id expression. */
  entityId?: 'uuid' | 'id' | ((row: AuditRow) => string | null);
  label?: (row: AuditRow) => string;
  /** Default: the `engagementId` column for engagement scope, nothing for site scope. */
  parent?: (row: AuditRow, l: Lookups) => Promise<EngagementRef | null>;
  /** When the label itself needs a lookup, replace both label and parent at once. */
  describe?: RowSpec['describe'];
}

const ALL_OPS: readonly WriteKind[] = ['create', 'update', 'delete'];

function row(def: RowDef): RowSpec {
  const scope = def.scope ?? 'engagement';
  const idFields = def.idFields ?? ['id'];
  const entityIdMode = def.entityId ?? 'id';
  const entityId: RowSpec['entityId'] =
    typeof entityIdMode === 'function'
      ? entityIdMode
      : entityIdMode === 'uuid'
        ? (r) => (typeof r.uuid === 'string' ? r.uuid : null)
        : (r) => (r.id == null ? null : String(r.id));
  const parent =
    def.parent ??
    (scope === 'engagement' ? (r, l) => engagementRef(r.engagementId, l) : async () => null);
  const label = def.label ?? (() => '');
  const describe: RowSpec['describe'] =
    def.describe ?? (async (r, l) => ({ label: label(r), engagement: await parent(r, l) }));
  const reads = new Set<string>([...idFields, ...(def.reads ?? [])]);
  if (entityIdMode === 'uuid') reads.add('uuid');
  if (!def.parent && !def.describe && scope === 'engagement') reads.add('engagementId');
  const lists = def.lists ?? {};
  const structured = def.structured ?? {};
  const select = [
    ...new Set([...def.fields, ...Object.keys(lists), ...Object.keys(structured), ...reads]),
  ];
  return {
    kind: 'row',
    entityType: def.entityType,
    noun: def.noun,
    scope,
    idFields,
    fields: def.fields,
    lists,
    structured,
    ignore: def.ignore ?? [],
    redacted: def.redacted ?? [],
    reads: [...reads],
    ops: def.ops ?? ALL_OPS,
    diff: def.diff,
    cascadeCounts: def.cascadeCounts,
    select,
    entityId,
    describe,
  };
}

const TIMESTAMPS = ['createdAt', 'updatedAt'] as const;
const stringRef: RefOf = refOf((item) => String(item ?? ''));

// ---------------------------------------------------------------------------
// Spec table — the 21 audited models
// ---------------------------------------------------------------------------

export const AUDITED_MODEL_NAMES = [
  'Engagement',
  'EngagementTarget',
  'TargetActivity',
  'ActivityGoal',
  'GoalEvidence',
  'GoalFinding',
  'UserEngagementRole',
  'Tag',
  'DefaultTag',
  'ReportSettings',
  'ReportTemplate',
  'GeneratedReport',
  'Evidence',
  'EvidenceComment',
  'FindingCategory',
  'Finding',
  'EvidenceTag',
  'FindingTag',
  'EvidenceFinding',
  'SavedQuery',
  'User',
] as const satisfies readonly Prisma.ModelName[];

export type AuditedModelName = (typeof AUDITED_MODEL_NAMES)[number];

export const MODEL_SPECS: Readonly<Record<AuditedModelName, ModelSpec>> = {
  // The 30-column save. `fields` here is the SELECT list; the diff itself is
  // `diffEngagement`, shared with the intent path, plus `slug`/`proposalImport`
  // which that differ leaves to the handlers that own them. The engagement is
  // its own parent, read from the row so a delete can still stamp the snapshot.
  Engagement: row({
    entityType: 'engagement',
    noun: 'engagement',
    fields: [
      'slug',
      'name',
      'status',
      'startedAt',
      'projectedEndAt',
      'actualEndAt',
      'clientName',
      'assessmentType',
      'testApproach',
      'location',
      'scope',
      'executiveSummary',
      'methodology',
      'objectivesNarrative',
      'threatModelNarrative',
      'watermarkEnabled',
      'watermarkText',
      'watermarkColor',
      'watermarkOpacity',
      'watermarkLayer',
      'scopeTargets',
      'scopeExclusions',
      'strategicRecommendations',
      'threatModelDiagrams',
      'executionNarrative',
      'providerContacts',
      'clientContacts',
      'softwareTested',
      'thirdPartySoftware',
      'reportConfig',
      'proposalImport',
    ],
    diff: 'engagement',
    redacted: ['proposalImport'],
    ignore: TIMESTAMPS,
    cascadeCounts: {
      evidence: 'evidence',
      findings: 'finding',
      tags: 'tag',
      targets: 'target',
      roles: 'member',
      categories: 'finding category',
      savedQueries: 'saved query',
      generatedReports: 'report',
    },
    label: (r) => str(r.name),
    parent: async (r) =>
      typeof r.id === 'number' ? { id: r.id, slug: str(r.slug), name: str(r.name) } : null,
  }),

  EngagementTarget: row({
    entityType: 'target',
    noun: 'target',
    fields: ['name', 'description', 'position'],
    ignore: TIMESTAMPS,
    label: (r) => str(r.name),
  }),

  TargetActivity: row({
    entityType: 'activity',
    noun: 'activity',
    fields: ['name', 'category', 'tagId', 'position'],
    ignore: TIMESTAMPS,
    reads: ['targetId'],
    label: (r) => str(r.name),
    parent: (r, l) =>
      l.memo(`EngagementTarget:${num(r.targetId)}:engagement`, async () => {
        const id = num(r.targetId);
        if (id === null) return null;
        const t = await l.db.engagementTarget.findUnique({
          where: { id },
          select: { engagement: { select: REF_SELECT } },
        });
        return t?.engagement ?? null;
      }),
  }),

  ActivityGoal: row({
    entityType: 'goal',
    noun: 'goal',
    fields: ['title', 'status', 'isRetest', 'notes', 'position'],
    ignore: TIMESTAMPS,
    reads: ['activityId'],
    label: (r) => str(r.title),
    parent: (r, l) =>
      l.memo(`TargetActivity:${num(r.activityId)}:engagement`, async () => {
        const id = num(r.activityId);
        if (id === null) return null;
        const a = await l.db.targetActivity.findUnique({
          where: { id },
          select: { target: { select: { engagement: { select: REF_SELECT } } } },
        });
        return a?.target.engagement ?? null;
      }),
  }),

  GoalEvidence: {
    kind: 'link',
    ownerKey: 'goalId',
    targetKey: 'evidenceId',
    targetLabel: 'Evidence',
    targetNoun: 'evidence',
    owner: goalOwner,
    target: evidenceTarget,
  },

  GoalFinding: {
    kind: 'link',
    ownerKey: 'goalId',
    targetKey: 'findingId',
    targetLabel: 'Findings',
    targetNoun: 'finding',
    owner: goalOwner,
    target: findingTarget,
  },

  // A membership is recorded against the USER's id (`member` -> String(userId)),
  // and labelled with the user's name at write time — the role row's own id
  // means nothing to anyone. Cascading removals (user or engagement delete) are
  // invisible here and are described by those entries instead.
  UserEngagementRole: row({
    entityType: 'member',
    noun: 'member',
    fields: ['role'],
    reads: ['userId', 'engagementId'],
    entityId: (r) => (r.userId == null ? null : String(r.userId)),
    describe: async (r, l) => {
      const userId = num(r.userId);
      const user =
        userId === null
          ? null
          : await l.memo(`User:${userId}:label`, () =>
              l.db.user.findUnique({
                where: { id: userId },
                select: { firstName: true, lastName: true, email: true },
              }),
            );
      const label = user
        ? `${user.firstName} ${user.lastName}`.trim() || user.email
        : `user #${userId ?? '?'}`;
      return { label, engagement: await engagementRef(r.engagementId, l) };
    },
  }),

  Tag: row({
    entityType: 'tag',
    noun: 'tag',
    fields: ['name', 'colorName', 'position'],
    label: (r) => str(r.name),
  }),

  DefaultTag: row({
    entityType: 'default_tag',
    noun: 'default tag',
    scope: 'site',
    fields: ['name', 'colorName'],
    label: (r) => str(r.name),
  }),

  // The singleton branding row. The logo is an inline data: URI — redacted to
  // its size, so the log says the logo changed and never carries the image.
  ReportSettings: row({
    entityType: 'report_settings',
    noun: 'report branding',
    scope: 'site',
    fields: ['organizationName', 'accentColor', 'logoDataUri', 'footerNote'],
    redacted: ['logoDataUri'],
    ignore: ['updatedAt'],
    label: () => 'Report branding',
  }),

  ReportTemplate: row({
    entityType: 'report_template',
    noun: 'report template',
    scope: 'site',
    entityId: 'uuid',
    fields: ['name', 'description'],
    structured: { config: 'reportConfig' },
    ignore: ['createdById', ...TIMESTAMPS],
    label: (r) => str(r.name),
  }),

  // Creation is the `report_generated` intent entry (the read/export area owns
  // it, with the options the document was built with); the artifact columns the
  // best-effort patch in report-history.ts writes afterwards are ignored, so that
  // patch is silent. What the backstop still sees is a relabel or a delete.
  GeneratedReport: row({
    entityType: 'generated_report',
    noun: 'report',
    entityId: 'uuid',
    ops: ['update', 'delete'],
    fields: ['preset', 'label', 'version', 'format'],
    ignore: [
      'summary',
      'blobKey',
      'filename',
      'sizeBytes',
      'contentType',
      'sha256',
      'generatedById',
      'createdAt',
    ],
    label: (r) => `${str(r.label)} ${str(r.version)}`.trim(),
  }),

  Evidence: row({
    entityType: 'evidence',
    noun: 'evidence',
    entityId: 'uuid',
    fields: [
      'title',
      'description',
      'contentType',
      'contentSubtype',
      'originalFilename',
      'sha256',
      'sizeBytes',
      'parentEvidenceId',
      'occurredAt',
      'excludeFromReport',
      'operatorId',
    ],
    // The blob keys are storage addresses, not content (`sha256`/`sizeBytes`
    // already say the content changed); `lastEditedById` IS the actor.
    ignore: ['fullBlobKey', 'thumbBlobKey', 'lastEditedById', ...TIMESTAMPS],
    label: (r) => str(r.title) || `${str(r.contentType)} evidence`,
  }),

  EvidenceComment: row({
    entityType: 'evidence_comment',
    noun: 'evidence note',
    entityId: 'uuid',
    fields: ['body'],
    ignore: ['authorId', ...TIMESTAMPS],
    reads: ['evidenceId'],
    describe: async (r, l) => {
      const evidenceId = num(r.evidenceId);
      const ev =
        evidenceId === null
          ? null
          : await l.memo(`Evidence:${evidenceId}:note-owner`, () =>
              l.db.evidence.findUnique({
                where: { id: evidenceId },
                select: { title: true, engagement: { select: REF_SELECT } },
              }),
            );
      return { label: ev ? `Note on ${ev.title}` : 'Note', engagement: ev?.engagement ?? null };
    },
  }),

  // A category is soft-deleted, so its delete surfaces as `deletedAt` changing.
  FindingCategory: row({
    entityType: 'finding_category',
    noun: 'finding category',
    fields: ['category', 'deletedAt'],
    label: (r) => str(r.category),
  }),

  // `cvssScore` is derived from `cvssVector` and would double every CVSS edit;
  // the category reads as its id here (the intent differ names it) — a backstop
  // entry is the safety net, not the primary record.
  Finding: row({
    entityType: 'finding',
    noun: 'finding',
    entityId: 'uuid',
    fields: [
      'title',
      'description',
      'kind',
      'affectedTarget',
      'impact',
      'fixEffort',
      'remediation',
      'severity',
      'cvssVector',
      'position',
      'readyToReport',
      'categoryId',
    ],
    lists: { iso21434Refs: stringRef, unr155Refs: stringRef },
    ignore: ['cvssScore', ...TIMESTAMPS],
    label: (r) => str(r.title),
  }),

  EvidenceTag: {
    kind: 'ownerTags',
    ownerKey: 'evidenceId',
    entityType: 'evidence',
    noun: 'evidence',
    owner: evidenceWithTags,
  },

  FindingTag: {
    kind: 'ownerTags',
    ownerKey: 'findingId',
    entityType: 'finding',
    noun: 'finding',
    owner: findingWithTags,
  },

  // Attach/detach is a link on the finding; an edit of the link row's own
  // content (caption, attack-path bucket, position) is an update of the
  // `finding_evidence` entity, identified by both uuids.
  EvidenceFinding: {
    kind: 'link',
    ownerKey: 'findingId',
    targetKey: 'evidenceId',
    targetLabel: 'Evidence',
    targetNoun: 'evidence',
    owner: findingOwner,
    target: evidenceTarget,
    row: {
      entityType: 'finding_evidence',
      noun: 'finding evidence',
      fields: ['caption', 'inPath', 'position'],
      entityId: (owner, target) => `${owner.id}:${target.id}`,
      label: (owner, target) => `${owner.label} ↔ ${target.label}`,
    },
  },

  SavedQuery: row({
    entityType: 'saved_query',
    noun: 'saved query',
    fields: ['name', 'query', 'type'],
    label: (r) => str(r.name),
  }),

  // Identified by slug, the same id `api_key_auth` and the sign-in events use,
  // so one user's history filters as one thread. The nested `identities.create`
  // that `createLocalUser` sends is summarised as a count and never read.
  User: row({
    entityType: 'user',
    noun: 'user',
    scope: 'site',
    fields: [
      'slug',
      'firstName',
      'lastName',
      'email',
      'admin',
      'disabled',
      'headless',
      'deletedAt',
    ],
    ignore: TIMESTAMPS,
    entityId: (r) => (typeof r.slug === 'string' ? r.slug : null),
    label: (r) => `${str(r.firstName)} ${str(r.lastName)}`.trim() || str(r.email),
  }),
};

/**
 * Every model the backstop does NOT record, with the reason. Total over
 * `Prisma.ModelName` together with `MODEL_SPECS`, so a new model is a compile
 * error here until someone decides where it belongs.
 */
export const UNAUDITED_MODELS: Readonly<
  Record<Exclude<Prisma.ModelName, AuditedModelName>, string>
> = {
  AuthIdentity:
    'Credential model: sign-in, password change, TOTP reset and recovery are their own ' +
    'intent events on the user; a generic diff would have to redact every column it has.',
  ApiKey:
    'Credential model: key create/revoke are intent events naming the key by id; the ' +
    'lastAuth stamp in requireApiAuth is fire-and-forget and must stay unaudited.',
  RecoveryCode:
    'Credential model: issuing and redeeming a recovery link are intent events; the code ' +
    'hash is the only content.',
  WebauthnCredential:
    'Credential model: two Bytes columns (credentialId, publicKey) and a sign counter that ' +
    'moves on every assertion; enrolment is an intent event.',
  Session:
    'Its id is the sha256 of the cookie token and `data` may hold auth state; rows churn ' +
    'on every login and expiry, and sign-in/sign-out are intent events.',
  UserEngagementPref: 'Per-user favorites: personal UI state, not engagement content.',
  UserEvidencePref: 'Per-user favorites: personal UI state, not engagement content.',
  EvidenceMetadata: 'Dead code — nothing writes it.',
  AuditEntry:
    'The log never audits itself: a removal is recorded in place on the row by the ' +
    'trigger-guarded transition, and recording the write of an entry would recurse.',
};

/** The delegate name the audit context keys on (`Tag` -> `tag`, `EvidenceTag` -> `evidenceTag`). */
export function delegateOf(model: string): AuditModel {
  return (model.charAt(0).toLowerCase() + model.slice(1)) as AuditModel;
}

/** Every audited model as a delegate name — the list an importer's `withIntent` wrap names. */
export const ALL_AUDITED_MODELS: readonly AuditModel[] = AUDITED_MODEL_NAMES.map(delegateOf);
