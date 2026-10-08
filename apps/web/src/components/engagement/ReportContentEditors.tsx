import { createContext, useContext, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Field,
  Input,
  MarkdownField,
  Select,
  Spinner,
} from '@reporter/ui';
import {
  EVIDENCE_GROUPINGS,
  EVIDENCE_GROUPING_LABELS,
  EXECUTION_SUBSECTION_KIND_HINTS,
  EXECUTION_SUBSECTION_KIND_LABELS,
  type Contact,
  type EvidenceGrouping,
  type Evidence,
  type ExecutionEvidenceRef,
  type ExecutionSubsection,
  type ExecutionTimelineConfig,
  type Finding,
  type RecommendationItem,
  type ScopeTarget,
  type SoftwareItem,
  type ThreatDiagram,
} from '@reporter/shared';
import { RepeatableList } from '../common/RepeatableList.js';
import { EvidencePickerModal } from '../findings/EvidencePickerModal.js';
import { FindingMultiSelect } from './FindingMultiSelect.js';
import { TagsFilter } from '../evidence/filters/TagsFilter.js';
import { TypeFilter } from '../evidence/filters/TypeFilter.js';
import { useEvidence, useTags } from '../../api/hooks.js';
import { DEEP_LINK_HIGHLIGHT, useDeepLinkRow } from '../../hooks/useDeepLinkRow.js';
import { evidenceHeading } from '../../lib/evidence-label.js';

/** Readiness state for a required content section (drives the header badge). */
export type SectionStatus = 'complete' | 'incomplete' | 'na';

/** Anchor ids of the collapsible content sections, in render order. */
export const CONTENT_SECTION_IDS = [
  'sec-service-scope',
  'sec-recommendations',
  'sec-threat-model',
  'sec-assessment-execution',
  'sec-provider-contacts',
  'sec-client-contacts',
  'sec-client-software',
  'sec-test-tools',
] as const;

/**
 * Drives the Content-tab accordion. Each {@link SectionCard} reads its own
 * open/closed state by id, so the parent form can collapse/expand all sections
 * (and expand one when the readiness checklist jumps to it) without threading
 * open-state through every editor.
 */
export const SectionCollapseContext = createContext<{
  collapsed: Set<string>;
  toggle: (id: string) => void;
} | null>(null);

/*
 * Deep link to one strategic recommendation. The Reports page keeps its active
 * sub-tab in `?section=` (absent means the Content tab), and `?rec=` addresses a
 * recommendation **by its position** in the list — R1 is `rec=0`. Position is
 * already this product's identity for a recommendation (the R-numbers printed in
 * the report are index+1), so there is nothing stabler to point at. Both ends of
 * the link live in this module: {@link recommendationHref} builds it, and
 * {@link RecommendationsEditor} consumes it on arrival.
 */
const CONTENT_SECTION_PARAM = 'section';
const CONTENT_SECTION_VALUE = 'content';
export const RECOMMENDATION_PARAM = 'rec';

/** Href to Reports → Content → Strategic recommendations, scrolled to one item. */
export function recommendationHref(slug: string, index: number): string {
  const params = new URLSearchParams({
    [CONTENT_SECTION_PARAM]: CONTENT_SECTION_VALUE,
    [RECOMMENDATION_PARAM]: String(index),
  });
  return `/engagements/${slug}/reports?${params.toString()}`;
}

/** DOM id of one recommendation row, so the arriving link can scroll to it. */
function recommendationRowId(index: number): string {
  return `rec-row-${index}`;
}

/** A fresh timeline-subsection filter config (all-inclusive, chronological). */
const DEFAULT_TIMELINE_CONFIG: ExecutionTimelineConfig = {
  tags: [],
  types: [],
  group: 'chronological',
  includeComments: false,
  starredOnly: false,
};

// Threat-model diagram limits (mirrors the server's ~2 MB/image cap; see the
// shared threatDiagramSchema). base64 inflates ~33%, so a ~2 MB data URI ≈ 1.5 MB
// of raw file — we validate on the raw File.size below.
const MAX_DIAGRAM_BYTES = 2_000_000;
const MAX_DIAGRAMS = 12;
const DIAGRAM_ACCEPT = 'image/png,image/jpeg,image/svg+xml,image/webp';

function readFileAsDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file'));
    reader.readAsDataURL(file);
  });
}

interface Common {
  disabled: boolean;
  disabledTitle?: string;
  /** Flush the debounced autosave now (wire to text-input onBlur). */
  onFlush?: () => void;
}

/**
 * The structured Report v2 content editors. Presentational + controlled: each
 * section is a value/onChange pair driven by the settings page's local state and
 * persisted via its save handler. Rendered only for engagement admins; the
 * `disabled` flag mirrors the page's read-only gating.
 */
export function ReportContentEditors({
  slug,
  disabled,
  disabledTitle,
  scopeTargets,
  onScopeTargets,
  scopeExclusions,
  onScopeExclusions,
  recommendations,
  onRecommendations,
  threatModelNarrative,
  onThreatModelNarrative,
  threatModelDiagrams,
  onThreatModelDiagrams,
  executionNarrative,
  onExecutionNarrative,
  providerContacts,
  onProviderContacts,
  clientContacts,
  onClientContacts,
  softwareTested,
  onSoftwareTested,
  thirdPartySoftware,
  onThirdPartySoftware,
  findings,
  sectionStatus,
  scope,
  onScope,
  onFlush,
  seeded,
}: Common & {
  slug: string;
  /** Free-text scope notes, shown inside the Service scope section. */
  scope: string;
  onScope: (v: string) => void;
  scopeTargets: ScopeTarget[];
  onScopeTargets: (v: ScopeTarget[]) => void;
  scopeExclusions: string[];
  onScopeExclusions: (v: string[]) => void;
  recommendations: RecommendationItem[];
  onRecommendations: (v: RecommendationItem[]) => void;
  threatModelNarrative: string;
  onThreatModelNarrative: (v: string) => void;
  threatModelDiagrams: ThreatDiagram[];
  onThreatModelDiagrams: (v: ThreatDiagram[]) => void;
  executionNarrative: ExecutionSubsection[];
  onExecutionNarrative: (v: ExecutionSubsection[]) => void;
  providerContacts: Contact[];
  onProviderContacts: (v: Contact[]) => void;
  clientContacts: Contact[];
  onClientContacts: (v: Contact[]) => void;
  softwareTested: SoftwareItem[];
  onSoftwareTested: (v: SoftwareItem[]) => void;
  thirdPartySoftware: SoftwareItem[];
  onThirdPartySoftware: (v: SoftwareItem[]) => void;
  /** Engagement findings, for linking recommendations to the findings they address. */
  findings: Finding[];
  /** Per-section readiness state, keyed by readiness item key. */
  sectionStatus: Partial<Record<string, SectionStatus>>;
  /** Flush the debounced autosave immediately (called on field blur). */
  onFlush?: () => void;
  /**
   * The values are the engagement's, not the parent form's empty initial state
   * (it seeds in an effect). Only the recommendation deep link reads this, to tell
   * "this index is past the end of the list" from "the list hasn't arrived yet".
   */
  seeded: boolean;
}) {
  const common: Common = { disabled, disabledTitle, onFlush };

  return (
    <>
      <ScopeEditor
        {...common}
        id="sec-service-scope"
        status={sectionStatus.serviceScope}
        targets={scopeTargets}
        onTargets={onScopeTargets}
        exclusions={scopeExclusions}
        onExclusions={onScopeExclusions}
        scope={scope}
        onScope={onScope}
      />

      <RecommendationsEditor
        {...common}
        id="sec-recommendations"
        status={sectionStatus.recommendations}
        slug={slug}
        items={recommendations}
        onChange={onRecommendations}
        findings={findings}
        seeded={seeded}
      />

      <ThreatModelEditor
        {...common}
        id="sec-threat-model"
        status={sectionStatus.threatModel}
        narrative={threatModelNarrative}
        onNarrative={onThreatModelNarrative}
        diagrams={threatModelDiagrams}
        onDiagrams={onThreatModelDiagrams}
      />

      <ExecutionEditor
        {...common}
        id="sec-assessment-execution"
        status={sectionStatus.assessmentExecution}
        slug={slug}
        subsections={executionNarrative}
        onChange={onExecutionNarrative}
      />

      <ContactsEditor
        {...common}
        id="sec-provider-contacts"
        status={sectionStatus.providerContacts}
        title="Provider contacts"
        hint="Assessment-team members listed in the report front matter."
        idPrefix="prov"
        items={providerContacts}
        onChange={onProviderContacts}
      />

      <ContactsEditor
        {...common}
        id="sec-client-contacts"
        status={sectionStatus.clientContacts}
        title="Client contacts"
        hint="Client-side points of contact for the engagement."
        idPrefix="cli"
        items={clientContacts}
        onChange={onClientContacts}
      />

      <SoftwareEditor
        {...common}
        id="sec-client-software"
        title="Client software tested"
        hint="Software and versions in scope for the assessment."
        idPrefix="cst"
        items={softwareTested}
        onChange={onSoftwareTested}
      />

      <SoftwareEditor
        {...common}
        id="sec-test-tools"
        status={sectionStatus.testTools}
        title="Test tools used"
        hint="Tools, hardware, and 3rd-party software used by the assessment team, with versions."
        idPrefix="tps"
        items={thirdPartySoftware}
        onChange={onThirdPartySoftware}
      />
    </>
  );
}

function SectionCard({
  title,
  hint,
  id,
  status,
  children,
}: {
  title: string;
  hint?: string;
  /** Anchor id so the readiness checklist can jump here (and collapse key). */
  id?: string;
  /** Readiness state — renders a status marker in the header. */
  status?: SectionStatus;
  children: ReactNode;
}) {
  const ctx = useContext(SectionCollapseContext);
  // Sections without an id (or with no accordion context) are always open.
  const open = !ctx || !id ? true : !ctx.collapsed.has(id);
  const panelId = id ? `${id}-panel` : undefined;
  return (
    <Card id={id} className="space-y-4 p-4 scroll-mt-4 lg:col-span-2">
      <div className="flex items-start justify-between gap-2">
        <button
          type="button"
          onClick={() => id && ctx?.toggle(id)}
          aria-expanded={open}
          aria-controls={panelId}
          disabled={!ctx || !id}
          className="flex min-w-0 flex-1 items-start gap-2 text-left"
        >
          {ctx && id && (
            <span
              aria-hidden="true"
              className={`mt-0.5 select-none text-xs text-muted transition-transform ${open ? 'rotate-90' : ''}`}
            >
              ▶
            </span>
          )}
          <span className="min-w-0">
            <span className="block text-sm font-semibold text-text">{title}</span>
            {hint && open && <span className="mt-1 block text-xs text-muted">{hint}</span>}
          </span>
        </button>
        <span className="shrink-0">
          {status === 'incomplete' && <Badge tone="warning">Incomplete</Badge>}
          {status === 'na' && <Badge tone="neutral">N/A</Badge>}
          {status === 'complete' && <Badge tone="success">Ready</Badge>}
        </span>
      </div>
      {open && (
        <div id={panelId} className="space-y-4">
          {children}
        </div>
      )}
    </Card>
  );
}

// --- Service Scope ---------------------------------------------------------

function ScopeEditor({
  disabled,
  disabledTitle,
  onFlush,
  id,
  status,
  targets,
  onTargets,
  exclusions,
  onExclusions,
  scope,
  onScope,
}: Common & {
  id?: string;
  status?: SectionStatus;
  targets: ScopeTarget[];
  onTargets: (v: ScopeTarget[]) => void;
  exclusions: string[];
  onExclusions: (v: string[]) => void;
  scope: string;
  onScope: (v: string) => void;
}) {
  return (
    <SectionCard
      id={id}
      status={status}
      title="Service scope"
      hint="Targets and their in-scope subsystems, plus anything explicitly out of scope."
    >
      <div>
        <p className="mb-2 text-sm font-medium text-text">Targets</p>
        <RepeatableList
          items={targets}
          onChange={onTargets}
          disabled={disabled}
          disabledTitle={disabledTitle}
          addLabel="Add target"
          emptyHint="No targets yet — add the systems or assets in scope."
          newItem={() => ({ name: '', subsystems: [] })}
          renderRow={(target, update) => (
            <div className="space-y-2">
              <Field label="Target name" htmlFor="scope-target-name">
                <Input
                  value={target.name}
                  onChange={(e) => update({ ...target, name: e.target.value })}
                  disabled={disabled}
                  title={disabledTitle}
                  placeholder="e.g. Telematics unit"
                />
              </Field>
              <div>
                <p className="mb-1 text-xs font-medium text-muted">Subsystems</p>
                <RepeatableList
                  items={target.subsystems}
                  onChange={(subsystems) => update({ ...target, subsystems })}
                  disabled={disabled}
                  disabledTitle={disabledTitle}
                  addLabel="Add subsystem"
                  emptyHint="No subsystems listed."
                  newItem={() => ''}
                  renderRow={(sub, updateSub) => (
                    <Input
                      value={sub}
                      onChange={(e) => updateSub(e.target.value)}
                      disabled={disabled}
                      title={disabledTitle}
                      aria-label="Subsystem"
                      placeholder="e.g. CAN gateway"
                    />
                  )}
                />
              </div>
            </div>
          )}
        />
      </div>

      <div className="border-t border-border pt-4">
        <p className="mb-2 text-sm font-medium text-text">Scope exclusions</p>
        <RepeatableList
          items={exclusions}
          onChange={onExclusions}
          disabled={disabled}
          disabledTitle={disabledTitle}
          addLabel="Add exclusion"
          emptyHint="Nothing explicitly excluded."
          newItem={() => ''}
          renderRow={(item, update) => (
            <Input
              value={item}
              onChange={(e) => update(e.target.value)}
              disabled={disabled}
              title={disabledTitle}
              aria-label="Scope exclusion"
              placeholder="e.g. Third-party cloud infrastructure"
            />
          )}
        />
      </div>

      <div className="border-t border-border pt-4">
        <Field
          label="Additional scope notes"
          htmlFor="r-scope"
          hint="Optional free-text notes shown above the scope tables."
        >
          <MarkdownField
            id="r-scope"
            rows={3}
            value={scope}
            onChange={(v) => onScope(v)}
            onBlur={onFlush}
            disabled={disabled}
            title={disabledTitle}
          />
        </Field>
      </div>
    </SectionCard>
  );
}

// --- Strategic Recommendations --------------------------------------------

/**
 * Arrival side of {@link recommendationHref}, over the shared
 * {@link useDeepLinkRow}: expands this (collapsed-by-default) section, scrolls the
 * addressed row into view and flashes it. Returns the index to flash, or null.
 *
 * `seeded` says `count` is the engagement's recommendation count rather than the
 * parent form's empty initial state (it seeds in an effect). Without it a perfectly
 * good link would be judged against a zero-length list on the first pass, read as
 * stale, and dropped.
 */
function useRecommendationDeepLink(
  sectionId: string | undefined,
  count: number,
  seeded: boolean,
): number | null {
  const collapse = useContext(SectionCollapseContext);
  const [params] = useSearchParams();
  // The Content tab stays mounted (just hidden) while another sub-tab is active,
  // and scrolling a hidden subtree does nothing, so the param is held — not spent
  // — until Content is the tab on screen.
  const onContentTab =
    (params.get(CONTENT_SECTION_PARAM) ?? CONTENT_SECTION_VALUE) === CONTENT_SECTION_VALUE;
  const highlighted = useDeepLinkRow(
    RECOMMENDATION_PARAM,
    (raw) => {
      // A 0-based array position and nothing else. The digits test is load-bearing:
      // `Number('')` is 0, so a bare `?rec=` would otherwise flash R1.
      if (!/^\d+$/.test(raw)) return null;
      const index = Number(raw);
      if (index >= count) return null;
      return {
        rowId: recommendationRowId(index),
        reveal: () => {
          if (sectionId && collapse?.collapsed.has(sectionId)) collapse.toggle(sectionId);
        },
      };
    },
    seeded && onContentTab,
  );
  return highlighted === null ? null : Number(highlighted);
}

function RecommendationsEditor({
  disabled,
  disabledTitle,
  id,
  status,
  slug,
  items,
  onChange,
  findings,
  seeded,
}: Common & {
  id?: string;
  status?: SectionStatus;
  slug: string;
  items: RecommendationItem[];
  onChange: (v: RecommendationItem[]) => void;
  findings: Finding[];
  /** The list is the engagement's, not the parent form's empty initial state. */
  seeded: boolean;
}) {
  const highlighted = useRecommendationDeepLink(id, items.length, seeded);
  // Coverage: which weaknesses are addressed by at least one recommendation.
  const weaknesses = findings.filter((f) => f.kind === 'weakness');
  const covered = new Set(items.flatMap((i) => i.findingUuids ?? []));
  const uncovered = weaknesses.filter((f) => !covered.has(f.uuid));
  const coveredCount = weaknesses.length - uncovered.length;
  // Quick-add: a new recommendation pre-linked to this finding (title it below).
  const addFor = (findingUuid: string) =>
    onChange([...items, { title: '', description: '', findingUuids: [findingUuid] }]);

  return (
    <SectionCard
      id={id}
      status={status}
      title="Strategic recommendations"
      hint="High-level guidance, numbered R1, R2, … in the report. Each must be linked to the finding(s) it addresses."
    >
      {weaknesses.length > 0 && (
        <div className="space-y-2 rounded-input border border-border bg-surface-2 p-3">
          <p className="text-xs font-medium text-text">
            Coverage — {coveredCount}/{weaknesses.length} weaknesses have a strategic recommendation
          </p>
          {uncovered.length === 0 ? (
            <p className="text-xs text-muted">Every weakness is linked to a recommendation.</p>
          ) : (
            <ul className="space-y-1">
              {uncovered.map((f) => (
                <li key={f.uuid} className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-sm text-muted">
                    {f.title || '(untitled finding)'}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => addFor(f.uuid)}
                    disabled={disabled}
                    title={disabled ? disabledTitle : 'Add a recommendation linked to this finding'}
                  >
                    Add
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <RepeatableList
        items={items}
        onChange={onChange}
        disabled={disabled}
        disabledTitle={disabledTitle}
        addLabel="Add recommendation"
        emptyHint="No recommendations yet."
        newItem={() => ({ title: '', description: '', findingUuids: [] })}
        renderRow={(item, update, index) => {
          const linked = item.findingUuids ?? [];
          // Only nag once a recommendation has real content to link.
          const needsLink = item.title.trim().length > 0 && linked.length === 0;
          return (
            <div
              id={recommendationRowId(index)}
              className={`space-y-2 rounded-input transition-colors ${
                highlighted === index ? DEEP_LINK_HIGHLIGHT : ''
              }`}
            >
              <div className="flex items-center gap-2">
                <Badge tone="accent">R{index + 1}</Badge>
                {needsLink && <Badge tone="warning">Link a finding</Badge>}
              </div>
              <Field label="Title" htmlFor={`rec-title-${index}`}>
                <Input
                  id={`rec-title-${index}`}
                  value={item.title}
                  onChange={(e) => update({ ...item, title: e.target.value })}
                  disabled={disabled}
                  title={disabledTitle}
                />
              </Field>
              <Field label="Description" htmlFor={`rec-desc-${index}`}>
                <MarkdownField
                  id={`rec-desc-${index}`}
                  rows={3}
                  value={item.description}
                  onChange={(v) => update({ ...item, description: v })}
                  disabled={disabled}
                  title={disabledTitle}
                />
              </Field>
              <Field
                label="Related findings"
                htmlFor={`rec-find-${index}`}
                hint="Required — the finding(s) this recommendation addresses."
                error={needsLink ? 'Link at least one finding.' : undefined}
              >
                <FindingMultiSelect
                  id={`rec-find-${index}`}
                  slug={slug}
                  findings={findings}
                  selected={linked}
                  onChange={(findingUuids) => update({ ...item, findingUuids })}
                  disabled={disabled}
                  disabledTitle={disabledTitle}
                />
              </Field>
            </div>
          );
        }}
      />
    </SectionCard>
  );
}

// --- Threat Model ----------------------------------------------------------

function ThreatModelEditor({
  disabled,
  disabledTitle,
  onFlush,
  id,
  status,
  narrative,
  onNarrative,
  diagrams,
  onDiagrams,
}: Common & {
  id?: string;
  status?: SectionStatus;
  narrative: string;
  onNarrative: (v: string) => void;
  diagrams: ThreatDiagram[];
  onDiagrams: (v: ThreatDiagram[]) => void;
}) {
  const [error, setError] = useState<string | null>(null);

  return (
    <SectionCard
      id={id}
      status={status}
      title="Threat model"
      hint="A narrative plus optional diagrams embedded in the report."
    >
      <Field label="Threat model narrative" htmlFor="tm-narrative">
        <MarkdownField
          id="tm-narrative"
          rows={6}
          value={narrative}
          onChange={(v) => onNarrative(v)}
          onBlur={onFlush}
          disabled={disabled}
          title={disabledTitle}
        />
      </Field>

      <div className="border-t border-border pt-4">
        <p className="mb-1 text-sm font-medium text-text">Diagrams</p>
        <p className="mb-3 text-xs text-muted">
          PNG or SVG, ~1600px wide, under 2 MB each. Up to {MAX_DIAGRAMS} diagrams.
        </p>
        <RepeatableList
          items={diagrams}
          onChange={onDiagrams}
          disabled={disabled}
          disabledTitle={disabledTitle}
          addLabel="Add diagram"
          emptyHint="No diagrams yet."
          // The "add" button appends a blank slot; the file picker in the row
          // fills its image. This keeps a consistent add/reorder/remove UX.
          newItem={() => ({ imageDataUri: '', caption: '' })}
          renderRow={(diagram, update, index) => (
            <div className="flex flex-wrap items-start gap-3">
              <div className="flex h-20 w-28 items-center justify-center overflow-hidden rounded-input border border-border bg-surface-2">
                {diagram.imageDataUri ? (
                  <img
                    src={diagram.imageDataUri}
                    alt={diagram.caption || `Diagram ${index + 1} preview`}
                    className="max-h-full max-w-full object-contain"
                  />
                ) : (
                  <span className="px-2 text-center text-xs text-muted">No image</span>
                )}
              </div>
              <div className="min-w-0 flex-1 space-y-2">
                <input
                  type="file"
                  accept={DIAGRAM_ACCEPT}
                  aria-label={`Upload diagram ${index + 1}`}
                  disabled={disabled}
                  title={disabledTitle}
                  onChange={async (e) => {
                    setError(null);
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (!file) return;
                    if (file.size > MAX_DIAGRAM_BYTES) {
                      setError('That image is too large — keep each diagram under 2 MB.');
                      return;
                    }
                    try {
                      const imageDataUri = await readFileAsDataUri(file);
                      if (!imageDataUri.startsWith('data:image/')) {
                        setError('That file is not an image.');
                        return;
                      }
                      update({ ...diagram, imageDataUri });
                    } catch (err) {
                      setError(err instanceof Error ? err.message : 'Could not read the image');
                    }
                  }}
                  className="block text-sm text-muted file:mr-3 file:rounded-input file:border file:border-border file:bg-surface-2 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-text hover:file:bg-surface disabled:opacity-50"
                />
                <Field label="Caption" htmlFor={`tm-cap-${index}`}>
                  <Input
                    id={`tm-cap-${index}`}
                    value={diagram.caption}
                    onChange={(e) => update({ ...diagram, caption: e.target.value })}
                    disabled={disabled}
                    title={disabledTitle}
                    placeholder="Describe the diagram"
                  />
                </Field>
              </div>
            </div>
          )}
        />
        {error && <p className="mt-2 text-sm text-danger">{error}</p>}
      </div>
    </SectionCard>
  );
}

// --- Assessment Execution narrative ---------------------------------------

function ExecutionEditor({
  disabled,
  disabledTitle,
  id,
  status,
  slug,
  subsections,
  onChange,
}: Common & {
  id?: string;
  status?: SectionStatus;
  slug: string;
  subsections: ExecutionSubsection[];
  onChange: (v: ExecutionSubsection[]) => void;
}) {
  const newNarrative = (): ExecutionSubsection => ({
    kind: 'narrative',
    title: '',
    body: '',
    evidence: [],
  });
  const newTimeline = (): ExecutionSubsection => ({
    kind: 'timeline',
    title: '',
    body: '',
    evidence: [],
    timeline: { ...DEFAULT_TIMELINE_CONFIG },
  });

  return (
    <SectionCard
      id={id}
      status={status}
      title="Assessment execution"
      hint="Written narrative subsections with embedded evidence, or activity timelines drawn from the engagement’s captured evidence."
    >
      <RepeatableList
        items={subsections}
        onChange={onChange}
        disabled={disabled}
        disabledTitle={disabledTitle}
        addLabel="Add subsection"
        emptyHint="No execution subsections yet."
        newItem={newNarrative}
        addSlot={
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={disabled}
              title={disabledTitle}
              onClick={() => onChange([...subsections, newNarrative()])}
            >
              ＋ Add narrative
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={disabled}
              title={disabledTitle}
              onClick={() => onChange([...subsections, newTimeline()])}
            >
              ＋ Add timeline
            </Button>
          </div>
        }
        renderRow={(sub, update, index) => {
          const kind = sub.kind === 'timeline' ? 'timeline' : 'narrative';
          return (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Badge tone={kind === 'timeline' ? 'accent' : 'neutral'}>
                  {EXECUTION_SUBSECTION_KIND_LABELS[kind]}
                </Badge>
                <span className="text-xs text-muted">{EXECUTION_SUBSECTION_KIND_HINTS[kind]}</span>
              </div>
              <Field label="Subsection title" htmlFor={`ex-title-${index}`}>
                <Input
                  id={`ex-title-${index}`}
                  value={sub.title}
                  onChange={(e) => update({ ...sub, title: e.target.value })}
                  disabled={disabled}
                  title={disabledTitle}
                  placeholder={
                    kind === 'timeline' ? 'e.g. CAN bus activity' : 'e.g. CAN bus analysis'
                  }
                />
              </Field>
              {kind === 'timeline' ? (
                <ExecutionTimelineEditor
                  slug={slug}
                  index={index}
                  disabled={disabled}
                  disabledTitle={disabledTitle}
                  config={sub.timeline}
                  onChange={(timeline) => update({ ...sub, timeline })}
                />
              ) : (
                <>
                  <Field label="Body" htmlFor={`ex-body-${index}`}>
                    <MarkdownField
                      id={`ex-body-${index}`}
                      rows={5}
                      value={sub.body}
                      onChange={(v) => update({ ...sub, body: v })}
                      disabled={disabled}
                      title={disabledTitle}
                    />
                  </Field>
                  <ExecutionEvidenceEditor
                    slug={slug}
                    disabled={disabled}
                    disabledTitle={disabledTitle}
                    refs={sub.evidence}
                    onChange={(evidence) => update({ ...sub, evidence })}
                  />
                </>
              )}
            </div>
          );
        }}
      />
    </SectionCard>
  );
}

/** Filters + grouping for a timeline-kind execution subsection. */
function ExecutionTimelineEditor({
  slug,
  index,
  disabled,
  disabledTitle,
  config,
  onChange,
}: Common & {
  slug: string;
  /** Row position — keeps this editor's control ids unique across subsections. */
  index: number;
  config: ExecutionTimelineConfig | undefined;
  onChange: (v: ExecutionTimelineConfig) => void;
}) {
  const { data: tags = [] } = useTags(slug);
  const cfg = config ?? DEFAULT_TIMELINE_CONFIG;
  const groupId = `ex-tl-group-${index}`;
  return (
    <div className="space-y-3 rounded-card border border-dashed border-border p-3">
      <p className="text-xs font-medium text-muted">
        Renders the engagement’s captured evidence, filtered and grouped — no hand-picked evidence.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Group evidence by" htmlFor={groupId}>
          <Select
            id={groupId}
            value={cfg.group}
            disabled={disabled}
            title={disabledTitle}
            onChange={(e) => onChange({ ...cfg, group: e.target.value as EvidenceGrouping })}
          >
            {EVIDENCE_GROUPINGS.map((g) => (
              <option key={g} value={g}>
                {EVIDENCE_GROUPING_LABELS[g]}
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex items-center gap-2 pb-0.5">
          <TagsFilter
            value={cfg.tags}
            tags={tags}
            onChange={(t) => onChange({ ...cfg, tags: t })}
          />
          <TypeFilter value={cfg.types} onChange={(t) => onChange({ ...cfg, types: t })} />
        </div>
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <Checkbox
          label="Include follow-up comments"
          checked={cfg.includeComments}
          disabled={disabled}
          onChange={(e) => onChange({ ...cfg, includeComments: e.target.checked })}
        />
        <Checkbox
          label="Only starred evidence"
          checked={cfg.starredOnly}
          disabled={disabled}
          onChange={(e) => onChange({ ...cfg, starredOnly: e.target.checked })}
        />
      </div>
    </div>
  );
}

function ExecutionEvidenceEditor({
  slug,
  disabled,
  disabledTitle,
  refs,
  onChange,
}: Common & {
  slug: string;
  refs: ExecutionEvidenceRef[];
  onChange: (v: ExecutionEvidenceRef[]) => void;
}) {
  const [picking, setPicking] = useState(false);
  const existingUuids = refs.map((r) => r.evidenceUuid);

  function onPick(picked: Evidence[]) {
    const seen = new Set(existingUuids);
    const additions = picked
      .filter((e) => !seen.has(e.uuid))
      .map<ExecutionEvidenceRef>((e) => ({ evidenceUuid: e.uuid, caption: '' }));
    onChange([...refs, ...additions]);
    setPicking(false);
  }

  return (
    <div className="rounded-card border border-dashed border-border p-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs font-medium text-muted">Embedded evidence ({refs.length})</p>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => setPicking(true)}
          disabled={disabled}
          title={disabledTitle}
        >
          Add evidence
        </Button>
      </div>

      <RepeatableList
        items={refs}
        onChange={onChange}
        disabled={disabled}
        disabledTitle={disabledTitle}
        addLabel="Add evidence"
        emptyHint="No evidence embedded in this subsection yet."
        // Rows are only added via the picker, so surface that instead of a blank
        // ref: the RepeatableList "add" button appends an empty (invalid) ref.
        newItem={() => ({ evidenceUuid: '', caption: '' })}
        renderRow={(ref, update, index) => (
          <ExecutionEvidenceRow
            slug={slug}
            evidenceRef={ref}
            index={index}
            disabled={disabled}
            disabledTitle={disabledTitle}
            onCaption={(caption) => update({ ...ref, caption })}
          />
        )}
      />

      <EvidencePickerModal
        slug={slug}
        attachedUuids={existingUuids}
        targetInPath={false}
        open={picking}
        onClose={() => setPicking(false)}
        onPick={onPick}
      />
    </div>
  );
}

function ExecutionEvidenceRow({
  slug,
  evidenceRef,
  index,
  disabled,
  disabledTitle,
  onCaption,
}: Common & {
  slug: string;
  evidenceRef: ExecutionEvidenceRef;
  index: number;
  onCaption: (caption: string) => void;
}) {
  // Resolve the referenced evidence to show a label and detect stale refs (the
  // evidence was deleted, or the uuid slot is still empty). One query per row is
  // fine — the list is small and results are cached across renders.
  const { data, isLoading, isError } = useEvidence(slug, evidenceRef.evidenceUuid);
  const missing = !evidenceRef.evidenceUuid || isError;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-sm">
        {isLoading ? (
          <Spinner size={14} />
        ) : missing ? (
          <Badge tone="warning">Missing evidence</Badge>
        ) : (
          <span className="min-w-0 truncate font-medium text-text">
            {data ? evidenceHeading(data) : <span className="text-muted">Evidence</span>}
          </span>
        )}
      </div>
      {missing && (
        <p className="text-xs text-warning">
          This evidence is no longer in the engagement and will be skipped in the report.
        </p>
      )}
      <Field label="Caption" htmlFor={`ex-ev-cap-${index}`}>
        <Input
          id={`ex-ev-cap-${index}`}
          value={evidenceRef.caption}
          onChange={(e) => onCaption(e.target.value)}
          disabled={disabled}
          title={disabledTitle}
          placeholder="Optional caption"
        />
      </Field>
    </div>
  );
}

// --- Contacts --------------------------------------------------------------

function ContactsEditor({
  disabled,
  disabledTitle,
  id,
  status,
  title,
  hint,
  idPrefix,
  items,
  onChange,
}: Common & {
  id?: string;
  status?: SectionStatus;
  title: string;
  hint: string;
  idPrefix: string;
  items: Contact[];
  onChange: (v: Contact[]) => void;
}) {
  return (
    <SectionCard id={id} status={status} title={title} hint={hint}>
      <RepeatableList
        items={items}
        onChange={onChange}
        disabled={disabled}
        disabledTitle={disabledTitle}
        addLabel="Add contact"
        emptyHint="No contacts yet."
        newItem={() => ({ name: '', title: '', email: '' })}
        renderRow={(contact, update, index) => (
          <div className="grid gap-2 sm:grid-cols-3">
            <Field label="Name" htmlFor={`${idPrefix}-name-${index}`}>
              <Input
                id={`${idPrefix}-name-${index}`}
                value={contact.name}
                onChange={(e) => update({ ...contact, name: e.target.value })}
                disabled={disabled}
                title={disabledTitle}
              />
            </Field>
            <Field label="Title" htmlFor={`${idPrefix}-title-${index}`}>
              <Input
                id={`${idPrefix}-title-${index}`}
                value={contact.title}
                onChange={(e) => update({ ...contact, title: e.target.value })}
                disabled={disabled}
                title={disabledTitle}
              />
            </Field>
            <Field label="Email" htmlFor={`${idPrefix}-email-${index}`}>
              <Input
                id={`${idPrefix}-email-${index}`}
                type="email"
                value={contact.email}
                onChange={(e) => update({ ...contact, email: e.target.value })}
                disabled={disabled}
                title={disabledTitle}
              />
            </Field>
          </div>
        )}
      />
    </SectionCard>
  );
}

// --- Software --------------------------------------------------------------

function SoftwareEditor({
  disabled,
  disabledTitle,
  id,
  status,
  title,
  hint,
  idPrefix,
  items,
  onChange,
}: Common & {
  id?: string;
  status?: SectionStatus;
  title: string;
  hint: string;
  idPrefix: string;
  items: SoftwareItem[];
  onChange: (v: SoftwareItem[]) => void;
}) {
  return (
    <SectionCard id={id} status={status} title={title} hint={hint}>
      <RepeatableList
        items={items}
        onChange={onChange}
        disabled={disabled}
        disabledTitle={disabledTitle}
        addLabel="Add software"
        emptyHint="No software listed yet."
        newItem={() => ({ name: '', version: '' })}
        renderRow={(item, update, index) => (
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="Name" htmlFor={`${idPrefix}-name-${index}`}>
              <Input
                id={`${idPrefix}-name-${index}`}
                value={item.name}
                onChange={(e) => update({ ...item, name: e.target.value })}
                disabled={disabled}
                title={disabledTitle}
              />
            </Field>
            <Field label="Version" htmlFor={`${idPrefix}-ver-${index}`}>
              <Input
                id={`${idPrefix}-ver-${index}`}
                value={item.version}
                onChange={(e) => update({ ...item, version: e.target.value })}
                disabled={disabled}
                title={disabledTitle}
              />
            </Field>
          </div>
        )}
      />
    </SectionCard>
  );
}
