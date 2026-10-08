import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useParams } from 'react-router-dom';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  MarkdownField,
  Modal,
  Spinner,
  Textarea,
  useConfirm,
  useToast,
} from '@reporter/ui';
import { GOAL_STATUS_LABELS, type Activity, type Goal, type Target } from '@reporter/shared';
import {
  useCreateActivity,
  useCreateGoal,
  useCreateTarget,
  useDeleteActivity,
  useDeleteGoal,
  useDeleteTarget,
  useEngagement,
  useGoals,
  useLinkGoalEvidence,
  useReorderActivities,
  useReorderGoals,
  useReorderTargets,
  useUpdateActivity,
  useUpdateEngagement,
  useUpdateGoal,
  useUpdateTarget,
} from '../api/hooks.js';
import { ADMIN_ONLY_TITLE, READ_ONLY_TITLE, useEngagementPermissions } from '../lib/permissions.js';
import { useAutosave } from '../hooks/useAutosave.js';
import { DEEP_LINK_HIGHLIGHT, useDeepLinkRow } from '../hooks/useDeepLinkRow.js';
import { GOAL_PARAM, goalRowId } from '../components/goals/goalDeepLink.js';
import { SaveStatusIndicator } from '../components/SaveStatusIndicator.js';
import { ProgressBar } from '../components/goals/ProgressBar.js';
import { GoalStatusControl } from '../components/goals/GoalStatusControl.js';
import { ImportProposalModal } from '../components/goals/ImportProposalModal.js';
import { FindingPickerModal } from '../components/goals/FindingPickerModal.js';
import { EvidencePickerModal } from '../components/findings/EvidencePickerModal.js';
import { InlineAdd } from '../components/common/InlineAdd.js';
import { RowMenu } from '../components/common/RowMenu.js';
import { SortableList, SortableRow } from '../components/common/Sortable.js';

/** Per-node collapse state shared down the tree, keyed `t:<id>` / `a:<id>`. */
interface CollapseState {
  collapsed: Set<string>;
  toggle: (key: string) => void;
}

/**
 * The goal a `?goal=` deep link has just arrived at, so that one row can flash.
 * A context rather than a prop: the row is three components down (Target →
 * Activity → Goal) and only the leaf cares, so threading it would put a prop on
 * two components that never read it.
 */
const ArrivedGoalContext = createContext<number | null>(null);

export function GoalsPage() {
  const { slug = '' } = useParams();
  const { canWrite, canAdmin } = useEngagementPermissions(slug);
  const { data: tree, isLoading, isError, refetch } = useGoals(slug);
  const toast = useToast();
  const [importOpen, setImportOpen] = useState(false);
  const createTarget = useCreateTarget(slug);
  const reorderTargets = useReorderTargets(slug);

  const targets = tree?.targets ?? [];
  const hasTargets = targets.length > 0;

  // Collapse state (Target/Activity). Goals are leaves and always shown.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const allKeys = useMemo(() => {
    const keys: string[] = [];
    for (const t of targets) {
      keys.push(`t:${t.id}`);
      for (const a of t.activities) keys.push(`a:${a.id}`);
    }
    return keys;
  }, [targets]);
  const allCollapsed = allKeys.length > 0 && allKeys.every((k) => collapsed.has(k));
  const collapseState: CollapseState = { collapsed, toggle };

  // `?goal=<id>` (see goalDeepLink.ts) — a "Linked goals" card on a finding or an
  // evidence item sends the reader here. Expand the goal's Target and Activity
  // first: both start expanded, but "Collapse all" is one click away, and a reader
  // who collapsed the tree and then followed a link would otherwise land on a page
  // with nothing to see.
  const arrivedRaw = useDeepLinkRow(
    GOAL_PARAM,
    (raw) => {
      if (!/^\d+$/.test(raw)) return null;
      const id = Number(raw);
      for (const t of targets) {
        for (const a of t.activities) {
          if (!a.goals.some((g) => g.id === id)) continue;
          return {
            rowId: goalRowId(id),
            reveal: () =>
              setCollapsed((prev) => {
                const next = new Set(prev);
                next.delete(`t:${t.id}`);
                next.delete(`a:${a.id}`);
                return next;
              }),
          };
        }
      }
      // A goal deleted since the link was made: nothing to scroll to, and the
      // shared hook drops the param so it can't sit in the address bar.
      return null;
    },
    !isLoading && tree !== undefined,
  );
  const arrivedGoal = arrivedRaw === null ? null : Number(arrivedRaw);

  async function addTarget(name: string) {
    try {
      await createTarget.mutateAsync({ name, description: '' });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not add target');
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold text-text">Goals</h2>
          <p className="text-sm text-muted">
            Scope tree: Target → Activity → Goal. Progress rolls up from each goal’s status.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {hasTargets && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(allKeys))}
            >
              {allCollapsed ? 'Expand all' : 'Collapse all'}
            </Button>
          )}
          <Button
            variant="secondary"
            onClick={() => setImportOpen(true)}
            disabled={!canWrite}
            title={canWrite ? undefined : READ_ONLY_TITLE}
          >
            Import proposal
          </Button>
        </div>
      </div>

      <ObjectivesNarrative slug={slug} canEdit={canAdmin} canWrite={canWrite} />

      {tree && tree.progress.total > 0 && (
        <Card className="space-y-2 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-text">Progress</h3>
            <div className="flex flex-wrap gap-1.5">
              <Badge tone="success">{tree.progress.complete} complete</Badge>
              <Badge tone="accent">{tree.progress.inProgress} in progress</Badge>
              <Badge tone="neutral">{tree.progress.notStarted} not started</Badge>
              {tree.progress.notApplicable > 0 && (
                <Badge tone="neutral">{tree.progress.notApplicable} N/A</Badge>
              )}
            </div>
          </div>
          <ProgressBar progress={tree.progress} showLabel />
        </Card>
      )}

      {isLoading ? (
        <Spinner />
      ) : isError ? (
        <ErrorState description="Couldn’t load goals." onRetry={() => refetch()} />
      ) : !hasTargets ? (
        <EmptyState
          title="No targets yet"
          description="Import a proposal to build the goals tree automatically, or add a target to start manually."
          action={
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                onClick={() => setImportOpen(true)}
                disabled={!canWrite}
                title={canWrite ? undefined : READ_ONLY_TITLE}
              >
                Import proposal
              </Button>
              <InlineAdd
                label="Add target"
                placeholder="Target name — e.g. Web application"
                onAdd={addTarget}
                disabled={!canWrite}
                disabledTitle={READ_ONLY_TITLE}
              />
            </div>
          }
        />
      ) : (
        <div className="space-y-3">
          <ArrivedGoalContext.Provider value={arrivedGoal}>
            <SortableList
              ids={targets.map((t) => t.id)}
              onReorder={(ids) => reorderTargets.mutate(ids)}
            >
              <div className="space-y-3">
                {targets.map((target) => (
                  <SortableRow key={target.id} id={target.id} disabled={!canWrite}>
                    {(handle) => (
                      <TargetCard
                        slug={slug}
                        target={target}
                        canWrite={canWrite}
                        handle={handle}
                        collapse={collapseState}
                      />
                    )}
                  </SortableRow>
                ))}
              </div>
            </SortableList>
          </ArrivedGoalContext.Provider>
          <InlineAdd
            label="Add target"
            placeholder="Target name — e.g. Web application"
            onAdd={addTarget}
            disabled={!canWrite}
            disabledTitle={READ_ONLY_TITLE}
          />
        </div>
      )}

      <ImportProposalModal slug={slug} open={importOpen} onClose={() => setImportOpen(false)} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Objectives narrative — autosaved to the engagement (admin-gated).
// ---------------------------------------------------------------------------

function ObjectivesNarrative({
  slug,
  canEdit,
  canWrite,
}: {
  slug: string;
  canEdit: boolean;
  canWrite: boolean;
}) {
  const { data: eng } = useEngagement(slug);
  const update = useUpdateEngagement(slug);

  const seededSlug = useRef<string | null>(null);
  const [value, setValue] = useState('');
  const [baseline, setBaseline] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (eng && seededSlug.current !== eng.slug) {
      seededSlug.current = eng.slug;
      const seeded = eng.objectivesNarrative ?? '';
      setValue(seeded);
      setBaseline(seeded);
    }
  }, [eng]);

  const { status, flush } = useAutosave<string>({
    value,
    baseline,
    isValid: () => canEdit,
    save: async (v) => {
      await update.mutateAsync({ objectivesNarrative: v.trim() === '' ? null : v });
      setBaseline(v);
    },
  });

  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-text">Objectives</h3>
          <p className="mt-0.5 text-xs text-muted">
            A short narrative of the engagement’s objectives (shown in the report’s scope coverage).
            {!canEdit && canWrite && ' Only engagement admins can edit this.'}
          </p>
        </div>
        {canEdit && <SaveStatusIndicator status={status} />}
      </div>
      <MarkdownField
        rows={4}
        value={value}
        onChange={(v) => setValue(v)}
        onBlur={() => void flush()}
        disabled={!canEdit}
        title={canEdit ? undefined : ADMIN_ONLY_TITLE}
        placeholder="Describe the objectives / areas of interest for this engagement…"
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Rollup helpers for collapsed summaries
// ---------------------------------------------------------------------------

function goalCounts(goals: Goal[]): { total: number; complete: number } {
  let complete = 0;
  for (const g of goals) if (g.status === 'complete') complete++;
  return { total: goals.length, complete };
}

/** A muted "N/M complete" summary chip for a collapsed node. */
function CountSummary({
  prefix,
  complete,
  total,
}: {
  prefix?: string;
  complete: number;
  total: number;
}) {
  return (
    <span className="text-xs font-normal text-muted">
      {prefix}
      {total === 0 ? 'empty' : `${complete}/${total} complete`}
    </span>
  );
}

/** A small ▸/▾ collapse toggle. */
function Caret({ open, onClick, label }: { open: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={open}
      aria-label={label}
      className={`shrink-0 select-none px-0.5 text-xs text-muted transition-transform hover:text-text ${
        open ? 'rotate-90' : ''
      }`}
    >
      ▶
    </button>
  );
}

// ---------------------------------------------------------------------------
// Target card
// ---------------------------------------------------------------------------

function TargetCard({
  slug,
  target,
  canWrite,
  handle,
  collapse,
}: {
  slug: string;
  target: Target;
  canWrite: boolean;
  handle: ReactNode;
  collapse: CollapseState;
}) {
  const confirm = useConfirm();
  const toast = useToast();
  const del = useDeleteTarget(slug);
  const createActivity = useCreateActivity(slug);
  const reorderActivities = useReorderActivities(slug);
  const [editing, setEditing] = useState(false);

  const key = `t:${target.id}`;
  const open = !collapse.collapsed.has(key);
  const allGoals = target.activities.flatMap((a) => a.goals);
  const counts = goalCounts(allGoals);

  async function remove() {
    const ok = await confirm({
      title: 'Delete target',
      message: `Delete “${target.name}” and all of its activities and goals? This can’t be undone.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await del.mutateAsync(target.id);
      toast.success('Target deleted');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Delete failed');
    }
  }

  async function addActivity(name: string) {
    try {
      await createActivity.mutateAsync({ targetId: target.id, input: { name, category: '' } });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not add activity');
    }
  }

  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-center gap-2">
        {handle}
        <Caret open={open} onClick={() => collapse.toggle(key)} label={`Toggle ${target.name}`} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <h3 className="truncate text-base font-semibold text-text">{target.name}</h3>
            {!open && (
              <CountSummary
                prefix={`${target.activities.length} ${target.activities.length === 1 ? 'activity' : 'activities'} · `}
                complete={counts.complete}
                total={counts.total}
              />
            )}
          </div>
          {open && target.description && (
            <p className="mt-0.5 text-sm text-muted">{target.description}</p>
          )}
        </div>
        {canWrite && (
          <RowMenu
            label={`Target actions for ${target.name}`}
            items={[
              { label: 'Edit target…', onSelect: () => setEditing(true) },
              { label: 'Delete target', onSelect: () => void remove(), danger: true },
            ]}
          />
        )}
      </div>

      {open && (
        <div className="space-y-2 pl-6">
          {target.activities.length === 0 ? (
            <p className="text-sm text-muted">No activities yet.</p>
          ) : (
            <SortableList
              ids={target.activities.map((a) => a.id)}
              onReorder={(ids) =>
                reorderActivities.mutate({ targetId: target.id, orderedIds: ids })
              }
            >
              <div className="space-y-2">
                {target.activities.map((activity) => (
                  <SortableRow key={activity.id} id={activity.id} disabled={!canWrite}>
                    {(aHandle) => (
                      <ActivityBlock
                        slug={slug}
                        activity={activity}
                        canWrite={canWrite}
                        handle={aHandle}
                        collapse={collapse}
                      />
                    )}
                  </SortableRow>
                ))}
              </div>
            </SortableList>
          )}
          {canWrite && (
            <InlineAdd
              label="Add activity"
              placeholder="Activity name"
              onAdd={addActivity}
              disabled={!canWrite}
              disabledTitle={READ_ONLY_TITLE}
            />
          )}
        </div>
      )}

      <TargetModal slug={slug} open={editing} onClose={() => setEditing(false)} target={target} />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Activity block
// ---------------------------------------------------------------------------

function ActivityBlock({
  slug,
  activity,
  canWrite,
  handle,
  collapse,
}: {
  slug: string;
  activity: Activity;
  canWrite: boolean;
  handle: ReactNode;
  collapse: CollapseState;
}) {
  const confirm = useConfirm();
  const toast = useToast();
  const del = useDeleteActivity(slug);
  const createGoal = useCreateGoal(slug);
  const reorderGoals = useReorderGoals(slug);
  const [editing, setEditing] = useState(false);

  const key = `a:${activity.id}`;
  const open = !collapse.collapsed.has(key);
  const counts = goalCounts(activity.goals);

  async function remove() {
    const ok = await confirm({
      title: 'Delete activity',
      message: `Delete “${activity.name}” and its goals? This can’t be undone.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await del.mutateAsync(activity.id);
      toast.success('Activity deleted');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Delete failed');
    }
  }

  async function addGoal(title: string) {
    try {
      await createGoal.mutateAsync({
        activityId: activity.id,
        input: { title, notes: '', isRetest: false },
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not add goal');
    }
  }

  return (
    <div className="rounded-card border border-border bg-surface-2 p-3">
      <div className="flex items-center gap-2">
        {handle}
        <Caret open={open} onClick={() => collapse.toggle(key)} label={`Toggle ${activity.name}`} />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-baseline gap-x-1.5 text-sm font-medium text-text">
            <span className="truncate">{activity.name}</span>
            {activity.category && (
              <span className="text-xs font-normal text-muted">· {activity.category}</span>
            )}
            {!open && <CountSummary prefix="· " complete={counts.complete} total={counts.total} />}
          </p>
        </div>
        {canWrite && (
          <RowMenu
            label={`Activity actions for ${activity.name}`}
            items={[
              { label: 'Edit activity…', onSelect: () => setEditing(true) },
              { label: 'Delete activity', onSelect: () => void remove(), danger: true },
            ]}
          />
        )}
      </div>

      {open && (
        <div className="mt-2 space-y-2 pl-6">
          {activity.goals.length === 0 ? (
            <p className="text-sm text-muted">No goals yet.</p>
          ) : (
            <SortableList
              ids={activity.goals.map((g) => g.id)}
              onReorder={(ids) => reorderGoals.mutate({ activityId: activity.id, orderedIds: ids })}
            >
              <ul className="flex flex-col gap-2">
                {activity.goals.map((goal) => (
                  <SortableRow key={goal.id} id={goal.id} disabled={!canWrite}>
                    {(gHandle) => (
                      <GoalRow slug={slug} goal={goal} canWrite={canWrite} handle={gHandle} />
                    )}
                  </SortableRow>
                ))}
              </ul>
            </SortableList>
          )}
          {canWrite && (
            <InlineAdd
              label="Add goal"
              placeholder="Goal title"
              onAdd={addGoal}
              disabled={!canWrite}
              disabledTitle={READ_ONLY_TITLE}
            />
          )}
        </div>
      )}

      <ActivityModal
        slug={slug}
        open={editing}
        onClose={() => setEditing(false)}
        activity={activity}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Goal row
// ---------------------------------------------------------------------------

function GoalRow({
  slug,
  goal,
  canWrite,
  handle,
}: {
  slug: string;
  goal: Goal;
  canWrite: boolean;
  handle: ReactNode;
}) {
  const confirm = useConfirm();
  const toast = useToast();
  const updateGoal = useUpdateGoal(slug);
  const del = useDeleteGoal(slug);
  const linkEvidence = useLinkGoalEvidence(slug);
  const [editing, setEditing] = useState(false);
  const [pickEvidence, setPickEvidence] = useState(false);
  const [pickFinding, setPickFinding] = useState(false);
  /** This is the goal a `?goal=` deep link just arrived at — flash the row. */
  const arrived = useContext(ArrivedGoalContext) === goal.id;

  async function setStatus(status: Goal['status']) {
    try {
      await updateGoal.mutateAsync({ id: goal.id, patch: { status } });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not update status');
    }
  }

  async function remove() {
    const ok = await confirm({
      title: 'Delete goal',
      message: `Delete “${goal.title}”? Linked evidence and findings are kept.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await del.mutateAsync(goal.id);
      toast.success('Goal deleted');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Delete failed');
    }
  }

  async function onPickEvidence(picked: { uuid: string }[]) {
    if (picked.length === 0) return;
    try {
      await linkEvidence.mutateAsync({ goalId: goal.id, evidenceUuids: picked.map((e) => e.uuid) });
      toast.success(`Linked ${picked.length} evidence`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not link evidence');
    }
  }

  return (
    <li
      id={goalRowId(goal.id)}
      className={`rounded-input border border-border bg-surface p-2.5 transition-colors ${
        arrived ? DEEP_LINK_HIGHLIGHT : ''
      }`}
    >
      <div className="flex items-center gap-2">
        {handle}
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="min-w-0 truncate text-sm text-text">{goal.title}</span>
          {goal.isRetest && <Badge tone="warning">Retest</Badge>}
        </div>
        <GoalStatusControl
          value={goal.status}
          onChange={(status) => void setStatus(status)}
          disabled={!canWrite}
          disabledTitle={READ_ONLY_TITLE}
        />
        {!canWrite && <span className="text-xs text-muted">{GOAL_STATUS_LABELS[goal.status]}</span>}
        {canWrite && (
          <>
            <RowMenu
              triggerLabel="＋ Link…"
              label={`Link to ${goal.title}`}
              items={[
                {
                  label: `Link evidence (${goal.numEvidence})`,
                  onSelect: () => setPickEvidence(true),
                },
                {
                  label: `Link finding (${goal.numFindings})`,
                  onSelect: () => setPickFinding(true),
                },
              ]}
            />
            <RowMenu
              label={`Goal actions for ${goal.title}`}
              items={[
                { label: 'Edit goal…', onSelect: () => setEditing(true) },
                { label: 'Delete goal', onSelect: () => void remove(), danger: true },
              ]}
            />
          </>
        )}
      </div>

      {(goal.notes || goal.numEvidence > 0 || goal.numFindings > 0) && (
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-7 text-xs text-muted">
          {(goal.numEvidence > 0 || goal.numFindings > 0) && (
            <span>
              Evidence ({goal.numEvidence}) · Findings ({goal.numFindings})
            </span>
          )}
          {goal.notes && <span className="min-w-0">{goal.notes}</span>}
        </div>
      )}

      <GoalModal slug={slug} open={editing} onClose={() => setEditing(false)} goal={goal} />
      {/*
        Reuse the finding's evidence picker in selection mode. On pick, link the
        chosen evidence to this goal. We don't know linked uuids from the tree, so
        we don't pre-filter — the server ignores duplicate links.
      */}
      <EvidencePickerModal
        slug={slug}
        attachedUuids={[]}
        targetInPath={false}
        open={pickEvidence}
        onClose={() => setPickEvidence(false)}
        onPick={(picked) => void onPickEvidence(picked)}
      />
      <FindingPickerModal
        slug={slug}
        goalId={goal.id}
        linkedUuids={[]}
        open={pickFinding}
        onClose={() => setPickFinding(false)}
      />
    </li>
  );
}

// ---------------------------------------------------------------------------
// Target / Activity / Goal edit modals (the "full" editor; quick-add is inline)
// ---------------------------------------------------------------------------

function TargetModal({
  slug,
  open,
  onClose,
  target,
}: {
  slug: string;
  open: boolean;
  onClose: () => void;
  target: Target;
}) {
  const toast = useToast();
  const update = useUpdateTarget(slug);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  useEffect(() => {
    if (open) {
      setName(target.name);
      setDescription(target.description ?? '');
    }
  }, [open, target]);

  async function submit() {
    try {
      await update.mutateAsync({ id: target.id, patch: { name, description } });
      toast.success('Target updated');
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save target');
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Edit target"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={update.isPending}>
            Cancel
          </Button>
          <Button onClick={submit} loading={update.isPending} disabled={!name.trim()}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Name" htmlFor="t-name">
          <Input id="t-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <Field label="Description" htmlFor="t-desc" hint="Optional">
          <MarkdownField
            id="t-desc"
            rows={3}
            value={description}
            onChange={(v) => setDescription(v)}
          />
        </Field>
      </div>
    </Modal>
  );
}

function ActivityModal({
  slug,
  open,
  onClose,
  activity,
}: {
  slug: string;
  open: boolean;
  onClose: () => void;
  activity: Activity;
}) {
  const toast = useToast();
  const update = useUpdateActivity(slug);
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');

  useEffect(() => {
    if (open) {
      setName(activity.name);
      setCategory(activity.category ?? '');
    }
  }, [open, activity]);

  async function submit() {
    try {
      await update.mutateAsync({ id: activity.id, patch: { name, category } });
      toast.success('Activity updated');
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save activity');
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Edit activity"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={update.isPending}>
            Cancel
          </Button>
          <Button onClick={submit} loading={update.isPending} disabled={!name.trim()}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Name" htmlFor="a-name">
          <Input id="a-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <Field
          label="Category"
          htmlFor="a-cat"
          hint="Optional testing category (used to label the auto-created tag)."
        >
          <Input id="a-cat" value={category} onChange={(e) => setCategory(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

function GoalModal({
  slug,
  open,
  onClose,
  goal,
}: {
  slug: string;
  open: boolean;
  onClose: () => void;
  goal: Goal;
}) {
  const toast = useToast();
  const update = useUpdateGoal(slug);
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [isRetest, setIsRetest] = useState(false);

  useEffect(() => {
    if (open) {
      setTitle(goal.title);
      setNotes(goal.notes ?? '');
      setIsRetest(goal.isRetest);
    }
  }, [open, goal]);

  async function submit() {
    try {
      await update.mutateAsync({ id: goal.id, patch: { title, notes, isRetest } });
      toast.success('Goal updated');
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save goal');
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Edit goal"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={update.isPending}>
            Cancel
          </Button>
          <Button onClick={submit} loading={update.isPending} disabled={!title.trim()}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Title" htmlFor="g-title">
          <Input id="g-title" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        </Field>
        <Field label="Notes" htmlFor="g-notes" hint="Optional">
          <Textarea
            id="g-notes"
            rows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </Field>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-text">
          <input
            type="checkbox"
            checked={isRetest}
            onChange={(e) => setIsRetest(e.target.checked)}
            className="h-4 w-4 rounded border-border text-accent accent-[var(--accent)]"
          />
          Retest item (carried over from a prior report)
        </label>
      </div>
    </Modal>
  );
}
