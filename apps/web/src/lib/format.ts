export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Local wall-clock time, e.g. "2:14 PM". */
export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** Long weekday + full date, e.g. "Thursday, August 14, 2026". */
export function formatDayHeading(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

/**
 * Date only (no time), e.g. "Aug 18, 2026", in the viewer's local time zone —
 * consistent with the other formatters here. Engagement dates are a mix of
 * server-set instants (`startedAt` defaults to now(); `actualEndAt` is stamped on
 * completion) and dates picked in an `<input type="date">`; formatting them
 * locally keeps "Started <today>" honest for the operator who just created the
 * engagement, rather than jumping a day for anyone west of UTC.
 */
export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** ISO datetime → "YYYY-MM-DD" for an `<input type="date">` value, in local time. */
export function toDateInputValue(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * "YYYY-MM-DD" from an `<input type="date">` → an ISO datetime at LOCAL midnight
 * (built from the parts so it isn't parsed as UTC), or null when the field is
 * cleared. Pairs with {@link toDateInputValue} for a clean local round-trip.
 */
export function fromDateInput(ymd: string): string | null {
  if (!ymd) return null;
  const [y, m, d] = ymd.split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d).toISOString();
}

export function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const secs = Math.round((Date.now() - then) / 1000);
  const abs = Math.abs(secs);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31536000],
    ['month', 2592000],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ];
  for (const [unit, secondsIn] of units) {
    if (abs >= secondsIn) return rtf.format(-Math.round(secs / secondsIn), unit);
  }
  return rtf.format(-secs, 'second');
}

/**
 * Humanize a byte count — "840 B", "2.4 MB", "1.1 GB". Null renders as the empty
 * string so a size that was never recorded (report history from before artifacts
 * were stored) simply shows nothing rather than "0 B".
 *
 * Binary units (1024) with a decimal label, matching what desktop file managers
 * show, since every caller is labelling a file the operator will save or has saved.
 */
export function formatBytes(bytes: number | null): string {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
