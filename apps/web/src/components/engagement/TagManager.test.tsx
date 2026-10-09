// @vitest-environment jsdom
//
// jsdom is scoped to this file by the docblock above rather than set globally in
// vitest.config.ts: the rest of the suite is pure logic and runs in node.
//
// The data layer is mocked at the hooks module: TagManager is a presentational
// block over `useTags` and five mutations, and what this file asserts is the
// contract between the rendered controls and those hooks — which controls exist
// for which role, and exactly what a save or a pin sends. Wiring a real
// QueryClient and fetch would only re-test TanStack Query.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ConfirmProvider, ThemeProvider, ToastProvider } from '@reporter/ui';
import type { Tag } from '@reporter/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { READ_ONLY_TITLE } from '../../lib/permissions.js';
import { TagManager } from './TagManager.js';
import { activityTagHint, deleteTagMessage } from './tag-copy.js';

// vitest runs without `globals`, so RTL's auto-cleanup never registers itself.
afterEach(cleanup);

/**
 * Hoisted so the `vi.mock` factory below (which vitest lifts above the imports)
 * can read it. Each test overwrites `tags` and the spies are reset between tests.
 */
const mocks = vi.hoisted(() => {
  const mutation = () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn().mockResolvedValue({ evidenceCleared: 0, findingsCleared: 0 }),
    isPending: false,
  });
  return {
    tags: [] as Tag[],
    update: mutation(),
    del: mutation(),
    reorder: mutation(),
    unapply: mutation(),
    create: mutation(),
    merge: mutation(),
  };
});

vi.mock('../../api/hooks.js', () => ({
  useTags: () => ({ data: mocks.tags, isLoading: false, isError: false, refetch: vi.fn() }),
  useCreateTag: () => mocks.create,
  useUpdateTag: () => mocks.update,
  useDeleteTag: () => mocks.del,
  useReorderTags: () => mocks.reorder,
  useUnapplyTag: () => mocks.unapply,
  useMergeTags: () => mocks.merge,
  useTagReferences: () => ({ data: { savedQueries: [], timelineSections: [] } }),
  // `lib/permissions.ts` imports this; it is never called here.
  useEngagement: () => ({ data: undefined }),
}));

const alpha: Tag = { id: 1, name: 'alpha', colorName: 'teal', evidenceCount: 2, activityNames: [] };
const beta: Tag = {
  id: 2,
  name: 'beta',
  colorName: 'red',
  evidenceCount: 0,
  activityNames: ['Recon'],
};

beforeEach(() => {
  mocks.tags = [alpha, beta];
  for (const m of [mocks.update, mocks.del, mocks.reorder, mocks.unapply, mocks.create]) {
    m.mutate.mockClear();
    m.mutateAsync.mockClear();
  }
});

/** The providers the component's `useToast`, `useConfirm` and `useTheme` need. */
function renderManager(readOnly: boolean) {
  return render(
    // A fixed mode: in `system` mode the provider subscribes to `matchMedia`,
    // which jsdom does not implement.
    <ThemeProvider defaultMode="light" persist={false}>
      <ToastProvider>
        <ConfirmProvider>
          <TagManager slug="op1" readOnly={readOnly} />
        </ConfirmProvider>
      </ToastProvider>
    </ThemeProvider>,
  );
}

describe('TagManager, read-only', () => {
  it('renders no drag handle and disables every control with the read-only title', () => {
    renderManager(true);
    expect(screen.queryByRole('button', { name: 'Drag to reorder' })).toBeNull();

    // Every row action, every swatch and the Add button — nothing is left live.
    const buttons = screen.getAllByRole('button');
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) {
      expect(b, b.textContent ?? b.getAttribute('aria-label') ?? '').toHaveProperty(
        'disabled',
        true,
      );
      expect(b.getAttribute('title')).toBe(READ_ONLY_TITLE);
    }
    const nameInput = screen.getByLabelText('Name');
    expect(nameInput).toHaveProperty('disabled', true);
    expect(nameInput.getAttribute('title')).toBe(READ_ONLY_TITLE);
  });
});

describe('TagManager, write', () => {
  it('offers a drag handle per row and Pin to top for every row but the first', () => {
    renderManager(false);
    expect(screen.getAllByRole('button', { name: 'Drag to reorder' })).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Pin alpha to top' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Pin beta to top' })).toHaveProperty(
      'disabled',
      false,
    );
  });

  it('pins by sending the full order with that tag first', () => {
    renderManager(false);
    fireEvent.click(screen.getByRole('button', { name: 'Pin beta to top' }));
    expect(mocks.reorder.mutate).toHaveBeenCalledTimes(1);
    expect(mocks.reorder.mutate.mock.calls[0]?.[0]).toEqual([2, 1]);
  });

  it('opens the inline editor with the name and the swatches, without the hint for an unused tag', () => {
    renderManager(false);
    fireEvent.click(screen.getByRole('button', { name: 'Edit tag alpha' }));

    const input = screen.getByDisplayValue('alpha');
    expect(input.tagName).toBe('INPUT');
    const swatches = screen.getByRole('group', { name: 'Color for “alpha”' });
    expect(within(swatches).getAllByRole('button')).toHaveLength(12);
    expect(
      within(swatches).getByRole('button', { name: 'teal' }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(screen.queryByText(/Used as the correlation tag/)).toBeNull();
  });

  it('shows the activity hint only for a tag an activity correlates on', () => {
    renderManager(false);
    fireEvent.click(screen.getByRole('button', { name: 'Edit tag beta' }));
    expect(screen.getByText(activityTagHint(['Recon'])!)).toBeTruthy();
  });

  it('saves only the fields that changed', async () => {
    renderManager(false);
    fireEvent.click(screen.getByRole('button', { name: 'Edit tag alpha' }));
    fireEvent.change(screen.getByDisplayValue('alpha'), { target: { value: '  alpha-2 ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mocks.update.mutateAsync).toHaveBeenCalledTimes(1));
    // Trimmed, and no `colorName` — a rename must not re-send the colour.
    expect(mocks.update.mutateAsync.mock.calls[0]?.[0]).toEqual({
      id: 1,
      patch: { name: 'alpha-2' },
    });
    // The editor closes on success and the row is back.
    await waitFor(() => expect(screen.queryByDisplayValue('alpha')).toBeNull());
  });

  it('recolors without re-sending the name', async () => {
    renderManager(false);
    fireEvent.click(screen.getByRole('button', { name: 'Edit tag alpha' }));
    const swatches = screen.getByRole('group', { name: 'Color for “alpha”' });
    fireEvent.click(within(swatches).getByRole('button', { name: 'blue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mocks.update.mutateAsync).toHaveBeenCalledTimes(1));
    expect(mocks.update.mutateAsync.mock.calls[0]?.[0]).toEqual({
      id: 1,
      patch: { colorName: 'blue' },
    });
  });

  it('deletes only after the blast-radius confirmation is accepted', async () => {
    renderManager(false);
    fireEvent.click(screen.getByRole('button', { name: 'Delete tag alpha' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(deleteTagMessage(alpha))).toBeTruthy();
    expect(mocks.del.mutateAsync).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(mocks.del.mutateAsync).toHaveBeenCalledWith(1));
  });
});
