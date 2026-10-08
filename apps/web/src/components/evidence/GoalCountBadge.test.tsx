// @vitest-environment jsdom
//
// jsdom is scoped to this file by the docblock above rather than set globally in
// vitest.config.ts: the rest of the suite is pure logic and runs in node.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { GoalCountBadge, goalCountTitle } from './GoalCountBadge.js';

// vitest runs without `globals`, so RTL's auto-cleanup never registers itself.
afterEach(cleanup);

describe('goalCountTitle', () => {
  it('reads as a sentence, singular at one', () => {
    expect(goalCountTitle(1)).toBe('Linked to 1 goal');
    expect(goalCountTitle(2)).toBe('Linked to 2 goals');
    // Never rendered (the badge is absent at zero) but the wording still has to
    // be grammatical for any caller that reaches for the sentence alone.
    expect(goalCountTitle(0)).toBe('Linked to 0 goals');
  });
});

describe('GoalCountBadge', () => {
  it('renders nothing when the evidence is linked to no goal', () => {
    const { container } = render(<GoalCountBadge evidence={{ numGoals: 0 }} />);
    expect(container.innerHTML).toBe('');
  });

  it('shows the count, with the full wording as its tooltip', () => {
    render(<GoalCountBadge evidence={{ numGoals: 2 }} />);
    const badge = screen.getByTitle('Linked to 2 goals');
    // The glyph is decorative, so the number is the badge's only text.
    expect(badge.textContent?.trim()).toContain('2');
    expect(badge.querySelector('[aria-hidden]')).not.toBeNull();
  });

  it('keeps the tooltip singular for a single goal', () => {
    render(<GoalCountBadge evidence={{ numGoals: 1 }} />);
    expect(screen.getByTitle('Linked to 1 goal')).toBeTruthy();
  });
});
