/**
 * Both ends of the deep link to a single goal, in one module so the departure and
 * arrival sides cannot drift: {@link goalHref} builds the link (from the "Linked
 * goals" card on a finding or an evidence item), {@link goalRowId} is the anchor
 * the Goals page scrolls to, and `GoalsPage` consumes the param.
 *
 * The Goals route has no address for a single goal — it is
 * `/engagements/:slug/goals` with no param — so this adds one. A goal is named by
 * its database id, not its position: positions change with every drag, and unlike
 * a strategic recommendation (whose position *is* its identity, printed as R1/R2)
 * a goal has a real id to point at.
 */
export const GOAL_PARAM = 'goal';

/** Href to the Goals page, scrolled to and briefly flashing one goal. */
export function goalHref(slug: string, goalId: number): string {
  const params = new URLSearchParams({ [GOAL_PARAM]: String(goalId) });
  return `/engagements/${slug}/goals?${params.toString()}`;
}

/** DOM id of one goal's row, so an arriving link can scroll to it. */
export function goalRowId(goalId: number): string {
  return `goal-row-${goalId}`;
}
