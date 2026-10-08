import { isEvidenceType, type EvidenceType } from './enums.js';

/**
 * A parsed evidence-timeline query. The same parser is used by the web query
 * builder UI and by the server, which translates a `ParsedQuery` into a
 * parameterized SQL WHERE clause. Keep this format stable — it is the contract
 * between the two.
 */
export interface DateRange {
  /** Inclusive lower bound, `YYYY-MM-DD` (or empty for open-ended). */
  from: string;
  /** Inclusive upper bound, `YYYY-MM-DD` (or empty for open-ended). */
  to: string;
}

export interface ParsedQuery {
  /** Free-text terms, matched against the evidence description. */
  text: string[];
  /** Tag names that must all be present (`tag:` terms). */
  tags: string[];
  /** Operator slugs/names (`operator:` terms). */
  operators: string[];
  /** Evidence content types (`type:` terms). */
  types: EvidenceType[];
  /** Occurred-at date ranges (`range:from,to`). */
  dateRanges: DateRange[];
  /** Specific evidence UUIDs (`uuid:` terms). */
  uuids: string[];
  /** `with-finding` → true, `without-finding` → false, absent → undefined. */
  withFinding?: boolean;
  /** `starred` / `starred:true` → true (only evidence the viewer starred), `starred:false` → false. */
  starred?: boolean;
  /** `no-comments` → true: hide evidence that is a comment on other evidence. */
  noComments?: boolean;
  /** `sort:asc` → true (oldest first); default false (newest first). */
  sortAsc: boolean;
}

const VALUE_KEYS = new Set(['tag', 'operator', 'type', 'range', 'uuid', 'sort', 'starred']);

interface RawToken {
  key: string | null;
  value: string;
}

function isSpace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

/** Split a query string into key/value tokens, honoring `"quoted values"`. */
function tokenize(input: string): RawToken[] {
  const tokens: RawToken[] = [];
  let i = 0;
  const n = input.length;

  const readQuoted = (): string => {
    // assumes input[i] === '"'
    i++; // skip opening quote
    let out = '';
    while (i < n && input[i] !== '"') {
      out += input[i];
      i++;
    }
    if (i < n) i++; // skip closing quote
    return out;
  };

  const readUntilSpace = (): string => {
    let out = '';
    while (i < n && !isSpace(input[i]!)) {
      out += input[i];
      i++;
    }
    return out;
  };

  while (i < n) {
    // skip whitespace
    while (i < n && isSpace(input[i]!)) i++;
    if (i >= n) break;

    if (input[i] === '"') {
      tokens.push({ key: null, value: readQuoted() });
      continue;
    }

    // read a head up to space, ':' or quote
    let head = '';
    while (i < n && !isSpace(input[i]!) && input[i] !== ':' && input[i] !== '"') {
      head += input[i];
      i++;
    }

    if (i < n && input[i] === ':') {
      const key = head.toLowerCase();
      if (VALUE_KEYS.has(key)) {
        i++; // consume ':'
        const value = i < n && input[i] === '"' ? readQuoted() : readUntilSpace();
        tokens.push({ key, value });
        continue;
      }
      // not a known key: the ':' and the rest are part of a free-text token
      const rest = readUntilSpace(); // starts at ':'
      tokens.push({ key: null, value: head + rest });
      continue;
    }

    // plain bareword (may be a boolean flag)
    tokens.push({ key: null, value: head });
  }

  return tokens;
}

/** Parse a raw timeline query string into a typed `ParsedQuery`. */
export function parseQuery(input: string): ParsedQuery {
  const result: ParsedQuery = {
    text: [],
    tags: [],
    operators: [],
    types: [],
    dateRanges: [],
    uuids: [],
    sortAsc: false,
  };

  for (const { key, value } of tokenize(input)) {
    if (value === '' && key === null) continue;

    switch (key) {
      case 'tag':
        if (value) result.tags.push(value);
        break;
      case 'operator':
        if (value) result.operators.push(value);
        break;
      case 'type':
        // `isEvidenceType` narrows, so an unknown `type:` token is dropped rather
        // than cast into the enum — a typo silently matches nothing instead of
        // becoming a filter no evidence can satisfy.
        if (isEvidenceType(value)) result.types.push(value);
        break;
      case 'uuid':
        if (value) result.uuids.push(value);
        break;
      case 'range': {
        const [from = '', to = ''] = value.split(',');
        // A single date means a single-day range.
        result.dateRanges.push({ from: from.trim(), to: (to || from).trim() });
        break;
      }
      case 'sort':
        result.sortAsc = value.toLowerCase() === 'asc';
        break;
      case 'starred': {
        const flag = value.toLowerCase();
        if (flag === 'true') result.starred = true;
        else if (flag === 'false') result.starred = false;
        // Any other value is not a valid flag — keep the whole token as free
        // text, the same way unknown key:value tokens are treated.
        else result.text.push(`starred:${value}`);
        break;
      }
      case null:
        if (value === 'with-finding') result.withFinding = true;
        else if (value === 'without-finding') result.withFinding = false;
        else if (value === 'starred') result.starred = true;
        else if (value === 'no-comments') result.noComments = true;
        else result.text.push(value);
        break;
    }
  }

  return result;
}

function quoteIfNeeded(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}

/** Reconstruct a canonical query string from a `ParsedQuery` (for the UI). */
export function stringifyQuery(q: ParsedQuery): string {
  const parts: string[] = [];
  for (const t of q.tags) parts.push(`tag:${quoteIfNeeded(t)}`);
  for (const o of q.operators) parts.push(`operator:${quoteIfNeeded(o)}`);
  for (const t of q.types) parts.push(`type:${t}`);
  for (const r of q.dateRanges) parts.push(`range:${r.from},${r.to}`);
  for (const u of q.uuids) parts.push(`uuid:${u}`);
  if (q.withFinding === true) parts.push('with-finding');
  if (q.withFinding === false) parts.push('without-finding');
  if (q.starred === true) parts.push('starred');
  if (q.starred === false) parts.push('starred:false');
  if (q.noComments === true) parts.push('no-comments');
  if (q.sortAsc) parts.push('sort:asc');
  for (const t of q.text) parts.push(quoteIfNeeded(t));
  return parts.join(' ');
}

/** True when the query would not filter anything out. */
export function isEmptyQuery(q: ParsedQuery): boolean {
  return (
    q.text.length === 0 &&
    q.tags.length === 0 &&
    q.operators.length === 0 &&
    q.types.length === 0 &&
    q.dateRanges.length === 0 &&
    q.uuids.length === 0 &&
    q.withFinding === undefined &&
    q.starred === undefined &&
    q.noComments === undefined
  );
}
