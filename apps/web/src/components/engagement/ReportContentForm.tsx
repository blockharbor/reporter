import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, Card, Checkbox, Field, Input, MarkdownField, Select } from '@reporter/ui';
import {
  WATERMARK_LAYERS,
  WATERMARK_LAYER_LABELS,
  WATERMARK_MAX_CHARS,
  WATERMARK_OPACITIES,
  WATERMARK_OPACITY_LABELS,
  type Contact,
  type Engagement,
  type ExecutionSubsection,
  type RecommendationItem,
  type ScopeTarget,
  type SoftwareItem,
  type ThreatDiagram,
  type WatermarkLayer,
  type WatermarkOpacity,
} from '@reporter/shared';
import { useFindings, useUpdateEngagement } from '../../api/hooks.js';
import { useAutosave } from '../../hooks/useAutosave.js';
import { computeFindingWarnings, computeReadiness } from '../../lib/report-readiness.js';
import { SaveStatusIndicator } from '../SaveStatusIndicator.js';
import {
  CONTENT_SECTION_IDS,
  ReportContentEditors,
  SectionCollapseContext,
  type SectionStatus,
} from './ReportContentEditors.js';
import { FindingsNeedingAttention } from './FindingsNeedingAttention.js';
import { ReportReadiness } from './ReportReadiness.js';

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/**
 * The slice of engagement fields that describe the report's *content* — the
 * report-detail metadata, the watermark, and the structured Report v2 sections.
 * This is the set moved out of the engagement Settings page into the Reports tab's
 * "Content" sub-tab; it owns its own debounced autosave over the same engagement
 * record (the Settings page keeps the details/members/tags slice).
 */
interface ContentForm {
  clientName: string;
  assessmentType: string;
  location: string;
  scope: string;
  executiveSummary: string;
  methodology: string;
  wmEnabled: boolean;
  wmText: string;
  wmColor: string;
  wmOpacity: WatermarkOpacity;
  wmLayer: WatermarkLayer;
  scopeTargets: ScopeTarget[];
  scopeExclusions: string[];
  recommendations: RecommendationItem[];
  threatModelNarrative: string;
  threatModelDiagrams: ThreatDiagram[];
  executionNarrative: ExecutionSubsection[];
  providerContacts: Contact[];
  clientContacts: Contact[];
  softwareTested: SoftwareItem[];
  thirdPartySoftware: SoftwareItem[];
}

/**
 * Self-contained, autosaving editor for an engagement's report content. Seeds its
 * own form state from the passed engagement and PUTs partial `updateEngagementInput`
 * patches through {@link useUpdateEngagement}. `canWrite` gates every input into a
 * read-only view (mirroring the old Settings page's `disabled` behavior).
 */
export function ReportContentForm({
  slug,
  engagement: eng,
  canWrite,
  readinessNa,
  onToggleReadinessNa,
  canToggleReadinessNa,
}: {
  slug: string;
  engagement: Engagement;
  canWrite: boolean;
  /** Readiness item keys the author has marked "Not applicable" (from reportConfig). */
  readinessNa: string[];
  /** Toggle an item's N/A state (persisted in reportConfig by the parent page). */
  onToggleReadinessNa: (key: string, na: boolean) => void;
  /** N/A lives in the admin-gated reportConfig, so toggling needs admin rights. */
  canToggleReadinessNa: boolean;
}) {
  const disabled = !canWrite;
  const disabledTitle = disabled ? 'You need write access to edit this.' : undefined;
  const { data: findings = [] } = useFindings(slug);

  const [form, setForm] = useState<ContentForm>({
    clientName: '',
    assessmentType: '',
    location: '',
    scope: '',
    executiveSummary: '',
    methodology: '',
    wmEnabled: true,
    wmText: '',
    wmColor: '#64748b',
    wmOpacity: 'medium',
    wmLayer: 'behind',
    scopeTargets: [],
    scopeExclusions: [],
    recommendations: [],
    threatModelNarrative: '',
    threatModelDiagrams: [],
    executionNarrative: [],
    providerContacts: [],
    clientContacts: [],
    softwareTested: [],
    thirdPartySoftware: [],
  });
  const patchForm = <K extends keyof ContentForm>(key: K, value: ContentForm[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  // Seed once per engagement, not on every cache change — membership/favorite
  // mutations replace the cached `eng` object, and reseeding then would clobber an
  // in-progress edit. (Mirrors the Settings page's seeding guard.)
  const seededSlug = useRef<string | null>(null);
  const [baseline, setBaseline] = useState<ContentForm | undefined>(undefined);
  useEffect(() => {
    if (seededSlug.current === eng.slug) return;
    seededSlug.current = eng.slug;
    const seeded: ContentForm = {
      clientName: eng.clientName ?? '',
      assessmentType: eng.assessmentType ?? '',
      location: eng.location ?? '',
      scope: eng.scope ?? '',
      executiveSummary: eng.executiveSummary ?? '',
      methodology: eng.methodology ?? '',
      wmEnabled: eng.watermarkEnabled ?? true,
      // Clamp to the current cap so an engagement that saved a longer watermark
      // under the old limit doesn't block autosave of the whole form.
      wmText: (eng.watermarkText ?? '').slice(0, WATERMARK_MAX_CHARS),
      wmColor: eng.watermarkColor ?? '#64748b',
      wmOpacity: eng.watermarkOpacity ?? 'medium',
      wmLayer: eng.watermarkLayer ?? 'behind',
      scopeTargets: eng.scopeTargets ?? [],
      scopeExclusions: eng.scopeExclusions ?? [],
      // Normalize legacy recommendations that predate finding links.
      recommendations: (eng.strategicRecommendations ?? []).map((r) => ({
        ...r,
        findingUuids: r.findingUuids ?? [],
      })),
      threatModelNarrative: eng.threatModelNarrative ?? '',
      threatModelDiagrams: eng.threatModelDiagrams ?? [],
      executionNarrative: eng.executionNarrative ?? [],
      providerContacts: eng.providerContacts ?? [],
      clientContacts: eng.clientContacts ?? [],
      softwareTested: eng.softwareTested ?? [],
      thirdPartySoftware: eng.thirdPartySoftware ?? [],
    };
    setForm(seeded);
    setBaseline(seeded);
  }, [eng]);

  // The watermark color must be a #rrggbb hex or the server 400s; a dirty-but-
  // invalid form parks at `unsaved` and never saves.
  const colorInvalid = !HEX_COLOR_RE.test(form.wmColor);
  const formValid = (v: ContentForm) => HEX_COLOR_RE.test(v.wmColor);

  const update = useUpdateEngagement(slug);
  const { status, flush } = useAutosave<ContentForm>({
    value: form,
    baseline,
    isValid: (v) => canWrite && formValid(v),
    save: async (v) => {
      const orNull = (s: string) => (s.trim() === '' ? null : s);
      const trim = (s: string) => s.trim();
      const nonEmpty = (s: string) => trim(s) !== '';
      await update.mutateAsync({
        // Report metadata — empty string clears the field (sent as null).
        clientName: orNull(v.clientName),
        assessmentType: orNull(v.assessmentType),
        location: orNull(v.location),
        scope: orNull(v.scope),
        executiveSummary: orNull(v.executiveSummary),
        methodology: orNull(v.methodology),
        watermarkEnabled: v.wmEnabled,
        // Slice defensively so a legacy over-long value can never 400 the patch.
        watermarkText: orNull(v.wmText.slice(0, WATERMARK_MAX_CHARS)),
        watermarkColor: v.wmColor,
        watermarkOpacity: v.wmOpacity,
        watermarkLayer: v.wmLayer,
        // Structured report content — drop blank rows the same way the manual save did.
        scopeTargets: v.scopeTargets
          .filter((t) => nonEmpty(t.name))
          .map((t) => ({ name: trim(t.name), subsystems: t.subsystems.filter(nonEmpty) })),
        scopeExclusions: v.scopeExclusions.filter(nonEmpty),
        strategicRecommendations: v.recommendations
          .filter((r) => nonEmpty(r.title))
          .map((r) => ({
            title: trim(r.title),
            description: r.description,
            findingUuids: r.findingUuids ?? [],
          })),
        threatModelNarrative: nonEmpty(v.threatModelNarrative) ? v.threatModelNarrative : null,
        threatModelDiagrams: v.threatModelDiagrams.filter((d) =>
          d.imageDataUri.startsWith('data:image/'),
        ),
        executionNarrative: v.executionNarrative
          .filter((s) => nonEmpty(s.title))
          .map((s) => ({ ...s, evidence: s.evidence.filter((e) => e.evidenceUuid !== '') })),
        providerContacts: v.providerContacts.filter(
          (c) => nonEmpty(c.name) || nonEmpty(c.title) || nonEmpty(c.email),
        ),
        clientContacts: v.clientContacts.filter(
          (c) => nonEmpty(c.name) || nonEmpty(c.title) || nonEmpty(c.email),
        ),
        softwareTested: v.softwareTested.filter((s) => nonEmpty(s.name)),
        thirdPartySoftware: v.thirdPartySoftware.filter((s) => nonEmpty(s.name)),
      });
      setBaseline(v);
    },
  });

  // Report readiness — computed live from the in-progress form so the checklist
  // ticks as fields are filled. The ready-finding gate reads the findings list.
  const readyFindingCount = findings.filter((f) => f.readyToReport).length;
  const readiness = useMemo(
    () =>
      computeReadiness(
        {
          clientName: form.clientName,
          assessmentType: form.assessmentType,
          location: form.location,
          scope: form.scope,
          executiveSummary: form.executiveSummary,
          methodology: form.methodology,
          watermarkEnabled: form.wmEnabled,
          scopeTargets: form.scopeTargets,
          recommendations: form.recommendations,
          threatModelNarrative: form.threatModelNarrative,
          threatModelDiagrams: form.threatModelDiagrams,
          executionNarrative: form.executionNarrative,
          providerContacts: form.providerContacts,
          clientContacts: form.clientContacts,
          thirdPartySoftware: form.thirdPartySoftware,
          readyFindingCount,
        },
        readinessNa,
      ),
    [form, readinessNa, readyFindingCount],
  );
  // Advisory, alongside readiness rather than inside it: ready findings the report
  // will render incomplete. Computed from the same findings list the gate above
  // reduces to a single count.
  const findingWarnings = useMemo(() => computeFindingWarnings(findings), [findings]);
  const statusOf = (key: string): SectionStatus | undefined => {
    const it = readiness.items.find((i) => i.key === key);
    return it ? (it.complete ? 'complete' : it.na ? 'na' : 'incomplete') : undefined;
  };
  const sectionStatus: Partial<Record<string, SectionStatus>> = {
    serviceScope: statusOf('serviceScope'),
    recommendations: statusOf('recommendations'),
    threatModel: statusOf('threatModel'),
    assessmentExecution: statusOf('assessmentExecution'),
    providerContacts: statusOf('providerContacts'),
    clientContacts: statusOf('clientContacts'),
    testTools: statusOf('testTools'),
  };
  // The report-details card groups these seven items; badge it if any is missing.
  const detailsIncomplete = [
    'clientName',
    'assessmentType',
    'location',
    'scope',
    'executiveSummary',
    'methodology',
    'watermark',
  ].some((k) => statusOf(k) === 'incomplete');
  // Content-tab accordion: the structured sections start collapsed so the whole
  // report structure is visible at a glance; jumping from the readiness checklist
  // expands the target section, then scrolls to it.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(CONTENT_SECTION_IDS));
  const toggleSection = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const allCollapsed = CONTENT_SECTION_IDS.every((id) => collapsed.has(id));
  const jump = (anchor: string) => {
    if (CONTENT_SECTION_IDS.includes(anchor as (typeof CONTENT_SECTION_IDS)[number])) {
      setCollapsed((prev) => {
        if (!prev.has(anchor)) return prev;
        const next = new Set(prev);
        next.delete(anchor);
        return next;
      });
    }
    // Expand first; scroll after the panel has rendered.
    requestAnimationFrame(() =>
      document.getElementById(anchor)?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
    );
  };

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <ReportReadiness
        result={readiness}
        disabled={!canToggleReadinessNa}
        onJump={jump}
        onToggleNa={onToggleReadinessNa}
        findingsHref={`/engagements/${slug}/findings`}
      />
      <FindingsNeedingAttention slug={slug} result={findingWarnings} />
      <Card className="space-y-4 p-4 lg:col-span-2">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-text">Report details</h3>
            <p className="mt-1 text-xs text-muted">
              Metadata for the exported report PDF. Leave a field blank to omit it.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {detailsIncomplete && <Badge tone="warning">Incomplete</Badge>}
            {!disabled && <SaveStatusIndicator status={status} />}
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Client / organization name" htmlFor="r-client">
            <Input
              id="r-client"
              value={form.clientName}
              onChange={(e) => patchForm('clientName', e.target.value)}
              onBlur={() => void flush()}
              disabled={disabled}
              title={disabledTitle}
            />
          </Field>
          <Field
            label="Assessment type"
            htmlFor="r-type"
            hint="e.g. External Penetration Assessment"
          >
            <Input
              id="r-type"
              value={form.assessmentType}
              onChange={(e) => patchForm('assessmentType', e.target.value)}
              onBlur={() => void flush()}
              disabled={disabled}
              title={disabledTitle}
            />
          </Field>
        </div>
        <Field label="Location / environment" htmlFor="r-location">
          <Input
            id="r-location"
            value={form.location}
            onChange={(e) => patchForm('location', e.target.value)}
            onBlur={() => void flush()}
            disabled={disabled}
            title={disabledTitle}
          />
        </Field>
        <Field label="Executive summary" htmlFor="r-exec">
          <MarkdownField
            id="r-exec"
            rows={5}
            value={form.executiveSummary}
            onChange={(v) => patchForm('executiveSummary', v)}
            onBlur={() => void flush()}
            disabled={disabled}
            title={disabledTitle}
          />
        </Field>
        <Field label="Methodology" htmlFor="r-method">
          <MarkdownField
            id="r-method"
            rows={5}
            value={form.methodology}
            onChange={(v) => patchForm('methodology', v)}
            onBlur={() => void flush()}
            disabled={disabled}
            title={disabledTitle}
          />
        </Field>

        <div className="border-t border-border pt-4">
          <p className="text-sm font-medium text-text">Watermark</p>
          <p className="mt-1 text-xs text-muted">
            Drawn diagonally across every page of the exported report PDF except the title page.
          </p>
        </div>
        <Checkbox
          label="Show a watermark on the exported report"
          checked={form.wmEnabled}
          disabled={disabled}
          onChange={(e) => patchForm('wmEnabled', e.target.checked)}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Watermark text"
            htmlFor="wm-text"
            hint={`Defaults to CONFIDENTIAL. Up to ${WATERMARK_MAX_CHARS} characters.`}
          >
            <Input
              id="wm-text"
              value={form.wmText}
              placeholder="CONFIDENTIAL"
              maxLength={WATERMARK_MAX_CHARS}
              onChange={(e) => patchForm('wmText', e.target.value)}
              onBlur={() => void flush()}
              disabled={disabled || !form.wmEnabled}
              title={disabledTitle}
            />
          </Field>
          <Field
            label="Color"
            htmlFor="wm-color"
            error={
              !disabled && form.wmEnabled && colorInvalid ? 'Use a #rrggbb hex color.' : undefined
            }
          >
            <div className="flex items-center gap-2">
              <input
                type="color"
                id="wm-color"
                aria-label="Watermark color"
                value={colorInvalid ? '#64748b' : form.wmColor}
                onChange={(e) => patchForm('wmColor', e.target.value)}
                onBlur={() => void flush()}
                disabled={disabled || !form.wmEnabled}
                className="h-9 w-12 shrink-0 rounded-input border border-border bg-surface disabled:opacity-50"
              />
              <Input
                value={form.wmColor}
                onChange={(e) => patchForm('wmColor', e.target.value)}
                onBlur={() => void flush()}
                invalid={!disabled && form.wmEnabled && colorInvalid}
                disabled={disabled || !form.wmEnabled}
                title={disabledTitle}
                className="font-mono"
                aria-label="Watermark color hex"
              />
            </div>
          </Field>
          <Field label="Transparency" htmlFor="wm-opacity">
            <Select
              id="wm-opacity"
              value={form.wmOpacity}
              onChange={(e) => patchForm('wmOpacity', e.target.value as WatermarkOpacity)}
              disabled={disabled || !form.wmEnabled}
              title={disabledTitle}
            >
              {WATERMARK_OPACITIES.map((o) => (
                <option key={o} value={o}>
                  {WATERMARK_OPACITY_LABELS[o]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Placement" htmlFor="wm-layer">
            <Select
              id="wm-layer"
              value={form.wmLayer}
              onChange={(e) => patchForm('wmLayer', e.target.value as WatermarkLayer)}
              disabled={disabled || !form.wmEnabled}
              title={disabledTitle}
            >
              {WATERMARK_LAYERS.map((l) => (
                <option key={l} value={l}>
                  {WATERMARK_LAYER_LABELS[l]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </Card>

      <div className="flex items-center justify-between gap-2 lg:col-span-2">
        <p className="text-sm font-medium text-text">Report sections</p>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(CONTENT_SECTION_IDS))}
        >
          {allCollapsed ? 'Expand all' : 'Collapse all'}
        </Button>
      </div>

      <SectionCollapseContext.Provider value={{ collapsed, toggle: toggleSection }}>
        <ReportContentEditors
          slug={slug}
          disabled={disabled}
          disabledTitle={disabledTitle}
          onFlush={() => void flush()}
          scope={form.scope}
          onScope={(v) => patchForm('scope', v)}
          scopeTargets={form.scopeTargets}
          onScopeTargets={(v) => patchForm('scopeTargets', v)}
          scopeExclusions={form.scopeExclusions}
          onScopeExclusions={(v) => patchForm('scopeExclusions', v)}
          recommendations={form.recommendations}
          onRecommendations={(v) => patchForm('recommendations', v)}
          threatModelNarrative={form.threatModelNarrative}
          onThreatModelNarrative={(v) => patchForm('threatModelNarrative', v)}
          threatModelDiagrams={form.threatModelDiagrams}
          onThreatModelDiagrams={(v) => patchForm('threatModelDiagrams', v)}
          executionNarrative={form.executionNarrative}
          onExecutionNarrative={(v) => patchForm('executionNarrative', v)}
          providerContacts={form.providerContacts}
          onProviderContacts={(v) => patchForm('providerContacts', v)}
          clientContacts={form.clientContacts}
          onClientContacts={(v) => patchForm('clientContacts', v)}
          softwareTested={form.softwareTested}
          onSoftwareTested={(v) => patchForm('softwareTested', v)}
          thirdPartySoftware={form.thirdPartySoftware}
          onThirdPartySoftware={(v) => patchForm('thirdPartySoftware', v)}
          findings={findings}
          sectionStatus={sectionStatus}
          seeded={baseline !== undefined}
        />
      </SectionCollapseContext.Provider>
    </div>
  );
}
