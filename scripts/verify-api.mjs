// HMAC client-API smoke test. Exercises @reporter/api-client the same way the
// desktop app and reporter-term do. See the /verify-api skill.
//
//   REPORTER_URL=... REPORTER_ACCESS_KEY=... REPORTER_SECRET_KEY=... node scripts/verify-api.mjs
import { ReporterClient } from '@reporter/api-client';

const baseUrl = process.env.REPORTER_URL ?? 'http://localhost:8080';
const accessKey = process.env.REPORTER_ACCESS_KEY;
const secretKey = process.env.REPORTER_SECRET_KEY;

if (!accessKey || !secretKey) {
  console.error('Set REPORTER_ACCESS_KEY and REPORTER_SECRET_KEY (see the seed output).');
  process.exit(2);
}

// A minimal 1x1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

const client = new ReporterClient({ baseUrl, accessKey, secretKey });

try {
  const conn = await client.checkConnection();
  check('checkConnection', conn.ok === true, `user=${conn.user?.email} v${conn.serverVersion}`);

  const ops = await client.listEngagements();
  const demo = ops.find((o) => o.slug === 'acme-assessment');
  check('listEngagements includes demo', Boolean(demo), `${ops.length} engagement(s)`);

  const slug = demo?.slug ?? ops[0]?.slug;
  if (!slug) {
    check('has an engagement to write to', false);
  } else {
    const created = await client.createEvidence(
      slug,
      {
        contentType: 'image',
        title: 'verify-api smoke test',
        description: 'verify-api smoke test',
        tagIds: [],
      },
      { filename: 'smoke.png', contentType: 'image/png', data: PNG },
    );
    check('createEvidence returns a uuid', Boolean(created.uuid), created.uuid);
    check('created evidence has description', created.description === 'verify-api smoke test');
    check('image thumbnail generated', created.hasThumbnail === true);
  }
} catch (err) {
  check('client API request', false, String(err));
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
