import { describe, expect, it } from 'vitest';
import { GOAL_PARAM, goalHref, goalRowId } from './goalDeepLink.js';

describe('the goal deep link', () => {
  it('addresses one goal, not just the Goals page', () => {
    // The regression: a linked goal used to link to `/engagements/op-1/goals` with
    // no address for the goal itself, so on a large tree the reader landed on a
    // page and had to find the row by eye.
    expect(goalHref('op-1', 42)).toBe('/engagements/op-1/goals?goal=42');
  });

  it('round-trips through the param the Goals page reads', () => {
    const url = new URL(goalHref('op-1', 42), 'https://reporter.invalid');
    expect(url.pathname).toBe('/engagements/op-1/goals');
    expect(url.searchParams.get(GOAL_PARAM)).toBe('42');
  });

  it('names the row the arriving page scrolls to', () => {
    expect(goalRowId(42)).toBe('goal-row-42');
  });
});
