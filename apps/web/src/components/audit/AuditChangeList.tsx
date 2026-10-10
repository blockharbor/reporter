import { useState, type ReactNode } from 'react';
import { Badge, cn, type BadgeTone } from '@reporter/ui';
import {
  auditFieldLabel,
  type AuditChange,
  type AuditEntityType,
  type AuditListItemRef,
} from '@reporter/shared';
import { diffRefList, diffValues, formatValue, type KeyChange } from './json-diff.js';

/** Past this many characters a value folds behind "Show full". */
export const LONG_VALUE_CHARS = 280;

/**
 * The heading for one change: the change's own label for the kinds that carry
 * one, else the shared field label — pinned (`executiveSummary` → "Executive
 * summary") or de-camel-cased, so a key nobody pinned still reads as words.
 */
export function changeName(change: AuditChange, entityType: AuditEntityType): string {
  if (change.kind === 'items' || change.kind === 'count') return change.label;
  return auditFieldLabel(entityType, change.field);
}

/**
 * One side of a before/after. Nothing renders as the em dash with a title, so
 * "— → value" is readable and hoverable; text past LONG_VALUE_CHARS folds
 * behind "Show full"; structured values (pretty JSON) render in a monospace
 * block of their own.
 */
function ValueText({ value }: { value: unknown }) {
  const [full, setFull] = useState(false);
  if (value === null || value === undefined || value === '') {
    return (
      <span className="text-muted" title="empty">
        —
      </span>
    );
  }
  const text = formatValue(value);
  const long = text.length > LONG_VALUE_CHARS;
  const block = text.includes('\n') || (long && full);
  const shown = long && !full ? `${text.slice(0, LONG_VALUE_CHARS)}…` : text;
  return (
    <span
      className={cn(
        'whitespace-pre-wrap break-words',
        block && 'block rounded-input bg-surface-2 px-2 py-1 font-mono text-xs',
      )}
    >
      {shown}
      {long && (
        <button
          type="button"
          onClick={() => setFull((v) => !v)}
          className="ml-1 text-xs text-accent hover:underline"
        >
          {full ? 'Show less' : 'Show full'}
        </button>
      )}
    </span>
  );
}

function Arrow() {
  return (
    <>
      <span aria-hidden="true" className="text-muted">
        →
      </span>
      <span className="sr-only">changed to</span>
    </>
  );
}

function BeforeAfter({ from, to }: { from: unknown; to: unknown }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <ValueText value={from} />
      <Arrow />
      <ValueText value={to} />
    </div>
  );
}

/** A headed sub-list; renders nothing when there is nothing under it. */
function Group({ heading, tone, items }: { heading: string; tone: BadgeTone; items: ReactNode[] }) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <Badge tone={tone}>{heading}</Badge>
      <ul className="ml-4 list-disc">
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

const keyLine = (c: KeyChange, side: 'from' | 'to') => (
  <span className="flex flex-wrap items-baseline gap-x-2">
    <span className="font-mono text-xs text-accent">{c.key}</span>
    <ValueText value={side === 'from' ? c.from : c.to} />
  </span>
);

const refLabel = (r: AuditListItemRef) => <span title={r.hash}>{r.label}</span>;

function FieldChange({ from, to }: { from: unknown; to: unknown }) {
  const diff = diffValues(from, to);
  switch (diff.kind) {
    case 'scalar':
      return <BeforeAfter from={diff.from} to={diff.to} />;
    case 'array':
      if (diff.added.length === 0 && diff.removed.length === 0) {
        return <span className="text-muted">Reordered or saved without a change.</span>;
      }
      return (
        <div className="flex flex-col gap-2">
          <Group
            heading="Added"
            tone="success"
            items={diff.added.map((v, i) => (
              <ValueText key={i} value={v} />
            ))}
          />
          <Group
            heading="Removed"
            tone="danger"
            items={diff.removed.map((v, i) => (
              <ValueText key={i} value={v} />
            ))}
          />
        </div>
      );
    case 'object':
      if (diff.added.length === 0 && diff.removed.length === 0 && diff.edited.length === 0) {
        return <span className="text-muted">Saved without a change.</span>;
      }
      return (
        <div className="flex flex-col gap-2">
          <Group heading="Added" tone="success" items={diff.added.map((c) => keyLine(c, 'to'))} />
          <Group
            heading="Removed"
            tone="danger"
            items={diff.removed.map((c) => keyLine(c, 'from'))}
          />
          <Group
            heading="Edited"
            tone="info"
            items={diff.edited.map((c) => (
              <span className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-mono text-xs text-accent">{c.key}</span>
                <BeforeAfter from={c.from} to={c.to} />
              </span>
            ))}
          />
        </div>
      );
  }
}

function ListChange({ from, to }: { from: AuditListItemRef[]; to: AuditListItemRef[] }) {
  const diff = diffRefList(from, to);
  if (diff.added.length === 0 && diff.removed.length === 0 && diff.edited.length === 0) {
    return <span className="text-muted">Reordered or saved without a change.</span>;
  }
  return (
    <div className="flex flex-col gap-2">
      <Group heading="Added" tone="success" items={diff.added.map(refLabel)} />
      <Group heading="Removed" tone="danger" items={diff.removed.map(refLabel)} />
      <Group heading="Edited" tone="info" items={diff.edited.map(refLabel)} />
    </div>
  );
}

function OrderChange({ from, to }: { from: string[]; to: string[] }) {
  const column = (heading: string, labels: string[]) => (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-xs font-medium text-muted">{heading}</span>
      {labels.length === 0 ? (
        <span className="text-muted">—</span>
      ) : (
        <ol className="ml-4 list-decimal">
          {labels.map((l, i) => (
            <li key={`${i}-${l}`}>{l}</li>
          ))}
        </ol>
      )}
    </div>
  );
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {column('Before', from)}
      {column('After', to)}
    </div>
  );
}

/** The body of one change, by kind. Never assumes `from`/`to` exist. */
function ChangeBody({ change }: { change: AuditChange }) {
  switch (change.kind) {
    case 'field':
      return <FieldChange from={change.from} to={change.to} />;
    case 'list':
      return <ListChange from={change.from} to={change.to} />;
    case 'order':
      return <OrderChange from={change.from} to={change.to} />;
    case 'items':
      return change.items.length === 0 ? (
        <span className="text-muted">—</span>
      ) : (
        <ul className="ml-4 list-disc">
          {change.items.map((item, i) => (
            <li key={`${i}-${item}`}>{item}</li>
          ))}
        </ul>
      );
    case 'count':
      return <span className="tabular-nums">{change.count.toLocaleString()}</span>;
    case 'elided':
      return (
        <span className="italic text-muted" title="Its value was too large for the log to keep">
          Too large to record
        </span>
      );
  }
}

/**
 * Every change on one entry, as a definition list: the field (labelled through
 * the shared AUDIT_FIELD_LABELS, never a hand-written table) and what happened
 * to it. Branches on `kind` — the wire is a discriminated union, and only two
 * of its six kinds carry a before and an after.
 */
export function AuditChangeList({
  changes,
  entityType,
}: {
  changes: AuditChange[];
  entityType: AuditEntityType;
}) {
  if (changes.length === 0) {
    return <p className="text-sm text-muted">No details were recorded for this entry.</p>;
  }
  // A run of counts ("Evidence 6", "Findings 3") is one word each; stacked
  // one per line across the full table width it reads as a column of air.
  const compact = changes.every((c) => c.kind === 'count');
  return (
    <dl className={cn('gap-3', compact ? 'grid sm:grid-cols-2 lg:grid-cols-3' : 'flex flex-col')}>
      {changes.map((change, i) => (
        <div key={i} className="flex flex-col gap-1">
          <dt className="text-xs font-medium uppercase tracking-wide text-muted">
            {changeName(change, entityType)}
          </dt>
          <dd className="text-sm text-text">
            <ChangeBody change={change} />
          </dd>
        </div>
      ))}
    </dl>
  );
}
