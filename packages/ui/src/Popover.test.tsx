// @vitest-environment jsdom
//
// jsdom is scoped per-file (see Modal.test.tsx for why). Left untested here
// because jsdom has no layout engine: the anchored placement (`absolute`,
// `right-0` for align="end") resolves to Tailwind class names only, so asserting
// on it would test the class string rather than where the panel lands.
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Popover } from './Popover.js';

// vitest runs without `globals`, so RTL's auto-cleanup never registers itself.
afterEach(cleanup);

const noop = () => {};

/**
 * Open popover whose input state lives in the *parent*, with an inline
 * `onOpenChange`. The input is deliberately the *second* focusable in the panel:
 * the pre-fix effect listed `onOpenChange` in its dependencies, so a keystroke
 * tore the effect down (focusing the trigger) and set it up again (focusing the
 * first panel control), which is only observable when that is not the input.
 */
function ParentOwnedInputPopover() {
  const [value, setValue] = useState('');
  const [open, setOpen] = useState(true);
  return (
    <Popover
      open={open}
      onOpenChange={(next) => setOpen(next)}
      label="Filters"
      trigger={<button type="button">Filters</button>}
    >
      <button type="button">Clear all</button>
      <input aria-label="Search" value={value} onChange={(e) => setValue(e.target.value)} />
    </Popover>
  );
}

/** An open popover with one panel control, rendered so `onOpenChange` can be swapped. */
function escHarness(onOpenChange: (open: boolean) => void) {
  return (
    <Popover
      open
      onOpenChange={onOpenChange}
      label="Filters"
      trigger={<button type="button">Filters</button>}
    >
      <input aria-label="Search" />
    </Popover>
  );
}

describe('Popover', () => {
  it('keeps focus in a parent-controlled input across keystrokes', async () => {
    // Same bug class as the Modal regression: a fresh `onOpenChange` identity
    // used to re-run the focus effect and steal the caret. Against the pre-fix
    // Popover this asserts 'abc' and gets 'a', with focus on "Clear all".
    const user = userEvent.setup();
    render(<ParentOwnedInputPopover />);

    const input = screen.getByLabelText<HTMLInputElement>('Search');
    await user.type(input, 'abc');

    expect(input.value).toBe('abc');
    expect(document.activeElement).toBe(input);
  });

  it('focuses the first control in the panel on open', async () => {
    const user = userEvent.setup();

    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <Popover
          open={open}
          onOpenChange={setOpen}
          label="Filters"
          trigger={<button type="button">Filters</button>}
        >
          <input aria-label="Search" />
          <button type="button">Clear all</button>
        </Popover>
      );
    }

    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Filters' }));
    expect(document.activeElement).toBe(screen.getByLabelText('Search'));
  });

  it('prefers [data-autofocus] over the first panel control', () => {
    render(
      <Popover
        open
        onOpenChange={noop}
        label="Filters"
        trigger={<button type="button">Filters</button>}
      >
        <button type="button">Clear all</button>
        <input aria-label="Search" data-autofocus />
      </Popover>,
    );

    expect(document.activeElement).toBe(screen.getByLabelText('Search'));
  });

  it('dismisses on Esc, calling the latest onOpenChange', async () => {
    // What the latest-value ref buys: the keydown listener is installed once per
    // open, yet still reaches the current callback.
    const user = userEvent.setup();
    const stale = vi.fn();
    const current = vi.fn();

    const { rerender } = render(escHarness(stale));
    rerender(escHarness(current));
    await user.keyboard('{Escape}');

    expect(current).toHaveBeenCalledTimes(1);
    expect(current).toHaveBeenCalledWith(false);
    expect(stale).not.toHaveBeenCalled();
  });

  it('dismisses on an outside press and leaves focus where the press landed', async () => {
    const user = userEvent.setup();

    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <Popover
            open={open}
            onOpenChange={(next) => setOpen(next)}
            label="Filters"
            trigger={<button type="button">Filters</button>}
          >
            <input aria-label="Search" />
          </Popover>
          <button type="button">Elsewhere</button>
        </>
      );
    }

    render(<Harness />);
    const elsewhere = screen.getByRole('button', { name: 'Elsewhere' });
    await user.click(elsewhere);

    expect(screen.queryByRole('dialog')).toBeNull();
    // The press moved focus deliberately, so the unmount must not yank it back
    // to the trigger.
    expect(document.activeElement).toBe(elsewhere);
  });

  it('stays open when the press lands inside the panel', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <Popover
        open
        onOpenChange={onOpenChange}
        label="Filters"
        trigger={<button type="button">Filters</button>}
      >
        <input aria-label="Search" />
      </Popover>,
    );

    await user.click(screen.getByLabelText('Search'));
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInstanceOf(HTMLElement);
  });

  it('returns focus to the trigger when dismissed from inside', async () => {
    const user = userEvent.setup();

    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <Popover
          open={open}
          onOpenChange={setOpen}
          label="Filters"
          trigger={<button type="button">Filters</button>}
        >
          <input aria-label="Search" />
        </Popover>
      );
    }

    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Filters' });
    await user.click(trigger);
    expect(document.activeElement).toBe(screen.getByLabelText('Search'));

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('wires the trigger to the panel and toggles on click', async () => {
    const user = userEvent.setup();
    const triggerClick = vi.fn();

    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <Popover
          open={open}
          onOpenChange={setOpen}
          label="Filters"
          trigger={
            <button type="button" onClick={triggerClick}>
              Filters
            </button>
          }
        >
          <input aria-label="Search" />
        </Popover>
      );
    }

    const { container } = render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Filters' });
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    await user.click(trigger);
    // The caller's own onClick survives cloning.
    expect(triggerClick).toHaveBeenCalledTimes(1);
    const panel = screen.getByRole('dialog');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(trigger.getAttribute('aria-controls')).toBe(panel.id);
    // Unlike Modal, the panel is anchored inline rather than portaled.
    expect(container.contains(panel)).toBe(true);

    await user.click(trigger);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
