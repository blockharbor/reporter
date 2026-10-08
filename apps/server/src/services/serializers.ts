import type {
  ApiKey as DbApiKey,
  Evidence as DbEvidence,
  EvidenceComment as DbEvidenceComment,
  EvidenceFinding as DbEvidenceFinding,
  Finding as DbFinding,
  FindingCategory,
  Engagement as DbEngagement,
  ReportSettings as DbReportSettings,
  ReportTemplate as DbReportTemplate,
  SavedQuery as DbSavedQuery,
  Tag as DbTag,
  User as DbUser,
} from '@prisma/client';
import {
  recommendationItemSchema,
  reportConfigSchema,
  reportTemplateConfigSchema,
  type ApiKey,
  type Evidence,
  type EvidenceComment,
  type EngagementProgress,
  type FindingEvidence,
  type Finding,
  type Engagement,
  type EngagementRole,
  type ReportSettings,
  type ReportTemplate,
  type SavedQuery,
  type Tag,
  type User,
} from '@reporter/shared';

export function serializeUser(u: DbUser, extras: { mustResetPassword?: boolean } = {}): User {
  return {
    slug: u.slug,
    firstName: u.firstName,
    lastName: u.lastName,
    email: u.email,
    admin: u.admin,
    disabled: u.disabled,
    headless: u.headless,
    // Only /web/me passes this — it lives on the local AuthIdentity, not the user.
    mustResetPassword: extras.mustResetPassword,
  };
}

export function serializeEngagement(
  eng: DbEngagement,
  extras: {
    role?: EngagementRole;
    favorite?: boolean;
    numUsers?: number;
    numEvidence?: number;
    numFindings?: number;
    /** Rolled-up goal progress; present once the engagement has goals. */
    progress?: EngagementProgress;
    /**
     * Include the structured report content (scope, recommendations, threat model +
     * diagrams, execution narrative, contacts, software). These are heavy (diagrams
     * carry inline base64), so only the single-engagement detail response sets this;
     * list responses omit them to stay lean.
     */
    includeContent?: boolean;
  } = {},
): Engagement {
  const out: Engagement = {
    slug: eng.slug,
    name: eng.name,
    status: eng.status,
    createdAt: eng.createdAt.toISOString(),
    startedAt: eng.startedAt.toISOString(),
    projectedEndAt: eng.projectedEndAt?.toISOString() ?? null,
    actualEndAt: eng.actualEndAt?.toISOString() ?? null,
    clientName: eng.clientName,
    assessmentType: eng.assessmentType,
    testApproach: eng.testApproach,
    location: eng.location,
    scope: eng.scope,
    executiveSummary: eng.executiveSummary,
    methodology: eng.methodology,
    objectivesNarrative: eng.objectivesNarrative,
    watermarkEnabled: eng.watermarkEnabled,
    watermarkText: eng.watermarkText,
    watermarkColor: eng.watermarkColor,
    watermarkOpacity: eng.watermarkOpacity as Engagement['watermarkOpacity'],
    watermarkLayer: eng.watermarkLayer as Engagement['watermarkLayer'],
    // Report config is always returned, normalized to the canonical default when
    // the engagement has never been configured (stored as `{}`).
    reportConfig: reportConfigSchema.parse(eng.reportConfig ?? {}),
    hasProposalImport: eng.proposalImport != null,
    progress: extras.progress,
    role: extras.role,
    favorite: extras.favorite,
    numUsers: extras.numUsers,
    numEvidence: extras.numEvidence,
    numFindings: extras.numFindings,
  };
  if (extras.includeContent) {
    out.scopeTargets = (eng.scopeTargets as unknown as Engagement['scopeTargets']) ?? [];
    out.scopeExclusions = (eng.scopeExclusions as unknown as Engagement['scopeExclusions']) ?? [];
    out.strategicRecommendations =
      (eng.strategicRecommendations as unknown as Engagement['strategicRecommendations']) ?? [];
    out.threatModelNarrative = eng.threatModelNarrative;
    out.threatModelDiagrams =
      (eng.threatModelDiagrams as unknown as Engagement['threatModelDiagrams']) ?? [];
    out.executionNarrative =
      (eng.executionNarrative as unknown as Engagement['executionNarrative']) ?? [];
    out.providerContacts =
      (eng.providerContacts as unknown as Engagement['providerContacts']) ?? [];
    out.clientContacts = (eng.clientContacts as unknown as Engagement['clientContacts']) ?? [];
    out.softwareTested = (eng.softwareTested as unknown as Engagement['softwareTested']) ?? [];
    out.thirdPartySoftware =
      (eng.thirdPartySoftware as unknown as Engagement['thirdPartySoftware']) ?? [];
  }
  return out;
}

/** Public API-key shape. The secret is never included (it is returned exactly once, at creation). */
export function serializeApiKey(k: DbApiKey): ApiKey {
  return {
    accessKey: k.accessKey,
    lastAuth: k.lastAuth?.toISOString() ?? null,
    createdAt: k.createdAt.toISOString(),
  };
}

export function serializeTag(t: DbTag, usageCount?: number): Tag {
  return { id: t.id, name: t.name, colorName: t.colorName, usageCount };
}

export function serializeReportSettings(s: DbReportSettings): ReportSettings {
  return {
    organizationName: s.organizationName,
    accentColor: s.accentColor,
    logoDataUri: s.logoDataUri,
    footerNote: s.footerNote,
  };
}

/**
 * A report template row with its author resolved. The author is a `Pick`, not a
 * whole `DbUser`: the serialized shape only ever shows a byline, and a template is
 * readable by anyone authenticated, so the row must not carry an email or admin
 * flag into the response.
 */
type ReportTemplateWithAuthor = DbReportTemplate & {
  createdBy: Pick<DbUser, 'slug' | 'firstName' | 'lastName'> | null;
};

export function serializeReportTemplate(t: ReportTemplateWithAuthor): ReportTemplate {
  return {
    uuid: t.uuid,
    name: t.name,
    description: t.description,
    // Parsed, not cast: `config` is a free-form JSON column, so a row written by an
    // older build (or edited by hand in psql) is normalized to the canonical shape
    // here — including dropping a stray `readinessNa`, which a template never
    // carries — rather than reaching the client as something it doesn't expect.
    config: reportTemplateConfigSchema.parse(t.config ?? {}),
    // Null once the author has been deleted; the template itself survives.
    createdBy: t.createdBy
      ? { slug: t.createdBy.slug, firstName: t.createdBy.firstName, lastName: t.createdBy.lastName }
      : null,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

type EvidenceWithRelations = DbEvidence & {
  /** The capturing operator, or null once that user has been deleted. */
  operator: Pick<DbUser, 'slug' | 'firstName' | 'lastName'> | null;
  /** The last editor (any field), when the evidence has been edited since creation. */
  lastEditedBy?: Pick<DbUser, 'slug' | 'firstName' | 'lastName'> | null;
  tags: { tag: DbTag }[];
  /** Present when the include resolves the comment parent; carries the parent's uuid
   *  (for `parentEvidenceUuid`) and its report-exclusion flag, which is what makes
   *  inherited exclusion visible to the client (`parentExcludedFromReport`). */
  parent?: Pick<DbEvidence, 'uuid' | 'excludeFromReport'> | null;
  /** Present when the include counts comments (linked evidence) on this item. */
  _count?: { comments: number };
  /** The requesting user's pref only (see `evidenceInclude`); powers `starred`. */
  userPrefs?: { isFavorite: boolean }[];
};

export function serializeEvidence(e: EvidenceWithRelations, engagementSlug: string): Evidence {
  return {
    uuid: e.uuid,
    engagementSlug,
    // Null once the capturing user has been deleted — the evidence is the client
    // deliverable and outlives its author, so never fabricate an identity here.
    operator: e.operator
      ? {
          slug: e.operator.slug,
          firstName: e.operator.firstName,
          lastName: e.operator.lastName,
        }
      : null,
    title: e.title,
    description: e.description,
    contentType: e.contentType as Evidence['contentType'],
    contentSubtype: e.contentSubtype,
    originalFilename: e.originalFilename,
    occurredAt: e.occurredAt.toISOString(),
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
    lastEditedBy: e.lastEditedBy
      ? {
          slug: e.lastEditedBy.slug,
          firstName: e.lastEditedBy.firstName,
          lastName: e.lastEditedBy.lastName,
        }
      : null,
    tags: e.tags.map((et) => serializeTag(et.tag)),
    hasContent: Boolean(e.fullBlobKey),
    hasThumbnail: Boolean(e.thumbBlobKey),
    parentEvidenceUuid: e.parent?.uuid ?? null,
    commentCount: e._count?.comments ?? 0,
    starred: e.userPrefs?.[0]?.isFavorite ?? false,
    excludeFromReport: e.excludeFromReport,
    // The inherited half of report exclusion, resolved server-side: only the server
    // can see the parent's flag, and without it an item withheld purely by
    // inheritance looks report-bound everywhere it is listed.
    parentExcludedFromReport: e.parent?.excludeFromReport ?? false,
  };
}

/** Serialize a plain-text evidence comment. `edited` is true once the body has
 *  changed after posting; the create handler pins created == updated so this is a
 *  clean strict comparison. */
export function serializeEvidenceComment(
  c: DbEvidenceComment & { author: Pick<DbUser, 'slug' | 'firstName' | 'lastName'> | null },
): EvidenceComment {
  return {
    uuid: c.uuid,
    body: c.body,
    // Null once the authoring user has been deleted; the comment itself stays.
    author: c.author
      ? { slug: c.author.slug, firstName: c.author.firstName, lastName: c.author.lastName }
      : null,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
    edited: c.updatedAt.getTime() > c.createdAt.getTime(),
  };
}

/**
 * Serialize an evidence↔finding link: the base evidence shape plus the link's
 * bucket fields (`caption`, `inPath`). Used to build a finding-detail response.
 */
export function serializeFindingEvidence(
  ef: DbEvidenceFinding & { evidence: EvidenceWithRelations },
  engagementSlug: string,
): FindingEvidence {
  return {
    ...serializeEvidence(ef.evidence, engagementSlug),
    caption: ef.caption,
    inPath: ef.inPath,
  };
}

type FindingWithRelations = DbFinding & {
  category: FindingCategory | null;
  /** Link counts from the route's `findingInclude` (attached evidence, linked goals). */
  _count?: { evidence: number; goals: number };
  /**
   * The finding's evidence links already narrowed to the ones a report may show
   * (`REPORT_VISIBLE_EVIDENCE`), loaded for their count alone — `numEvidenceInReport`
   * is `.length`. Rows rather than a number because Prisma's `_count` can't alias a
   * relation, so a filtered `evidence` count cannot sit beside the unfiltered one
   * that `numEvidence` needs. Required, not optional: a caller that omitted it would
   * silently report every finding's evidence as absent from the report.
   */
  evidence: { evidenceId: number }[];
};

/**
 * `findingUuid → how many strategic recommendations address it`, built from an
 * engagement's `strategicRecommendations` JSON column (pass the raw column value;
 * null/undefined — an engagement that never had any — yields an empty map).
 *
 * The column is parsed through `recommendationItemSchema` rather than cast, so a
 * shape the write path never produced can't make the counts lie; an unparseable
 * column degrades to "no recommendations" instead of failing the request. One
 * recommendation may address several findings, so the counts across findings
 * legitimately sum to more than the number of recommendations, and a uuid naming a
 * deleted finding matches nothing and is counted nowhere.
 *
 * Build this once per request and feed `serializeFinding` from it — never per
 * finding, which would re-parse the column inside a loop.
 */
export function recommendationCountsByFinding(
  strategicRecommendations: unknown,
): Map<string, number> {
  const counts = new Map<string, number>();
  const parsed = recommendationItemSchema.array().safeParse(strategicRecommendations ?? []);
  if (!parsed.success) return counts;
  for (const rec of parsed.data) {
    // Deduped per recommendation: the count is "how many recommendations address
    // this finding", so a uuid repeated inside one `findingUuids` array (the editor
    // can't produce it, the API shape permits it) must still count that
    // recommendation once — matching what the finding page's own list shows.
    for (const uuid of new Set(rec.findingUuids)) counts.set(uuid, (counts.get(uuid) ?? 0) + 1);
  }
  return counts;
}

/**
 * `numRecommendations` arrives as its own argument rather than being derived here:
 * the number lives on the engagement's JSON column, and taking the engagement row
 * instead would both hand this serializer state it has no business reading and make
 * it re-parse that column once per finding. A required positional parameter (not an
 * optional extra) so a call site that hasn't got the count can't silently report 0.
 */
export function serializeFinding(
  f: FindingWithRelations,
  engagementSlug: string,
  numRecommendations: number,
): Finding {
  return {
    uuid: f.uuid,
    engagementSlug,
    title: f.title,
    description: f.description,
    kind: f.kind,
    affectedTarget: f.affectedTarget,
    impact: f.impact,
    fixEffort: f.fixEffort,
    iso21434Refs: (f.iso21434Refs as unknown as string[]) ?? [],
    unr155Refs: (f.unr155Refs as unknown as string[]) ?? [],
    remediation: f.remediation,
    category: f.category?.category ?? null,
    severity: f.severity,
    cvssVector: f.cvssVector,
    cvssScore: f.cvssScore,
    readyToReport: f.readyToReport,
    position: f.position,
    numEvidence: f._count?.evidence ?? 0,
    numEvidenceInReport: f.evidence.length,
    numGoals: f._count?.goals ?? 0,
    numRecommendations,
    createdAt: f.createdAt.toISOString(),
    updatedAt: f.updatedAt.toISOString(),
  };
}

export function serializeSavedQuery(q: DbSavedQuery): SavedQuery {
  return { id: q.id, name: q.name, query: q.query, type: q.type };
}

/**
 * Standard include for returning a fully-populated evidence row, scoped to the
 * requesting user so `starred` reflects — and only ever exposes — their pref.
 */
export function evidenceInclude(userId: number) {
  return {
    operator: { select: { slug: true, firstName: true, lastName: true } },
    lastEditedBy: { select: { slug: true, firstName: true, lastName: true } },
    tags: { include: { tag: true } },
    // Comment-linking: the parent (for `parentEvidenceUuid`) and the count of
    // comments pointing at this item (for `commentCount`). The parent's
    // `excludeFromReport` rides along because report exclusion is inherited, and
    // this one include backs every surface that lists evidence — the Evidence tab,
    // a finding's attached evidence, the evidence pickers — so resolving it here
    // badges the inherited case everywhere at once.
    parent: { select: { uuid: true, excludeFromReport: true } },
    _count: { select: { comments: true } },
    userPrefs: { where: { userId }, select: { isFavorite: true } },
  } as const;
}
