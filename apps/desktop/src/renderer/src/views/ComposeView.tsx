import { useCallback, useEffect, useRef, useState } from 'react';
import {
  EVIDENCE_TYPE_LABELS,
  EXCLUDED_FROM_REPORT_LABEL,
  defaultTagColorFor,
  type EvidenceType,
} from '@reporter/shared';
import {
  Button,
  EmptyState,
  Field,
  Input,
  MarkdownField,
  Select,
  TagPicker,
  Textarea,
  useConfirm,
  useToast,
} from '@reporter/ui';
import type { CaptureDraft, EngagementLite, EvidenceLite, TagLite } from '../../../shared/types.js';

/**
 * Registers a guard so the parent can ask "is it safe to leave the compose
 * form?" before switching views. The guard returns `true` when leaving is OK
 * (form clean, or the user confirmed discarding) and `false` to stay.
 */
export type LeaveGuard = () => Promise<boolean>;

/**
 * A human, identifiable label for an evidence item in the "Link to" picker.
 * Prefers the title, then the description, then the friendly type name — never
 * the bare content-type — and appends a short timestamp so near-identical
 * captures (e.g. a burst of screenshots) can still be told apart.
 */
function evidenceOptionLabel(ev: EvidenceLite): string {
  const base =
    ev.title.trim() ||
    ev.description.trim() ||
    EVIDENCE_TYPE_LABELS[ev.contentType as EvidenceType] ||
    ev.contentType;
  const when = new Date(ev.occurredAt);
  const stamp = Number.isNaN(when.getTime())
    ? ''
    : when.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
  const withStamp = stamp ? `${base} · ${stamp}` : base;
  // A <select> option can only carry text, so the badge the web UI renders
  // becomes a prefix and a suffix here. Both, because the prefix survives the
  // truncation a long title causes in a narrow tray window.
  return ev.excludeFromReport
    ? `⊘ ${withStamp} — ${EXCLUDED_FROM_REPORT_LABEL.toLowerCase()}`
    : withStamp;
}

export function ComposeView({
  onDone,
  registerLeaveGuard,
}: {
  onDone: () => void;
  /** Called on mount with a guard the parent invokes before leaving compose. */
  registerLeaveGuard?: (guard: LeaveGuard | null) => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const [draft, setDraft] = useState<CaptureDraft | null | undefined>(undefined);
  const [engagements, setEngagements] = useState<EngagementLite[]>([]);
  const [engagementSlug, setEngagementSlug] = useState('');
  const [tags, setTags] = useState<TagLite[]>([]);
  const [tagIds, setTagIds] = useState<number[]>([]);
  const [evidenceOptions, setEvidenceOptions] = useState<EvidenceLite[]>([]);
  const [parentEvidenceUuid, setParentEvidenceUuid] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [content, setContent] = useState('');
  const [language, setLanguage] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Snapshot of the initial editable form state, so "dirty" means the user
  // actually changed something. `content` starts from the draft (a codeblock
  // capture pre-fills it), so its baseline is the draft's content.
  const initialContentRef = useRef('');

  // Keep a live snapshot of what "dirty" means for the leave guard, which is a
  // stable callback registered once. Reading through a ref avoids re-registering
  // the guard (and re-running the parent's effect) on every keystroke.
  const dirtyRef = useRef(false);
  const submittedRef = useRef(false);
  const isDirty =
    !submittedRef.current &&
    (title.trim() !== '' ||
      description.trim() !== '' ||
      content !== initialContentRef.current ||
      language.trim() !== '' ||
      tagIds.length > 0);
  dirtyRef.current = isDirty;

  const confirmDiscard = useCallback(async (): Promise<boolean> => {
    if (!dirtyRef.current) return true;
    return confirm({
      title: 'Discard changes?',
      message: 'This capture has unsaved changes. Leave without adding it as evidence?',
      confirmLabel: 'Discard',
      cancelLabel: 'Keep editing',
      danger: true,
    });
  }, [confirm]);

  // Register the leave guard with the parent for the lifetime of this view.
  useEffect(() => {
    registerLeaveGuard?.(confirmDiscard);
    return () => registerLeaveGuard?.(null);
  }, [registerLeaveGuard, confirmDiscard]);

  // Best-effort guard against closing the window with a dirty form. The
  // renderer can't run an async confirm here, so fall back to the native prompt
  // by cancelling the unload (Electron shows its own "Leave site?" dialog).
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  useEffect(() => {
    (async () => {
      const [d, settings, engs] = await Promise.all([
        window.reporter.getDraft(),
        window.reporter.getSettings(),
        window.reporter.listEngagements().catch(() => [] as EngagementLite[]),
      ]);
      setDraft(d);
      setContent(d?.content ?? '');
      initialContentRef.current = d?.content ?? '';
      setEngagements(engs);
      setEngagementSlug(settings.currentEngagementSlug ?? engs[0]?.slug ?? '');
    })();
  }, []);

  const refreshTags = useCallback((slug: string) => {
    window.reporter
      .listTags(slug)
      .then(setTags)
      .catch(() => setTags([]));
  }, []);

  useEffect(() => {
    if (!engagementSlug) {
      setTags([]);
      setEvidenceOptions([]);
      return;
    }
    refreshTags(engagementSlug);
    window.reporter
      .listEvidence(engagementSlug)
      .then(setEvidenceOptions)
      .catch(() => setEvidenceOptions([]));
    setTagIds([]);
    setParentEvidenceUuid('');
  }, [engagementSlug, refreshTags]);

  const createTag = useCallback(
    async (name: string): Promise<number> => {
      const t = await window.reporter.createTag(engagementSlug, {
        name,
        colorName: defaultTagColorFor(name),
      });
      refreshTags(engagementSlug);
      return t.id;
    },
    [engagementSlug, refreshTags],
  );

  const cancel = useCallback(async () => {
    if (await confirmDiscard()) onDone();
  }, [confirmDiscard, onDone]);

  if (draft === undefined) return <p className="text-sm text-muted">Loading…</p>;

  if (draft === null) {
    return (
      <EmptyState
        title="Nothing to compose"
        description="Capture a screenshot or add a code block from the tray, then describe it here."
        action={
          <Button size="sm" onClick={() => window.reporter.captureArea()}>
            Capture area
          </Button>
        }
      />
    );
  }

  async function submit() {
    if (!engagementSlug) {
      toast.error('Choose an engagement first');
      return;
    }
    if (!title.trim()) {
      toast.error('Add a title first');
      return;
    }
    setSubmitting(true);
    try {
      await window.reporter.submitDraft({
        engagementSlug,
        title: title.trim(),
        description,
        tagIds,
        contentType: draft!.contentType,
        filePath: draft!.filePath,
        content: draft!.contentType === 'image' ? undefined : content,
        contentSubtype: draft!.contentType === 'codeblock' && language ? language : undefined,
        parentEvidenceUuid: parentEvidenceUuid || undefined,
      });
      // A successful submit clears the draft on the main side, so leaving is no
      // longer "discarding" — mark clean before onDone() so the parent's leave
      // guard doesn't prompt.
      submittedRef.current = true;
      dirtyRef.current = false;
      toast.success('Queued for upload');
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not queue evidence');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {draft.contentType === 'image' && draft.previewDataUrl && (
        <img
          src={draft.previewDataUrl}
          alt="Capture preview"
          className="max-h-52 w-full rounded-card border border-border object-contain bg-surface-2"
        />
      )}

      <Field label="Engagement" htmlFor="eng">
        <Select id="eng" value={engagementSlug} onChange={(e) => setEngagementSlug(e.target.value)}>
          <option value="">— choose —</option>
          {engagements.map((eng) => (
            <option key={eng.slug} value={eng.slug}>
              {eng.name} — {eng.status}
            </option>
          ))}
        </Select>
      </Field>

      <Field label="Title" htmlFor="title" required>
        <Input
          id="title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          autoFocus
        />
      </Field>

      {/* The web UI authors this field as markdown and the report renders it as
          markdown, so the tray uses the same editor — a single-line input could
          not even hold the lists and paragraphs that end up in the deliverable. */}
      <Field label="Description" htmlFor="desc">
        <MarkdownField id="desc" rows={3} value={description} onChange={setDescription} />
      </Field>

      {draft.contentType === 'codeblock' && (
        <>
          <Field label="Language" htmlFor="lang" hint="Optional">
            <Input
              id="lang"
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              placeholder="bash"
            />
          </Field>
          <Field label="Content" htmlFor="content">
            <Textarea
              id="content"
              rows={6}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              className="font-mono"
            />
          </Field>
        </>
      )}

      {draft.contentType === 'none' && (
        <Field label="Note" htmlFor="note">
          <Textarea
            id="note"
            rows={5}
            value={content}
            onChange={(e) => setContent(e.target.value)}
          />
        </Field>
      )}

      <Field label="Tags">
        <TagPicker
          tags={tags}
          selectedIds={tagIds}
          onChange={setTagIds}
          emptyHint="No tags in this engagement."
          onCreateTag={engagementSlug ? createTag : undefined}
        />
      </Field>

      {evidenceOptions.length > 0 && (
        <Field
          label="Link to"
          htmlFor="link-to"
          hint="Optional — file this as linked evidence on recent evidence"
        >
          <Select
            id="link-to"
            value={parentEvidenceUuid}
            onChange={(e) => setParentEvidenceUuid(e.target.value)}
          >
            <option value="">— none —</option>
            {evidenceOptions.map((ev) => (
              <option key={ev.uuid} value={ev.uuid}>
                {evidenceOptionLabel(ev)}
              </option>
            ))}
          </Select>
          {/* Exclusion is inherited at read time, so linking under an excluded
              capture withholds THIS capture from every report while its own flag
              stays clear — invisible unless we say so before the link is made. */}
          {evidenceOptions.some((ev) => ev.uuid === parentEvidenceUuid && ev.excludeFromReport) && (
            <p className="mt-1 text-xs text-warning">
              That evidence is excluded from reports, so this capture will be left out of them too.
              It stays visible in the web app, and un-excluding the evidence brings both back.
            </p>
          )}
        </Field>
      )}

      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={cancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={submit}
          loading={submitting}
          disabled={!engagementSlug || !title.trim()}
        >
          Add evidence
        </Button>
      </div>
    </div>
  );
}
