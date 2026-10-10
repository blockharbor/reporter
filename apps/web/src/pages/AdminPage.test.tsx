// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { useLocation, useNavigationType } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../test-utils.js';
import { ADMIN_TABS, AdminPage } from './AdminPage.js';

// vitest runs without `globals`, so RTL's auto-cleanup never registers itself.
afterEach(cleanup);

/**
 * The page is the tab strip plus five data tabs and the Audit log tab. Only
 * the strip is under test here — which tab `?tab=` selects and how a switch
 * writes the URL — so every hook returns an empty, settled result, the raw
 * `api` the Default tags tab reaches for is a stub, and the Audit log tab is
 * a marker, because its own behaviour has its own test file.
 */
const settled = { data: [], isLoading: false, isError: false, refetch: vi.fn() };
const mutation = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false };
vi.mock('../api/hooks.js', () => ({
  useUsers: () => settled,
  useAdminEngagements: () => settled,
  useReportTemplates: () => settled,
  useUserApiKeys: () => settled,
  useReportSettings: () => ({
    data: { organizationName: 'Acme', accentColor: '#112233', logoDataUri: null, footerNote: null },
    isLoading: false,
    isError: false,
  }),
  useCreateUser: () => mutation,
  useUpdateUser: () => mutation,
  useDeleteUser: () => mutation,
  useGenerateRecoveryLink: () => mutation,
  useResetTotp: () => mutation,
  useRevokeUserApiKey: () => mutation,
  useDeleteEngagement: () => mutation,
  useUpdateReportSettings: () => mutation,
  useUpdateReportTemplate: () => mutation,
  useDeleteReportTemplate: () => mutation,
}));
vi.mock('../api/client.js', () => ({
  api: {
    get: vi.fn(async () => []),
    post: vi.fn(async () => ({})),
    put: vi.fn(async () => ({})),
    delete: vi.fn(async () => ({})),
  },
  ApiError: class ApiError extends Error {
    status = 500;
  },
}));
// The Users tab reads the signed-in user to keep an admin from deleting themselves.
vi.mock('../auth.js', () => ({
  useAuth: () => ({
    user: {
      slug: 'ada-admin',
      firstName: 'Ada',
      lastName: 'Admin',
      email: 'ada@example.com',
      admin: true,
      disabled: false,
      headless: false,
    },
  }),
}));
vi.mock('../components/admin/AuditLogTab.js', () => ({
  AuditLogTab: () => <output data-testid="audit-log-tab">audit log tab</output>,
}));

/** Reports the current location and how it was reached, so a test can tell a push from a replace. */
function LocationProbe() {
  const loc = useLocation();
  const type = useNavigationType();
  return <output data-testid="location">{`${type} ${loc.pathname}${loc.search}`}</output>;
}

function renderPage(route = '/admin') {
  return renderWithProviders(
    <>
      <AdminPage />
      <LocationProbe />
    </>,
    { route },
  );
}

const location = () => screen.getByTestId('location').textContent;
const selectedTab = () =>
  screen.getAllByRole('tab').find((t) => t.getAttribute('aria-selected') === 'true')?.textContent;

describe('AdminPage ?tab=', () => {
  it('offers the six tabs, Audit log last', () => {
    renderPage();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(
      ADMIN_TABS.map((t) => t.label),
    );
    expect(ADMIN_TABS.at(-1)?.key).toBe('audit-log');
  });

  it('selects Users when ?tab= is absent, and when it names a tab that does not exist', () => {
    renderPage('/admin');
    expect(selectedTab()).toBe('Users');
    cleanup();
    renderPage('/admin?tab=not-a-tab');
    expect(selectedTab()).toBe('Users');
    expect(screen.queryByTestId('audit-log-tab')).toBeNull();
  });

  it('selects the tab ?tab= names and renders its body', () => {
    renderPage('/admin?tab=audit-log');
    expect(selectedTab()).toBe('Audit log');
    expect(screen.getByTestId('audit-log-tab')).toBeTruthy();
  });

  it('pushes on a tab switch and drops every other param, which belonged to the tab being left', () => {
    renderPage('/admin?tab=audit-log&q=token&action=update');
    fireEvent.click(screen.getByRole('tab', { name: 'Engagements' }));
    expect(location()).toBe('PUSH /admin?tab=engagements');
    expect(selectedTab()).toBe('Engagements');
  });

  it('writes no ?tab= for Users, so the default view has the canonical URL', () => {
    renderPage('/admin?tab=audit-log');
    fireEvent.click(screen.getByRole('tab', { name: 'Users' }));
    expect(location()).toBe('PUSH /admin');
  });

  it('does not push an identical entry when the active tab is clicked again', () => {
    renderPage('/admin?tab=audit-log');
    expect(location()).toBe('POP /admin?tab=audit-log');
    fireEvent.click(screen.getByRole('tab', { name: 'Audit log' }));
    // Still the initial entry: a re-click is not navigation, so Back keeps working.
    expect(location()).toBe('POP /admin?tab=audit-log');
  });
});
