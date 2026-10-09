import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Field,
  Input,
  MarkdownField,
  Select,
  SeverityBadge,
  Spinner,
  useConfirm,
  useToast,
} from '@reporter/ui';
import {
  FINDING_KINDS,
  FINDING_KIND_LABELS,
  FIX_EFFORTS,
  FIX_EFFORT_LABELS,
  ISO_21434_WORK_PRODUCTS,
  SEVERITIES,
  SEVERITY_LABELS,
  UN_R155_REQUIREMENTS,
  type FindingKind,
  type FixEffort,
  type Severity,
} from '@reporter/shared';
import { useDeleteFinding, useFinding, useUpdateFinding } from '../api/hooks.js';
import { READ_ONLY_TITLE, useEngagementPermissions } from '../lib/permissions.js';
import { useAutosave } from '../hooks/useAutosave.js';
import { SaveStatusIndicator } from '../components/SaveStatusIndicator.js';
import { CvssCalculator, type CvssResult } from '../components/findings/CvssCalculator.js';
import { AttackPathSection } from '../components/findings/AttackPathSection.js';
import { AttachedEvidenceSection } from '../components/findings/AttachedEvidenceSection.js';
import { EvidencePickerModal } from '../components/findings/EvidencePickerModal.js';
import { CategorySelect } from '../components/findings/CategorySelect.js';
import { StandardsPicker } from '../components/findings/StandardsPicker.js';
import { LinkedGoalsSection } from '../components/goals/LinkedGoalsSection.js';
import { FindingRecommendations } from '../components/findings/FindingRecommendations.js';

interface FindingForm {
  kind: FindingKind;
  title: string;
  description: string;
  affectedTarget: string;
  impact: string;
  remediation: string;
  category: string;
  fixEffort: FixEffort;
  iso21434Refs: string[];
  unr155Refs: string[];
  readyToReport: boolean;
  severity: Severity | '';
  cvssVector: string | null;
  cvssScore: number | null;
}

export function FindingDetailPage() {
  const { slug = '', uuid = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const { data: finding, isLoading } = useFinding(slug, uuid);
  const { canWrite, canAdmin } = useEngagementPermissions(slug);
  const update = useUpdateFinding(slug, uuid);
  const del = useDeleteFinding(slug);
  // Which bucket the picker attaches into, or null when closed.
  const [pickerTarget, setPickerTarget] = useState<null | 'path' | 'attached'>(null);
  const [calc, setCalc] = useState(false);

  const [form, setForm] = useState<FindingForm>({
    kind: 'weakness',
    title: '',
    description: '',
    affectedTarget: '',
    impact: '',
    remediation: '',
    category: '',
    fixEffort: 'none',
    iso21434Refs: [],
    unr155Refs: [],
    readyToReport: false,
    severity: '',
    cvssVector: null,
    cvssScore: null,
  });

  // Seed the form once per finding, not on every cache change. Optimistic
  // evidence reorder/attach/detach replace the cached `finding` object; without
  // this guard the effect would re-run and silently discard unsaved edits.
  const seededUuid = useRef<string | null>(null);
  // Baseline the autosave diffs against; undefined until the finding loads.
  const [baseline, setBaseline] = useState<FindingForm | undefined>(undefined);
  useEffect(() => {
    if (finding && seededUuid.current !== finding.uuid) {
      seededUuid.current = finding.uuid;
      const seeded: FindingForm = {
        kind: finding.kind,
        title: finding.title,
        description: finding.description,
        affectedTarget: finding.affectedTarget,
        impact: finding.impact,
        remediation: finding.remediation,
        category: finding.category ?? '',
        fixEffort: finding.fixEffort,
        iso21434Refs: finding.iso21434Refs,
        unr155Refs: finding.unr155Refs,
        readyToReport: finding.readyToReport,
        severity: finding.severity ?? '',
        cvssVector: finding.cvssVector,
        cvssScore: finding.cvssScore,
      };
      setForm(seeded);
      setBaseline(seeded);
    }
  }, [finding]);

  // Autosave the whole finding form. The CVSS calculator / severity picker set
  // vector+score+severity together, which is just another form change and saves
  // fine. Title is required; a blank title parks at `unsaved` and never saves.
  const { status, flush } = useAutosave<FindingForm>({
    value: form,
    baseline,
    isValid: (v) => v.title.trim().length > 0,
    save: async (v) => {
      const patch: Record<string, unknown> = {
        kind: v.kind,
        title: v.title,
        description: v.description,
        affectedTarget: v.affectedTarget,
        category: v.category || null,
        readyToReport: v.readyToReport,
        iso21434Refs: v.iso21434Refs,
        unr155Refs: v.unr155Refs,
      };
      if (v.kind === 'weakness') {
        // Weaknesses carry the impact/remediation/effort and a severity or CVSS.
        patch.impact = v.impact;
        patch.remediation = v.remediation;
        patch.fixEffort = v.fixEffort;
        if (v.cvssVector) {
          // A CVSS vector is set — the server derives score + severity from it.
          patch.cvssVector = v.cvssVector;
        } else {
          // No vector: record the manual severity (or clear it) and drop any vector.
          patch.severity = v.severity === '' ? null : v.severity;
          patch.cvssVector = null;
        }
      } else {
        // Strengths have no severity/CVSS/impact/remediation/effort — clear them.
        patch.severity = null;
        patch.cvssVector = null;
        patch.impact = '';
        patch.remediation = '';
        patch.fixEffort = 'none';
      }
      await update.mutateAsync(patch);
      setBaseline(v);
    },
  });

  const titleInvalid = form.title.trim().length === 0;

  if (isLoading) return <Spinner size={26} />;
  if (!finding) return <p className="text-danger">Finding not found.</p>;

  // Read-only pattern: inputs disable when the user can't write.
  const readOnlyTitle = canWrite ? undefined : READ_ONLY_TITLE;
  const isWeakness = form.kind === 'weakness';

  // Server pre-sorts: Attack Path (inPath=true) first, then Attached, each by position.
  const pathItems = finding.evidence.filter((e) => e.inPath);
  const attachedItems = finding.evidence.filter((e) => !e.inPath);
  const attachedUuids = finding.evidence.map((e) => e.uuid);

  // Picking a severity manually invalidates any stored CVSS vector.
  function pickSeverity(value: Severity | '') {
    setForm((prev) => ({ ...prev, severity: value, cvssVector: null, cvssScore: null }));
  }

  function applyCvss(result: CvssResult) {
    setForm((prev) => ({
      ...prev,
      severity: result.severity,
      cvssVector: result.vector,
      cvssScore: result.score,
    }));
    setCalc(false);
  }

  async function removeFinding() {
    if (!finding) return;
    const ok = await confirm({
      title: 'Delete finding',
      message: `Delete “${finding.title}”? Attached evidence is kept; this can’t be undone.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await del.mutateAsync(finding.uuid);
      toast.success('Finding deleted');
      navigate(`/engagements/${slug}/findings`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Delete failed');
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Link to={`/engagements/${slug}/findings`} className="text-sm text-muted hover:text-text">
          ← Back to findings
        </Link>
        <Button
          variant="ghost"
          onClick={removeFinding}
          className="text-danger"
          disabled={!canWrite}
          title={canWrite ? undefined : READ_ONLY_TITLE}
        >
          Delete finding
        </Button>
      </div>

      {/* Finding details — top, roomy. */}
      <Card className="space-y-4 p-4">
        <Field
          label="Kind"
          htmlFor="fk"
          hint="Weaknesses carry severity and remediation; strengths note good practices."
        >
          <div id="fk" role="radiogroup" aria-label="Finding kind" className="flex gap-2">
            {FINDING_KINDS.map((k) => (
              <Button
                key={k}
                type="button"
                size="sm"
                variant={form.kind === k ? 'primary' : 'secondary'}
                role="radio"
                aria-checked={form.kind === k}
                onClick={() => setForm({ ...form, kind: k })}
                disabled={!canWrite}
                title={readOnlyTitle}
              >
                {FINDING_KIND_LABELS[k]}
              </Button>
            ))}
            {form.kind === 'strength' && <Badge tone="success">Strength</Badge>}
          </div>
        </Field>

        <Field
          label="Title"
          htmlFor="ft"
          required
          error={canWrite && titleInvalid ? 'A title is required.' : undefined}
        >
          <Input
            id="ft"
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            onBlur={() => void flush()}
            invalid={canWrite && titleInvalid}
            disabled={!canWrite}
            title={readOnlyTitle}
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Category" htmlFor="fc">
            <CategorySelect
              id="fc"
              slug={slug}
              value={form.category}
              onChange={(category) => setForm((prev) => ({ ...prev, category }))}
              disabled={!canWrite}
            />
          </Field>
          <Field
            label="Affected target"
            htmlFor="fat"
            hint="Component, host, or subsystem this finding concerns."
          >
            <Input
              id="fat"
              value={form.affectedTarget}
              onChange={(e) => setForm({ ...form, affectedTarget: e.target.value })}
              onBlur={() => void flush()}
              disabled={!canWrite}
              title={readOnlyTitle}
            />
          </Field>
        </div>

        {isWeakness && (
          <>
            <Field label="Severity" htmlFor="fsev">
              <div className="flex items-center gap-2">
                <Select
                  id="fsev"
                  className="max-w-[10rem]"
                  value={form.severity}
                  onChange={(e) => pickSeverity(e.target.value as Severity | '')}
                  disabled={!canWrite}
                  title={readOnlyTitle}
                >
                  <option value="">Unrated</option>
                  {SEVERITIES.map((s) => (
                    <option key={s} value={s}>
                      {SEVERITY_LABELS[s]}
                    </option>
                  ))}
                </Select>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => setCalc(true)}
                  disabled={!canWrite}
                  title={readOnlyTitle}
                >
                  CVSS calculator
                </Button>
                {form.cvssVector && (
                  <SeverityBadge severity={form.severity || null} score={form.cvssScore} />
                )}
              </div>
            </Field>
            {form.cvssVector && (
              <p className="-mt-2 text-xs text-muted">
                <code>{form.cvssVector}</code>
              </p>
            )}
            <Field label="Fix effort" htmlFor="ffe" hint="Estimated effort to remediate.">
              <Select
                id="ffe"
                className="max-w-[10rem]"
                value={form.fixEffort}
                onChange={(e) => setForm({ ...form, fixEffort: e.target.value as FixEffort })}
                disabled={!canWrite}
                title={readOnlyTitle}
              >
                {FIX_EFFORTS.map((f) => (
                  <option key={f} value={f}>
                    {FIX_EFFORT_LABELS[f]}
                  </option>
                ))}
              </Select>
            </Field>
          </>
        )}

        <Field label="Description" htmlFor="fd">
          <MarkdownField
            id="fd"
            rows={6}
            value={form.description}
            onChange={(v) => setForm({ ...form, description: v })}
            onBlur={() => void flush()}
            disabled={!canWrite}
            title={readOnlyTitle}
          />
        </Field>

        {isWeakness && (
          <>
            <Field
              label="Impact"
              htmlFor="fimp"
              hint="Business or technical impact if exploited (distinct from the description)."
            >
              <MarkdownField
                id="fimp"
                rows={4}
                value={form.impact}
                onChange={(v) => setForm({ ...form, impact: v })}
                onBlur={() => void flush()}
                disabled={!canWrite}
                title={readOnlyTitle}
              />
            </Field>
            <Field
              label="Remediation"
              htmlFor="frem"
              hint="Recommended fix / guidance (shown in the report)."
            >
              <MarkdownField
                id="frem"
                rows={6}
                value={form.remediation}
                onChange={(v) => setForm({ ...form, remediation: v })}
                onBlur={() => void flush()}
                disabled={!canWrite}
                title={readOnlyTitle}
              />
            </Field>
          </>
        )}

        {/* Standards mapping — available for both kinds. */}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="ISO/SAE 21434" htmlFor="fiso" hint="Related work products / clauses.">
            <StandardsPicker
              catalog={ISO_21434_WORK_PRODUCTS}
              value={form.iso21434Refs}
              onChange={(iso21434Refs) => setForm((prev) => ({ ...prev, iso21434Refs }))}
              disabled={!canWrite}
              disabledTitle={readOnlyTitle}
              label="ISO 21434 work product"
            />
          </Field>
          <Field label="UN R155" htmlFor="funr" hint="Related requirements / Annex 5 entries.">
            <StandardsPicker
              catalog={UN_R155_REQUIREMENTS}
              value={form.unr155Refs}
              onChange={(unr155Refs) => setForm((prev) => ({ ...prev, unr155Refs }))}
              disabled={!canWrite}
              disabledTitle={readOnlyTitle}
              label="UN R155 requirement"
            />
          </Field>
        </div>

        <div className="flex items-center justify-between">
          <Checkbox
            label="Ready to report"
            checked={form.readyToReport}
            onChange={(e) => setForm({ ...form, readyToReport: e.target.checked })}
            disabled={!canWrite}
            title={readOnlyTitle}
          />
          {canWrite && <SaveStatusIndicator status={status} />}
        </div>
      </Card>

      <FindingRecommendations slug={slug} findingUuid={uuid} canAdmin={canAdmin} />

      <LinkedGoalsSection slug={slug} kind="finding" uuid={uuid} canWrite={canWrite} />

      {/* Evidence — full width, two buckets below the details. */}
      <AttackPathSection
        slug={slug}
        findingUuid={uuid}
        items={pathItems}
        onAddStep={() => setPickerTarget('path')}
        canWrite={canWrite}
        // Follows the *draft* kind, like the severity and remediation blocks above:
        // flip the kind selector and the section renames before you save, which is
        // the same feedback those blocks already give.
        isStrength={!isWeakness}
      />
      <AttachedEvidenceSection
        slug={slug}
        findingUuid={uuid}
        items={attachedItems}
        onAttach={() => setPickerTarget('attached')}
        canWrite={canWrite}
      />

      <CvssCalculator
        open={calc}
        onClose={() => setCalc(false)}
        initialVector={form.cvssVector}
        onApply={applyCvss}
      />
      <EvidencePickerModal
        slug={slug}
        findingUuid={uuid}
        attachedUuids={attachedUuids}
        targetInPath={pickerTarget === 'path'}
        targetIsStrength={!isWeakness}
        open={pickerTarget !== null}
        onClose={() => setPickerTarget(null)}
      />
    </div>
  );
}
