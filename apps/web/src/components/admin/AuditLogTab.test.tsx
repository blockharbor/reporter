// @vitest-environment jsdom
//
// jsdom is scoped to this file by the docblock above rather than set globally in
// vitest.config.ts: the rest of the suite is pure logic and runs in node.
//
// The data layer is mocked at the hooks module (the TagManager precedent): what
// this file asserts is the tab's contract with the URL and with the three admin
// hooks — the four states, which history operation each control performs, the
// engagement facet's three groups, and the removal flow from the disabled
// control on a tombstone to what the mutation is sent.
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useLocation, useNavigationType } from 'react-router-dom';
import {
  DELETED_ENGAGEMENT_LABEL,
  AUDIT_DELETE_REASON_MAX_CHARS,
  AUDIT_ENTRY_ALREADY_REMOVED,
  NO_ENGAGEMENT_LABEL,
  type AuditEntry,
  type AuditFacets,
  type AuditLogPage,
} from '@reporter/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client.js';
import { renderWithProviders } from '../../test-utils.js';
import { AuditLogTab, REMOVE_ENTRY_TITLE } from './AuditLogTab.js';
import {
  REASON_REQUIRED_TITLE,
  REASON_TOO_LONG,
  REMOVAL_CONSEQUENCE,
} from './RemoveAuditEntryModal.js';

// vitest runs without `globals`, so RTL's auto-cleanup never registers itself.
afterEach(cleanup);

/**
 * Hoisted so the `vi.mock` factory below (which vitest lifts above the imports)
 * can read it. Each test overwrites `log` / `facets` and the spies are reset.
 */
const mocks = vi.hoisted(() => ({
  log: {
    data: undefined as AuditLogPage | undefined,
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  },
  facets: { data: undefined as AuditFacets | undefined },
  remove: { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false },
}));

vi.mock('../../api/hooks.js', () => ({
  useAdminAuditLog: () => mocks.log,
  useAdminAuditFacets: () => mocks.facets,
  useRemoveAuditEntry: () => mocks.remove,
}));

/** A minimal entry; each fixture overrides only the fields its case exercises. */
function entry(partial: Partial<AuditEntry> & { uuid: string }): AuditEntry {
  return {
    engagement: { slug: 'op1', name: 'Operation One', deleted: false },
    actor: { name: 'Ada Lovelace', email: 'ada@example.com', slug: 'ada', currentName: null },
    via: 'session',
    action: 'update',
    entityType: 'finding',
    entityId: 'f-1',
    entityLabel: 'CAN bus replay',
    summary: 'Edited finding “CAN bus replay”: Title',
    changes: [{ kind: 'field', field: 'title', from: 'CAN replay', to: 'CAN bus replay' }],
    coalescedCount: 1,
    source: 'intent',
    createdAt: '2026-03-01T10:00:00.000Z',
    lastAt: '2026-03-01T10:00:00.000Z',
    deleted: null,
    ...partial,
  };
}

const live = entry({ uuid: 'e-1' });
const tombstone = entry({
  uuid: 't-1',
  summary: '',
  entityLabel: '',
  changes: [],
  deleted: {
    at: '2026-03-02T09:30:00.000Z',
    byName: 'Grace Hopper',
    byEmail: 'grace@example.com',
    bySlug: 'grace',
    reason: 'Duplicate of the entry above',
  },
});

const page = (items: AuditEntry[], total = items.length): AuditLogPage => ({
  items,
  total,
  page: 1,
  pageSize: 50,
});

const facets: AuditFacets = {
  actors: [{ value: 'ada', label: 'Ada Lovelace', email: 'ada@example.com', deleted: false }],
  actions: ['create', 'update'],
  entityTypes: ['finding'],
  engagements: [
    { slug: 'op1', name: 'Operation One', deleted: false },
    { slug: 'op2', name: 'Operation Two', deleted: false },
    { slug: 'old-eng', name: 'Old Engagement', deleted: true },
  ],
  logStartsAt: '2026-01-01T00:00:00.000Z',
};

beforeEach(() => {
  mocks.log = {
    data: page([live, tombstone]),
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  };
  mocks.facets = { data: facets };
  mocks.remove.mutate.mockReset();
  mocks.remove.mutateAsync.mockReset().mockResolvedValue({ entry: tombstone });
});

/** Reports the current location and how it was reached, so a test can tell a push from a replace. */
function LocationProbe() {
  const loc = useLocation();
  const type = useNavigationType();
  return <output data-testid="location">{`${type} ${loc.pathname}${loc.search}`}</output>;
}

function renderTab(route = '/admin?tab=audit-log') {
  return renderWithProviders(
    <>
      <AuditLogTab />
      <LocationProbe />
    </>,
    { route },
  );
}

const location = () => screen.getByTestId('location').textContent;
const removeButtons = () => screen.getAllByRole('button', { name: 'Remove' });

/** The table lists the rows in order, so the Nth Remove is the Nth row's. */
const openEngagementFacet = () => {
  fireEvent.click(screen.getByRole('button', { name: /^Engagement/ }));
  return screen.getByRole('dialog', { name: 'Filter by engagement' });
};

describe('AuditLogTab states', () => {
  it('shows a spinner while the first page loads', () => {
    mocks.log = { ...mocks.log, data: undefined, isLoading: true };
    renderTab();
    expect(screen.getByRole('status', { name: 'Loading' })).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('shows the error with a retry that refetches', () => {
    mocks.log = { ...mocks.log, data: undefined, isError: true };
    renderTab();
    expect(screen.getByText('Couldn’t load the audit log.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(mocks.log.refetch).toHaveBeenCalledTimes(1);
  });

  it('shows the empty log with a next step when nothing has been recorded', () => {
    mocks.log = { ...mocks.log, data: page([]) };
    renderTab();
    expect(screen.getByRole('heading', { name: 'No audit log entries yet' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Go to Engagements' }).getAttribute('href')).toBe(
      '/engagements',
    );
  });

  it('distinguishes a filter that hid everything, and its Clear all keeps ?tab=', () => {
    mocks.log = { ...mocks.log, data: page([]) };
    renderTab('/admin?tab=audit-log&action=create&page=2');
    const heading = screen.getByRole('heading', { name: 'No entries match these filters' });
    const emptyState = heading.closest('div')!.parentElement!;
    fireEvent.click(within(emptyState).getByRole('button', { name: 'Clear all' }));
    expect(location()).toBe('REPLACE /admin?tab=audit-log');
  });

  it('renders the rows with the engagement column and the log-start note', () => {
    renderTab();
    expect(screen.getByRole('columnheader', { name: 'Engagement' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Operation One' }).getAttribute('href')).toBe(
      '/engagements/op1/audit-log',
    );
    expect(screen.getByText(/The log starts on/)).toBeTruthy();
  });

  it('never links a deleted engagement, whose slug may have been reissued', () => {
    mocks.log = {
      ...mocks.log,
      data: page([
        entry({
          uuid: 'd-1',
          engagement: { slug: 'old-eng', name: 'Old Engagement', deleted: true },
        }),
        entry({ uuid: 'd-2', engagement: null }),
      ]),
    };
    renderTab();
    expect(screen.getByText('Old Engagement').closest('a')).toBeNull();
    expect(screen.getByText(DELETED_ENGAGEMENT_LABEL)).toBeTruthy();
    expect(screen.getByText(NO_ENGAGEMENT_LABEL)).toBeTruthy();
  });
});

describe('AuditLogTab URL writes', () => {
  it('replaces for a facet change, returns to page 1 and keeps ?tab=', () => {
    renderTab('/admin?tab=audit-log&page=2');
    const facet = openEngagementFacet();
    fireEvent.click(within(facet).getByLabelText('Operation One'));
    expect(location()).toBe('REPLACE /admin?tab=audit-log&eng=op1');
  });

  it('pushes for a page change', () => {
    mocks.log = { ...mocks.log, data: page([live], 120) };
    renderTab();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(location()).toBe('PUSH /admin?tab=audit-log&page=2');
  });

  it('clamps a page past the end with a replace, not a push', async () => {
    mocks.log = { ...mocks.log, data: { ...page([live], 120), page: 3 } };
    renderTab('/admin?tab=audit-log&page=9');
    await waitFor(() => expect(location()).toBe('REPLACE /admin?tab=audit-log&page=3'));
  });

  it('replaces for a sort change', () => {
    renderTab();
    // Scoped to the table: the filter bar has a "Who" facet button of its own.
    fireEvent.click(within(screen.getByRole('table')).getByRole('button', { name: /Who/ }));
    expect(location()).toBe('REPLACE /admin?tab=audit-log&sort=who&dir=asc');
  });
});

describe('AuditEngagementFilter', () => {
  it('lists No engagement, then live engagements, then the deleted group, and unions a deep-linked slug', () => {
    renderTab('/admin?tab=audit-log&eng=ghost-eng');
    const facet = openEngagementFacet();

    const labels = within(facet)
      .getAllByRole('checkbox')
      .map((cb) => cb.closest('label')!.textContent);
    expect(labels).toEqual([
      NO_ENGAGEMENT_LABEL,
      'Operation One',
      'Operation Two',
      'Old Engagement',
      'ghost-eng',
    ]);

    const deleted = within(facet).getByRole('group', { name: 'Deleted engagements' });
    expect(within(deleted).getByLabelText('Old Engagement')).toBeTruthy();
    // The slug the facets do not know keeps its checkbox, checked, and its chip.
    expect(within(deleted).getByLabelText('ghost-eng')).toHaveProperty('checked', true);
    expect(screen.getByText('Engagement: ghost-eng')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Engagement/ }).textContent).toBe('Engagement1');
  });

  it('is an explicit flag for No engagement, not a sentinel slug', () => {
    renderTab();
    const facet = openEngagementFacet();
    fireEvent.click(within(facet).getByLabelText(NO_ENGAGEMENT_LABEL));
    expect(location()).toBe('REPLACE /admin?tab=audit-log&noEng=1');
  });

  it('emits slugs in option order whatever the click order', () => {
    renderTab('/admin?tab=audit-log&eng=op2');
    const facet = openEngagementFacet();
    fireEvent.click(within(facet).getByLabelText('Operation One'));
    expect(location()).toBe('REPLACE /admin?tab=audit-log&eng=op1&eng=op2');
  });

  it('searches by name or slug without hiding No engagement', () => {
    renderTab();
    const facet = openEngagementFacet();
    fireEvent.change(within(facet).getByLabelText('Search engagements'), {
      target: { value: 'old' },
    });
    expect(within(facet).getByLabelText(NO_ENGAGEMENT_LABEL)).toBeTruthy();
    expect(within(facet).getByLabelText('Old Engagement')).toBeTruthy();
    expect(within(facet).queryByLabelText('Operation One')).toBeNull();
  });
});

describe('Remove control and modal', () => {
  it('is disabled with the shared title on a tombstone, live with its own on a row', () => {
    renderTab();
    const [onLive, onTombstone] = removeButtons();
    expect(onLive).toHaveProperty('disabled', false);
    expect(onLive!.getAttribute('title')).toBe(REMOVE_ENTRY_TITLE);
    expect(onTombstone).toHaveProperty('disabled', true);
    expect(onTombstone!.getAttribute('title')).toBe(AUDIT_ENTRY_ALREADY_REMOVED);
    expect(screen.getByText(/An entry was removed here by/)).toBeTruthy();
  });

  it('refuses a blank reason, states the consequence, and sends the trimmed reason', async () => {
    renderTab();
    fireEvent.click(removeButtons()[0]!);
    const dialog = await screen.findByRole('dialog', { name: '' });
    expect(within(dialog).getByText('Remove audit entry')).toBeTruthy();
    expect(within(dialog).getByText(REMOVAL_CONSEQUENCE)).toBeTruthy();
    // The entry is named so the admin confirms the one they meant.
    expect(within(dialog).getByText('Updated · Finding “CAN bus replay”')).toBeTruthy();

    const submit = within(dialog).getByRole('button', { name: 'Remove entry' });
    expect(submit).toHaveProperty('disabled', true);
    expect(submit.getAttribute('title')).toBe(REASON_REQUIRED_TITLE);

    const reason = within(dialog).getByLabelText(/Reason/);
    fireEvent.change(reason, { target: { value: '   ' } });
    expect(submit).toHaveProperty('disabled', true);

    fireEvent.change(reason, { target: { value: '  Pasted a secret  ' } });
    expect(submit).toHaveProperty('disabled', false);
    expect(submit.getAttribute('title')).toBeNull();

    fireEvent.click(submit);
    await waitFor(() => expect(mocks.remove.mutateAsync).toHaveBeenCalledTimes(1));
    expect(mocks.remove.mutateAsync).toHaveBeenCalledWith({
      uuid: 'e-1',
      reason: 'Pasted a secret',
    });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '' })).toBeNull());
  });

  it('refuses a reason past the shared cap', async () => {
    renderTab();
    fireEvent.click(removeButtons()[0]!);
    const dialog = await screen.findByRole('dialog', { name: '' });
    fireEvent.change(within(dialog).getByLabelText(/Reason/), {
      target: { value: 'x'.repeat(AUDIT_DELETE_REASON_MAX_CHARS + 1) },
    });
    const submit = within(dialog).getByRole('button', { name: 'Remove entry' });
    expect(submit).toHaveProperty('disabled', true);
    expect(submit.getAttribute('title')).toBe(REASON_TOO_LONG);
    expect(within(dialog).getByText(REASON_TOO_LONG)).toBeTruthy();
  });

  it('reads a 409 as already removed and closes, rather than a generic failure', async () => {
    mocks.remove.mutateAsync.mockRejectedValue(
      new ApiError(409, { error: AUDIT_ENTRY_ALREADY_REMOVED }),
    );
    renderTab();
    fireEvent.click(removeButtons()[0]!);
    const dialog = await screen.findByRole('dialog', { name: '' });
    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: 'dup' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove entry' }));

    expect(await screen.findByText(AUDIT_ENTRY_ALREADY_REMOVED)).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '' })).toBeNull());
  });

  it('keeps the dialog open with the reason intact on any other failure', async () => {
    mocks.remove.mutateAsync.mockRejectedValue(new ApiError(500, { error: 'Database away' }));
    renderTab();
    fireEvent.click(removeButtons()[0]!);
    const dialog = await screen.findByRole('dialog', { name: '' });
    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: 'dup' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove entry' }));

    expect(await screen.findByText('Database away')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: '' })).toBeTruthy();
    expect(within(dialog).getByLabelText(/Reason/)).toHaveProperty('value', 'dup');
  });

  it('forgets the typed reason between entries', async () => {
    renderTab();
    fireEvent.click(removeButtons()[0]!);
    let dialog = await screen.findByRole('dialog', { name: '' });
    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: 'draft' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '' })).toBeNull());

    fireEvent.click(removeButtons()[0]!);
    dialog = await screen.findByRole('dialog', { name: '' });
    expect(within(dialog).getByLabelText(/Reason/)).toHaveProperty('value', '');
  });
});
