import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildMultipart } from '@reporter/api-client';
import {
  MAX_SCRIPT_BYTES,
  SCRIPT_EMPTY_REASON,
  SCRIPT_NOT_TEXT_REASON,
  SCRIPT_TOO_LARGE_REASON,
} from '@reporter/shared';
import { WEB_HEADERS, buildTestApp, loginCookie, seedUsers, truncateAll } from './helpers.js';

// A minimal 1x1 PNG, for the one assertion that contrasts a script with an image.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

const SCRIPT = '#!/bin/bash\nset -euo pipefail\nnmap -sV "$1" | tee scan.txt\n';

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
  file?: { filename: string; contentType: string; data: Buffer },
) {
  const { body, contentType } = buildMultipart(
    { notes: JSON.stringify(notes) },
    file ? [{ field: 'file', ...file }] : [],
  );
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

describe('script evidence — typed and uploaded converge on one shape', () => {
  it('stores a typed script as a text blob and serves it back verbatim', async () => {
    const { cookie } = await setup();
    const res = await createJson(cookie, {
      contentType: 'script',
      title: 'Recon wrapper',
      contentSubtype: 'bash',
      content: SCRIPT,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().hasContent).toBe(true);

    const content = await getContent(cookie, res.json().uuid);
    expect(content.statusCode).toBe(200);
    // Verbatim: not markdown-rendered, not re-indented, not newline-normalized.
    expect(content.body).toBe(SCRIPT);
  });

  it('decodes an uploaded script to text, keeps its filename, and leaves it editable', async () => {
    const { cookie } = await setup();
    const res = await createUpload(
      cookie,
      { contentType: 'script', title: 'Recon wrapper' },
      { filename: 'recon.sh', contentType: 'application/x-sh', data: Buffer.from(SCRIPT, 'utf8') },
    );
    expect(res.statusCode).toBe(201);
    const uuid = res.json().uuid as string;
    // The real name survives, so the supporting-files ZIP can use it as the entry name.
    expect(res.json().originalFilename).toBe('recon.sh');

    // Stored exactly like typed content: one blob, no thumbnail, hashed and sized
    // from the decoded text rather than from an opaque upload.
    const row = await app.db.evidence.findFirstOrThrow({ where: { uuid } });
    expect(row.thumbBlobKey).toBeNull();
    expect(row.sizeBytes).toBe(Buffer.byteLength(SCRIPT, 'utf8'));
    expect((await getContent(cookie, uuid)).body).toBe(SCRIPT);

    // And therefore editable afterwards, which is the whole point of decoding at
    // create time: an upload must not produce a second, read-only kind of script.
    const edited = `${SCRIPT}echo done\n`;
    const put = await putEvidence(cookie, uuid, { content: edited });
    expect(put.statusCode).toBe(200);
    expect((await getContent(cookie, uuid)).body).toBe(edited);
  });

  it('strips a UTF-8 BOM so an uploaded script matches the typed one byte for byte', async () => {
    const { cookie } = await setup();
    const res = await createUpload(
      cookie,
      { contentType: 'script', title: 'BOM' },
      {
        filename: 'bom.sh',
        contentType: 'text/plain',
        data: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(SCRIPT, 'utf8')]),
      },
    );
    expect(res.statusCode).toBe(201);
    // A leading BOM would otherwise sit in front of `#!` and break the shebang.
    expect((await getContent(cookie, res.json().uuid)).body).toBe(SCRIPT);
  });
});

describe('script evidence — refusals', () => {
  it('rejects an upload that is not valid UTF-8 text', async () => {
    const { cookie } = await setup();
    const res = await createUpload(
      cookie,
      { contentType: 'script', title: 'Not a script' },
      { filename: 'tool', contentType: 'application/octet-stream', data: PNG },
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe(SCRIPT_NOT_TEXT_REASON);
    // Nothing half-created: the refusal happens before any row or blob is written.
    expect(await app.db.evidence.count()).toBe(0);
  });

  it('rejects an upload that decodes cleanly but carries NUL bytes', async () => {
    const { cookie } = await setup();
    // UTF-16LE "#!/bin/sh" is valid UTF-8 byte-wise (every other byte is NUL), so a
    // fatal decode alone would let it through as unreadable text.
    const res = await createUpload(
      cookie,
      { contentType: 'script', title: 'UTF-16' },
      {
        filename: 'utf16.sh',
        contentType: 'text/plain',
        data: Buffer.from('#!/bin/sh\n', 'utf16le'),
      },
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe(SCRIPT_NOT_TEXT_REASON);
  });

  it('rejects an oversized script on upload, on create and on edit', async () => {
    const { cookie } = await setup();
    const tooBig = 'x'.repeat(MAX_SCRIPT_BYTES + 1);

    const upload = await createUpload(
      cookie,
      { contentType: 'script', title: 'Huge' },
      { filename: 'huge.sh', contentType: 'text/plain', data: Buffer.from(tooBig, 'utf8') },
    );
    expect(upload.statusCode).toBe(413);
    expect(upload.json().error).toBe(SCRIPT_TOO_LARGE_REASON);

    const typed = await createJson(cookie, {
      contentType: 'script',
      title: 'Huge',
      content: tooBig,
    });
    expect(typed.statusCode).toBe(413);
    expect(typed.json().error).toBe(SCRIPT_TOO_LARGE_REASON);

    // The editor is bound by the same cap, or a small script could be grown past it.
    const ok = await createJson(cookie, {
      contentType: 'script',
      title: 'Small',
      content: SCRIPT,
    });
    const put = await putEvidence(cookie, ok.json().uuid, { content: tooBig });
    expect(put.statusCode).toBe(413);
    expect((await getContent(cookie, ok.json().uuid)).body).toBe(SCRIPT);
  });

  it('refuses a script sent as both a file and inline content instead of picking one', async () => {
    const { cookie } = await setup();
    const res = await createUpload(
      cookie,
      { contentType: 'script', title: 'Both', content: 'echo inline' },
      { filename: 'both.sh', contentType: 'text/plain', data: Buffer.from(SCRIPT, 'utf8') },
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/not both/);
  });
});

describe('evidence content route hardening', () => {
  it('serves a script as a nosniff attachment named after the upload', async () => {
    const { cookie } = await setup();
    const res = await createUpload(
      cookie,
      { contentType: 'script', title: 'Recon' },
      {
        filename: 'recon.sh',
        contentType: 'text/x-shellscript',
        data: Buffer.from(SCRIPT, 'utf8'),
      },
    );
    const content = await getContent(cookie, res.json().uuid);

    expect(content.headers['x-content-type-options']).toBe('nosniff');
    expect(content.headers['content-disposition']).toBe(
      `attachment; filename="recon.sh"; filename*=UTF-8''recon.sh`,
    );
    // The MIME comes from the evidence type, never from the upload's own
    // `text/x-shellscript` — echoing an uploader's type back would be stored XSS.
    expect(content.headers['content-type']).toBe('text/plain; charset=utf-8');
  });

  it('keeps screenshots inline, since the app renders them in an <img>', async () => {
    const { cookie } = await setup();
    const res = await createUpload(
      cookie,
      { contentType: 'image', title: 'Shot' },
      { filename: 'shot.png', contentType: 'image/png', data: PNG },
    );
    const content = await getContent(cookie, res.json().uuid);
    expect(content.headers['content-type']).toBe('image/png');
    expect(content.headers['x-content-type-options']).toBe('nosniff');
    expect(String(content.headers['content-disposition']).startsWith('inline;')).toBe(true);

    const thumb = await app.inject({
      method: 'GET',
      url: `/web/engagements/op1/evidence/${res.json().uuid}/thumbnail`,
      headers: { cookie },
    });
    expect(thumb.headers['x-content-type-options']).toBe('nosniff');
  });

  it('neutralizes a filename that would otherwise inject a header', async () => {
    const { cookie } = await setup();
    const res = await createJson(cookie, {
      contentType: 'script',
      title: 'Nasty name',
      content: SCRIPT,
      // Operator-supplied: a bare CRLF here would split the response (or make Node
      // reject the whole reply), and the non-ASCII name has to survive somewhere.
      originalFilename: 'évil\r\nSet-Cookie: a=b.sh',
    });
    expect(res.statusCode).toBe(201);
    const content = await getContent(cookie, res.json().uuid);
    expect(content.statusCode).toBe(200);
    expect(content.headers['set-cookie']).toBeUndefined();
    const disposition = String(content.headers['content-disposition']);
    expect(disposition).not.toMatch(/[\r\n]/);
    expect(disposition).toContain(`filename="_vil__Set-Cookie: a=b.sh"`);
    // The real name is still recoverable from the RFC 6266 parameter.
    expect(disposition).toContain(`filename*=UTF-8''%C3%A9vil%0D%0ASet-Cookie%3A%20a%3Db.sh`);
  });

  it('names a typed script from its interpreter when there is no uploaded filename', async () => {
    const { cookie } = await setup();
    const res = await createJson(cookie, {
      contentType: 'script',
      title: 'Parser',
      contentSubtype: 'Python 3',
      content: 'print("hi")\n',
    });
    const content = await getContent(cookie, res.json().uuid);
    // `evidenceFileExtension` resolves the interpreter token, so the download is
    // `.py` rather than the unrunnable `.python`.
    expect(content.headers['content-disposition']).toMatch(
      /^attachment; filename="script-[0-9a-f]{8}\.py"/,
    );
  });
});

describe('the interpreter is visible and correctable after capture', () => {
  /*
   * Regression: `contentSubtype` was stored at create time, never serialized, and
   * had no update field — yet for a script it chooses the extension of the file a
   * client is handed in the report ZIP. A typo in it was permanent short of
   * deleting and re-filing the evidence, with nothing on any screen explaining why
   * the delivered file came out `.txt`.
   */
  it('serializes the interpreter on create, read and update', async () => {
    const { cookie } = await setup();
    const created = await createJson(cookie, {
      contentType: 'script',
      title: 'Recon wrapper',
      contentSubtype: 'bash',
      content: SCRIPT,
    });
    expect(created.json().contentSubtype).toBe('bash');

    const read = await app.inject({
      method: 'GET',
      url: `/web/engagements/op1/evidence/${created.json().uuid}`,
      headers: { cookie },
    });
    expect(read.json().contentSubtype).toBe('bash');
  });

  it('corrects a mistyped interpreter, which re-names the delivered file', async () => {
    const { cookie } = await setup();
    const created = await createJson(cookie, {
      contentType: 'script',
      title: 'Recon wrapper',
      contentSubtype: 'pyton',
      content: 'print("hi")\n',
    });
    const uuid = created.json().uuid;
    // An interpreter the shared table doesn't know names the file `.txt` rather
    // than inventing `.pyton` — which is exactly why it has to be fixable.
    expect((await getContent(cookie, uuid)).headers['content-disposition']).toContain('.txt"');

    const fixed = await putEvidence(cookie, uuid, { contentSubtype: 'python3' });
    expect(fixed.statusCode).toBe(200);
    expect(fixed.json().contentSubtype).toBe('python3');
    expect((await getContent(cookie, uuid)).headers['content-disposition']).toContain('.py"');
  });

  it('clears the interpreter on null or blank, and leaves it alone when absent', async () => {
    const { cookie } = await setup();
    const uuid = (
      await createJson(cookie, {
        contentType: 'script',
        title: 'Recon wrapper',
        contentSubtype: 'bash',
        content: SCRIPT,
      })
    ).json().uuid;

    // Absent means unchanged — an ordinary body edit must not wipe it.
    expect((await putEvidence(cookie, uuid, { content: SCRIPT })).json().contentSubtype).toBe(
      'bash',
    );
    // Whitespace normalizes to null, so "no interpreter" is one value in the column.
    expect((await putEvidence(cookie, uuid, { contentSubtype: '  ' })).json().contentSubtype).toBe(
      null,
    );
    expect((await putEvidence(cookie, uuid, { contentSubtype: 'zsh' })).json().contentSubtype).toBe(
      'zsh',
    );
    expect((await putEvidence(cookie, uuid, { contentSubtype: null })).json().contentSubtype).toBe(
      null,
    );
  });

  it('refuses an interpreter on a type that has no reader for one', async () => {
    const { cookie } = await setup();
    const uuid = (
      await createJson(cookie, { contentType: 'none', title: 'A note', content: 'hello' })
    ).json().uuid;
    const res = await putEvidence(cookie, uuid, { contentSubtype: 'bash' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/language or interpreter/);
    // Nothing was written, so the row is untouched.
    expect((await app.db.evidence.findFirstOrThrow({ where: { uuid } })).contentSubtype).toBe(null);
  });
});

describe('an empty script upload', () => {
  /*
   * Regression: a 0-byte pick decoded to '' and took the text branch, writing a
   * zero-length blob. `gatherSupportingFiles` gates on `fullBlobKey` alone, so the
   * report ZIP got a blank entry and the Files Attached table listed the SHA-256 of
   * the empty string beside it — a file the client is told to look for and finds
   * empty. The typed path has always treated empty content as "no body".
   */
  it('is refused, rather than stored as a zero-length artifact', async () => {
    const { cookie } = await setup();
    const res = await createUpload(
      cookie,
      { contentType: 'script', title: 'Empty' },
      { filename: 'empty.sh', contentType: 'text/x-shellscript', data: Buffer.alloc(0) },
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe(SCRIPT_EMPTY_REASON);
    // No half-written evidence and no orphaned blob.
    expect(await app.db.evidence.count()).toBe(0);
  });

  it('is refused when the file holds only whitespace', async () => {
    const { cookie } = await setup();
    const res = await createUpload(
      cookie,
      { contentType: 'script', title: 'Blank' },
      { filename: 'blank.sh', contentType: 'text/plain', data: Buffer.from('\n\n   \t\n') },
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe(SCRIPT_EMPTY_REASON);
    expect(await app.db.evidence.count()).toBe(0);
  });

  it('still allows typed content to be left empty — that is a script with no body yet', async () => {
    const { cookie } = await setup();
    const res = await createJson(cookie, {
      contentType: 'script',
      title: 'To be written',
      description: 'Placeholder for the exploit script.',
      content: '',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().hasContent).toBe(false);
    // No blob means no ZIP entry, so nothing blank is ever delivered.
    expect((await app.db.evidence.findFirstOrThrow()).fullBlobKey).toBe(null);
  });
});
