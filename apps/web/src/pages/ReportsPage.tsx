import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { restrictToParentElement, restrictToVerticalAxis } from '@dnd-kit/modifiers';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  ErrorState,
  Field,
  Input,
  MarkdownField,
  Select,
  Spinner,
  Tabs,
  useConfirm,
  useToast,
} from '@reporter/ui';
import {
  ATTESTATION_FRAMEWORKS,
  ATTESTATION_FRAMEWORK_LABELS,
  DEFAULT_REPORT_SECTIONS,
  FINDING_GROUPINGS,
  FINDING_GROUPING_LABELS,
  MAX_REPORT_CUSTOM_SECTIONS,
  REPORT_SECTION_HINTS,
  REPORT_SECTION_ITEMS,
  REPORT_SECTION_LABELS,
  REPORT_SECTION_SAMPLE,
  SEVERITIES,
  SEVERITY_LABELS,
  reportConfigSchema,
  type AttestationFramework,
  type Contact,
  type FindingGrouping,
  type GeneratedReport,
  type ReportConfig,
  type ReportCustomSection,
  type ReportSection,
  type ReportSectionEntry,
  type ReportSectionItem,
} from '@reporter/shared';
import {
  reportHistoryKey,
  useEngagement,
  useFindings,
  useReportHistory,
  useReportTemplates,
  useUpdateEngagement,
} from '../api/hooks.js';
import { useEngagementPermissions } from '../lib/permissions.js';
import { useAutosave } from '../hooks/useAutosave.js';
import { computeFindingWarnings, computeReadiness } from '../lib/report-readiness.js';
import { SaveStatusIndicator } from '../components/SaveStatusIndicator.js';
import { ReportContentForm } from '../components/engagement/ReportContentForm.js';
import { SectionPreview } from '../components/engagement/SectionPreview.js';
import {
  DEFAULT_GENERATE_TARGET,
  ReportTargetField,
  ReportTemplateControls,
  type GenerateTarget,
} from '../components/engagement/ReportTemplateControls.js';
import { customIdOf, customSectionKey, sectionLabel } from '../lib/report-sections.js';
import { templateSanitizeWarning } from '../lib/report-templates.js';
import { downloadFile } from '../lib/download.js';
import { EXCLUDED_FROM_REPORT_LABEL } from '../components/evidence/ExcludedFromReportBadge.js';

/** The Reports tab's sub-sections, persisted in the `?section=` search param. */
const SECTIONS = ['content', 'configure', 'generate', 'attestation'] as const;
type Section = (typeof SECTIONS)[number];

const SECTION_TABS: { key: Section; label: string }[] = [
  { key: 'content', label: 'Content' },
  { key: 'configure', label: 'Configure' },
  { key: 'generate', label: 'Generate & History' },
  { key: 'attestation', label: 'Attestation' },
];

/** Humanize a byte count for the report-history size hint (null → ''). */
function fmtBytes(bytes: number | null): string {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** Stable id for a custom section not yet given a real id. */
function makeCustomId(): string {
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Human label + hint for a section entry (built-in or custom). */
function sectionMeta(
  entry: ReportSectionEntry,
  customSections: ReportCustomSection[],
): { label: string; hint: string; missing: boolean } {
  const label = sectionLabel(entry.key, customSections);
  const cid = customIdOf(entry.key);
  if (cid !== null) {
    return {
      label,
      hint: 'A free-text section you authored below.',
      // A `custom:` entry whose section has been deleted: still listed, flagged.
      missing: !customSections.some((c) => c.id === cid),
    };
  }
  const key = entry.key as ReportSection;
  return {
    label,
    hint: REPORT_SECTION_HINTS[key] ?? '',
    missing: !(entry.key in REPORT_SECTION_LABELS),
  };
}

export function ReportsPage() {
  const { slug = '' } = useParams();
  const toast = useToast();
  // The report config is persisted via the engagement update endpoint, which is
  // admin-gated — so gate these controls on the engagement-admin role. `canWrite`
  // gates the Content sub-tab's editors (report metadata + structured content).
  const { canAdmin: canEdit, canWrite } = useEngagementPermissions(slug);
  const { data: eng, isLoading, isError, refetch } = useEngagement(slug);

  // The active sub-tab lives in the URL so refresh / deep-links land correctly.
  const [searchParams, setSearchParams] = useSearchParams();
  const sectionParam = searchParams.get('section');
  const section: Section = SECTIONS.includes(sectionParam as Section)
    ? (sectionParam as Section)
    : 'content';
  const setSection = (next: Section) => {
    setSearchParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        p.set('section', next);
        return p;
      },
      { replace: true },
    );
  };

  // Seed the config form once per engagement (normalizing an empty config to the
  // canonical default), then autosave edits back through useUpdateEngagement.
  const seededSlug = useRef<string | null>(null);
  const [config, setConfig] = useState<ReportConfig>(() => reportConfigSchema.parse({}));
  const [baseline, setBaseline] = useState<ReportConfig | undefined>(undefined);
  useEffect(() => {
    if (eng && seededSlug.current !== eng.slug) {
      seededSlug.current = eng.slug;
      const seeded = reportConfigSchema.parse(eng.reportConfig ?? {});
      setConfig(seeded);
      setBaseline(seeded);
    }
  }, [eng]);

  const update = useUpdateEngagement(slug);
  const { status, flush } = useAutosave<ReportConfig>({
    value: config,
    baseline,
    isValid: () => canEdit,
    save: async (v) => {
      await update.mutateAsync({ reportConfig: v });
      setBaseline(v);
    },
  });

  // Report-readiness N/A overrides live in reportConfig, so the Configure tab owns
  // them (single writer) and the Content tab's checklist toggles through here.
  const toggleReadinessNa = (key: string, na: boolean) =>
    setConfig((c) => ({
      ...c,
      readinessNa: na
        ? [...new Set([...c.readinessNa, key])]
        : c.readinessNa.filter((k) => k !== key),
    }));

  const confirm = useConfirm();
  const { data: findings = [] } = useFindings(slug);
  const readyFindingCount = findings.filter((f) => f.readyToReport).length;
  // Readiness for the Generate gate, from the SAVED engagement (what will render).
  const readiness = useMemo(
    () =>
      computeReadiness(
        {
          clientName: eng?.clientName ?? '',
          assessmentType: eng?.assessmentType ?? '',
          location: eng?.location ?? '',
          scope: eng?.scope ?? '',
          executiveSummary: eng?.executiveSummary ?? '',
          methodology: eng?.methodology ?? '',
          watermarkEnabled: eng?.watermarkEnabled ?? true,
          scopeTargets: eng?.scopeTargets ?? [],
          recommendations: eng?.strategicRecommendations ?? [],
          threatModelNarrative: eng?.threatModelNarrative ?? '',
          threatModelDiagrams: eng?.threatModelDiagrams ?? [],
          executionNarrative: eng?.executionNarrative ?? [],
          providerContacts: eng?.providerContacts ?? [],
          clientContacts: eng?.clientContacts ?? [],
          thirdPartySoftware: eng?.thirdPartySoftware ?? [],
          readyFindingCount,
        },
        config.readinessNa,
      ),
    [eng, config.readinessNa, readyFindingCount],
  );
  // Findings the report will render incomplete. Advisory like readiness, and from
  // the same already-fetched list, but a separate axis: readiness is about the
  // engagement's report *content*, this is about the findings themselves.
  const findingWarnings = useMemo(() => computeFindingWarnings(findings), [findings]);

  // Live section preview (Configure tab): which section, and a token that bumps to
  // reload the iframe after content/config autosaves land (eng refetches).
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [previewToken, setPreviewToken] = useState(0);
  useEffect(() => {
    // Default the preview to the first enabled section once the config is seeded.
    if (previewKey === null) {
      const first = config.sections.find((s) => s.enabled);
      if (first) setPreviewKey(first.key);
    }
  }, [config.sections, previewKey]);
  useEffect(() => {
    // React-query structural sharing keeps `eng` stable unless it actually changed,
    // so this bumps only when a save (content or config) lands.
    setPreviewToken((t) => t + 1);
  }, [eng]);

  const qc = useQueryClient();
  const { data: history = [] } = useReportHistory(slug);
  const hasHistory = history.length > 0;
  // Only PDF/ZIP documents can be attested to; a JSON export is a data dump, not
  // a deliverable, so it must never be the attestation letter's default target.
  const attestableReports = useMemo(() => history.filter((r) => r.format !== 'json'), [history]);

  const [busy, setBusy] = useState<'pdf' | 'zip' | 'json' | 'backup' | 'attestation' | null>(null);
  // A history row currently re-downloading its stored artifact (by uuid).
  const [downloadingUuid, setDownloadingUuid] = useState<string | null>(null);
  // Report history collapses to the most recent few until expanded.
  const [showAllHistory, setShowAllHistory] = useState(false);
  // What Generate renders: a built-in preset (`custom` = this engagement's
  // configured sections, the others canned subsets) or a saved report template.
  // Drives the exported filename (`<slug>-<type|template>-<time>.<ext>`).
  const [target, setTarget] = useState<GenerateTarget>(DEFAULT_GENERATE_TARGET);
  // The template library is global; the Configure tab's controls read the same
  // cache entry. Only the chooser and the warnings below need it here.
  const {
    data: templates = [],
    isLoading: templatesLoading,
    isError: templatesError,
    refetch: refetchTemplates,
  } = useReportTemplates();
  const selectedTemplate =
    target.kind === 'template' ? templates.find((t) => t.uuid === target.uuid) : undefined;
  // Clamp to a target that still exists: someone else may have deleted the chosen
  // template between the pick and the click (same reason `effSignatoryIdx` clamps).
  const effTarget: GenerateTarget =
    target.kind === 'template' && !selectedTemplate ? DEFAULT_GENERATE_TARGET : target;
  // A template that would un-sanitize this engagement's report. Computed against
  // the live config, so it says what this run would reveal that the Configure tab
  // currently hides — the same comparison the Apply confirm makes.
  const targetSanitizeWarning = selectedTemplate
    ? templateSanitizeWarning(config, selectedTemplate.config)
    : null;

  async function generate(format: 'pdf' | 'zip' | 'json') {
    // Flush any pending config edit so the report reflects the latest options.
    await flush();
    // Two soft gates — missing report content, and ready findings that will render
    // incomplete. Both warn and neither blocks, and they're raised in one prompt so
    // the author is never asked to confirm the same click twice.
    const problems: string[] = [];
    if (!readiness.ready) {
      const remaining = readiness.total - readiness.satisfiedCount;
      problems.push(
        `${remaining} required item${remaining === 1 ? '' : 's'} still incomplete on the Content tab.`,
      );
    }
    if (findingWarnings.findingCount > 0) {
      problems.push(
        `${findingWarnings.findingCount} finding${findingWarnings.findingCount === 1 ? '' : 's'} marked “Ready to report” will render incomplete.`,
      );
    }
    // A third gate, and a different kind: generating with a template that turns a
    // sanitize option on puts evidence capture times and/or operator names into a
    // client deliverable. It rides in the same prompt (one confirm per click) but as
    // its own warning-toned line, never folded into the soft-gate sentence above.
    if (problems.length > 0 || targetSanitizeWarning) {
      const ok = await confirm({
        title: targetSanitizeWarning
          ? 'This template shows evidence details'
          : readiness.ready
            ? 'Some findings will render incomplete'
            : 'Report not marked ready',
        message: (
          <span className="block space-y-2">
            {targetSanitizeWarning && (
              <span className="block text-warning">{targetSanitizeWarning}</span>
            )}
            <span className="block">
              {problems.length > 0 ? `${problems.join(' ')} ` : ''}Generate anyway?
            </span>
          </span>
        ),
        confirmLabel: 'Generate anyway',
      });
      if (!ok) return;
    }
    setBusy(format);
    try {
      // A template is a complete configuration, so it replaces `preset` rather than
      // combining with it, and it is used for this run only — nothing is written
      // back to the engagement's own report configuration.
      const params = new URLSearchParams(
        effTarget.kind === 'template'
          ? { templateUuid: effTarget.uuid }
          : { preset: effTarget.preset },
      );
      const url = `/web/engagements/${slug}/report.${format}?${params.toString()}`;
      // The server sets the authoritative filename (the report type or the
      // template's name, plus a timestamp); this is only a fallback if the
      // Content-Disposition header is missing.
      const fallbackName =
        effTarget.kind === 'template'
          ? `${slug}-report.${format}`
          : `${slug}-${effTarget.preset}-report.${format}`;
      await downloadFile(url, fallbackName);
      // Every generation (PDF, ZIP, and JSON) is logged server-side with its
      // stored bytes; refresh history so the new entry and its Download button
      // appear. PDF/ZIP entries also unlock the attestation letter.
      qc.invalidateQueries({ queryKey: reportHistoryKey(slug) });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setBusy(null);
    }
  }

  // --- Backup export (JSON) ------------------------------------------------
  // A data dump for backups and moving findings between servers — a different
  // thing from the "Export JSON" deliverable above, so it has its own route
  // (`/findings/export.json`, not recorded in report history) and its own button.
  // Every finding and embedded evidence content are implied: without them an
  // import can't recreate the evidence, so they aren't offered as choices.
  // Report-excluded evidence is the one decision, and it is off by default — it
  // leaves the server only when explicitly asked for.
  const [includeExcludedEvidence, setIncludeExcludedEvidence] = useState(false);

  async function downloadBackup() {
    setBusy('backup');
    try {
      const params = new URLSearchParams({
        includeAll: 'true',
        includeEvidenceContent: 'true',
        includeExcludedEvidence: String(includeExcludedEvidence),
      });
      const url = `/web/engagements/${slug}/findings/export.json?${params}`;
      await downloadFile(url, `${slug}-backup.json`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setBusy(null);
    }
  }

  // Re-download a stored report artifact by its history-row uuid. The server may
  // 404 for rows generated before artifact storage (guarded by `downloadable`).
  async function downloadStored(r: GeneratedReport) {
    setDownloadingUuid(r.uuid);
    try {
      const url = `/web/engagements/${slug}/reports/${r.uuid}/download`;
      await downloadFile(url, `${slug}-${r.version}.${r.format}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Download failed');
    } finally {
      setDownloadingUuid(null);
    }
  }

  // --- Attestation letter (only available once a report exists) ------------
  const providerContacts = useMemo<Contact[]>(
    () => (eng?.providerContacts ?? []).filter((c) => c.name.trim()),
    [eng],
  );
  const [attReportUuid, setAttReportUuid] = useState<string>('');
  const [framework, setFramework] = useState<AttestationFramework>('soc2');
  const [frameworkLabel, setFrameworkLabel] = useState<string>('');
  const [signatoryIdx, setSignatoryIdx] = useState<string>('0');
  // Clamp to the current list so a shrinking/refetched providerContacts can't
  // leave the <Select> pointing at a non-existent option (which would silently
  // drop the chosen signatory on download).
  const effSignatoryIdx = providerContacts.length
    ? Math.min(Math.max(Number(signatoryIdx) || 0, 0), providerContacts.length - 1)
    : 0;
  // '' means "use the report snapshot's own overall-risk rating".
  const [overallRisk, setOverallRisk] = useState<string>('');

  // "Attn:" recipient + "Dear" salutation, prefilled from the engagement's first
  // client contact. Seeded once per engagement so an in-progress edit isn't
  // clobbered when the cached `eng` object is replaced by unrelated mutations.
  const [recipientName, setRecipientName] = useState<string>('');
  const [recipientTitle, setRecipientTitle] = useState<string>('');
  const [salutationName, setSalutationName] = useState<string>('');
  // Scope exclusions are omitted from the letter unless explicitly opted in.
  const [showExclusions, setShowExclusions] = useState<boolean>(false);
  const attSeededSlug = useRef<string | null>(null);
  useEffect(() => {
    if (!eng || attSeededSlug.current === eng.slug) return;
    attSeededSlug.current = eng.slug;
    const firstClient = eng.clientContacts?.[0];
    const name = firstClient?.name ?? '';
    setRecipientName(name);
    setRecipientTitle(firstClient?.title ?? '');
    setSalutationName(name);
  }, [eng]);

  // The report the letter attests to (the picked one, else the latest PDF/ZIP).
  const selectedReport: GeneratedReport | undefined =
    attestableReports.find((r) => r.uuid === attReportUuid) ?? attestableReports[0];

  async function downloadAttestation() {
    if (!selectedReport) return;
    setBusy('attestation');
    try {
      const params = new URLSearchParams({ framework, reportUuid: selectedReport.uuid });
      if (framework === 'custom' && frameworkLabel.trim())
        params.set('frameworkLabel', frameworkLabel.trim());
      const contact = providerContacts[effSignatoryIdx];
      if (contact) {
        params.set('signatoryName', contact.name);
        if (contact.title.trim()) params.set('signatoryTitle', contact.title);
        if (contact.email.trim()) params.set('signatoryEmail', contact.email);
      }
      if (overallRisk) params.set('overallRisk', overallRisk);
      // "Attn:" recipient + optional "Dear" greeting.
      if (recipientName.trim()) params.set('recipientName', recipientName.trim());
      if (recipientTitle.trim()) params.set('recipientTitle', recipientTitle.trim());
      if (salutationName.trim()) params.set('salutationName', salutationName.trim());
      if (showExclusions) params.set('showExclusions', 'true');
      const url = `/web/engagements/${slug}/attestation-letter.pdf?${params.toString()}`;
      await downloadFile(url, `${slug}-attestation-letter.pdf`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Attestation letter failed');
    } finally {
      setBusy(null);
    }
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const keys = config.sections.map((s) => s.key);
    const from = keys.indexOf(String(active.id));
    const to = keys.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    setConfig((c) => ({ ...c, sections: arrayMove(c.sections, from, to) }));
  }

  function toggleSection(key: string, enabled: boolean) {
    setConfig((c) => ({
      ...c,
      sections: c.sections.map((s) => (s.key === key ? { ...s, enabled } : s)),
    }));
  }

  // Which section rows are expanded to show their sample + sub-item toggles.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const toggleExpand = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    // Interacting with a section also targets it for the live preview.
    setPreviewKey(key);
  };

  function setSectionOption(key: string, itemKey: string, value: boolean) {
    setConfig((c) => ({
      ...c,
      sections: c.sections.map((s) =>
        s.key === key ? { ...s, options: { ...(s.options ?? {}), [itemKey]: value } } : s,
      ),
    }));
  }

  function resetSections() {
    setConfig((c) => {
      // Keep any custom sections at the end; reset built-ins to the default order.
      const customEntries = c.sections.filter((s) => customIdOf(s.key));
      return { ...c, sections: [...DEFAULT_REPORT_SECTIONS, ...customEntries] };
    });
  }

  // Custom sections
  function addCustomSection() {
    const id = makeCustomId();
    setConfig((c) => ({
      ...c,
      customSections: [...c.customSections, { id, title: 'New section', body: '' }],
      sections: [...c.sections, { key: customSectionKey(id), enabled: true }],
    }));
  }

  function updateCustomSection(id: string, patch: Partial<ReportCustomSection>) {
    setConfig((c) => ({
      ...c,
      customSections: c.customSections.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    }));
  }

  function removeCustomSection(id: string) {
    setConfig((c) => ({
      ...c,
      customSections: c.customSections.filter((s) => s.id !== id),
      sections: c.sections.filter((s) => customIdOf(s.key) !== id),
    }));
  }

  /**
   * Adopt a report template's configuration (already merged with this engagement's
   * by `ReportTemplateControls`, which also owns the confirm). Writing it to the
   * form is all that's needed — the autosave above persists it like any other edit.
   */
  function applyTemplateConfig(next: ReportConfig) {
    setConfig(next);
    // The preview may have been pointing at a section the template leaves out, so
    // re-aim it at the first section the applied configuration actually renders.
    setPreviewKey(next.sections.find((s) => s.enabled)?.key ?? null);
  }

  const busyAny = busy !== null;
  const readOnly = !canEdit;

  const orderedKeys = useMemo(() => config.sections.map((s) => s.key), [config.sections]);

  // Human label for the section currently shown in the live preview panel.
  const previewLabel = previewKey
    ? sectionMeta({ key: previewKey, enabled: true }, config.customSections).label
    : '';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold text-text">Reports</h2>
          <p className="text-sm text-muted">
            Author the report’s content, choose which sections appear, then generate and download
            the report.
          </p>
        </div>
        {canEdit && section === 'configure' && <SaveStatusIndicator status={status} />}
      </div>

      <Tabs tabs={SECTION_TABS} active={section} onChange={(key) => setSection(key as Section)} />

      {isLoading ? (
        <Spinner />
      ) : isError || !eng ? (
        <ErrorState description="Couldn’t load this engagement." onRetry={() => refetch()} />
      ) : (
        <>
          {/* Kept mounted (hidden when inactive) so switching sub-tabs never
              unmounts the content editor — its local form state and any pending
              autosave must survive a tab switch, exactly as the Configure tab's
              state does (it lives on this page, which stays mounted). Unmounting
              it mid-save could reseed a fresh instance from stale cache. */}
          <div className={section === 'content' ? undefined : 'hidden'}>
            <ReportContentForm
              slug={slug}
              engagement={eng}
              canWrite={canWrite}
              readinessNa={config.readinessNa}
              onToggleReadinessNa={toggleReadinessNa}
              canToggleReadinessNa={canEdit}
            />
          </div>
          {section === 'configure' ? (
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(360px,560px)]">
              <div className="space-y-4">
                {/* Section list */}
                <Card className="space-y-3 p-4">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold text-text">Sections</h3>
                    <Button size="sm" variant="ghost" onClick={resetSections} disabled={readOnly}>
                      Reset order
                    </Button>
                  </div>
                  <DndContext
                    sensors={sensors}
                    collisionDetection={closestCenter}
                    modifiers={[restrictToVerticalAxis, restrictToParentElement]}
                    onDragEnd={onDragEnd}
                  >
                    <SortableContext items={orderedKeys} strategy={verticalListSortingStrategy}>
                      <ul className="flex flex-col gap-2">
                        {config.sections.map((entry) => {
                          const meta = sectionMeta(entry, config.customSections);
                          const isCustom = customIdOf(entry.key) !== null;
                          const isBuiltin = !isCustom && !meta.missing;
                          const rk = entry.key as ReportSection;
                          const sample = isBuiltin
                            ? REPORT_SECTION_SAMPLE[rk]
                            : isCustom
                              ? 'A free-text section you authored below.'
                              : undefined;
                          const items = isBuiltin ? REPORT_SECTION_ITEMS[rk] : undefined;
                          return (
                            <SortableSectionRow
                              key={entry.key}
                              id={entry.key}
                              label={meta.label}
                              hint={meta.hint}
                              missing={meta.missing}
                              enabled={entry.enabled}
                              canEdit={canEdit}
                              selected={entry.key === previewKey}
                              onToggle={(v) => toggleSection(entry.key, v)}
                              expanded={expanded.has(entry.key)}
                              onToggleExpand={() => toggleExpand(entry.key)}
                              sample={sample}
                              items={items}
                              options={entry.options}
                              onToggleOption={(itemKey, v) =>
                                setSectionOption(entry.key, itemKey, v)
                              }
                              extra={
                                entry.key === 'assessmentExecution' ? (
                                  <SanitizeControl
                                    showTimestamps={config.showEvidenceTimestamps}
                                    showOperators={config.showEvidenceOperators}
                                    canEdit={canEdit}
                                    onChange={(patch) => setConfig((c) => ({ ...c, ...patch }))}
                                  />
                                ) : undefined
                              }
                            />
                          );
                        })}
                      </ul>
                    </SortableContext>
                  </DndContext>
                </Card>

                {/* Report templates — save this configuration under a name, or
                    replace it with a saved one. Sits with the Sections panel
                    because that panel is most of what a template carries. */}
                <ReportTemplateControls
                  config={config}
                  canSave={canWrite}
                  canApply={canEdit}
                  onApply={applyTemplateConfig}
                  onFlush={flush}
                />

                {/* Custom sections editor */}
                <Card className="space-y-3 p-4">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <h3 className="text-sm font-semibold text-text">Custom sections</h3>
                      <p className="mt-0.5 text-xs text-muted">
                        Free-text sections inserted into the report flow. Each appears in the list
                        above as an enable/reorder entry.
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={addCustomSection}
                      disabled={
                        readOnly || config.customSections.length >= MAX_REPORT_CUSTOM_SECTIONS
                      }
                    >
                      Add section
                    </Button>
                  </div>
                  {config.customSections.length === 0 ? (
                    <p className="text-sm text-muted">No custom sections yet.</p>
                  ) : (
                    <div className="space-y-3">
                      {config.customSections.map((s) => (
                        <div
                          key={s.id}
                          className="rounded-card border border-border bg-surface-2 p-3"
                        >
                          <div className="flex items-start gap-2">
                            <div className="flex-1 space-y-2">
                              <Field label="Title" htmlFor={`cs-title-${s.id}`}>
                                <Input
                                  id={`cs-title-${s.id}`}
                                  value={s.title}
                                  onChange={(e) =>
                                    updateCustomSection(s.id, { title: e.target.value })
                                  }
                                  onBlur={() => void flush()}
                                  disabled={readOnly}
                                />
                              </Field>
                              <Field label="Body" htmlFor={`cs-body-${s.id}`}>
                                <MarkdownField
                                  id={`cs-body-${s.id}`}
                                  rows={4}
                                  value={s.body}
                                  onChange={(v) => updateCustomSection(s.id, { body: v })}
                                  onBlur={() => void flush()}
                                  disabled={readOnly}
                                />
                              </Field>
                            </div>
                            {canEdit && (
                              <button
                                type="button"
                                onClick={() => removeCustomSection(s.id)}
                                aria-label={`Remove section ${s.title}`}
                                title="Remove section"
                                className="px-1 text-muted hover:text-danger"
                              >
                                ✕
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </Card>
                {/* Report options */}
                <Card className="space-y-3 p-4">
                  <h3 className="text-sm font-semibold text-text">Options</h3>
                  <Field
                    label="Findings grouping"
                    htmlFor="rp-finding-group"
                    hint="How findings are ordered/grouped in the report."
                  >
                    <Select
                      id="rp-finding-group"
                      value={config.findingGroup}
                      onChange={(e) =>
                        setConfig((c) => ({
                          ...c,
                          findingGroup: e.target.value as FindingGrouping,
                        }))
                      }
                      disabled={readOnly}
                    >
                      {FINDING_GROUPINGS.map((g) => (
                        <option key={g} value={g}>
                          {FINDING_GROUPING_LABELS[g]}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <p className="text-xs text-muted">
                    Reports include only “Ready to report” findings. The Assessment Execution
                    timeline is built from the timeline subsections you add on the Content tab.
                  </p>
                </Card>
              </div>

              {/* Live section preview */}
              <div>
                <SectionPreview
                  slug={slug}
                  sectionKey={previewKey}
                  sectionLabel={previewLabel}
                  refreshToken={previewToken}
                  onRefresh={() => setPreviewToken((t) => t + 1)}
                />
              </div>
            </div>
          ) : section === 'generate' ? (
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="space-y-4">
                <Card className="space-y-3 p-4">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold text-text">Generate</h3>
                    {readiness.ready ? (
                      <Badge tone="success">Ready to report</Badge>
                    ) : (
                      <Badge tone="warning">
                        Not ready — {readiness.total - readiness.satisfiedCount} left
                      </Badge>
                    )}
                  </div>
                  {!readiness.ready && (
                    <p className="rounded-input border border-warning/30 bg-warning/5 px-2.5 py-1.5 text-xs text-muted">
                      Some required content is incomplete. Finish it on the{' '}
                      <button
                        type="button"
                        className="text-accent hover:underline"
                        onClick={() => setSection('content')}
                      >
                        Content tab
                      </button>{' '}
                      — you can still generate, but you’ll be asked to confirm.
                    </p>
                  )}
                  {findingWarnings.findingCount > 0 && (
                    <p className="rounded-input border border-warning/30 bg-warning/5 px-2.5 py-1.5 text-xs text-muted">
                      {findingWarnings.findingCount} finding
                      {findingWarnings.findingCount === 1 ? '' : 's'} marked “Ready to report” will
                      render incomplete. See “Findings needing attention” on the{' '}
                      <button
                        type="button"
                        className="text-accent hover:underline"
                        onClick={() => setSection('content')}
                      >
                        Content tab
                      </button>
                      .
                    </p>
                  )}
                  <ReportTargetField
                    target={effTarget}
                    onChange={setTarget}
                    templates={templates}
                    isLoading={templatesLoading}
                    isError={templatesError}
                    onRetry={() => void refetchTemplates()}
                    config={config}
                    onConfigure={() => setSection('configure')}
                  />
                  <p className="text-xs text-muted">
                    The ZIP bundle wraps the PDF with its supporting files; JSON exports the
                    report-ready findings and can be re-imported later. The file is named for the
                    report type — or the report template — and the moment it was generated.
                  </p>
                  <div className="flex flex-col gap-2">
                    <Button
                      onClick={() => generate('pdf')}
                      loading={busy === 'pdf'}
                      disabled={busyAny}
                    >
                      Generate PDF
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => generate('zip')}
                      loading={busy === 'zip'}
                      disabled={busyAny}
                    >
                      Generate ZIP bundle
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => generate('json')}
                      loading={busy === 'json'}
                      disabled={busyAny}
                    >
                      Export JSON
                    </Button>
                  </div>
                </Card>

                {/* Backup export — deliberately separate from the deliverables
                    above: a different route, a different file, and the only
                    output that can carry report-excluded evidence. */}
                <Card className="space-y-3 p-4">
                  <h3 className="text-sm font-semibold text-text">Backup export</h3>
                  <p className="text-xs text-muted">
                    A JSON export of every finding — not just the report-ready ones — with its
                    linked evidence and that evidence&rsquo;s content embedded, so another reporter
                    server can recreate the findings with{' '}
                    <strong className="font-medium text-text">Import</strong>. Findings only: goals,
                    tags, report content and evidence that isn&rsquo;t linked to a finding stay
                    behind. Not a client deliverable, and not recorded in report history.
                  </p>
                  <Checkbox
                    label={`Include evidence marked “${EXCLUDED_FROM_REPORT_LABEL}”`}
                    checked={includeExcludedEvidence}
                    onChange={(e) => setIncludeExcludedEvidence(e.target.checked)}
                  />
                  <p className="pl-6 text-xs text-muted">
                    For backups and transfers between servers. Excluded evidence is normally left
                    out of every export; included here, it stays excluded after an import.
                  </p>
                  <Button
                    variant="secondary"
                    onClick={downloadBackup}
                    loading={busy === 'backup'}
                    disabled={busyAny}
                  >
                    Download backup JSON
                  </Button>
                </Card>
              </div>

              {/* Report history */}
              <div className="space-y-4">
                <Card className="space-y-3 p-4">
                  <h3 className="text-sm font-semibold text-text">Report history</h3>
                  {/* Stored artifacts are the record of what was handed over, so they
                      are never rewritten — excluding evidence now can't redact a
                      download taken before it. Said out loud here because the
                      alternative is an operator assuming the flag reached backwards. */}
                  <p className="text-xs text-muted">
                    Each entry keeps the exact bytes that were downloaded, with the exclusions that
                    were in force at the time. Generate again after changing what the report shows.
                  </p>
                  {hasHistory ? (
                    <ul className="space-y-2">
                      {(showAllHistory ? history : history.slice(0, 8)).map((r) => {
                        const sizeLabel = fmtBytes(r.sizeBytes);
                        const downloading = downloadingUuid === r.uuid;
                        return (
                          <li
                            key={r.uuid}
                            className="rounded-input border border-border p-2 text-xs text-muted"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="min-w-0 truncate font-medium text-text">
                                {r.version} · {r.label}
                              </span>
                              <span className="flex shrink-0 items-center gap-1.5">
                                <Badge>{r.format.toUpperCase()}</Badge>
                                {sizeLabel && <span className="text-muted">{sizeLabel}</span>}
                              </span>
                            </div>
                            <div className="mt-1">
                              {fmtDateTime(r.createdAt)}
                              {r.generatedBy ? ` · ${r.generatedBy}` : ''}
                            </div>
                            <div className="mt-0.5">{summaryLine(r.summary)}</div>
                            <div className="mt-1.5">
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => downloadStored(r)}
                                loading={downloading}
                                disabled={
                                  !r.downloadable || (downloadingUuid !== null && !downloading)
                                }
                                title={
                                  r.downloadable
                                    ? undefined
                                    : 'Generated before downloads were stored'
                                }
                              >
                                Download
                              </Button>
                            </div>
                          </li>
                        );
                      })}
                      {history.length > 8 && (
                        <li>
                          <button
                            type="button"
                            onClick={() => setShowAllHistory((v) => !v)}
                            className="rounded-input px-1 text-xs font-medium text-accent hover:underline"
                          >
                            {showAllHistory ? 'Show less' : `Show ${history.length - 8} earlier`}
                          </button>
                        </li>
                      )}
                    </ul>
                  ) : (
                    <p className="text-xs text-muted">
                      No reports generated yet. Generate a PDF or ZIP to start the history.
                    </p>
                  )}
                </Card>
              </div>
            </div>
          ) : section === 'attestation' ? (
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="space-y-4 lg:col-span-2">
                {/* Attestation letter */}
                <Card className="space-y-3 p-4">
                  <h3 className="text-sm font-semibold text-text">Attestation letter</h3>
                  {selectedReport ? (
                    <>
                      <p className="text-xs text-muted">
                        A short, formal letter attesting that this assessment was performed — for a
                        specific generated report — that the client can share with auditors,
                        customers, or regulators in support of a compliance framework.
                      </p>
                      <Field label="Report to attest" htmlFor="att-report">
                        <Select
                          id="att-report"
                          value={selectedReport.uuid}
                          onChange={(e) => setAttReportUuid(e.target.value)}
                        >
                          {attestableReports.map((r) => (
                            <option key={r.uuid} value={r.uuid}>
                              {r.version} · {r.label} · {r.format.toUpperCase()} ·{' '}
                              {fmtDate(r.createdAt)}
                            </option>
                          ))}
                        </Select>
                      </Field>
                      <Field label="Compliance framework" htmlFor="att-framework">
                        <Select
                          id="att-framework"
                          value={framework}
                          onChange={(e) => setFramework(e.target.value as AttestationFramework)}
                        >
                          {ATTESTATION_FRAMEWORKS.map((f) => (
                            <option key={f} value={f}>
                              {ATTESTATION_FRAMEWORK_LABELS[f]}
                            </option>
                          ))}
                        </Select>
                      </Field>
                      {framework === 'custom' && (
                        <Field
                          label="Framework name"
                          htmlFor="att-framework-label"
                          hint="Shown in the letter’s “Use of this letter” section (e.g. HITRUST, FedRAMP)."
                        >
                          <Input
                            id="att-framework-label"
                            value={frameworkLabel}
                            onChange={(e) => setFrameworkLabel(e.target.value)}
                            placeholder="e.g. HITRUST"
                          />
                        </Field>
                      )}
                      {providerContacts.length > 0 ? (
                        <Field label="Signatory" htmlFor="att-signatory">
                          <Select
                            id="att-signatory"
                            value={String(effSignatoryIdx)}
                            onChange={(e) => setSignatoryIdx(e.target.value)}
                          >
                            {providerContacts.map((c, i) => (
                              <option key={i} value={String(i)}>
                                {c.name}
                                {c.title ? ` — ${c.title}` : ''}
                              </option>
                            ))}
                          </Select>
                        </Field>
                      ) : (
                        <p className="text-xs text-muted">
                          No provider contacts set — the letter will be signed by the organization.
                          Add contacts on the Content sub-tab to name a signatory.
                        </p>
                      )}
                      <div className="grid gap-3 sm:grid-cols-2">
                        <Field
                          label="Attn: recipient"
                          htmlFor="att-recipient-name"
                          hint="Prefilled from the first client contact."
                        >
                          <Input
                            id="att-recipient-name"
                            value={recipientName}
                            onChange={(e) => setRecipientName(e.target.value)}
                            placeholder="Recipient name"
                          />
                        </Field>
                        <Field label="Recipient title" htmlFor="att-recipient-title">
                          <Input
                            id="att-recipient-title"
                            value={recipientTitle}
                            onChange={(e) => setRecipientTitle(e.target.value)}
                            placeholder="e.g. CISO"
                          />
                        </Field>
                      </div>
                      <Field
                        label="Dear"
                        htmlFor="att-salutation"
                        hint="Greeting name; defaults to the Attn: recipient."
                      >
                        <Input
                          id="att-salutation"
                          value={salutationName}
                          onChange={(e) => setSalutationName(e.target.value)}
                          placeholder="Greeting name"
                        />
                      </Field>
                      <Checkbox
                        label="Show scope exclusions"
                        checked={showExclusions}
                        onChange={(e) => setShowExclusions(e.target.checked)}
                      />
                      <Field
                        label="Overall risk"
                        htmlFor="att-risk"
                        hint="The overall-risk rating stated in the letter."
                      >
                        <Select
                          id="att-risk"
                          value={overallRisk}
                          onChange={(e) => setOverallRisk(e.target.value)}
                        >
                          <option value="">
                            Use report’s rating
                            {selectedReport.summary.overallRisk
                              ? ` (${SEVERITY_LABELS[selectedReport.summary.overallRisk]})`
                              : ''}
                          </option>
                          {SEVERITIES.map((s) => (
                            <option key={s} value={s}>
                              {SEVERITY_LABELS[s]}
                            </option>
                          ))}
                        </Select>
                      </Field>
                      <Button
                        onClick={downloadAttestation}
                        loading={busy === 'attestation'}
                        disabled={busyAny}
                      >
                        Download attestation letter
                      </Button>
                    </>
                  ) : (
                    <p className="text-xs text-muted">
                      Generate a report first — the attestation letter attests to a specific report,
                      so it unlocks once one has been generated.
                    </p>
                  )}
                </Card>
              </div>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

/** Weakness tally line for a report-history entry. */
function summaryLine(s: GeneratedReport['summary']): string {
  const { critical, high, medium, low, none } = s.bySeverity;
  return `${s.weaknessesTotal} weakness${s.weaknessesTotal === 1 ? '' : 'es'} · ${critical}C ${high}H ${medium}M ${low}L ${none}I`;
}

/** Short date (e.g. "Aug 26, 2026") for an ISO timestamp. */
function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** Short date + time for a history row. */
function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function SortableSectionRow({
  id,
  label,
  hint,
  missing,
  enabled,
  canEdit,
  selected,
  onToggle,
  expanded,
  onToggleExpand,
  sample,
  items,
  options,
  onToggleOption,
  extra,
}: {
  id: string;
  label: string;
  hint: string;
  missing: boolean;
  enabled: boolean;
  canEdit: boolean;
  /** This section is the one shown in the live preview. */
  selected?: boolean;
  onToggle: (enabled: boolean) => void;
  expanded: boolean;
  /** Expanding a section also targets it for the live preview (see toggleExpand). */
  onToggleExpand: () => void;
  /** One-line preview of the whole section, shown when expanded. */
  sample?: string;
  /** Independently-toggleable sub-items, shown when expanded (built-ins only). */
  items?: ReportSectionItem[];
  /** Current sub-item overrides keyed by item id (absent/true = included). */
  options?: Record<string, boolean>;
  onToggleOption: (itemKey: string, value: boolean) => void;
  /** Extra section-specific controls shown at the bottom of the expanded panel. */
  extra?: ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled: !canEdit,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  };
  const panelId = `section-panel-${id}`;

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={`flex items-start gap-2 rounded-card border p-3 ${
        selected ? 'border-accent ring-1 ring-accent' : 'border-border'
      } ${enabled ? 'bg-surface' : 'bg-surface-2'}`}
    >
      <button
        {...attributes}
        {...listeners}
        type="button"
        disabled={!canEdit}
        aria-label={`Drag to reorder ${label}`}
        className="mt-0.5 cursor-grab touch-none px-1 text-muted hover:text-text active:cursor-grabbing disabled:opacity-50"
      >
        ⠿
      </button>
      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={onToggleExpand}
          aria-expanded={expanded}
          aria-controls={panelId}
          className="flex w-full items-start gap-2 text-left"
        >
          <span
            className={`mt-0.5 select-none text-xs text-muted transition-transform ${
              expanded ? 'rotate-90' : ''
            }`}
            aria-hidden="true"
          >
            ▶
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span
                className={`truncate text-sm font-medium ${enabled ? 'text-text' : 'text-muted'}`}
              >
                {label}
              </span>
              {missing && <Badge tone="warning">Unknown</Badge>}
              {!enabled && <Badge tone="neutral">Hidden</Badge>}
            </span>
            {hint && <span className="mt-0.5 block text-xs text-muted">{hint}</span>}
          </span>
        </button>

        {expanded && (
          <div id={panelId} className="mt-2 space-y-2 border-t border-border pt-2 pl-6">
            {sample && <p className="text-xs text-muted">{sample}</p>}
            {items && items.length > 0 ? (
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-text">Include in this section:</p>
                {items.map((it) => (
                  <label key={it.key} className="flex cursor-pointer items-start gap-2">
                    <input
                      type="checkbox"
                      checked={options?.[it.key] !== false}
                      onChange={(e) => onToggleOption(it.key, e.target.checked)}
                      disabled={!canEdit || !enabled}
                      aria-label={`Include ${it.label}`}
                      className="mt-0.5 h-4 w-4 rounded border-border text-accent accent-[var(--accent)] disabled:opacity-50"
                    />
                    <span className="min-w-0">
                      <span className="block text-sm text-text">{it.label}</span>
                      <span className="block text-xs text-muted">{it.sample}</span>
                    </span>
                  </label>
                ))}
                {!enabled && (
                  <p className="text-xs text-muted">Enable the section to include its parts.</p>
                )}
              </div>
            ) : (
              !extra && (
                <p className="text-xs text-muted">
                  This section has no separately toggleable parts.
                </p>
              )
            )}
            {extra}
          </div>
        )}
      </div>
      <label className="mt-0.5 inline-flex cursor-pointer items-center">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onToggle(e.target.checked)}
          disabled={!canEdit}
          aria-label={`Include ${label}`}
          className="h-4 w-4 rounded border-border text-accent accent-[var(--accent)] disabled:opacity-50"
        />
      </label>
    </li>
  );
}

/**
 * "Sanitize" control shown under Assessment Execution. Expands to two opt-ins for
 * the evidence timestamp and operator name. Both are OFF by default (the report
 * config defaults to hidden), so a report never leaks capture times or operator
 * identities unless the author turns them on. The effect is report-wide — it
 * governs every evidence-log item wherever it appears — so a note clarifies that.
 */
function SanitizeControl({
  showTimestamps,
  showOperators,
  canEdit,
  onChange,
}: {
  showTimestamps: boolean;
  showOperators: boolean;
  canEdit: boolean;
  onChange: (patch: { showEvidenceTimestamps?: boolean; showEvidenceOperators?: boolean }) => void;
}) {
  // Auto-open when something is already un-sanitized so the active state is visible.
  const [open, setOpen] = useState(showTimestamps || showOperators);
  const panelId = 'sanitize-panel';
  return (
    <div className="space-y-1.5 border-t border-border pt-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex w-full items-center gap-2 text-left"
      >
        <span
          className={`select-none text-xs text-muted transition-transform ${open ? 'rotate-90' : ''}`}
          aria-hidden="true"
        >
          ▶
        </span>
        <span className="text-xs font-medium text-text">Sanitize</span>
        {(() => {
          const hidden = [!showTimestamps, !showOperators].filter(Boolean).length;
          return hidden > 0 ? (
            <Badge tone="neutral">{hidden === 2 ? 'Hiding both' : 'Hiding 1'}</Badge>
          ) : null;
        })()}
      </button>
      {open && (
        <div id={panelId} className="space-y-1.5 pl-6">
          <p className="text-xs text-muted">
            Applies to evidence throughout the report. Off by default so capture times and operator
            names stay out of the report.
          </p>
          <label className="flex cursor-pointer items-start gap-2">
            <input
              type="checkbox"
              checked={showTimestamps}
              onChange={(e) => onChange({ showEvidenceTimestamps: e.target.checked })}
              disabled={!canEdit}
              aria-label="Show timestamps"
              className="mt-0.5 h-4 w-4 rounded border-border text-accent accent-[var(--accent)] disabled:opacity-50"
            />
            <span className="min-w-0">
              <span className="block text-sm text-text">Show timestamps</span>
              <span className="block text-xs text-muted">
                Show each evidence item&apos;s capture date/time in the evidence log.
              </span>
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-2">
            <input
              type="checkbox"
              checked={showOperators}
              onChange={(e) => onChange({ showEvidenceOperators: e.target.checked })}
              disabled={!canEdit}
              aria-label="Show operator"
              className="mt-0.5 h-4 w-4 rounded border-border text-accent accent-[var(--accent)] disabled:opacity-50"
            />
            <span className="min-w-0">
              <span className="block text-sm text-text">Show operator</span>
              <span className="block text-xs text-muted">
                Show the operator who captured each evidence item.
              </span>
            </span>
          </label>
        </div>
      )}
    </div>
  );
}
