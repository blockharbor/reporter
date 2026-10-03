// @vitest-environment jsdom
//
// jsdom is scoped to this file by the docblock above rather than set globally in
// vitest.config.ts: the rest of the suite is pure logic and runs in node.
//
// Deliberately NOT tested here, because jsdom would make the test lie:
//   • Tab cycling through the *middle* of the focusable list. jsdom implements
//     no sequential focus navigation, so such a test would only assert
//     user-event's approximation of tab order, not our trap. We assert the two
//     boundaries, which are the only transitions our code actually performs.
//   • The `panel.focus()` fallback for a body whose only control is hidden.
//     jsdom happily focuses a `display: none` element, so the assertion fails
//     against correct code.
// Don't "close these gaps" with a jsdom test — close them in a real browser.
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Modal } from './Modal.js';

// vitest runs without `globals`, so RTL's auto-cleanup never registers itself.
afterEach(cleanup);

const noop = () => {};

/**
 * The bug this harness reproduces: the input's state lives in the *parent*, so
 * every keystroke re-renders the parent and hands Modal a brand-new inline
 * `onClose`. That is the exact shape of the real callers ("Save query", the
 * type-the-slug delete confirmation).
 */
function ParentOwnedInputModal() {
  const [value, setValue] = useState('');
  const [open, setOpen] = useState(true);
  return (
    <Modal open={open} onClose={() => setOpen(false)} title="Save query">
      <input aria-label="Name" value={value} onChange={(e) => setValue(e.target.value)} />
    </Modal>
  );
}

/** A modal with one body input, rendered so the `onClose` identity can be swapped. */
function escHarness(onClose: () => void) {
  return (
    <Modal open onClose={onClose} title="Save query">
      <input aria-label="Name" />
    </Modal>
  );
}

describe('Modal', () => {
  it('keeps focus in a parent-controlled input across keystrokes', async () => {
    // THE REGRESSION TEST. One effect used to install the key handler *and* move
    // initial focus, with `onClose` in its dependency array; a new inline
    // `onClose` identity therefore re-ran it and focus jumped to the header ✕
    // (first focusable in DOM order). The input accepted exactly one character.
    // Against the pre-fix Modal this asserts 'abc' and gets 'a'.
    const user = userEvent.setup();
    render(<ParentOwnedInputModal />);

    const input = screen.getByLabelText<HTMLInputElement>('Name');
    await user.type(input, 'abc');

    expect(input.value).toBe('abc');
    expect(document.activeElement).toBe(input);
  });

  it('focuses the first control in the body, never the header ✕', () => {
    render(
      <Modal open onClose={noop} title="Edit tag">
        <input aria-label="Label" />
        <button type="button">Save</button>
      </Modal>,
    );

    const label = screen.getByLabelText('Label');
    const close = screen.getByRole('button', { name: 'Close' });
    // The ✕ precedes the body in DOM order, so a panel-wide scan would pick it.
    expect(close.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.activeElement).toBe(label);
  });

  it('prefers [data-autofocus] over the first body control', () => {
    render(
      <Modal open onClose={noop} title="Filter">
        <input aria-label="First" />
        <input aria-label="Second" data-autofocus />
      </Modal>,
    );

    expect(document.activeElement).toBe(screen.getByLabelText('Second'));
  });

  it("honors a caller's autoFocus", () => {
    // React implements autoFocus by calling .focus() while committing, which
    // runs before our passive effect — so the effect must recognise "focus is
    // already inside the panel" and leave it where the caller put it, even
    // though the first body control comes earlier in DOM order.
    render(
      <Modal open onClose={noop} title="Filter">
        <button type="button">Not me</button>
        <input aria-label="Search" autoFocus />
      </Modal>,
    );

    expect(document.activeElement).toBe(screen.getByLabelText('Search'));
  });

  it('closes on Esc, calling the latest onClose', async () => {
    // What the latest-value ref buys: the keydown listener is installed once for
    // the lifetime of the open dialog, yet still reaches the current callback.
    const user = userEvent.setup();
    const stale = vi.fn();
    const current = vi.fn();

    const { rerender } = render(escHarness(stale));
    rerender(escHarness(current));
    await user.keyboard('{Escape}');

    expect(current).toHaveBeenCalledTimes(1);
    expect(stale).not.toHaveBeenCalled();
  });

  it('wraps Tab at both ends of the panel', async () => {
    const user = userEvent.setup();
    render(
      <Modal open onClose={noop} title="Save query" footer={<button type="button">Save</button>}>
        <input aria-label="Name" />
      </Modal>,
    );

    const close = screen.getByRole('button', { name: 'Close' });
    const save = screen.getByRole('button', { name: 'Save' });

    save.focus();
    await user.keyboard('{Tab}');
    expect(document.activeElement).toBe(close);

    await user.keyboard('{Shift>}{Tab}{/Shift}');
    expect(document.activeElement).toBe(save);
  });

  it('restores focus to the element that opened it', async () => {
    const user = userEvent.setup();

    function OpenerHarness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open
          </button>
          <Modal open={open} onClose={() => setOpen(false)} title="Save query">
            <input aria-label="Name" />
          </Modal>
        </>
      );
    }

    render(<OpenerHarness />);
    const opener = screen.getByRole('button', { name: 'Open' });
    await user.click(opener);
    expect(document.activeElement).toBe(screen.getByLabelText('Name'));

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('closes when the overlay itself is clicked, but not the panel', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="Save query">
        <input aria-label="Name" />
      </Modal>,
    );

    const overlay = screen.getByRole('dialog').parentElement!;
    await user.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);

    onClose.mockClear();
    await user.click(screen.getByLabelText('Name'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('portals the panel to document.body', () => {
    const { container } = render(
      <Modal open onClose={noop} title="Save query">
        <input aria-label="Name" />
      </Modal>,
    );

    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(screen.getByRole('dialog').closest('body')).toBe(document.body);
  });
});
