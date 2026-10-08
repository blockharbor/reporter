import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

export interface DeepLinkRow {
  /** DOM id of the element to scroll into view. */
  rowId: string;
  /** Open whatever hides the row — runs before the scroll. */
  reveal?: () => void;
}

/** How long a row arrived at through a deep link stays flashed. */
export const DEEP_LINK_HIGHLIGHT_MS = 1800;

/** The flash itself: an accent tint plus the ring used for selected rows. */
export const DEEP_LINK_HIGHLIGHT = 'bg-accent/10 ring-2 ring-accent';

/**
 * Arrival half of a deep link that addresses one row inside a page: read the
 * search param, reveal the row, scroll it into view, flash it, and drop the param.
 *
 * Every deep link in the app that lands on a *row* rather than a page uses this,
 * so the arrival feels the same everywhere (and there is one definition of the
 * flash, its duration and the reduced-motion rule):
 *
 * - `?rec=<index>` → a strategic recommendation (Reports → Content)
 * - `?goal=<id>` → one goal in the Goals tree
 *
 * `resolve` turns the raw param into the row it names, or `null` when it names
 * nothing — a malformed value, or a row deleted since the link was made. Its
 * `reveal` callback opens whatever is hiding the row (a collapsed section) and
 * runs before the scroll. `ready` says the page's data has arrived; until it does,
 * the param is held rather than judged, since an unloaded list resolves nothing.
 *
 * The param is deleted on arrival whatever `resolve` returns: a dead link must not
 * sit in the address bar re-evaluating on every render, and dropping it stops a
 * refresh or a Back/Forward from replaying the jump. Returns the raw param of the
 * row to flash (compare it against the row's own key), or `null`.
 *
 * Deliberately no auto-focus — the reader may have followed the link to read, and
 * focusing a field would scroll the page again under them.
 */
export function useDeepLinkRow(
  param: string,
  resolve: (raw: string) => DeepLinkRow | null,
  ready: boolean,
): string | null {
  const [params, setParams] = useSearchParams();
  const [arrived, setArrived] = useState<{ key: string; rowId: string } | null>(null);
  const raw = params.get(param);

  // `resolve` closes over freshly rendered data, so it is a new function every
  // render; kept in a ref so the arrival effect depends on the param alone.
  const resolveRef = useRef(resolve);
  resolveRef.current = resolve;
  // One arrival per distinct param value: a dep object re-created on re-render
  // would otherwise re-fire the effect and toggle a revealed section back shut.
  const consumed = useRef<string | null>(null);

  useEffect(() => {
    if (raw === null || !ready) return;
    if (consumed.current === raw) return;
    consumed.current = raw;
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete(param);
        return next;
      },
      { replace: true },
    );
    const row = resolveRef.current(raw);
    if (!row) return;
    row.reveal?.();
    setArrived({ key: raw, rowId: row.rowId });
  }, [raw, ready, param, setParams]);

  useEffect(() => {
    if (!arrived) return;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // One frame later: `reveal` expanded the row's container in the same commit
    // that set this state, so the element only exists after that render.
    const frame = requestAnimationFrame(() =>
      document.getElementById(arrived.rowId)?.scrollIntoView({
        behavior: reduceMotion ? 'auto' : 'smooth',
        block: 'center',
      }),
    );
    const timer = window.setTimeout(() => setArrived(null), DEEP_LINK_HIGHLIGHT_MS);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [arrived]);

  return arrived?.key ?? null;
}
