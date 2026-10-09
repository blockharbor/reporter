import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { restrictToVerticalAxis } from '@dnd-kit/modifiers';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Button, Card, EmptyState, useConfirm, useToast } from '@reporter/ui';
import type { FindingEvidence } from '@reporter/shared';
import {
  useDetachEvidence,
  useReorderEvidence,
  useUpdateFindingEvidence,
} from '../../api/hooks.js';
import { READ_ONLY_TITLE } from '../../lib/permissions.js';
import { FindingEvidenceCard } from './FindingEvidenceCard.js';

/**
 * The ordered, captioned Attack Path bucket (inPath=true). Numbered, drag-reorderable
 * steps with per-step captions, plus move-to-attached and detach actions.
 *
 * The same rows mean two different things depending on the finding's kind, so the
 * copy follows the report's wording exactly: a weakness builds an **Attack Path**,
 * a strength records the **Steps Taken** — the attempt the control withstood.
 * Calling a strength's verification an attack path would assert an exploitation
 * that did not happen. See `renderFinding` in the server's findings-report service,
 * which picks its `<h4>` by the same rule; the two must not drift.
 */
export function AttackPathSection({
  slug,
  findingUuid,
  items,
  onAddStep,
  canWrite,
  isStrength,
}: {
  slug: string;
  findingUuid: string;
  items: FindingEvidence[];
  onAddStep: () => void;
  /** The user may edit the finding; false renders every mutating control disabled. */
  canWrite: boolean;
  /** Switches the section's wording from "Attack Path" to "Steps Taken". */
  isStrength: boolean;
}) {
  const reorder = useReorderEvidence(slug, findingUuid);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const ids = items.map((ev) => ev.uuid);
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    // Reorder ONLY this bucket's uuids.
    reorder.mutate(arrayMove(ids, from, to));
  }

  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-text">
          {isStrength ? 'Steps Taken' : 'Attack Path'} ({items.length})
        </h3>
        <Button
          size="sm"
          onClick={onAddStep}
          disabled={!canWrite}
          title={canWrite ? undefined : READ_ONLY_TITLE}
        >
          Add step
        </Button>
      </div>

      {items.length === 0 ? (
        <EmptyState
          title={isStrength ? 'Record the steps taken' : 'Build the attack path'}
          description={
            isStrength
              ? 'Add evidence steps showing what was tried against this control, in order.'
              : 'Add evidence steps that tell the story of the attack, in order.'
          }
          action={
            <Button
              size="sm"
              onClick={onAddStep}
              disabled={!canWrite}
              title={canWrite ? undefined : READ_ONLY_TITLE}
            >
              Add step
            </Button>
          }
        />
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis]}
          onDragEnd={onDragEnd}
        >
          <SortableContext items={items.map((e) => e.uuid)} strategy={verticalListSortingStrategy}>
            <ol className="flex flex-col">
              {items.map((ev, i) => (
                <SortableStep
                  key={ev.uuid}
                  slug={slug}
                  findingUuid={findingUuid}
                  ev={ev}
                  stepNumber={i + 1}
                  isLast={i === items.length - 1}
                  canWrite={canWrite}
                  isStrength={isStrength}
                />
              ))}
            </ol>
          </SortableContext>
        </DndContext>
      )}
    </Card>
  );
}

function SortableStep({
  slug,
  findingUuid,
  ev,
  stepNumber,
  isLast,
  canWrite,
  isStrength,
}: {
  slug: string;
  findingUuid: string;
  ev: FindingEvidence;
  stepNumber: number;
  isLast: boolean;
  canWrite: boolean;
  /** Switches this row's copy to the strength wording; see {@link AttackPathSection}. */
  isStrength: boolean;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const detach = useDetachEvidence(slug, findingUuid);
  const update = useUpdateFindingEvidence(slug, findingUuid);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: ev.uuid,
    disabled: !canWrite,
  });

  async function onDetach() {
    const ok = await confirm({
      title: 'Remove step',
      message: isStrength
        ? 'Remove this evidence from the steps taken? The evidence itself is kept.'
        : 'Remove this evidence from the attack path? The evidence itself is kept.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    detach.mutate(ev.uuid);
  }

  function onMove() {
    update.mutate(
      { evidenceUuid: ev.uuid, patch: { inPath: false } },
      {
        onSuccess: () => toast.success('Moved to attached evidence'),
        onError: (err) => toast.error(err instanceof Error ? err.message : 'Move failed'),
      },
    );
  }

  return (
    <li className="relative pb-2">
      <FindingEvidenceCard
        slug={slug}
        ev={ev}
        variant="path"
        stepNumber={stepNumber}
        drag={{
          setNodeRef,
          style: {
            transform: CSS.Transform.toString(transform),
            transition,
            opacity: isDragging ? 0.6 : 1,
          },
          attributes,
          listeners,
          isDragging,
        }}
        onSaveCaption={(caption) => update.mutate({ evidenceUuid: ev.uuid, patch: { caption } })}
        onMove={onMove}
        onDetach={onDetach}
        moving={update.isPending}
        readOnly={!canWrite}
      />
      {/* Subtle sequence connector between steps: a short token-colored rule so the
          ordered flow reads clearly in both themes. */}
      {!isLast && (
        <div aria-hidden className="flex flex-col items-center gap-0.5 py-1 text-muted">
          <span className="h-3 w-px bg-border" />
          <span className="text-xs leading-none">↓</span>
        </div>
      )}
    </li>
  );
}
