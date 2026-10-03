import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { DraggableAttributes, DraggableSyntheticListeners } from '@dnd-kit/core';
import { Badge, Button, TagChip, Textarea } from '@reporter/ui';
import { EVIDENCE_TYPE_LABELS, type FindingEvidence } from '@reporter/shared';
import { evidenceHeading, evidenceSnippet } from '../../lib/evidence-label.js';
import { formatDateTime } from '../../lib/format.js';
import { READ_ONLY_TITLE } from '../../lib/permissions.js';
import { evidenceThumbUrl } from '../../lib/urls.js';
import { EvidenceExclusionBadge } from '../evidence/ExcludedFromReportBadge.js';

const TYPE_ICON: Record<string, string> = {
  image: '🖼',
  codeblock: '⌨',
  'terminal-recording': '▸',
  'http-request-cycle': '⇄',
  event: '⚑',
  none: '✎',
};

/** How long to wait after the last keystroke before autosaving a caption. */
const CAPTION_DEBOUNCE_MS = 700;

/** Drag-handle bindings threaded down from `useSortable`. */
export interface DragBindings {
  setNodeRef: (node: HTMLElement | null) => void;
  style: CSSProperties;
  attributes: DraggableAttributes;
  listeners: DraggableSyntheticListeners;
  isDragging: boolean;
}

/**
 * One evidence card as it appears inside a finding, shared by the Attack Path and
 * Attached Evidence sections so the two stay visually consistent. Purely
 * presentational except for the caption draft it owns (path variant): the draft
 * is seeded from `ev.caption` and keyed by uuid, so cache refreshes on other
 * links never clobber an in-progress edit.
 */
export function FindingEvidenceCard({
  slug,
  ev,
  variant,
  stepNumber,
  drag,
  onSaveCaption,
  onMove,
  onDetach,
  moving,
  readOnly,
}: {
  slug: string;
  ev: FindingEvidence;
  variant: 'path' | 'attached';
  stepNumber?: number;
  drag: DragBindings;
  /** Persist a caption change (path variant only). */
  onSaveCaption?: (caption: string) => void;
  /** Move this link to the other bucket. */
  onMove: () => void;
  /** Detach this link from the finding. */
  onDetach: () => void;
  /** The move action is in flight — disable it to avoid double-submits. */
  moving?: boolean;
  /** Read-only access: every mutating control renders disabled. */
  readOnly?: boolean;
}) {
  const extraTags = ev.tags.length - 3;
  // Move this link to the other bucket. Full label for assistive tech / tooltip;
  // short label keeps the action button compact inside the card action row.
  const moveLabel = variant === 'path' ? 'Move to attached evidence' : 'Move to attack path';
  const moveShort = variant === 'path' ? 'To attached' : 'To attack path';

  return (
    <div ref={drag.setNodeRef} style={drag.style} className={cardClass(drag.isDragging)}>
      <div className="flex items-start gap-3">
        {variant === 'path' && stepNumber !== undefined && (
          <span
            aria-label={`Step ${stepNumber}`}
            className="mt-0.5 flex h-6 w-6 flex-none items-center justify-center rounded-full bg-accent/10 text-xs font-semibold text-accent"
          >
            {stepNumber}
          </span>
        )}
        <button
          {...drag.attributes}
          {...drag.listeners}
          type="button"
          disabled={readOnly}
          title={readOnly ? READ_ONLY_TITLE : undefined}
          aria-label="Drag to reorder"
          className="mt-0.5 flex-none cursor-grab touch-none rounded-input px-0.5 text-muted transition-colors hover:text-text active:cursor-grabbing disabled:opacity-50"
        >
          <span aria-hidden>⠿</span>
        </button>
        <Thumb slug={slug} ev={ev} />
        <div className="min-w-0 flex-1">
          <Link
            to={`/engagements/${slug}/evidence/${ev.uuid}`}
            className="block truncate text-sm font-medium text-text hover:text-accent"
          >
            {evidenceHeading(ev)}
          </Link>
          {evidenceSnippet(ev) && (
            <p className="truncate text-xs text-muted">{evidenceSnippet(ev)}</p>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
            <Badge tone="neutral">{EVIDENCE_TYPE_LABELS[ev.contentType]}</Badge>
            {/* The link stays — the exclusion only withholds it from report output,
                so the author can see the gap the report will have. Inherited
                exclusion is badged too: linked evidence under an excluded capture is
                just as absent from the report, and nothing else on this row says so. */}
            <EvidenceExclusionBadge evidence={ev} />
            <span>{formatDateTime(ev.occurredAt)}</span>
            {ev.tags.slice(0, 3).map((t) => (
              <TagChip key={t.id} name={t.name} colorName={t.colorName} />
            ))}
            {extraTags > 0 && <Badge tone="neutral">+{extraTags}</Badge>}
          </div>
        </div>
        <div className="flex flex-none items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={onMove}
            loading={moving}
            disabled={readOnly}
            aria-label={moveLabel}
            title={readOnly ? READ_ONLY_TITLE : moveLabel}
          >
            {!moving && (
              <span aria-hidden className="text-muted">
                {variant === 'path' ? '↧' : '↥'}
              </span>
            )}
            {moveShort}
          </Button>
          <button
            type="button"
            onClick={onDetach}
            disabled={readOnly}
            aria-label="Detach"
            title={readOnly ? READ_ONLY_TITLE : 'Detach'}
            className="rounded-input p-1 text-muted transition-colors hover:bg-surface-2 hover:text-danger focus-visible:text-danger disabled:opacity-50"
          >
            ✕
          </button>
        </div>
      </div>

      {variant === 'path' && onSaveCaption && (
        <CaptionEditor
          key={ev.uuid}
          initial={ev.caption}
          onSave={onSaveCaption}
          disabled={readOnly}
        />
      )}
    </div>
  );
}

function cardClass(isDragging: boolean): string {
  return [
    'rounded-card border border-border bg-surface p-3 transition-colors',
    isDragging ? 'opacity-60' : 'hover:border-accent/50',
  ].join(' ');
}

function Thumb({ slug, ev }: { slug: string; ev: FindingEvidence }): ReactNode {
  return (
    <div className="h-12 w-12 flex-none overflow-hidden rounded-input border border-border bg-surface-2">
      {ev.hasThumbnail ? (
        <img src={evidenceThumbUrl(slug, ev.uuid)} alt="" className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-lg text-muted">
          {TYPE_ICON[ev.contentType] ?? '•'}
        </div>
      )}
    </div>
  );
}

/**
 * Attack-Path caption editor. Owns a local draft seeded from `initial` (the card
 * is keyed by uuid so remounting reseeds correctly). Saves on blur and after a
 * short debounce so cache refreshes never overwrite an active edit.
 */
function CaptionEditor({
  initial,
  onSave,
  disabled,
}: {
  initial: string;
  onSave: (caption: string) => void;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState(initial);
  // Track what's persisted so we don't fire redundant saves.
  const savedRef = useRef(initial);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const commit = (value: string) => {
    if (value === savedRef.current) return;
    savedRef.current = value;
    onSave(value);
  };

  const onChange = (value: string) => {
    setDraft(value);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => commit(value), CAPTION_DEBOUNCE_MS);
  };

  const onBlur = () => {
    if (timer.current) clearTimeout(timer.current);
    commit(draft);
  };

  return (
    <Textarea
      rows={2}
      value={draft}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      disabled={disabled}
      title={disabled ? READ_ONLY_TITLE : undefined}
      placeholder="Describe this step of the attack…"
      aria-label="Attack-path step caption"
      className="mt-3 text-sm"
    />
  );
}
