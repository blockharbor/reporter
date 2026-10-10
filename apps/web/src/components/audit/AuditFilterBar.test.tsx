// @vitest-environment jsdom
//
// jsdom is scoped to this file by the docblock above rather than set globally in
// vitest.config.ts: the rest of the suite is pure logic and runs in node.
//
// Fake timers drive the search debounce. What this file asserts is the bar's
// contract with its page — when and with what it calls `onFilterChange`, and
// that the latest-value refs make a facet toggled mid-debounce survive it.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { AuditFacets } from '@reporter/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditFilterBar, SEARCH_DEBOUNCE_MS } from './AuditFilterBar.js';
import { DEFAULT_AUDIT_SORT, EMPTY_AUDIT_FILTER, type AuditFilterState } from './audit-filter.js';

// vitest runs without `globals`, so RTL's auto-cleanup never registers itself.
afterEach(cleanup);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const facets: AuditFacets = {
  actors: [{ value: 'ada', label: 'Ada Lovelace', email: 'ada@example.com', deleted: false }],
  actions: ['create', 'update'],
  entityTypes: ['finding'],
  logStartsAt: '2026-01-01T00:00:00.000Z',
};

function renderBar(over: {
  filter?: AuditFilterState;
  sort?: typeof DEFAULT_AUDIT_SORT;
  total?: number;
  onFilterChange?: (next: AuditFilterState) => void;
  onClearAll?: () => void;
  leadingFacets?: React.ReactNode;
}) {
  const props = {
    filter: over.filter ?? EMPTY_AUDIT_FILTER,
    sort: over.sort ?? DEFAULT_AUDIT_SORT,
    facets,
    onFilterChange: over.onFilterChange ?? vi.fn(),
    onClearAll: over.onClearAll ?? vi.fn(),
    total: over.total ?? 0,
    leadingFacets: over.leadingFacets,
  };
  const view = render(<AuditFilterBar {...props} />);
  return { ...view, props };
}

const searchBox = () => screen.getByPlaceholderText('Search the audit log…');

describe('AuditFilterBar search', () => {
  it('applies the latest text once, after the debounce', () => {
    const onFilterChange = vi.fn();
    renderBar({ onFilterChange });

    fireEvent.change(searchBox(), { target: { value: 'ta' } });
    fireEvent.change(searchBox(), { target: { value: 'tag' } });
    expect(onFilterChange).not.toHaveBeenCalled();

    act(() => void vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS));
    expect(onFilterChange).toHaveBeenCalledTimes(1);
    expect(onFilterChange).toHaveBeenCalledWith({ ...EMPTY_AUDIT_FILTER, search: 'tag' });
  });

  it('applies the search over the filter that is current when the timer fires', () => {
    const onFilterChange = vi.fn();
    const { rerender, props } = renderBar({ onFilterChange });

    fireEvent.change(searchBox(), { target: { value: 'tag' } });
    // A facet lands during the debounce — the page re-renders the bar with it.
    const withFacet: AuditFilterState = { ...EMPTY_AUDIT_FILTER, actions: ['create'] };
    rerender(<AuditFilterBar {...props} filter={withFacet} />);

    act(() => void vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS));
    expect(onFilterChange).toHaveBeenCalledTimes(1);
    expect(onFilterChange).toHaveBeenCalledWith({ ...withFacet, search: 'tag' });
  });

  it('re-syncs the box when the URL changes elsewhere', () => {
    const { rerender, props } = renderBar({
      filter: { ...EMPTY_AUDIT_FILTER, search: 'token' },
    });
    expect(searchBox()).toHaveProperty('value', 'token');
    rerender(<AuditFilterBar {...props} filter={EMPTY_AUDIT_FILTER} />);
    expect(searchBox()).toHaveProperty('value', '');
  });
});

describe('AuditFilterBar Clear all', () => {
  it('is absent with no filter and the default sort', () => {
    renderBar({});
    expect(screen.queryByRole('button', { name: 'Clear all' })).toBeNull();
  });

  it('appears for a non-default sort alone', () => {
    renderBar({ sort: { key: 'who', dir: 'asc' } });
    expect(screen.getByRole('button', { name: 'Clear all' })).toBeTruthy();
  });

  it('calls onClearAll exactly once and empties the box', () => {
    const onClearAll = vi.fn();
    const onFilterChange = vi.fn();
    renderBar({
      filter: { ...EMPTY_AUDIT_FILTER, search: 'tok', actions: ['update'] },
      onClearAll,
      onFilterChange,
    });
    expect(searchBox()).toHaveProperty('value', 'tok');

    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(onClearAll).toHaveBeenCalledTimes(1);
    expect(searchBox()).toHaveProperty('value', '');
    // Emptying the box is not a second search application: one write, from the page.
    act(() => void vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS));
    expect(onFilterChange).not.toHaveBeenCalled();
  });
});

describe('AuditFilterBar status line', () => {
  it('names the matching count and the order in one live region', () => {
    renderBar({ filter: { ...EMPTY_AUDIT_FILTER, actions: ['create'] }, total: 3 });
    expect(screen.getByRole('status').textContent).toBe(
      '3 matching entries · sorted by when, descending',
    );
  });

  it('drops "matching" when nothing is filtered and singularises one entry', () => {
    renderBar({ total: 1, sort: { key: 'action', dir: 'asc' } });
    expect(screen.getByRole('status').textContent).toBe('1 entry · sorted by action, ascending');
  });
});

describe('AuditFilterBar chips and slots', () => {
  it('renders a removable chip per facet and drops the facet when it is removed', () => {
    const onFilterChange = vi.fn();
    renderBar({
      filter: { ...EMPTY_AUDIT_FILTER, actors: ['ada'], actions: ['create'] },
      onFilterChange,
    });
    expect(screen.getByText('Who: Ada Lovelace')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter Action: Created' }));
    expect(onFilterChange).toHaveBeenCalledWith({ ...EMPTY_AUDIT_FILTER, actors: ['ada'] });
  });

  it('renders the leading facets slot before the Who control', () => {
    renderBar({ leadingFacets: <button type="button">Engagement</button> });
    const buttons = screen.getAllByRole('button').map((b) => b.textContent);
    expect(buttons.indexOf('Engagement')).toBeLessThan(buttons.indexOf('Who'));
  });
});
