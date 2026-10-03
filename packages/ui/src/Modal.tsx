import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from './cn.js';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  /** Footer actions (usually buttons). */
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
}

const sizes = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-3xl' } as const;

/** A centered, focus-trapped modal dialog. Closes on Esc or overlay click. */
export function Modal({ open, onClose, title, children, footer, size = 'md' }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  /**
   * The body is scanned for the initial focus target separately from the panel,
   * so the header ✕ — first in DOM order, and never what the user wants — is
   * excluded. The Tab trap still covers the whole panel.
   */
  const bodyRef = useRef<HTMLDivElement>(null);

  /**
   * Latest-value ref. Lets the keydown effect below close the dialog without
   * listing `onClose` in its dependencies: callers pass inline arrows, so its
   * identity changes on every render of the parent.
   */
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  /**
   * What to hand focus back to on close. Captured during the opening render
   * rather than in an effect because React implements a child's `autoFocus` by
   * calling .focus() while committing the panel — by the time effects run,
   * `document.activeElement` is already inside the dialog.
   */
  const restoreRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  if (open !== wasOpenRef.current) {
    if (open && typeof document !== 'undefined') {
      const active = document.activeElement;
      restoreRef.current = active instanceof HTMLElement ? active : null;
    }
    wasOpenRef.current = open;
  }

  // Esc to close, Tab to cycle. Depends on [open] alone deliberately: `onClose`
  // is read through the ref above, so a new callback identity cannot tear this
  // listener down — which is what used to re-run the focus effect below.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
      if (e.key === 'Tab') trapFocus(e, panelRef.current);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  // Initial focus, and restoring focus on close. [open] must stay the *only*
  // dependency: this effect moves the caret, so re-running it on an ordinary
  // re-render steals focus from whatever the user is typing into. That was a
  // real bug — dialogs whose parent owns the input's state ("Save query", the
  // type-the-slug delete confirmation) accepted exactly one character before
  // focus jumped to the header ✕. Do not widen this array.
  useEffect(() => {
    if (!open) return;
    // The portal has committed by now, so the refs are attached; guard anyway.
    const panel = panelRef.current;
    if (!panel) return;

    const explicit = panel.querySelector<HTMLElement>('[data-autofocus], [autofocus]');
    if (explicit) {
      explicit.focus();
    } else if (!panel.contains(document.activeElement)) {
      // Nothing claimed focus during the commit — React never renders the
      // `autofocus` attribute, so a caller's `autoFocus` shows up as focus
      // already being inside the panel, not as something the query can find.
      // Otherwise: first control in the body, then the panel itself if that
      // control is hidden or disabled and silently refuses focus.
      bodyRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
      if (!panel.contains(document.activeElement)) panel.focus();
    }

    return () => {
      // Hand focus back to whatever opened the dialog. The panel is portaled,
      // so the browser drops focus to <body> as it unmounts; if focus has since
      // moved somewhere deliberate, leave it there. (`restoreRef` is left set on
      // purpose — StrictMode runs this cleanup once while the panel is still
      // mounted, and clearing it would lose the real restore target.)
      const active = document.activeElement;
      if (active && active !== document.body && active !== document.documentElement) return;
      const previous = restoreRef.current;
      if (previous?.isConnected) previous.focus();
    };
  }, [open]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/*
        Column layout capped at the viewport (overlay padding is p-4 → max-h-full
        resolves to 100vh − 2rem). The header and footer stay pinned (shrink-0) and
        only the body scrolls (flex-1 + min-h-0 + overflow-y-auto), so a tall body —
        e.g. a long markdown description — can never push the title or the action
        buttons off-screen. min-h-0 is required for the flex child to shrink and
        scroll instead of forcing the panel taller than its max height.
      */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        // Focusable only programmatically (tabindex="-1" is excluded from
        // FOCUSABLE), so the panel can hold focus when its body has no control.
        tabIndex={-1}
        className={cn(
          'flex max-h-full w-full flex-col rounded-panel border border-border bg-surface shadow-[var(--shadow)]',
          sizes[size],
        )}
        style={{ boxShadow: 'var(--shadow)' }}
      >
        {title && (
          <div className="flex shrink-0 items-center justify-between border-b border-border px-5 py-3">
            <h2 className="text-base font-semibold text-text">{title}</h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="rounded-input p-1 text-muted hover:bg-surface-2 hover:text-text"
            >
              ✕
            </button>
          </div>
        )}
        <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {children}
        </div>
        {footer && (
          <div className="flex shrink-0 justify-end gap-2 border-t border-border px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

function trapFocus(e: KeyboardEvent, container: HTMLElement | null) {
  if (!container) return;
  const nodes = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE));
  if (nodes.length === 0) return;
  const first = nodes[0]!;
  const last = nodes[nodes.length - 1]!;
  const active = document.activeElement;
  // Focus sitting on the panel itself (the fallback when the body has no
  // control) or outside it is not in `nodes`, so pull it back in explicitly —
  // otherwise Tab would walk straight out of the dialog.
  if (!container.contains(active) || active === container) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
  } else if (e.shiftKey && active === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}
