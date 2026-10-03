import React, { cloneElement, useEffect, useId, useRef, type ReactElement } from 'react';
import { cn } from './cn.js';

export interface PopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The trigger element; Popover clones it to wire aria-haspopup/aria-expanded/aria-controls + onClick toggle. */
  trigger: React.ReactElement;
  children: React.ReactNode;
  /** Panel horizontal alignment relative to the trigger. Default 'start'. */
  align?: 'start' | 'end';
  /** Accessible name for the panel (role=dialog). */
  label?: string;
  className?: string;
}

/** Selectable focusable elements inside the panel (mirrors Modal.tsx). */
const FOCUSABLE =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

/** The subset of trigger props Popover reads/injects. */
interface TriggerInjectedProps {
  ref?: React.Ref<HTMLElement>;
  onClick?: (e: React.MouseEvent<HTMLElement>) => void;
  'aria-haspopup'?: 'dialog';
  'aria-expanded'?: boolean;
  'aria-controls'?: string;
}

/** An anchored popover panel that hangs off a trigger element. Not full focus-trap. */
export function Popover({
  open,
  onOpenChange,
  trigger,
  children,
  align = 'start',
  label,
  className,
}: PopoverProps): React.JSX.Element {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement>(null);
  const panelId = useId();

  /**
   * Latest-value ref. Lets the effect below depend on [open] alone: callers may
   * hand over a fresh callback on every render (an inline arrow, or a ternary
   * that swaps it when the trigger is disabled).
   */
  const onOpenChangeRef = useRef(onOpenChange);
  useEffect(() => {
    onOpenChangeRef.current = onOpenChange;
  }, [onOpenChange]);

  // Esc + outside-click close, and focus handling. [open] must stay the *only*
  // dependency: this effect moves focus on open and on close, so re-running it
  // on an ordinary re-render would steal the caret from a control inside the
  // panel — an input in a popover would accept exactly one character. Do not
  // widen this array; `onOpenChange` is read through the ref above.
  useEffect(() => {
    if (!open) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChangeRef.current(false);
    };
    const onPointerDown = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        onOpenChangeRef.current(false);
      }
    };

    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointerDown);

    // Focus the first focusable element inside the panel on open, unless the
    // content already claimed focus. React never renders the `autofocus`
    // attribute — it calls .focus() while committing — so a caller's
    // `autoFocus` shows up as focus already being inside the panel.
    const panel = panelRef.current;
    const explicit = panel?.querySelector<HTMLElement>('[data-autofocus], [autofocus]');
    if (explicit) {
      explicit.focus();
    } else if (panel && !panel.contains(document.activeElement)) {
      panel.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    }

    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointerDown);
      // Return focus to the trigger when the popover closes — but only if the
      // unmounting panel is what dropped it (the browser hands focus back to
      // <body>). A click that landed on something else outside already moved
      // focus deliberately.
      const active = document.activeElement;
      if (active && active !== document.body && active !== document.documentElement) return;
      triggerRef.current?.focus();
    };
  }, [open]);

  const typedTrigger = trigger as ReactElement<TriggerInjectedProps>;
  const existingOnClick = typedTrigger.props.onClick;
  const existingRef = (typedTrigger as { ref?: React.Ref<HTMLElement> }).ref;
  const clonedTrigger = cloneElement(typedTrigger, {
    ref: mergeRefs(triggerRef, existingRef),
    onClick: (e: React.MouseEvent<HTMLElement>) => {
      existingOnClick?.(e);
      onOpenChange(!open);
    },
    'aria-haspopup': 'dialog',
    'aria-expanded': open,
    'aria-controls': panelId,
  });

  return (
    <div ref={wrapperRef} className={cn('relative inline-block', className)}>
      {clonedTrigger}
      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-label={label}
          className={cn(
            'absolute z-40 mt-1 min-w-56 rounded-card border border-border bg-surface p-2',
            align === 'end' ? 'right-0' : 'left-0',
          )}
          style={{ boxShadow: 'var(--shadow)' }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

/** Compose the internal trigger ref with any ref the caller already put on the element. */
function mergeRefs(
  ...refs: Array<React.Ref<HTMLElement> | undefined>
): React.RefCallback<HTMLElement> {
  return (node) => {
    for (const ref of refs) {
      if (!ref) continue;
      if (typeof ref === 'function') {
        ref(node);
      } else {
        (ref as React.MutableRefObject<HTMLElement | null>).current = node;
      }
    }
  };
}
