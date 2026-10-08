import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Badge,
  Button,
  Card,
  Field,
  Input,
  MarkdownField,
  MarkdownPreview,
  Select,
  Spinner,
  useConfirm,
  useToast,
} from '@reporter/ui';
import type { RecommendationItem } from '@reporter/shared';
import { useEngagement, useUpdateEngagement } from '../../api/hooks.js';
import { recommendationHref } from '../engagement/ReportContentEditors.js';

/**
 * The strategic recommendations (engagement-level, numbered R1/R2…) linked to a
 * finding. Admins can create a new one — auto-linked to this finding — or link an
 * existing recommendation, and unlink. Non-admins see the linked list read-only.
 * Strategic recommendations live on the engagement, so edits go through the
 * (admin-gated) engagement update; this keeps them in sync with Reports → Content.
 *
 * Each title deep-links to that recommendation in Reports → Content, which is
 * where its full text is edited (Configure only toggles section visibility).
 */
export function FindingRecommendations({
  slug,
  findingUuid,
  canAdmin,
}: {
  slug: string;
  findingUuid: string;
  canAdmin: boolean;
}) {
  const { data: eng, isLoading } = useEngagement(slug);
  const update = useUpdateEngagement(slug);
  const toast = useToast();
  const confirm = useConfirm();

  const [mode, setMode] = useState<null | 'add' | 'link'>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftDesc, setDraftDesc] = useState('');
  const [linkIndex, setLinkIndex] = useState('');
  const [saving, setSaving] = useState(false);

  const recs = eng?.strategicRecommendations ?? [];
  const withIndex = recs.map((r, i) => ({ ...r, index: i, number: i + 1 }));
  const linked = withIndex.filter((r) => (r.findingUuids ?? []).includes(findingUuid));
  const unlinked = withIndex.filter((r) => !(r.findingUuids ?? []).includes(findingUuid));

  async function save(next: RecommendationItem[], successMsg: string) {
    setSaving(true);
    try {
      await update.mutateAsync({ strategicRecommendations: next });
      toast.success(successMsg);
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save recommendation');
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function createRecommendation() {
    if (!draftTitle.trim()) {
      toast.error('A title is required.');
      return;
    }
    const next: RecommendationItem[] = [
      ...recs,
      { title: draftTitle.trim(), description: draftDesc, findingUuids: [findingUuid] },
    ];
    if (await save(next, 'Strategic recommendation added')) {
      setMode(null);
      setDraftTitle('');
      setDraftDesc('');
    }
  }

  async function linkExisting() {
    const idx = Number(linkIndex);
    if (!Number.isInteger(idx) || idx < 0 || idx >= recs.length) return;
    const next = recs.map((r, i) =>
      i === idx ? { ...r, findingUuids: [...(r.findingUuids ?? []), findingUuid] } : r,
    );
    if (await save(next, 'Linked to this finding')) {
      setMode(null);
      setLinkIndex('');
    }
  }

  async function unlink(index: number, title: string) {
    const ok = await confirm({
      title: 'Unlink recommendation',
      message: `Unlink “${title}” from this finding? The recommendation itself is kept.`,
      confirmLabel: 'Unlink',
    });
    if (!ok) return;
    const next = recs.map((r, i) =>
      i === index
        ? { ...r, findingUuids: (r.findingUuids ?? []).filter((u) => u !== findingUuid) }
        : r,
    );
    await save(next, 'Unlinked from this finding');
  }

  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-text">Strategic recommendations</h3>
          <p className="mt-0.5 text-xs text-muted">
            Program-level guidance (R1, R2…) this finding feeds into — shared with the report.
            {!canAdmin && ' Only engagement admins can edit these.'}
          </p>
        </div>
        {canAdmin && mode === null && (
          <div className="flex flex-none gap-2">
            {unlinked.length > 0 && (
              <Button size="sm" variant="secondary" onClick={() => setMode('link')}>
                Link existing
              </Button>
            )}
            <Button size="sm" onClick={() => setMode('add')}>
              Add recommendation
            </Button>
          </div>
        )}
      </div>

      {isLoading ? (
        <Spinner size={18} />
      ) : linked.length === 0 ? (
        <p className="text-sm text-muted">
          No strategic recommendations linked to this finding yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {linked.map((r) => (
            <li key={r.index} className="rounded-input border border-border bg-surface-2 p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-text">
                    <Badge tone="accent">R{r.number}</Badge>
                    {/* The tooltip names no R-number: the badge beside it already
                        shows this list's position, and the report numbers only the
                        recommendations that have a title, so the two disagree while
                        an untitled draft sits earlier in the list. */}
                    <Link
                      to={recommendationHref(slug, r.index)}
                      title="Open in Reports → Content"
                      className="min-w-0 break-words rounded text-text hover:text-accent hover:underline"
                    >
                      {r.title || '(untitled)'}
                    </Link>
                  </p>
                  {r.description.trim() && (
                    <div className="mt-1 text-sm text-text">
                      <MarkdownPreview source={r.description} />
                    </div>
                  )}
                </div>
                {canAdmin && (
                  <button
                    type="button"
                    onClick={() => void unlink(r.index, r.title)}
                    aria-label={`Unlink R${r.number}`}
                    className="shrink-0 text-xs font-medium text-muted hover:text-danger"
                  >
                    Unlink
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {mode === 'add' && (
        <div className="space-y-3 border-t border-border pt-3">
          <Field label="Title" htmlFor="sr-title" required>
            <Input
              id="sr-title"
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              placeholder="e.g. Adopt centralized secrets management"
              autoFocus
            />
          </Field>
          <Field label="Description" htmlFor="sr-desc" hint="Optional">
            <MarkdownField id="sr-desc" rows={3} value={draftDesc} onChange={setDraftDesc} />
          </Field>
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setMode(null);
                setDraftTitle('');
                setDraftDesc('');
              }}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => void createRecommendation()}
              loading={saving}
              disabled={!draftTitle.trim()}
            >
              Add
            </Button>
          </div>
        </div>
      )}

      {mode === 'link' && (
        <div className="space-y-3 border-t border-border pt-3">
          <Field label="Link an existing recommendation" htmlFor="sr-link">
            <Select id="sr-link" value={linkIndex} onChange={(e) => setLinkIndex(e.target.value)}>
              <option value="">— choose a recommendation —</option>
              {unlinked.map((r) => (
                <option key={r.index} value={r.index}>
                  R{r.number} — {r.title || '(untitled)'}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setMode(null);
                setLinkIndex('');
              }}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => void linkExisting()}
              loading={saving}
              disabled={!linkIndex}
            >
              Link
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
