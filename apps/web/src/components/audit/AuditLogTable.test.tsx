// @vitest-environment jsdom
//
// jsdom is scoped to this file by the docblock above rather than set globally in
// vitest.config.ts: the rest of the suite is pure logic and runs in node.
//
// The table is presentational, so nothing is mocked: rows go in, sort changes
// come out. A MemoryRouter is the only provider, for the What column's Link.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
  DELETED_ENGAGEMENT_LABEL,
  DELETED_USER_LABEL,
  NO_ENGAGEMENT_LABEL,
  SYSTEM_ACTOR_LABEL,
  type AuditEntry,
} from '@reporter/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatDateTime } from '../../lib/format.js';
import { AuditLogTable, type AuditLogTableProps } from './AuditLogTable.js';
import { DEFAULT_AUDIT_SORT } from './audit-filter.js';

// vitest runs without `globals`, so RTL's auto-cleanup never registers itself.
afterEach(cleanup);

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

function renderTable(over: Partial<AuditLogTableProps> & { rows: AuditEntry[] }) {
  const props: AuditLogTableProps = {
    sort: DEFAULT_AUDIT_SORT,
    onSortChange: vi.fn(),
    ...over,
  };
  return {
    ...render(
      <MemoryRouter>
        <AuditLogTable {...props} />
      </MemoryRouter>,
    ),
    props,
  };
}

describe('AuditLogTable tombstones', () => {
  const removed = entry({
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

  it('renders the removal record in place of the content, verbatim', () => {
    renderTable({ rows: [removed] });
    const row = screen.getByText(/An entry was removed here/).closest('tr')!;
    expect(row.textContent).toContain(
      `An entry was removed here by Grace Hopper on ${formatDateTime(
        '2026-03-02T09:30:00.000Z',
      )}: Duplicate of the entry above`,
    );
    expect(screen.getByText('Grace Hopper').getAttribute('title')).toBe('grace@example.com');
    expect(screen.queryByRole('button', { name: /change/ })).toBeNull();
  });

  it('still renders the actions cell so a disabled control can appear', () => {
    renderTable({
      rows: [removed],
      renderActions: (row) => (
        <button type="button" disabled={row.deleted !== null}>
          Remove
        </button>
      ),
    });
    expect(screen.getByRole('button', { name: 'Remove' })).toHaveProperty('disabled', true);
  });
});

describe('AuditLogTable rows', () => {
  it('expands a row into its change list and back', () => {
    renderTable({ rows: [entry({ uuid: 'e-1' })] });
    const toggle = screen.getByRole('button', { name: /1 change: Title/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('definition')).toBeNull();

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const detail = document.getElementById(toggle.getAttribute('aria-controls')!)!;
    expect(within(detail).getByText('Title')).toBeTruthy();
    expect(within(detail).getByText('CAN replay')).toBeTruthy();
    expect(within(detail).getByText('CAN bus replay')).toBeTruthy();

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('shows the summary and names the first two changes with a count of the rest', () => {
    renderTable({
      rows: [
        entry({
          uuid: 'e-2',
          changes: [
            { kind: 'field', field: 'title', from: 'a', to: 'b' },
            { kind: 'field', field: 'severity', from: 'low', to: 'high' },
            { kind: 'field', field: 'impact', from: '', to: 'x' },
          ],
        }),
      ],
    });
    expect(screen.getByText('Edited finding “CAN bus replay”: Title')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: /3 changes: Title, Severity, \+1 more/ }),
    ).toBeTruthy();
  });

  it('renders a list change as what was added and removed', () => {
    renderTable({
      rows: [
        entry({
          uuid: 'e-3',
          entityType: 'engagement',
          changes: [
            {
              kind: 'list',
              field: 'scopeTargets',
              from: [
                { label: 'Gateway', hash: 'h1' },
                { label: 'Old ECU', hash: 'h2' },
              ],
              to: [
                { label: 'Gateway', hash: 'h1' },
                { label: 'Head unit', hash: 'h3' },
              ],
            },
          ],
        }),
      ],
    });
    fireEvent.click(screen.getByRole('button', { name: /Scope targets/ }));
    expect(screen.getByText('Added')).toBeTruthy();
    expect(screen.getByText('Head unit')).toBeTruthy();
    expect(screen.getByText('Removed')).toBeTruthy();
    expect(screen.getByText('Old ECU')).toBeTruthy();
    expect(screen.queryByText('Edited')).toBeNull();
  });

  it('renders every change kind without a before/after', () => {
    renderTable({
      rows: [
        entry({
          uuid: 'e-4',
          entityType: 'goal',
          changes: [
            { kind: 'order', field: 'position', from: ['A', 'B'], to: ['B', 'A'] },
            { kind: 'items', label: 'Evidence linked', items: ['Screenshot 1', 'Recording'] },
            { kind: 'count', label: 'Evidence anonymized', count: 12 },
            { kind: 'elided', field: 'description' },
          ],
        }),
      ],
    });
    fireEvent.click(screen.getByRole('button', { name: /4 changes/ }));
    expect(screen.getByText('Before')).toBeTruthy();
    expect(screen.getByText('After')).toBeTruthy();
    expect(screen.getByText('Evidence linked')).toBeTruthy();
    expect(screen.getByText('Recording')).toBeTruthy();
    expect(screen.getByText('Evidence anonymized')).toBeTruthy();
    expect(screen.getByText('12')).toBeTruthy();
    expect(screen.getByText('Too large to record')).toBeTruthy();
  });

  it('folds a long value behind Show full', () => {
    const long = 'x'.repeat(300);
    renderTable({
      rows: [
        entry({ uuid: 'e-5', changes: [{ kind: 'field', field: 'impact', from: '', to: long }] }),
      ],
    });
    fireEvent.click(screen.getByRole('button', { name: /Impact/ }));
    expect(screen.queryByText(long)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show full' }));
    expect(screen.getByText(long)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Show less' })).toBeTruthy();
  });

  it('notes a coalesced burst under the time', () => {
    renderTable({
      rows: [
        entry({
          uuid: 'e-6',
          coalescedCount: 7,
          createdAt: '2026-03-01T10:00:00.000Z',
          lastAt: '2026-03-01T10:02:30.000Z',
        }),
      ],
    });
    expect(screen.getByText(/7 saves, last at/)).toBeTruthy();
  });

  it('renders the Who column from the snapshot, with the live name as a hint', () => {
    renderTable({
      rows: [
        entry({ uuid: 'w-1', actor: null, via: 'system' }),
        entry({
          uuid: 'w-2',
          actor: { name: 'Old Name', email: 'old@example.com', slug: null, currentName: null },
        }),
        entry({
          uuid: 'w-3',
          via: 'apikey',
          actor: {
            name: 'Ada L',
            email: 'ada@example.com',
            slug: 'ada',
            currentName: 'Ada Lovelace',
          },
        }),
      ],
    });
    expect(screen.getByText(SYSTEM_ACTOR_LABEL)).toBeTruthy();
    expect(screen.getByText('Old Name')).toBeTruthy();
    expect(screen.getByText(DELETED_USER_LABEL)).toBeTruthy();
    expect(screen.getByText('Ada L')).toBeTruthy();
    expect(screen.getByText('now called Ada Lovelace')).toBeTruthy();
    expect(screen.getByText('Client API')).toBeTruthy();
  });

  it('badges an imported row without calling its actor deleted', () => {
    renderTable({
      rows: [
        entry({
          uuid: 'i-1',
          source: 'import',
          actor: { name: 'Someone Else', email: 'x@other.io', slug: null, currentName: null },
        }),
      ],
    });
    expect(screen.getByText('Imported')).toBeTruthy();
    expect(screen.queryByText(DELETED_USER_LABEL)).toBeNull();
  });

  it('links the What column only when asked to', () => {
    const { rerender, props } = renderTable({
      rows: [entry({ uuid: 'l-1' })],
      entityHref: () => '/engagements/op1/findings/f-1',
    });
    expect(screen.getByRole('link', { name: 'CAN bus replay' }).getAttribute('href')).toBe(
      '/engagements/op1/findings/f-1',
    );
    rerender(
      <MemoryRouter>
        <AuditLogTable {...props} entityHref={() => undefined} />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('link', { name: 'CAN bus replay' })).toBeNull();
  });
});

describe('AuditLogTable engagement column', () => {
  it('links a live engagement, never a deleted snapshot, and names no engagement', () => {
    renderTable({
      showEngagementColumn: true,
      rows: [
        entry({ uuid: 'g-1' }),
        entry({ uuid: 'g-2', engagement: { slug: 'gone', name: 'Gone Op', deleted: true } }),
        entry({ uuid: 'g-3', engagement: null }),
      ],
    });
    expect(screen.getByRole('link', { name: 'Operation One' }).getAttribute('href')).toBe(
      '/engagements/op1/audit-log',
    );
    expect(screen.getByText('Gone Op')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Gone Op' })).toBeNull();
    expect(screen.getByText(DELETED_ENGAGEMENT_LABEL)).toBeTruthy();
    expect(screen.getByText(NO_ENGAGEMENT_LABEL)).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Engagement' })).toBeTruthy();
  });

  it('omits the column by default', () => {
    renderTable({ rows: [entry({ uuid: 'g-4' })] });
    expect(screen.queryByRole('columnheader', { name: 'Engagement' })).toBeNull();
  });
});

describe('AuditLogTable sorting', () => {
  it('emits the first-click direction for a new column and flips the active one', () => {
    const onSortChange = vi.fn();
    renderTable({ rows: [], onSortChange });
    fireEvent.click(screen.getByRole('button', { name: /Who/ }));
    expect(onSortChange).toHaveBeenCalledWith({ key: 'who', dir: 'asc' });
    fireEvent.click(screen.getByRole('button', { name: /When/ }));
    expect(onSortChange).toHaveBeenCalledWith({ key: 'when', dir: 'asc' });
  });

  it('marks the active header with aria-sort and leaves What unsortable', () => {
    renderTable({ rows: [], sort: { key: 'action', dir: 'desc' } });
    expect(screen.getByRole('columnheader', { name: /Action/ }).getAttribute('aria-sort')).toBe(
      'descending',
    );
    expect(screen.getByRole('columnheader', { name: /When/ }).getAttribute('aria-sort')).toBeNull();
    expect(
      within(screen.getByRole('columnheader', { name: 'What' })).queryByRole('button'),
    ).toBeNull();
  });
});
