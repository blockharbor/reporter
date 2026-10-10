import { Button, cn } from '@reporter/ui';

/**
 * Previous · "Page X of Y" · Next for a server-paginated list. The caller owns
 * the page (in the URL — a page is a place, so changing it PUSHES a history
 * entry, unlike filters, which replace) and must already have parsed and
 * clamped it: this control only disables the edges, it never corrects the
 * number. Renders nothing for a single page so a short list carries no chrome.
 *
 * Lifted from the Evidence tab's inline pager so the two Audit log tabs and the
 * timeline share one control.
 */
export function Pagination({
  page,
  totalPages,
  onPageChange,
  className,
}: {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  className?: string;
}) {
  if (totalPages <= 1) return null;
  return (
    <nav
      aria-label="Pagination"
      className={cn('flex items-center justify-center gap-3 text-sm', className)}
    >
      <Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
        Previous
      </Button>
      <span className="text-muted" aria-live="polite">
        Page {page} of {totalPages}
      </span>
      <Button
        variant="ghost"
        size="sm"
        disabled={page >= totalPages}
        onClick={() => onPageChange(page + 1)}
      >
        Next
      </Button>
    </nav>
  );
}

/**
 * `?page=` as a 1-based integer; anything else (absent, NaN, 0, '1.5', a
 * negative, an empty value) is page 1. `Number('')` is 0 and `Number('abc')` is
 * NaN — the two shapes that rendered "Page NaN of 3" on the Evidence tab.
 */
export function parsePageParam(raw: string | null): number {
  if (raw === null) return 1;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : 1;
}
