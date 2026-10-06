import { useState, type FormEvent } from 'react';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Modal,
  Select,
  Spinner,
  Textarea,
  useConfirm,
  useToast,
} from '@reporter/ui';
import {
  REPORT_PRESETS,
  REPORT_PRESET_HINTS,
  REPORT_PRESET_LABELS,
  type ReportConfig,
  type ReportPreset,
  type ReportTemplate,
  type ReportTemplateConfig,
  type UpdateReportTemplateInput,
} from '@reporter/shared';
import {
  useCreateReportTemplate,
  useDeleteReportTemplate,
  useReportTemplates,
  useUpdateReportTemplate,
} from '../../api/hooks.js';
import { ADMIN_ONLY_TITLE, READ_ONLY_TITLE } from '../../lib/permissions.js';
import { formatDate, formatDateTime } from '../../lib/format.js';
import {
  applyTemplateConfig,
  configSummary,
  overflowReason,
  templateSanitizeWarning,
} from '../../lib/report-templates.js';
import { userDisplayName } from '../../lib/user-display.js';
import { RowMenu } from '../common/RowMenu.js';
import { TemplateSanitizeBadge } from './TemplateSanitizeBadge.js';

/**
 * Report templates — a site-wide library of named report configurations — as the
 * Reports tab sees them. A template carries everything in an engagement's
 * `reportConfig` except `readinessNa` (see `reportTemplateConfigSchema`), so it
 * reproduces *how* a report is built without touching which readiness items this
 * engagement waived.
 *
 * Two surfaces live here: the Configure tab's save/apply/manage card
 * ({@link ReportTemplateControls}) and the Generate tab's target chooser
 * ({@link ReportTargetField}). The rules they share — the custom-section merge, the
 * sanitize warning, the one-line digest — are in lib/report-templates.ts, so the
 * part that can destroy an author's work is unit-tested away from the markup.
 */

/** "Saved by Dana Reyes · Oct 3, 2026" for a template row. */
function savedByLine(t: ReportTemplate): string {
  return `Saved by ${userDisplayName(t.createdBy)} · ${formatDate(t.createdAt)}`;
}

/**
 * The engagement's configuration as a template payload: everything except
 * `readinessNa`, which is per-engagement bookkeeping a template never carries. Both
 * writes that snapshot the configuration — saving a new template, and overwriting
 * an existing one — go through this, so neither can leak it in by hand.
 */
function templateConfigOf(config: ReportConfig): ReportTemplateConfig {
  const { readinessNa: _readinessNa, ...rest } = config;
  return rest;
}

/** The details modal's two jobs: name a new template, or re-word an existing one. */
type DetailsTarget = { kind: 'save' } | { kind: 'edit'; template: ReportTemplate };

/**
 * Configure tab: save this engagement's configuration as a template, apply one to
 * it, and manage the library entries themselves — rename one, overwrite its
 * configuration with this engagement's, or delete it. Reading the library needs only
 * a signed-in user, so everyone sees the list.
 *
 * The manage actions are here, and not only in the Admin area, because this is the
 * surface the people the server authorizes can actually reach.
 * `requireReportTemplateManager` lets through a site admin *or* anyone holding
 * write/admin on at least one engagement, while App.tsx routes `/admin` for site
 * admins alone — so for a write-level member the Admin library does not exist, and
 * without these controls they could add a template and then never rename, refresh or
 * remove it. Admin keeps rename and delete for its site-wide table and words them the
 * same way, deliberately: the two surfaces must promise the same consequences.
 * Overwriting is only here, because it needs a live configuration to snapshot.
 */
export function ReportTemplateControls({
  config,
  canSave,
  canApply,
  onApply,
  onFlush,
}: {
  /** The engagement's live report configuration, as edited on this tab. */
  config: ReportConfig;
  /**
   * The user may add to the library and manage what is in it (rename, overwrite,
   * delete). The server's rule is write (or admin) on *some* engagement, or site
   * admin, which a page scoped to one engagement cannot know — write here is the
   * honest local signal, and site admins satisfy it already. Where it guesses low,
   * the server's own 403 wording is what the user is shown.
   */
  canSave: boolean;
  /** The user may overwrite this engagement's configuration (engagement admin). */
  canApply: boolean;
  /** Hand the merged configuration back to the page, which autosaves it. */
  onApply: (next: ReportConfig) => void;
  /** Flush a pending config autosave, so a snapshot matches what is stored. */
  onFlush: () => Promise<void>;
}) {
  const { data: templates, isLoading, isError, refetch } = useReportTemplates();
  const create = useCreateReportTemplate();
  const update = useUpdateReportTemplate();
  const remove = useDeleteReportTemplate();
  const confirm = useConfirm();
  const toast = useToast();

  // One modal serves both the save form and the rename form: the same two fields
  // with the same caps, so the second one would have been a copy of the first.
  const [details, setDetails] = useState<DetailsTarget | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  // Server-side rejections (most often a 409 on a name already in the library) are
  // shown on the name field, where the fix is, not only as a toast.
  const [formError, setFormError] = useState<string | null>(null);
  // The library has loaded and holds nothing. The empty state carries the save
  // action in that case, so the header doesn't offer the same button twice.
  const isEmpty = !isLoading && !isError && (templates?.length ?? 0) === 0;

  function openSave() {
    setName('');
    setDescription('');
    setFormError(null);
    setDetails({ kind: 'save' });
  }

  function openEdit(t: ReportTemplate) {
    setName(t.name);
    setDescription(t.description);
    setFormError(null);
    setDetails({ kind: 'edit', template: t });
  }

  const editing = details?.kind === 'edit' ? details.template : null;
  const trimmedName = name.trim();
  const trimmedDescription = description.trim();
  /**
   * An edit sends only the fields that actually changed. Every field of the patch is
   * optional, and an empty save would still bump `updatedAt` (the server stamps it on
   * every write), which would make the library claim an edit that never happened.
   * Both values are compared trimmed because the server trims the name.
   */
  const detailsPatch: UpdateReportTemplateInput = {
    ...(editing && trimmedName !== editing.name ? { name: trimmedName } : {}),
    ...(editing && trimmedDescription !== editing.description
      ? { description: trimmedDescription }
      : {}),
  };
  const canSubmitDetails =
    trimmedName.length > 0 && (editing === null || Object.keys(detailsPatch).length > 0);

  async function submitDetails(e: FormEvent) {
    e.preventDefault();
    if (!details || !canSubmitDetails) return;
    setFormError(null);
    try {
      if (details.kind === 'save') {
        // Snapshot what the author sees on this tab. Flushing first keeps the
        // engagement and the template in step; the snapshot itself comes from the
        // live form state either way.
        await onFlush();
        await create.mutateAsync({
          name: trimmedName,
          description: trimmedDescription,
          config: templateConfigOf(config),
        });
        setDetails(null);
        toast.success(`Saved report template “${trimmedName}”`);
      } else {
        await update.mutateAsync({ uuid: details.template.uuid, patch: detailsPatch });
        setDetails(null);
        toast.success('Report template updated');
      }
    } catch (err) {
      // Both refusals arrive worded by the server — 409 for a name already in the
      // library, 403 for its write-to-manage rule, which this card cannot evaluate
      // locally. Show that wording rather than a guess at the reason.
      const message =
        err instanceof Error
          ? err.message
          : details.kind === 'save'
            ? 'Could not save the report template'
            : 'Could not update the report template';
      setFormError(message);
      toast.error(message);
    }
  }

  async function applyTemplate(t: ReportTemplate) {
    const next = applyTemplateConfig(config, t.config);
    const overflow = overflowReason(next);
    if (overflow) {
      toast.error(`“${t.name}” can’t be applied. ${overflow}`);
      return;
    }
    const sanitize = templateSanitizeWarning(config, t.config);
    const ok = await confirm({
      title: 'Apply report template',
      // Applying overwrites a configuration the author built by hand, and two of
      // its consequences are counterintuitive (custom sections survive, readiness
      // N/A marks are untouched), so each one gets its own line.
      message: (
        <span className="block space-y-2">
          <span className="block">
            Apply <span className="font-semibold">{t.name}</span> to this engagement’s report
            configuration?
          </span>
          <span className="block">
            Replaces the current section selection and order, the findings grouping, and the
            evidence-log options with the template’s.
          </span>
          <span className="block">
            Custom sections from the template are merged in — one that shares an id with yours is
            overwritten by the template’s version, and your own custom sections the template doesn’t
            reference are kept (added to the section list switched off, so nothing is deleted and
            nothing appears in the report uninvited).
          </span>
          <span className="block">
            Report-readiness “Not applicable” marks belong to this engagement and are not affected.
          </span>
          {sanitize && <span className="block text-warning">{sanitize}</span>}
        </span>
      ),
      confirmLabel: 'Apply template',
    });
    if (!ok) return;
    // Handing the merged configuration to the page is the whole of the write: its
    // autosave persists it and the Save status indicator reports on it, so there is
    // nothing to await and no per-row pending state here.
    onApply(next);
    toast.success(`Applied “${t.name}” to this engagement’s report configuration`);
  }

  /**
   * Replace a template's stored configuration with this engagement's current one —
   * the write a team reaches for once the sections have been tuned on a real
   * engagement and the shared template should follow. Name and description are left
   * alone (an absent patch field is left as it was), so this is never a rename.
   */
  async function overwriteTemplate(t: ReportTemplate) {
    const next = templateConfigOf(config);
    // The same comparison the apply path makes, pointed the other way: what this
    // configuration would start revealing relative to what the template holds now.
    const sanitize = templateSanitizeWarning(t.config, next);
    const ok = await confirm({
      title: 'Overwrite report template',
      message: (
        <span className="block space-y-2">
          <span className="block">
            Replace <span className="font-semibold">{t.name}</span>’s saved configuration with this
            engagement’s current one?
          </span>
          <span className="block">
            Every engagement that generates a report from{' '}
            <span className="font-semibold">{t.name}</span>, or applies it, afterwards gets the new
            configuration — the library entry is shared site-wide.
          </span>
          <span className="block">
            Engagements that already applied it keep the settings they were given, because applying
            copies them rather than linking. The template’s name and description don’t change, and
            report-readiness “Not applicable” marks are never part of a template.
          </span>
          {sanitize && <span className="block text-warning">{sanitize}</span>}
        </span>
      ),
      confirmLabel: 'Overwrite template',
    });
    if (!ok) return;
    try {
      // Flush for the reason saving does: the library entry and the engagement it
      // was snapshotted from should not disagree about what was captured.
      await onFlush();
      await update.mutateAsync({ uuid: t.uuid, patch: { config: next } });
      toast.success(`“${t.name}” now holds this engagement’s report configuration`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not update the report template');
    }
  }

  /**
   * A plain confirm, not a type-the-name one — matching the Admin library, and the
   * tone of this page's other destructive actions: deleting a template destroys no
   * report and no configuration, only the library entry. The wording is Admin's
   * verbatim so both surfaces promise the same thing, and it holds in the server:
   * applying copies into the engagement's own `reportConfig`, and a generated report
   * records the template's name in its `label` rather than a reference to the row.
   */
  async function confirmDelete(t: ReportTemplate) {
    const ok = await confirm({
      title: 'Delete report template',
      message: (
        <span className="block space-y-2">
          <span className="block">
            Delete the report template <span className="font-semibold">{t.name}</span>?
          </span>
          <span className="block">
            Applying a template copies its settings into the engagement rather than linking to it,
            so every engagement that already applied this one keeps its report configuration, and
            reports already generated from it keep their history entry. Only the library entry goes.
          </span>
          <span className="block">
            Any engagement still configured this way can save it again from Reports → Configure.
          </span>
        </span>
      ),
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await remove.mutateAsync(t.uuid);
      toast.success('Report template deleted');
    } catch (err) {
      // A 403 here is the server's write-to-manage rule talking, and it words the
      // requirement precisely — pass it through rather than guess at the reason.
      toast.error(err instanceof Error ? err.message : 'Could not delete the report template');
    }
  }

  /**
   * The row with a write in flight, if any. `update` also backs the details modal,
   * which spins its own button — the row indicator is harmless there, and it is the
   * only progress signal the overwrite and delete actions have, since both run
   * straight from the menu with no button of their own.
   */
  const busyUuid = remove.isPending
    ? remove.variables
    : update.isPending
      ? update.variables?.uuid
      : undefined;

  const saveButton = (
    <Button
      size="sm"
      variant="secondary"
      onClick={openSave}
      disabled={!canSave}
      title={canSave ? undefined : READ_ONLY_TITLE}
    >
      Save as template
    </Button>
  );

  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-text">Report templates</h3>
          <p className="mt-0.5 text-xs text-muted">
            A named copy of a report configuration that every engagement shares, so teammates can
            produce the same kind of report. Report-readiness “Not applicable” marks stay with the
            engagement and are never part of a template.
          </p>
        </div>
        {!isEmpty && saveButton}
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-xs text-muted">
          <Spinner size={12} /> Loading report templates…
        </div>
      ) : isError ? (
        <ErrorState description="Couldn’t load report templates." onRetry={() => void refetch()} />
      ) : isEmpty ? (
        <EmptyState
          className="px-4 py-8"
          title="No report templates yet"
          description="Save this engagement’s configuration as the first one, and any engagement can produce the same kind of report."
          action={saveButton}
        />
      ) : (
        <ul className="space-y-2">
          {(templates ?? []).map((t) => (
            <li key={t.uuid} className="rounded-card border border-border bg-surface-2 p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-sm font-medium text-text">{t.name}</span>
                    <TemplateSanitizeBadge config={t.config} />
                  </div>
                  {t.description && <p className="mt-0.5 text-xs text-muted">{t.description}</p>}
                  <p className="mt-0.5 text-xs text-muted" title={formatDateTime(t.createdAt)}>
                    {savedByLine(t)}
                  </p>
                  <p className="mt-0.5 text-xs text-muted">{configSummary(t.config)}</p>
                </div>
                {/* Apply stays the primary control; the three manage actions sit in
                    the row's overflow menu, so adding them doesn't turn every row
                    into a strip of buttons. */}
                <div className="flex flex-none items-center gap-1">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => void applyTemplate(t)}
                    disabled={!canApply}
                    title={canApply ? undefined : ADMIN_ONLY_TITLE}
                  >
                    Apply
                  </Button>
                  {busyUuid === t.uuid ? (
                    <Spinner size={14} label={`Updating ${t.name}`} />
                  ) : canSave ? (
                    <RowMenu
                      label={`Report template actions for ${t.name}`}
                      items={[
                        { label: 'Edit name & description…', onSelect: () => openEdit(t) },
                        {
                          label: 'Overwrite with this configuration',
                          onSelect: () => void overwriteTemplate(t),
                        },
                        {
                          label: 'Delete template',
                          onSelect: () => void confirmDelete(t),
                          danger: true,
                        },
                      ]}
                    />
                  ) : (
                    /* Read-only: the menu's items can't carry a disabled state of
                       their own, and hiding the trigger would hide the capability,
                       so the row keeps the control and states the reason. */
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled
                      aria-label={`Report template actions for ${t.name}`}
                      title={READ_ONLY_TITLE}
                    >
                      ⋯
                    </Button>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Modal
        open={details !== null}
        onClose={() => setDetails(null)}
        title={editing ? 'Edit report template' : 'Save as report template'}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDetails(null)}>
              Cancel
            </Button>
            <Button
              onClick={submitDetails}
              loading={editing ? update.isPending : create.isPending}
              disabled={!canSubmitDetails || create.isPending || update.isPending}
            >
              {editing ? 'Save' : 'Save template'}
            </Button>
          </>
        }
      >
        <form onSubmit={submitDetails} className="space-y-3">
          <Field
            label="Name"
            htmlFor="rt-name"
            hint={
              editing
                ? 'Unique across the library — every engagement sees this name.'
                : 'Shown to every engagement, so name it for the deliverable — not for this client.'
            }
            error={formError ?? undefined}
          >
            <Input
              id="rt-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Client deliverable"
              maxLength={120}
              invalid={formError !== null}
              autoFocus
            />
          </Field>
          <Field
            label="Description"
            htmlFor="rt-description"
            hint="Optional — when to reach for this one."
          >
            <Textarea
              id="rt-description"
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g. Full report with the evidence log, for retests"
              maxLength={500}
            />
          </Field>
          {editing ? (
            // The configuration isn't editable field-by-field in a template — it is
            // a snapshot of a real engagement's. Point at the action that replaces
            // it, which is on the same row this modal was opened from.
            <p className="text-xs text-muted">
              This edits the name and description only. To bring the template’s configuration up to
              date with this engagement’s, choose “Overwrite with this configuration” on its row.
            </p>
          ) : (
            <div className="space-y-1 rounded-input border border-border bg-surface-2 px-2.5 py-2">
              <p className="text-xs font-medium text-text">This template will capture</p>
              <p className="text-xs text-muted">{configSummary(config)}</p>
              <p className="text-xs text-muted">
                Section order, every per-section option, and the custom sections’ titles and bodies
                travel with it. Report-readiness “Not applicable” marks do not.
              </p>
              {(config.showEvidenceTimestamps || config.showEvidenceOperators) && (
                <p className="text-xs text-warning">
                  {config.showEvidenceTimestamps && config.showEvidenceOperators
                    ? 'Both sanitize options are on here, so every report made from this template shows evidence capture times and operator names.'
                    : config.showEvidenceTimestamps
                      ? 'A sanitize option is on here, so every report made from this template shows evidence capture times.'
                      : 'A sanitize option is on here, so every report made from this template names the operator who captured each evidence item.'}
                </p>
              )}
            </div>
          )}
        </form>
      </Modal>
    </Card>
  );
}

/**
 * What the Generate tab will render: one of the built-in presets, or a saved
 * template. A template is a complete configuration, so it replaces the preset
 * rather than combining with it (the server ignores `?preset` when
 * `?templateUuid` is present).
 */
export type GenerateTarget =
  { kind: 'preset'; preset: ReportPreset } | { kind: 'template'; uuid: string };

/** The default target: the engagement's own configured sections. */
export const DEFAULT_GENERATE_TARGET: GenerateTarget = { kind: 'preset', preset: 'custom' };

/** `<option>` value for a target — the kind, so the two namespaces can't collide. */
function targetValue(target: GenerateTarget): string {
  return target.kind === 'template' ? `template:${target.uuid}` : `preset:${target.preset}`;
}

function parseTargetValue(value: string): GenerateTarget {
  const sep = value.indexOf(':');
  const kind = value.slice(0, sep);
  const id = value.slice(sep + 1);
  if (kind === 'template' && id) return { kind: 'template', uuid: id };
  return {
    kind: 'preset',
    preset: REPORT_PRESETS.includes(id as ReportPreset) ? (id as ReportPreset) : 'custom',
  };
}

/**
 * Generate tab: pick what to render. Built-in presets and saved templates share one
 * `<select>` but sit in separate, labeled groups, because they behave differently —
 * a preset is a canned subset of *this* engagement's configuration, a template is a
 * configuration of its own, used for that one run and never written back.
 */
export function ReportTargetField({
  target,
  onChange,
  templates,
  isLoading,
  isError,
  onRetry,
  config,
  onConfigure,
}: {
  target: GenerateTarget;
  onChange: (next: GenerateTarget) => void;
  /** The library, from the page's own `useReportTemplates()` (same cache entry). */
  templates: ReportTemplate[];
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  /** The engagement's live configuration, for the sanitize comparison. */
  config: ReportConfig;
  /** Jump to the Configure tab, where templates are saved and applied. */
  onConfigure: () => void;
}) {
  const selected =
    target.kind === 'template' ? templates.find((t) => t.uuid === target.uuid) : undefined;
  const sanitize = selected ? templateSanitizeWarning(config, selected.config) : null;

  return (
    <div className="space-y-2">
      <Field
        label="Report type"
        htmlFor="rp-target"
        hint={
          target.kind === 'preset'
            ? REPORT_PRESET_HINTS[target.preset]
            : 'A saved report template — its configuration is used for this report only, and this engagement’s own configuration is left exactly as it is.'
        }
      >
        <Select
          id="rp-target"
          value={targetValue(target)}
          onChange={(e) => onChange(parseTargetValue(e.target.value))}
        >
          <optgroup label="Built-in report types">
            {REPORT_PRESETS.map((p) => (
              <option key={p} value={`preset:${p}`}>
                {REPORT_PRESET_LABELS[p]}
              </option>
            ))}
          </optgroup>
          {templates.length > 0 && (
            <optgroup label="Saved report templates">
              {templates.map((t) => (
                <option key={t.uuid} value={`template:${t.uuid}`}>
                  {t.name}
                </option>
              ))}
            </optgroup>
          )}
        </Select>
      </Field>

      {/* Library states. Compact lines rather than the full ErrorState/EmptyState
          panels: this is one field inside the Generate card, and the built-in
          presets above stay usable whatever the library is doing. */}
      {isLoading ? (
        <p className="flex items-center gap-2 text-xs text-muted">
          <Spinner size={12} /> Loading report templates…
        </p>
      ) : isError ? (
        <p className="flex flex-wrap items-center gap-2 text-xs text-danger">
          Couldn’t load report templates — the built-in report types above still work.
          <Button size="sm" variant="ghost" onClick={onRetry}>
            Try again
          </Button>
        </p>
      ) : templates.length === 0 ? (
        <p className="text-xs text-muted">
          No report templates saved yet. Configure the sections you want, then choose{' '}
          <button type="button" className="text-accent hover:underline" onClick={onConfigure}>
            Save as template
          </button>{' '}
          on the Configure tab to reuse them here and on every other engagement.
        </p>
      ) : null}

      {selected && (
        <div className="space-y-1 rounded-input border border-border bg-surface-2 px-2.5 py-2">
          <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
            <Badge tone="accent">Report template</Badge>
            <span title={formatDateTime(selected.createdAt)}>{savedByLine(selected)}</span>
            <TemplateSanitizeBadge config={selected.config} />
          </p>
          {selected.description && <p className="text-xs text-muted">{selected.description}</p>}
          <p className="text-xs text-muted">{configSummary(selected.config)}</p>
        </div>
      )}

      {sanitize && (
        <p className="rounded-input border border-warning/30 bg-warning/5 px-2.5 py-1.5 text-xs text-warning">
          {sanitize} You’ll be asked to confirm before this report is generated.
        </p>
      )}
    </div>
  );
}
