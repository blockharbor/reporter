// @vitest-environment jsdom
//
// jsdom is scoped to this file by the docblock above rather than set globally in
// vitest.config.ts: the rest of the suite is pure logic and runs in node.
//
// The data layer is mocked at the hooks and permissions modules, matching the
// TagManager precedent: what this file asserts is the tab strip's contract
// with the role — which tabs render, in which order, and that the Audit log
// tab is OPTIMISTIC while the role is unknown rather than flickering in.
import { cleanup, screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import type { Engagement } from '@reporter/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../test-utils.js';
import { EngagementLayout } from './EngagementLayout.js';

// vitest runs without `globals`, so RTL's auto-cleanup never registers itself.
afterEach(cleanup);

const mocks = vi.hoisted(() => ({
  engagement: {
    data: undefined as Engagement | undefined,
    isLoading: false,
    isError: false,
  },
  canWrite: false,
}));

vi.mock('../api/hooks.js', () => ({
  useEngagement: () => mocks.engagement,
}));

vi.mock('../lib/permissions.js', () => ({
  useEngagementPermissions: () => ({ canWrite: mocks.canWrite, canAdmin: false }),
}));

const loaded = {
  name: 'Operation One',
  status: 'active',
  startedAt: '2026-01-05T00:00:00.000Z',
  projectedEndAt: null,
  actualEndAt: null,
  numEvidence: 3,
  numFindings: 0,
  progress: null,
} as unknown as Engagement;

beforeEach(() => {
  mocks.engagement = { data: loaded, isLoading: false, isError: false };
  mocks.canWrite = false;
});

/** Mounted the way App.tsx mounts it: a layout route with one child, so the relative tab links resolve against `/engagements/:slug`. */
function renderLayout() {
  return renderWithProviders(
    <Routes>
      <Route path="/engagements/:slug" element={<EngagementLayout />}>
        <Route path="evidence" element={<p>evidence</p>} />
      </Route>
    </Routes>,
    { route: '/engagements/op1/evidence' },
  );
}

const tabLabels = () => screen.getAllByRole('link').map((a) => a.textContent);

describe('EngagementLayout tabs', () => {
  it('shows Audit log between Saved queries and Settings for a writer', () => {
    mocks.canWrite = true;
    renderLayout();
    expect(tabLabels()).toEqual([
      'Evidence',
      'Goals',
      'Findings',
      'Reports',
      'Saved queries',
      'Audit log',
      'Settings',
    ]);
    expect(screen.getByRole('link', { name: 'Audit log' }).getAttribute('href')).toBe(
      '/engagements/op1/audit-log',
    );
  });

  it('hides Audit log once the role is known to be read-only, Settings still last', () => {
    renderLayout();
    expect(tabLabels()).toEqual([
      'Evidence',
      'Goals',
      'Findings',
      'Reports',
      'Saved queries',
      'Settings',
    ]);
  });

  it('renders Audit log optimistically while the engagement is still loading', () => {
    // canWrite reports false until the engagement resolves; the tab must not
    // flicker in on every load, so an unknown role keeps it.
    mocks.engagement = { data: undefined, isLoading: true, isError: false };
    renderLayout();
    expect(tabLabels()).toContain('Audit log');
    expect(screen.getByRole('status', { name: 'Loading' })).toBeTruthy();
  });

  it('keeps the strip, Audit log included, when the engagement fails to load', () => {
    mocks.engagement = { data: undefined, isLoading: false, isError: true };
    renderLayout();
    expect(screen.getByText("Couldn't load this engagement.")).toBeTruthy();
    expect(tabLabels()).toContain('Audit log');
    expect(tabLabels()).toContain('Settings');
  });
});
