import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Button,
  Field,
  Input,
  MarkdownField,
  Modal,
  Select,
  TagPicker,
  useToast,
} from '@reporter/ui';
import {
  EVIDENCE_TYPE_LABELS,
  defaultTagColorFor,
  type CreateEvidenceInput,
  type EvidenceType,
} from '@reporter/shared';
import { HttpRequestField } from './HttpRequestField.js';
import { useCreateEvidence, useCreateTag, useTags } from '../../api/hooks.js';
import { useEngagementPermissions } from '../../lib/permissions.js';
import { useUnsavedGuard } from '../../hooks/useUnsavedGuard.js';

const CREATABLE: EvidenceType[] = ['image', 'codeblock', 'none', 'event', 'http-request-cycle'];

export function CreateEvidenceModal({
  slug,
  open,
  onClose,
  parentEvidenceUuid,
  title = 'Add evidence',
}: {
  slug: string;
  open: boolean;
  onClose: () => void;
  /** When set, the created evidence is filed as a comment on this evidence. */
  parentEvidenceUuid?: string;
  /** Modal + submit-button label; use "Add comment" for the comment flow. */
  title?: string;
}) {
  const toast = useToast();
  const { data: tags } = useTags(slug);
  const create = useCreateEvidence(slug);
  const createTag = useCreateTag(slug);
  const { canWrite } = useEngagementPermissions(slug);
  const isComment = parentEvidenceUuid !== undefined;

  // Inline "+ New tag" in the picker: create a tag with a name-derived color and
  // return its id so the picker selects it. Writers only (creating a tag needs write).
  const onCreateTag = canWrite
    ? async (tagName: string) => {
        try {
          const t = await createTag.mutateAsync({
            name: tagName,
            colorName: defaultTagColorFor(tagName),
          });
          return t.id;
        } catch (err) {
          toast.error(err instanceof Error ? err.message : 'Could not create tag');
          throw err;
        }
      }
    : undefined;

  const [type, setType] = useState<EvidenceType>('image');
  const [evTitle, setEvTitle] = useState('');
  const [description, setDescription] = useState('');
  const [content, setContent] = useState('');
  const [language, setLanguage] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [tagIds, setTagIds] = useState<number[]>([]);

  const needsFile = type === 'image';
  const needsText = type !== 'image';
  // Title is required; the type-specific content/file inputs still gate submit.
  const hasTitle = evTitle.trim().length > 0;
  const canSubmit =
    hasTitle &&
    (needsFile ? Boolean(file) : content.trim().length > 0 || description.trim().length > 0);

  // Dirty when the operator has entered anything beyond the default type. Used to
  // trigger the discard-confirm on close/cancel/Esc/backdrop.
  const isDirty = useMemo(
    () =>
      evTitle.trim().length > 0 ||
      description.trim().length > 0 ||
      content.trim().length > 0 ||
      language.trim().length > 0 ||
      Boolean(file) ||
      tagIds.length > 0 ||
      type !== 'image',
    [evTitle, description, content, language, file, tagIds, type],
  );

  const reset = useCallback(() => {
    setType('image');
    setEvTitle('');
    setDescription('');
    setContent('');
    setLanguage('');
    setFile(null);
    setDragging(false);
    setTagIds([]);
  }, []);

  const { requestClose } = useUnsavedGuard({
    isDirty,
    enabled: open,
    onClose,
    onSave: submit,
    canSave: canSubmit,
  });

  // Clear the form whenever the modal closes so nothing carries into the next open
  // — important since this same modal is reused as the per-parent comment composer.
  useEffect(() => {
    if (!open) reset();
  }, [open, reset]);

  // Accept an image from the file picker, drag-and-drop, or a clipboard paste.
  const selectImage = useCallback(
    (f: File | null | undefined) => {
      if (!f) return;
      if (!f.type.startsWith('image/')) {
        toast.error('Please choose an image (PNG, JPEG, GIF, or WEBP).');
        return;
      }
      setFile(f);
    },
    [toast],
  );

  // Live object-URL preview of the chosen image; revoked when it changes/unmounts.
  useEffect(() => {
    if (!file) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  // Paste an image from the clipboard anywhere in the modal (screenshot type only).
  useEffect(() => {
    if (!open || type !== 'image') return;
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of Array.from(items)) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const f = item.getAsFile();
          if (f) {
            e.preventDefault();
            selectImage(f);
          }
          break;
        }
      }
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [open, type, selectImage]);

  async function submit() {
    const metadata: CreateEvidenceInput = {
      contentType: type,
      title: evTitle.trim(),
      description,
      tagIds,
      content: needsText ? content : undefined,
      contentSubtype: type === 'codeblock' && language ? language : undefined,
      parentEvidenceUuid,
      // New evidence is always report-eligible. Excluding it is a deliberate,
      // reversible call made afterwards from the evidence's own Report card.
      excludeFromReport: false,
    };
    try {
      await create.mutateAsync({ metadata, file: needsFile && file ? file : undefined });
      toast.success(isComment ? 'Comment added' : 'Evidence added');
      reset();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not add evidence');
    }
  }

  return (
    <Modal
      open={open}
      onClose={requestClose}
      title={title}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={requestClose}>
            Cancel
          </Button>
          <Button onClick={submit} loading={create.isPending} disabled={!canSubmit}>
            {title}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Type" htmlFor="ev-type">
            <Select
              id="ev-type"
              value={type}
              onChange={(e) => setType(e.target.value as EvidenceType)}
            >
              {CREATABLE.map((t) => (
                <option key={t} value={t}>
                  {EVIDENCE_TYPE_LABELS[t]}
                </option>
              ))}
            </Select>
          </Field>
          {type === 'codeblock' && (
            <Field label="Language" htmlFor="ev-lang" hint="Optional">
              <Input
                id="ev-lang"
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                placeholder="bash"
              />
            </Field>
          )}
        </div>

        <Field label="Title" htmlFor="ev-title" required>
          <Input
            id="ev-title"
            value={evTitle}
            onChange={(e) => setEvTitle(e.target.value)}
            placeholder="Short label shown in lists and the report"
            autoFocus
          />
        </Field>

        <Field label="Description" htmlFor="ev-desc" hint="Optional">
          <MarkdownField
            id="ev-desc"
            value={description}
            onChange={(v) => setDescription(v)}
            rows={3}
          />
        </Field>

        {needsFile ? (
          <Field label="Screenshot" htmlFor="ev-file" hint="PNG, JPEG, GIF, or WEBP.">
            <div
              role="button"
              tabIndex={0}
              aria-label="Add a screenshot: click to browse, drag and drop, or paste an image"
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  fileInputRef.current?.click();
                }
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
              }}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                selectImage(e.dataTransfer.files?.[0]);
              }}
              className={`flex cursor-pointer flex-col items-center justify-center gap-3 rounded-card border-2 border-dashed p-6 text-center transition-colors ${
                dragging
                  ? 'border-accent bg-surface-2'
                  : 'border-border bg-surface-2/40 hover:border-accent/60'
              }`}
            >
              {previewUrl ? (
                <>
                  <img
                    src={previewUrl}
                    alt="Selected screenshot preview"
                    className="max-h-48 w-auto rounded-input border border-border"
                  />
                  <p className="max-w-full truncate text-xs text-muted">
                    {file?.name}
                    {file ? ` · ${Math.max(1, Math.round(file.size / 1024))} KB` : ''}
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={(e) => {
                      e.stopPropagation();
                      setFile(null);
                      if (fileInputRef.current) fileInputRef.current.value = '';
                    }}
                  >
                    Remove
                  </Button>
                </>
              ) : (
                <>
                  <p className="text-sm text-text">
                    <span className="font-medium text-accent">Choose a file</span>, drag &amp; drop,
                    or paste an image
                  </p>
                  <p className="text-xs text-muted">Press ⌘/Ctrl+V to paste a screenshot</p>
                </>
              )}
              <input
                ref={fileInputRef}
                id="ev-file"
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => selectImage(e.target.files?.[0])}
              />
            </div>
          </Field>
        ) : type === 'http-request-cycle' ? (
          <Field label="HTTP data" htmlFor="ev-content" hint="HAR, JSON, or a raw request/response">
            <HttpRequestField id="ev-content" value={content} onChange={setContent} rows={8} />
          </Field>
        ) : (
          <Field label="Content" htmlFor="ev-content">
            <MarkdownField
              id="ev-content"
              value={content}
              onChange={setContent}
              rows={8}
              className={type === 'codeblock' ? 'font-mono' : undefined}
            />
          </Field>
        )}

        <Field label="Tags">
          <TagPicker
            tags={tags ?? []}
            selectedIds={tagIds}
            onChange={setTagIds}
            onCreateTag={onCreateTag}
            emptyHint={
              canWrite
                ? 'No tags in this engagement yet — create one below.'
                : 'No tags in this engagement yet — add some on the Tags tab.'
            }
          />
        </Field>
      </div>
    </Modal>
  );
}
