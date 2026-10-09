import { useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Button,
  Checkbox,
  EmptyState,
  ErrorState,
  Input,
  Modal,
  SeverityBadge,
  Spinner,
  TagChip,
  useToast,
} from '@reporter/ui';
import { FINDING_KIND_LABELS, type Finding } from '@reporter/shared';
import { useFindings, useLinkGoalFinding } from '../../api/hooks.js';

/**
 * Pick one or more findings to link to a goal. Already-linked findings (by uuid)
 * are hidden. Multi-select, then link in one request.
 */
export function FindingPickerModal({
  slug,
  goalId,
  linkedUuids,
  open,
  onClose,
}: {
  slug: string;
  goalId: number | null;
  linkedUuids: string[];
  open: boolean;
  onClose: () => void;
}) {
  const toast = useToast();
  const { data: findings, isLoading, isError, refetch } = useFindings(slug);
  const link = useLinkGoalFinding(slug);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string[]>([]);

  useEffect(() => {
    if (open) {
      setSearch('');
      setSelected([]);
    }
  }, [open]);

  const linkedSet = useMemo(() => new Set(linkedUuids), [linkedUuids]);
  const q = search.trim().toLowerCase();
  const candidates = useMemo(
    () =>
      (findings ?? []).filter(
        (f) =>
          !linkedSet.has(f.uuid) &&
          (!q || f.title.toLowerCase().includes(q) || (f.category ?? '').toLowerCase().includes(q)),
      ),
    [findings, linkedSet, q],
  );

  function toggle(uuid: string, checked: boolean) {
    setSelected((s) => (checked ? [...s, uuid] : s.filter((x) => x !== uuid)));
  }

  async function submit() {
    if (goalId === null || selected.length === 0) return;
    try {
      await link.mutateAsync({ goalId, findingUuids: selected });
      toast.success(`Linked ${selected.length} finding${selected.length === 1 ? '' : 's'}`);
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not link findings');
    }
  }

  const n = selected.length;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Link findings to goal"
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={link.isPending}>
            Cancel
          </Button>
          <Button onClick={submit} loading={link.isPending} disabled={n === 0}>
            {n > 0 ? `Link ${n}` : 'Link'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter findings…"
          aria-label="Filter findings"
          autoFocus
        />
        <div className="max-h-[24rem] overflow-auto rounded-card border border-border">
          {isLoading ? (
            <div className="flex h-40 items-center justify-center">
              <Spinner size={22} />
            </div>
          ) : isError ? (
            <div className="p-4">
              <ErrorState description="Couldn’t load findings." onRetry={() => refetch()} />
            </div>
          ) : candidates.length === 0 ? (
            <div className="p-4">
              <EmptyState
                title={q ? 'No findings match your filter' : 'No findings to link'}
                description={
                  q
                    ? 'Try a different search.'
                    : 'Create findings on the Findings tab, or all findings are already linked.'
                }
              />
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {candidates.map((f) => (
                <FindingRow
                  key={f.uuid}
                  finding={f}
                  selected={selected.includes(f.uuid)}
                  onToggle={(checked) => toggle(f.uuid, checked)}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  );
}

function FindingRow({
  finding: f,
  selected,
  onToggle,
}: {
  finding: Finding;
  selected: boolean;
  onToggle: (checked: boolean) => void;
}) {
  return (
    <li className="flex items-start gap-2 p-2">
      <div className="pt-0.5">
        <Checkbox
          label=""
          aria-label={`Select ${f.title}`}
          checked={selected}
          onChange={(e) => onToggle(e.target.checked)}
        />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-text">{f.title}</p>
        <p className="truncate text-xs text-muted">
          {f.category ?? 'Uncategorized'} · Evidence ({f.numEvidence})
          {f.numGoals > 0 && ` · Goals (${f.numGoals})`}
          {f.numRecommendations > 0 && ` · Recommendations (${f.numRecommendations})`}
        </p>
        {/* Chips get their own wrapping row rather than joining the subtitle,
            which is a single `truncate` line already carrying up to four facts
            and would clip them on a narrow viewport. */}
        {f.tags.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {f.tags.map((t) => (
              <TagChip key={t.id} name={t.name} colorName={t.colorName} />
            ))}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {f.kind === 'strength' ? (
          <Badge tone="success">{FINDING_KIND_LABELS.strength}</Badge>
        ) : (
          <SeverityBadge severity={f.severity} score={f.cvssScore} />
        )}
      </div>
    </li>
  );
}
