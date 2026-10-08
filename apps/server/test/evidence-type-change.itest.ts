import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildMultipart } from '@reporter/api-client';
import {
  MAX_SCRIPT_BYTES,
  SCRIPT_NOT_TEXT_REASON,
  SCRIPT_TOO_LARGE_REASON,
} from '@reporter/shared';
import { WEB_HEADERS, buildTestApp, loginCookie, seedUsers, truncateAll } from './helpers.js';

// A minimal 1x1 PNG, for the two cases that contrast text evidence with a screenshot.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

// Deliberately full of markdown punctuation: the same bytes read one way through the
// report's markdown renderer (code block) and verbatim (script), which is why the
// type has to be correctable after capture.
const BODY = '#!/bin/bash\n# *not* emphasis\nnmap -sV "$1" | tee scan.txt\n';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await truncateAll(app);
});

async function setup() {
  const users = await seedUsers(app);
  await app.db.engagement.create({
    data: {
      slug: 'op1',
      name: 'Op One',
      roles: { create: { userId: users.writer.id, role: 'write' } },
    },
  });
  const cookie = await loginCookie(app, 'writer@test.local', 'password123');
  return { users, cookie };
}

/** Create evidence from a JSON body (typed content, no file). */
function createJson(cookie: string, body: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/web/engagements/op1/evidence',
    headers: { ...WEB_HEADERS, cookie, 'content-type': 'application/json' },
    payload: body,
  });
}

/** Create evidence from a multipart body (an uploaded file, plus the notes part). */
function createUpload(
  cookie: string,
  notes: Record<string, unknown>,
  file: { filename: string; contentType: string; data: Buffer },
) {
  const { body, contentType } = buildMultipart({ notes: JSON.stringify(notes) }, [
    { field: 'file', ...file },
  ]);
  return app.inject({
    method: 'POST',
    url: '/web/engagements/op1/evidence',
    headers: { ...WEB_HEADERS, cookie, 'content-type': contentType },
    payload: body,
  });
}

function getContent(cookie: string, uuid: string) {
  return app.inject({
    method: 'GET',
    url: `/web/engagements/op1/evidence/${uuid}/content`,
    headers: { cookie },
  });
}

function putEvidence(cookie: string, uuid: string, body: Record<string, unknown>) {
  return app.inject({
    method: 'PUT',
    url: `/web/engagements/op1/evidence/${uuid}`,
    headers: { ...WEB_HEADERS, cookie, 'content-type': 'application/json' },
    payload: body,
  });
}

/** The stored blob's identity — key, hash and size — to prove a re-type left it alone. */
async function blobIdentity(uuid: string) {
  const row = await app.db.evidence.findFirstOrThrow({ where: { uuid } });
  return { fullBlobKey: row.fullBlobKey, sha256: row.sha256, sizeBytes: row.sizeBytes };
}

describe('changing a text evidence item’s type', () => {
  it('moves a code block to a script and back, never touching the stored blob', async () => {
    const { cookie } = await setup();
    const uuid = (
      await createJson(cookie, { contentType: 'codeblock', title: 'Recon', content: BODY })
    ).json().uuid as string;
    const before = await blobIdentity(uuid);

    const toScript = await putEvidence(cookie, uuid, { contentType: 'script' });
    expect(toScript.statusCode).toBe(200);
    expect(toScript.json().contentType).toBe('script');
    // Metadata only: same blob key, same hash, same length, same bytes served back.
    expect(await blobIdentity(uuid)).toEqual(before);
    expect((await getContent(cookie, uuid)).body).toBe(BODY);

    // And back — the round trip is lossless in both directions, which is what makes
    // a mistaken change recoverable rather than a reason to re-file the evidence.
    const backToCodeblock = await putEvidence(cookie, uuid, { contentType: 'codeblock' });
    expect(backToCodeblock.statusCode).toBe(200);
    expect(backToCodeblock.json().contentType).toBe('codeblock');
    expect(await blobIdentity(uuid)).toEqual(before);
    expect((await getContent(cookie, uuid)).body).toBe(BODY);
  });

  it('carries the interpreter across, re-naming the delivered file with it', async () => {
    const { cookie } = await setup();
    const uuid = (
      await createJson(cookie, {
        contentType: 'codeblock',
        title: 'Recon',
        contentSubtype: 'bash',
        content: BODY,
      })
    ).json().uuid as string;
    // As a code block the ZIP entry is named from the raw token (`.bash`).
    expect((await getContent(cookie, uuid)).headers['content-disposition']).toContain('.bash"');

    const res = await putEvidence(cookie, uuid, { contentType: 'script' });
    expect(res.statusCode).toBe(200);
    // Both types read a `contentSubtype`, so it rides along rather than being lost.
    expect(res.json().contentSubtype).toBe('bash');
    // Which changes the extension the client is handed: a script resolves the
    // interpreter token through `SCRIPT_INTERPRETER_EXTENSIONS`.
    expect((await getContent(cookie, uuid)).headers['content-disposition']).toContain('.sh"');
  });

  it('clears the interpreter when the new type reads none', async () => {
    const { cookie } = await setup();
    const uuid = (
      await createJson(cookie, {
        contentType: 'script',
        title: 'Recon',
        contentSubtype: 'bash',
        content: BODY,
      })
    ).json().uuid as string;

    // A note has no reader for an interpreter, so leaving `bash` in the column would
    // park an invisible value that reappears if the evidence is ever re-typed back.
    const res = await putEvidence(cookie, uuid, { contentType: 'none' });
    expect(res.statusCode).toBe(200);
    expect(res.json().contentSubtype).toBe(null);
    expect((await app.db.evidence.findFirstOrThrow({ where: { uuid } })).contentSubtype).toBe(null);
    // The body is still the body — clearing the interpreter is not a content edit.
    expect((await getContent(cookie, uuid)).body).toBe(BODY);
  });

  it('accepts a type and an interpreter in one request, judging both against the new type', async () => {
    const { cookie } = await setup();
    const uuid = (
      await createJson(cookie, { contentType: 'event', title: 'Recon', content: BODY })
    ).json().uuid as string;

    /*
     * The ordering case. `event` carries no interpreter, so evaluating the
     * `contentSubtype` guard against the *stored* type refuses this request — even
     * though the type it asks for reads one. The Details form sends both fields
     * together, so that refusal would land on an ordinary edit.
     */
    const res = await putEvidence(cookie, uuid, {
      contentType: 'script',
      contentSubtype: 'python3',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().contentType).toBe('script');
    expect(res.json().contentSubtype).toBe('python3');
    expect((await getContent(cookie, uuid)).headers['content-disposition']).toContain('.py"');
  });

  it('accepts a contentType equal to the current one as a no-op', async () => {
    const { cookie } = await setup();
    const uuid = (
      await createJson(cookie, {
        contentType: 'script',
        title: 'Recon',
        contentSubtype: 'bash',
        content: BODY,
      })
    ).json().uuid as string;

    // The form posts the whole Details draft, so the unchanged type arrives on every
    // save. It must not be read as a change, and must not clear the interpreter.
    const res = await putEvidence(cookie, uuid, { contentType: 'script', title: 'Recon v2' });
    expect(res.statusCode).toBe(200);
    expect(res.json().contentType).toBe('script');
    expect(res.json().contentSubtype).toBe('bash');
    expect(res.json().title).toBe('Recon v2');
  });

  it('still updates an unrelated field when no contentType is sent', async () => {
    const { cookie } = await setup();
    const uuid = (
      await createJson(cookie, {
        contentType: 'codeblock',
        title: 'Recon',
        contentSubtype: 'bash',
        content: BODY,
      })
    ).json().uuid as string;

    const res = await putEvidence(cookie, uuid, { description: 'Ran against the staging host.' });
    expect(res.statusCode).toBe(200);
    expect(res.json().description).toBe('Ran against the staging host.');
    // Absent means unchanged, for the type exactly as for the interpreter.
    expect(res.json().contentType).toBe('codeblock');
    expect(res.json().contentSubtype).toBe('bash');
  });

  it('records who re-typed the evidence — a type change is an edit', async () => {
    const { cookie, users } = await setup();
    const uuid = (
      await createJson(cookie, { contentType: 'codeblock', title: 'Recon', content: BODY })
    ).json().uuid as string;

    await putEvidence(cookie, uuid, { contentType: 'script' });
    const row = await app.db.evidence.findFirstOrThrow({ where: { uuid } });
    expect(row.lastEditedById).toBe(users.writer.id);
  });
});

describe('changing a type the stored bytes can’t support', () => {
  it('refuses a screenshot → script, and mutates nothing', async () => {
    const { cookie } = await setup();
    const uuid = (
      await createUpload(
        cookie,
        { contentType: 'image', title: 'Shot' },
        { filename: 'shot.png', contentType: 'image/png', data: PNG },
      )
    ).json().uuid as string;
    const before = await app.db.evidence.findFirstOrThrow({ where: { uuid } });

    const res = await putEvidence(cookie, uuid, { contentType: 'script' });
    expect(res.statusCode).toBe(400);
    // Names the failing side and why, rather than "the request was invalid": the
    // stored bytes are an image, which no amount of relabelling makes into a script.
    expect(res.json().error).toMatch(/^A Screenshot can't change type — what's stored for it/);
    expect(res.json().error).toContain('not an editable text body');

    const after = await app.db.evidence.findFirstOrThrow({ where: { uuid } });
    expect(after.contentType).toBe('image');
    // Not even the audit stamp moved, so a refused request is not an edit. The
    // thumbnail is still there to be rendered, rather than orphaned by a re-type.
    expect(after.updatedAt).toEqual(before.updatedAt);
    expect(after.lastEditedById).toBe(before.lastEditedById);
    expect(after.thumbBlobKey).toBe(before.thumbBlobKey);
  });

  it('refuses a script → screenshot, naming the requested type', async () => {
    const { cookie } = await setup();
    const uuid = (
      await createJson(cookie, { contentType: 'script', title: 'Recon', content: BODY })
    ).json().uuid as string;

    const res = await putEvidence(cookie, uuid, { contentType: 'image' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/^This evidence can't become a Screenshot/);
    // The refusal lists what it *can* become, derived from EVIDENCE_TEXT_EDITABLE.
    expect(res.json().error).toContain('Code block, Script, HTTP request, Event, Note');
    expect((await app.db.evidence.findFirstOrThrow({ where: { uuid } })).contentType).toBe(
      'script',
    );
    // The text is still served as text — nothing was relabelled on the way out.
    expect((await getContent(cookie, uuid)).body).toBe(BODY);
  });

  it('refuses a terminal recording → code block', async () => {
    const { cookie } = await setup();
    const cast = '{"version":2,"width":80,"height":24}\n[0.1,"o","$ id\\r\\n"]\n';
    const uuid = (
      await createUpload(
        cookie,
        { contentType: 'terminal-recording', title: 'Session' },
        { filename: 's.cast', contentType: 'application/x-asciicast', data: Buffer.from(cast) },
      )
    ).json().uuid as string;

    // An asciicast is text, but it is a *player's* format: re-typed to a code block
    // the report would print its JSON frames at the client instead of a session.
    const res = await putEvidence(cookie, uuid, { contentType: 'codeblock' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/^A Terminal recording can't change type/);
    // And the reason has to be one the operator can't disprove by opening the file.
    // The stored asciicast *is* text; what rules it out is that it is a file for the
    // player, not an editable body — so the message must not claim "not text".
    expect(res.json().error).toContain('a file only its own viewer reads');
    expect(res.json().error).not.toContain('raw bytes');
    expect((await app.db.evidence.findFirstOrThrow({ where: { uuid } })).contentType).toBe(
      'terminal-recording',
    );
  });

  it('refuses an interpreter the new type has no reader for', async () => {
    const { cookie } = await setup();
    const uuid = (
      await createJson(cookie, {
        contentType: 'codeblock',
        title: 'Recon',
        contentSubtype: 'bash',
        content: BODY,
      })
    ).json().uuid as string;

    // The mirror image of the combined edit above: judged against the new type, so
    // asking for a note *with* an interpreter is refused rather than quietly stored.
    const res = await putEvidence(cookie, uuid, { contentType: 'none', contentSubtype: 'bash' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/language or interpreter/);
    const row = await app.db.evidence.findFirstOrThrow({ where: { uuid } });
    expect(row.contentType).toBe('codeblock');
    expect(row.contentSubtype).toBe('bash');
  });

  /*
   * Regression: the guard above keyed off `contentSubtype !== undefined`, so an
   * explicit null — a *clear*, not a value — was refused for a type that carries no
   * interpreter. A client asking the obvious thing ("become a Note and drop the
   * interpreter") got a 400, while omitting the field cleared the column anyway.
   */
  it('accepts an explicit null interpreter alongside a type that reads none', async () => {
    const { cookie } = await setup();
    const uuid = (
      await createJson(cookie, {
        contentType: 'codeblock',
        title: 'Recon',
        contentSubtype: 'bash',
        content: BODY,
      })
    ).json().uuid as string;

    const res = await putEvidence(cookie, uuid, { contentType: 'none', contentSubtype: null });
    expect(res.statusCode).toBe(200);
    expect(res.json().contentType).toBe('none');
    expect(res.json().contentSubtype).toBe(null);
    // Clearing it on its own, with no type change, is accepted for the same reason.
    expect((await putEvidence(cookie, uuid, { contentSubtype: null })).statusCode).toBe(200);
  });
});

/*
 * `script` is the one type in the re-typable set with an invariant about its stored
 * bytes — UTF-8 text, no NULs, under `MAX_SCRIPT_BYTES` — because it is held in
 * memory to be edited and printed verbatim into a client's PDF. Both create paths
 * enforce it (`decodeScriptUpload` for an upload, the same cap for typed content).
 * A re-type is a third way into that column, and these are the two preconditions
 * that make the hole reachable with nothing exotic: the cap belongs to `script`
 * alone, so an oversized code block is ordinary, and nothing at create pairs an
 * uploaded `file` with a text type, so a code block whose blob is a binary is too.
 */
describe('becoming a script, where the stored bytes have to earn it', () => {
  it('refuses a code block larger than the script cap, and mutates nothing', async () => {
    const { cookie } = await setup();
    const uuid = (
      await createJson(cookie, {
        contentType: 'codeblock',
        title: 'Dump',
        // Over the cap and legal as a code block: only a script is capped, and the
        // request body limit is `MAX_UPLOAD_BYTES`, orders of magnitude above this.
        content: 'x'.repeat(MAX_SCRIPT_BYTES + 10),
      })
    ).json().uuid as string;
    const before = await app.db.evidence.findFirstOrThrow({ where: { uuid } });

    const res = await putEvidence(cookie, uuid, { contentType: 'script' });
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toBe(SCRIPT_TOO_LARGE_REASON);
    const after = await app.db.evidence.findFirstOrThrow({ where: { uuid } });
    expect(after.contentType).toBe('codeblock');
    expect(after.updatedAt).toEqual(before.updatedAt);
    expect(after.fullBlobKey).toBe(before.fullBlobKey);
  });

  it('refuses the same growth when the body arrives in the same request', async () => {
    const { cookie } = await setup();
    const uuid = (
      await createJson(cookie, { contentType: 'codeblock', title: 'Dump', content: BODY })
    ).json().uuid as string;

    // The cap is judged against the type the request leaves behind, so a code block
    // can't be re-typed and grown past it in one move either.
    const res = await putEvidence(cookie, uuid, {
      contentType: 'script',
      content: 'x'.repeat(MAX_SCRIPT_BYTES + 10),
    });
    expect(res.statusCode).toBe(413);
    expect((await getContent(cookie, uuid)).body).toBe(BODY);
    expect((await app.db.evidence.findFirstOrThrow({ where: { uuid } })).contentType).toBe(
      'codeblock',
    );
  });

  it('refuses a code block whose stored file is a binary, and mutates nothing', async () => {
    const { cookie } = await setup();
    // An ELF header: invalid UTF-8 *and* full of NULs. Filed as a code block, which
    // the create path accepts without decoding it — only a script is decoded there.
    const bin = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x00, 0x00, 0xff, 0xfe, 0x00, 0x01]);
    const uuid = (
      await createUpload(
        cookie,
        { contentType: 'codeblock', title: 'Dropped binary' },
        { filename: 'a.out', contentType: 'application/octet-stream', data: bin },
      )
    ).json().uuid as string;
    const before = await app.db.evidence.findFirstOrThrow({ where: { uuid } });

    // Relabelled, the report would print this verbatim as a wall of U+FFFD into a
    // client PDF, and the ZIP would hand it over named for an interpreter.
    const res = await putEvidence(cookie, uuid, { contentType: 'script' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe(SCRIPT_NOT_TEXT_REASON);
    const after = await app.db.evidence.findFirstOrThrow({ where: { uuid } });
    expect(after.contentType).toBe('codeblock');
    expect(after.updatedAt).toEqual(before.updatedAt);
    expect(after.fullBlobKey).toBe(before.fullBlobKey);
  });

  it('still accepts an uploaded code block that is genuinely text', async () => {
    const { cookie } = await setup();
    const uuid = (
      await createUpload(
        cookie,
        { contentType: 'codeblock', title: 'Recon' },
        { filename: 'notes.txt', contentType: 'text/plain', data: Buffer.from(BODY) },
      )
    ).json().uuid as string;
    const before = await blobIdentity(uuid);

    // The guard tests the bytes, not where they came from: an uploaded text body is
    // as re-typable as a typed one, and the blob is still never rewritten.
    const res = await putEvidence(cookie, uuid, { contentType: 'script' });
    expect(res.statusCode).toBe(200);
    expect(res.json().contentType).toBe('script');
    expect(await blobIdentity(uuid)).toEqual(before);
    expect((await getContent(cookie, uuid)).body).toBe(BODY);
  });

  it('leaves an uploaded file’s own name alone across a re-type', async () => {
    const { cookie } = await setup();
    const uuid = (
      await createUpload(
        cookie,
        { contentType: 'script', title: 'Deploy', contentSubtype: 'bash' },
        {
          filename: 'deploy.sh',
          contentType: 'text/x-shellscript',
          data: Buffer.from(BODY),
        },
      )
    ).json().uuid as string;

    const res = await putEvidence(cookie, uuid, { contentType: 'none' });
    expect(res.statusCode).toBe(200);
    expect(res.json().contentSubtype).toBe(null);
    /*
     * The type-derived extension (`.sh` → `.txt` here) only names evidence that has
     * no `originalFilename`: an uploaded file keeps its own name, in the download
     * header and in the report's supporting files alike, and that is deliberate —
     * renaming it would rename a file already listed in a delivered archive's "Files
     * Attached" table. So a re-type moves the extension only where it was derived.
     */
    expect((await getContent(cookie, uuid)).headers['content-disposition']).toContain(
      'filename="deploy.sh"',
    );
  });
});
