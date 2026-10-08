import { useState } from 'react';
import {
  Button,
  Card,
  Field,
  Input,
  MarkdownField,
  MarkdownPreview,
  Spinner,
  Textarea,
  useToast,
} from '@reporter/ui';
import {
  evidenceCarriesSubtype,
  evidenceFileExtension,
  isEditableTextEvidence,
  parseHttpExchanges,
  type Evidence,
} from '@reporter/shared';
import { useUpdateEvidence } from '../../api/hooks.js';
import { useEvidenceText } from '../../hooks/useEvidenceText.js';
import { READ_ONLY_TITLE } from '../../lib/permissions.js';
import { EvidenceContent, ScriptBody } from './EvidenceContent.js';
import { HttpRequestField } from './HttpRequestField.js';
import { HttpExchangeView } from './HttpExchangeView.js';

/**
 * The evidence's main content body. For the editable-text types
 * (`EVIDENCE_TEXT_EDITABLE` in `@reporter/shared`) it renders the body read-only
 * with an explicit Edit → Save/Cancel flow (deliberate: clicking away never
 * saves), keeping the markdown / HTTP field-value / verbatim-script preview.
 * Non-text types (image/recording) fall back to the read-only viewer.
 */
export function EvidenceBody({
  slug,
  evidence,
  canWrite,
}: {
  slug: string;
  evidence: Evidence;
  canWrite: boolean;
}) {
  if (!isEditableTextEvidence(evidence.contentType)) {
    return <EvidenceContent evidence={evidence} slug={slug} showCaption={false} />;
  }
  return <EditableBody slug={slug} evidence={evidence} canWrite={canWrite} />;
}

function EditableBody({
  slug,
  evidence,
  canWrite,
}: {
  slug: string;
  evidence: Evidence;
  canWrite: boolean;
}) {
  const toast = useToast();
  const update = useUpdateEvidence(slug);
  const isHttp = evidence.contentType === 'http-request-cycle';
  // A script is plain text, not markdown, so it gets a bare monospace textarea
  // rather than the Write/Preview markdown editor — same choice as the create form.
  const isScript = evidence.contentType === 'script';
  // The language / interpreter is editable here rather than being fixed at capture
  // time, because for a script it chooses the extension of the file a client is
  // handed in the report ZIP — a wrong one is a correction the operator has to be
  // able to make without deleting and re-filing the evidence.
  const carriesSubtype = evidenceCarriesSubtype(evidence.contentType);
  // Cache-bust on updatedAt so a just-saved edit shows immediately; blob-less
  // notes/events have nothing to fetch.
  const { loading, text, error } = useEvidenceText(
    slug,
    evidence.uuid,
    evidence.updatedAt,
    evidence.hasContent,
  );
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [subtypeDraft, setSubtypeDraft] = useState('');
  const [saving, setSaving] = useState(false);

  function startEdit() {
    setDraft(text);
    setSubtypeDraft(evidence.contentSubtype ?? '');
    setEditing(true);
  }
  function cancel() {
    setEditing(false);
    setDraft('');
    setSubtypeDraft('');
  }
  async function save() {
    setSaving(true);
    try {
      await update.mutateAsync({
        uuid: evidence.uuid,
        patch: {
          content: draft,
          // Sent only for the types that have the field, and only when it actually
          // changed, so an ordinary body edit does not restate it. Blank means
          // "clear it", which the server normalizes to null.
          ...(carriesSubtype && subtypeDraft.trim() !== (evidence.contentSubtype ?? '').trim()
            ? { contentSubtype: subtypeDraft.trim() || null }
            : {}),
        },
      });
      toast.success('Content saved');
      setEditing(false);
      setDraft('');
      setSubtypeDraft('');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save content');
    } finally {
      setSaving(false);
    }
  }

  /**
   * The language / interpreter row: an editable field while editing, otherwise a
   * read-only line. It is a line at all because the value is invisible everywhere
   * else, and for a script it is what names the file delivered in the report ZIP —
   * so "not set" and the extension it resolves to are both worth stating, rather
   * than leaving an operator to wonder why their Python script arrived as `.txt`.
   * A code block with no language says nothing, so it gets no row.
   */
  let subtypeField: React.ReactNode = null;
  if (carriesSubtype && editing) {
    subtypeField = (
      <Field
        label={isScript ? 'Interpreter' : 'Language'}
        htmlFor="ev-subtype"
        hint={
          isScript
            ? `Optional · names the file in the report ZIP (${evidenceFileExtension('script', subtypeDraft)})`
            : 'Optional'
        }
      >
        <Input
          id="ev-subtype"
          value={subtypeDraft}
          onChange={(e) => setSubtypeDraft(e.target.value)}
          placeholder={isScript ? 'bash' : 'json'}
          spellCheck={false}
        />
      </Field>
    );
  } else if (carriesSubtype && (isScript || evidence.contentSubtype?.trim())) {
    subtypeField = (
      <p className="text-xs text-muted">
        {isScript ? 'Interpreter' : 'Language'}:{' '}
        {evidence.contentSubtype?.trim() ? (
          <span className="font-mono text-text">{evidence.contentSubtype}</span>
        ) : (
          <span className="italic">not set</span>
        )}
        {isScript && ` · delivered as ${evidenceFileExtension('script', evidence.contentSubtype)}`}
      </p>
    );
  }

  return (
    <Card className="min-w-0 space-y-2 p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-text">Content</h3>
        {!editing ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={startEdit}
            disabled={!canWrite || loading}
            title={canWrite ? undefined : READ_ONLY_TITLE}
          >
            Edit
          </Button>
        ) : (
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={cancel} disabled={saving}>
              Cancel
            </Button>
            <Button size="sm" onClick={save} loading={saving}>
              Save
            </Button>
          </div>
        )}
      </div>

      {subtypeField}

      {editing ? (
        isHttp ? (
          <HttpRequestField id="ev-body" value={draft} onChange={setDraft} rows={14} />
        ) : isScript ? (
          <Textarea
            id="ev-body"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={16}
            spellCheck={false}
            className="font-mono"
          />
        ) : (
          <MarkdownField
            id="ev-body"
            value={draft}
            onChange={setDraft}
            rows={12}
            className={evidence.contentType === 'codeblock' ? 'font-mono' : undefined}
          />
        )
      ) : loading ? (
        <Spinner />
      ) : error ? (
        <p className="text-sm text-danger">Couldn’t load the content.</p>
      ) : (
        <BodyView contentType={evidence.contentType} text={text} />
      )}
    </Card>
  );
}

/** Read-only render of the saved body: JSON field/value for HTTP, verbatim
 *  monospace for a script, else markdown. */
function BodyView({ contentType, text }: { contentType: string; text: string }) {
  if (contentType === 'http-request-cycle') {
    const parsed = parseHttpExchanges(text);
    if (parsed.ok) {
      return (
        <div className="min-w-0 rounded-card border border-border bg-surface-2 p-4">
          <HttpExchangeView entries={parsed.entries} />
        </div>
      );
    }
    return (
      <pre className="min-w-0 overflow-auto rounded-card border border-border bg-surface-2 p-4 text-xs">
        <code className="font-mono">{text}</code>
      </pre>
    );
  }
  if (!text.trim()) {
    return <p className="text-sm text-muted">No content yet. Use “Edit” to add it.</p>;
  }
  if (contentType === 'script') {
    return <ScriptBody text={text} />;
  }
  return (
    <div className="min-w-0 break-words rounded-card border border-border bg-surface-2 p-4 text-sm text-text">
      <MarkdownPreview source={text} />
    </div>
  );
}
