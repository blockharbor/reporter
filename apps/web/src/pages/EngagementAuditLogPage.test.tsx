// @vitest-environment jsdom
import { cleanup, screen } from '@testing-library/react';
import { Route, Routes, useLocation, useNavigationType } from 'react-router-dom';
import type { AuditEntry, AuditFacets, AuditLogPage } from '@reporter/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../test-utils.js';
import { EngagementAuditLogPage } from './EngagementAuditLogPage.js';

afterEach(cleanup);

/**
 * The page composes the audit module (tested on its own) under a role gate;
 * what is under test here is the gate, the `enabled` wiring that keeps a
 * read-only deep link from ever fetching, and the page clamp's refusal to act
 * on keepPreviousData's placeholder. Hooks and auth are mocked; the route
 * carries the slug the page reads.
 */
const mocks = vi.hoisted(() => ({
  engagement: {
    data: undefined as { slug: string; name: string; role: string } | undefined,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  },
  user: { slug: 'wendy', firstName: 'Wendy', lastName: 'Writer', email: 'w@x', admin: false },
  log: {
    data: undefined as AuditLogPage | undefined,
    isLoading: false,
    isError: false,
    isFetching: false,
    isPlaceholderData: false,
    refetch: vi.fn(),
  },
  logCalls: [] as unknown[][],
  facets: { data: undefined as AuditFacets | undefined },
}));
vi.mock('../api/hooks.js', () => ({
  useEngagement: () => mocks.engagement,
  useAuditLog: (...args: unknown[]) => {
    mocks.logCalls.push(args);
    return mocks.log;
  },
  useAuditFacets: () => mocks.facets,
}));
vi.mock('../auth.js', () => ({ useAuth: () => ({ user: mocks.user }) }));

const entry: AuditEntry = {
  uuid: 'e-1',
  engagement: { slug: 'op1', name: 'Op One', deleted: false },
  actor: { name: 'Wendy Writer', email: 'w@x', slug: 'wendy', currentName: null },
  via: 'session',
  action: 'update',
  entityType: 'finding',
  entityId: 'f-1',
  entityLabel: 'CAN bus replay',
  summary: 'Edited finding “CAN bus replay”: Title',
  changes: [{ kind: 'field', field: 'title', from: 'a', to: 'b' }],
  coalescedCount: 1,
  source: 'intent',
  createdAt: '2026-03-01T10:00:00.000Z',
  lastAt: '2026-03-01T10:00:00.000Z',
  deleted: null,
};
const onePage: AuditLogPage = { items: [entry], total: 1, page: 1, pageSize: 50 };

function LocationProbe() {
  const loc = useLocation();
  const type = useNavigationType();
  return <output data-testid="location">{`${type} ${loc.pathname}${loc.search}`}</output>;
}
function renderPage(route = '/engagements/op1/audit-log') {
  return renderWithProviders(
    <Routes>
      <Route
        path="/engagements/:slug/audit-log"
        element={
          <>
            <EngagementAuditLogPage />
            <LocationProbe />
          </>
        }
      />
    </Routes>,
    { route },
  );
}
const location = () => screen.getByTestId('location').textContent;
/** The `enabled` argument of the most recent useAuditLog call. */
const lastEnabled = () => mocks.logCalls.at(-1)?.[2];

beforeEach(() => {
  mocks.engagement = {
    data: { slug: 'op1', name: 'Op One', role: 'write' },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  };
  mocks.user = {
    slug: 'wendy',
    firstName: 'Wendy',
    lastName: 'Writer',
    email: 'w@x',
    admin: false,
  };
  mocks.log = {
    data: onePage,
    isLoading: false,
    isError: false,
    isFetching: false,
    isPlaceholderData: false,
    refetch: vi.fn(),
  };
  mocks.logCalls = [];
  mocks.facets = { data: undefined };
});

describe('EngagementAuditLogPage gate', () => {
  it('shows a writer the log, with the queries enabled', () => {
    renderPage();
    expect(screen.getByRole('table')).toBeTruthy();
    expect(screen.getByText('Edited finding “CAN bus replay”: Title')).toBeTruthy();
    expect(lastEnabled()).toBe(true);
  });

  it('turns a read-only member away with an explanation, and never fetches', () => {
    mocks.engagement.data = { slug: 'op1', name: 'Op One', role: 'read' };
    renderPage();
    expect(screen.getByText('The audit log needs write access')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByRole('link', { name: /Go to Evidence/ }).getAttribute('href')).toBe(
      '/engagements/op1/evidence',
    );
    expect(lastEnabled()).toBe(false);
  });

  it('does not flash the read-only state at a writer while the engagement loads', () => {
    mocks.engagement = { data: undefined, isLoading: true, isError: false, refetch: vi.fn() };
    renderPage();
    expect(screen.queryByText('The audit log needs write access')).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
    expect(lastEnabled()).toBe(false);
  });

  it('lets a site admin in before the engagement resolves', () => {
    mocks.user = { ...mocks.user, admin: true };
    mocks.engagement = { data: undefined, isLoading: true, isError: false, refetch: vi.fn() };
    renderPage();
    expect(lastEnabled()).toBe(true);
  });
});

describe('EngagementAuditLogPage page clamp', () => {
  it('clamps a page past the end with a replace once this query has answered', () => {
    renderPage('/engagements/op1/audit-log?page=9');
    expect(location()).toBe('REPLACE /engagements/op1/audit-log');
  });

  it('leaves the page alone while the rows are another query’s placeholder', () => {
    // Back from a narrowed view to a deep page: keepPreviousData shows the
    // narrowed view's single page until this page's own fetch resolves, and the
    // URL the user asked for must survive that.
    mocks.log = { ...mocks.log, isPlaceholderData: true };
    renderPage('/engagements/op1/audit-log?page=9');
    expect(location()).toBe('POP /engagements/op1/audit-log?page=9');
  });

  it('ignores the site-only engagement params instead of showing them as filters', () => {
    renderPage('/engagements/op1/audit-log?eng=other&noEng=1');
    expect(screen.queryByText(/^Engagement:/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Clear all' })).toBeNull();
    expect(screen.getByRole('table')).toBeTruthy();
  });
});
