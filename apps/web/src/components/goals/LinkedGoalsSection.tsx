import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Card, Spinner, useToast } from '@reporter/ui';
import { GOAL_STATUS_LABELS, type LinkedGoal } from '@reporter/shared';
import {
  useGoalsForEvidence,
  useGoalsForFinding,
  useLinkGoalEvidence,
  useLinkGoalFinding,
  useUnlinkGoalEvidence,
  useUnlinkGoalFinding,
} from '../../api/hooks.js';
import { GoalStatusDot } from './GoalStatusDot.js';
import { GoalPickerModal } from './GoalPickerModal.js';
import { goalHref } from './goalDeepLink.js';

/**
 * A compact "Linked goals" card for an evidence or finding detail page. Lists the
 * goals the item is linked to (with target/activity context and an unlink button)
 * and offers an "Add to goal" picker. Read-only users see the list without controls.
 *
 * Each title deep-links to that goal in the Goals tree — see {@link goalHref},
 * which owns the `?goal=<id>` grammar the Goals page scrolls and flashes on.
 */
export function LinkedGoalsSection({
  slug,
  kind,
  uuid,
  canWrite,
}: {
  slug: string;
  kind: 'evidence' | 'finding';
  uuid: string;
  canWrite: boolean;
}) {
  const toast = useToast();
  const [picking, setPicking] = useState(false);

  const evidenceQuery = useGoalsForEvidence(slug, kind === 'evidence' ? uuid : '');
  const findingQuery = useGoalsForFinding(slug, kind === 'finding' ? uuid : '');
  const query = kind === 'evidence' ? evidenceQuery : findingQuery;

  const linkEvidence = useLinkGoalEvidence(slug);
  const unlinkEvidence = useUnlinkGoalEvidence(slug);
  const linkFinding = useLinkGoalFinding(slug);
  const unlinkFinding = useUnlinkGoalFinding(slug);

  const linking = kind === 'evidence' ? linkEvidence : linkFinding;
  const goals: LinkedGoal[] = query.data ?? [];

  async function link(goalId: number) {
    try {
      if (kind === 'evidence') {
        await linkEvidence.mutateAsync({ goalId, evidenceUuids: [uuid] });
      } else {
        await linkFinding.mutateAsync({ goalId, findingUuids: [uuid] });
      }
      toast.success('Linked to goal');
      setPicking(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not link goal');
    }
  }

  async function unlink(goalId: number) {
    try {
      if (kind === 'evidence') {
        await unlinkEvidence.mutateAsync({ goalId, evidenceUuid: uuid });
      } else {
        await unlinkFinding.mutateAsync({ goalId, findingUuid: uuid });
      }
      toast.success('Unlinked from goal');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not unlink goal');
    }
  }

  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-text">Linked goals</h3>
        {canWrite && (
          <Button size="sm" variant="secondary" onClick={() => setPicking(true)}>
            Add to goal
          </Button>
        )}
      </div>

      {query.isLoading ? (
        <Spinner size={18} />
      ) : query.isError ? (
        <p className="text-sm text-danger">Couldn’t load linked goals.</p>
      ) : goals.length === 0 ? (
        <p className="text-sm text-muted">
          Not linked to any goal yet. Use “Add to goal” to track this against an objective.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {goals.map((g) => (
            <li
              key={g.id}
              className="flex items-start gap-2 rounded-input border border-border bg-surface-2 px-2.5 py-2"
            >
              <span className="pt-0.5">
                <GoalStatusDot status={g.status} />
              </span>
              <div className="min-w-0 flex-1">
                <Link
                  to={goalHref(slug, g.id)}
                  title="Show this goal in the Goals tree"
                  className="block truncate rounded text-sm text-text hover:text-accent hover:underline"
                >
                  {g.title}
                </Link>
                <p className="truncate text-xs text-muted">
                  {g.targetName} · {g.activityName} · {GOAL_STATUS_LABELS[g.status]}
                </p>
              </div>
              {canWrite && (
                <button
                  type="button"
                  onClick={() => unlink(g.id)}
                  aria-label={`Remove ${g.title}`}
                  className="shrink-0 text-xs font-medium text-muted hover:text-danger"
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <GoalPickerModal
        slug={slug}
        open={picking}
        onClose={() => setPicking(false)}
        onPick={link}
        excludeGoalIds={goals.map((g) => g.id)}
        busy={linking.isPending}
      />
    </Card>
  );
}
