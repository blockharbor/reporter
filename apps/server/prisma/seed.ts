/**
 * Development/demo seed. Creates an admin + operator, default tags, finding
 * categories, and a demo engagement populated with evidence of several types so
 * the timeline and every renderer have real content. Prints an API key pair for
 * the operator (used by the /verify-api skill and the client apps).
 *
 * Run: `pnpm --filter @reporter/server seed`  (or via `prisma migrate reset`)
 */
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import Fastify from 'fastify';
import { scoreVector } from '@reporter/shared';
import sharp from 'sharp';
import { runAsSystem, withImporter } from '../src/audit/context.js';
import { createAuditedDb } from '../src/audit/extension.js';
import { LocalStore } from '../src/blobstore/local.js';
import { auditCtxFromContext, n, q, recordAudit } from '../src/services/audit.js';
import { createLocalUser } from '../src/services/users.js';
import { generateApiKey } from '../src/services/apikeys.js';

// The server's own logger without a server: the backstop and the recorder log
// through a Fastify logger, and pino is fastify's dependency, not ours.
const log = Fastify({ logger: { level: 'warn' } }).log;
// Through the audit factory, as app.ts does: the seed is the only other place
// a PrismaClient is constructed, and a client that bypasses the backstop would
// be the one hole in "every write is recorded". Under `withImporter` below the
// backstop counts rows instead of recording hundreds of anonymous entries.
const db = createAuditedDb(new PrismaClient(), log);
const blobs = new LocalStore(process.env.BLOB_DIR ?? './.data/blobs');

const DEFAULT_TAGS = [
  { name: 'recon', colorName: 'blue' },
  { name: 'foothold', colorName: 'orange' },
  { name: 'priv-esc', colorName: 'red' },
  { name: 'lateral-movement', colorName: 'violet' },
  { name: 'exfil', colorName: 'pink' },
  { name: 'cleanup', colorName: 'slate' },
];

const CATEGORIES = ['Vulnerability', 'Network', 'Web', 'Detection Gap'];

async function putBlob(data: Buffer): Promise<string> {
  const key = randomUUID();
  await blobs.put(key, data);
  return key;
}

/**
 * Runs the seed as the system actor inside an importer scope, so a seeded
 * database carries ONE audit entry — "seeded the demo engagement, N rows" —
 * rather than a per-row entry for every tag, finding and evidence item, none
 * of which anyone chose to create.
 */
async function main() {
  await runAsSystem(() => withImporter('seed', seed), log);
}

async function seed(counts: Record<string, number>) {
  // --- Users ---
  let admin = await db.user.findUnique({ where: { email: 'admin@reporter.local' } });
  if (!admin) {
    admin = await createLocalUser(db, {
      firstName: 'Ada',
      lastName: 'Admin',
      email: 'admin@reporter.local',
      password: 'reporter-dev',
      admin: true,
    });
  }

  let operator = await db.user.findUnique({ where: { email: 'op@reporter.local' } });
  if (!operator) {
    operator = await createLocalUser(db, {
      firstName: 'Olivia',
      lastName: 'Operator',
      email: 'op@reporter.local',
      password: 'reporter-dev',
    });
  }

  // --- Default tags ---
  for (const t of DEFAULT_TAGS) {
    await db.defaultTag.upsert({
      where: { name: t.name },
      create: t,
      update: { colorName: t.colorName },
    });
  }

  // --- Report branding (single row; defaults to the Block Harbor house style) ---
  await db.reportSettings.upsert({
    where: { id: 1 },
    create: { id: 1, footerNote: 'Confidential' },
    update: {},
  });

  // --- Demo engagement (recreate fresh) ---
  const existing = await db.engagement.findUnique({ where: { slug: 'acme-assessment' } });
  if (existing) await db.engagement.delete({ where: { id: existing.id } });

  const eng = await db.engagement.create({
    data: {
      slug: 'acme-assessment',
      name: 'Acme Corp — External Assessment',
      // startedAt defaults to now(); give the demo a projected end ~3 weeks out.
      projectedEndAt: new Date(Date.now() + 21 * 86_400_000),
      // Report metadata — populates the exported PDF's cover, details, and summary.
      clientName: 'Acme Corporation',
      assessmentType: 'External Penetration Assessment',
      location: 'Remote — Acme production perimeter',
      scope:
        'External-facing web application and API surface at acme.example.com and the ' +
        '203.0.113.0/24 network range. Testing covered authentication, access control, ' +
        'injection, and privilege-escalation paths. The billing subdomain and any ' +
        'destructive testing were explicitly out of scope.',
      executiveSummary:
        'Block Harbor conducted a time-boxed external penetration assessment of the Acme ' +
        'production perimeter. Testing identified a critical privilege-escalation path that ' +
        'allowed a low-privileged user to obtain root access, alongside information-disclosure ' +
        'weaknesses that could accelerate an attacker. Overall the perimeter is well maintained, ' +
        'but the privilege-escalation finding should be remediated as a priority.',
      methodology:
        'The assessment followed a gray-box methodology aligned to the OWASP Testing Guide and ' +
        'the PTES execution phases: reconnaissance, threat modeling, vulnerability analysis, ' +
        'exploitation, and post-exploitation. Findings are rated on the CVSS v3.1 base scale.',
      // Explicit positions, as the engagement create routes do: the seed list's
      // order becomes the demo engagement's initial curated tag order.
      tags: {
        create: DEFAULT_TAGS.map((t, i) => ({ name: t.name, colorName: t.colorName, position: i })),
      },
      roles: {
        create: [
          { userId: admin.id, role: 'admin' },
          { userId: operator.id, role: 'write' },
        ],
      },
    },
    include: { tags: true },
  });
  const tagByName = new Map(eng.tags.map((t) => [t.name, t]));

  // --- Evidence ---
  const now = Date.now();
  const at = (minsAgo: number) => new Date(now - minsAgo * 60_000);

  // A note whose whole text lives in the description (no body blob).
  const note = await db.evidence.create({
    data: {
      engagementId: eng.id,
      operatorId: operator.id,
      contentType: 'none',
      title: 'Engagement kickoff',
      description: 'Kickoff: scope confirmed for acme.example.com and 203.0.113.0/24.',
      occurredAt: at(240),
    },
  });

  // A note with a short caption (description) AND a long-form body (blob) — shows
  // the caption-on-top, body-below layout for notes. Also the demo of
  // `excludeFromReport`: internal rules-of-engagement detail that stays visible in
  // the app (badged) but is kept out of every report output.
  const noteBody =
    'Client granted an eight-hour testing window (09:00–17:00 UTC). Out of scope: the ' +
    'billing subdomain and any destructive testing.\n\nEscalation contact: soc@acme.example.com.';
  await db.evidence.create({
    data: {
      engagementId: eng.id,
      operatorId: operator.id,
      contentType: 'none',
      title: 'Rules of engagement',
      description: 'Client-approved testing window and scope constraints.',
      fullBlobKey: await putBlob(Buffer.from(noteBody, 'utf8')),
      occurredAt: at(238),
      excludeFromReport: true,
    },
  });

  // An event with a body — a timestamped marker plus supporting detail.
  const eventBody =
    'Initial foothold obtained on web01 (203.0.113.10) at 11:42 UTC via the reflected XSS → ' +
    'session hijack chain. Confirmed shell as www-data.';
  await db.evidence.create({
    data: {
      engagementId: eng.id,
      operatorId: operator.id,
      contentType: 'event',
      title: 'Foothold on web01',
      description: 'Initial access achieved via reflected XSS → session hijack.',
      fullBlobKey: await putBlob(Buffer.from(eventBody, 'utf8')),
      occurredAt: at(150),
      tags: { create: [{ tagId: tagByName.get('foothold')!.id }] },
    },
  });

  // A code block (stored as a text blob). Includes a deliberately long, unbroken
  // line so the detail view's code viewer scrolls inside its own box instead of
  // stretching the page sideways.
  const codeBody =
    'nmap -sV -Pn -oA acme 203.0.113.0/24\n# 22/tcp open ssh OpenSSH 8.2\n# 443/tcp open https nginx\n' +
    'curl -sk "https://acme.example.com/api/v2/search?q=%27%20OR%201=1--&token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6ImFkbWluIiwiaWF0IjoxNTE2MjM5MDIyfQ&redirect=https://acme.example.com/dashboard/reports/export?format=pdf&range=all-time"';
  const codeblock = await db.evidence.create({
    data: {
      engagementId: eng.id,
      operatorId: operator.id,
      contentType: 'codeblock',
      contentSubtype: 'bash',
      title: 'Initial port scan',
      description: 'nmap service scan of the in-scope range, plus a probe of the search API.',
      fullBlobKey: await putBlob(Buffer.from(codeBody, 'utf8')),
      occurredAt: at(180),
      tags: { create: [{ tagId: tagByName.get('recon')!.id }] },
    },
  });

  // A script (stored as a text blob, exactly like a codeblock or an uploaded
  // text file). Distinct from the short `codeblock` snippet: it's a full,
  // runnable artifact that renders verbatim in the report (never as markdown, so
  // the `#!/bin/bash` shebang stays a shebang) and lands in the supporting-files
  // ZIP as `.sh`.
  //
  // `originalFilename` is deliberately left unset: `synthesizeFilename` returns an
  // uploaded name verbatim when it has one, so setting it here would mean the demo
  // data never exercises the interpreter-derived extension at all. Without it the
  // entry is named from the title plus the `bash` in `contentSubtype`, which is the
  // path a typed script takes.
  const scriptBody =
    '#!/bin/bash\n' +
    'set -euo pipefail\n' +
    '# Enumerate sudo rights reachable from the current user, flagging any that\n' +
    '# grant a shell or wildcard — the path that led to the root-shell finding.\n' +
    'echo "[*] sudo -l for $(id -un):"\n' +
    'sudo -n -l 2>/dev/null | tee /tmp/sudo-rights.txt\n' +
    'echo "[*] Shell/wildcard entries:"\n' +
    "grep -E '(ALL|NOPASSWD).*(sh|bash|/\\*)' /tmp/sudo-rights.txt || echo '  none'\n";
  await db.evidence.create({
    data: {
      engagementId: eng.id,
      operatorId: operator.id,
      contentType: 'script',
      contentSubtype: 'bash',
      title: 'sudo rights enumeration',
      description:
        'Script run on web01 to enumerate reachable sudo rules during privilege escalation.',
      fullBlobKey: await putBlob(Buffer.from(scriptBody, 'utf8')),
      occurredAt: at(90),
      tags: { create: [{ tagId: tagByName.get('priv-esc')!.id }] },
    },
  });

  // A screenshot (generated placeholder PNG + thumbnail).
  const png = await sharp({
    create: { width: 640, height: 360, channels: 3, background: { r: 14, g: 138, b: 138 } },
  })
    .png()
    .toBuffer();
  const thumb = await sharp(png)
    .resize(500, 500, { fit: 'inside' })
    .jpeg({ quality: 80 })
    .toBuffer();
  await db.evidence.create({
    data: {
      engagementId: eng.id,
      operatorId: operator.id,
      contentType: 'image',
      title: 'Login page reflected XSS proof',
      description: 'Screenshot showing script execution rendered from the login form input.',
      fullBlobKey: await putBlob(png),
      thumbBlobKey: await putBlob(thumb),
      occurredAt: at(120),
      tags: { create: [{ tagId: tagByName.get('foothold')!.id }] },
    },
  });

  // A terminal recording (asciicast v2).
  const cast = [
    JSON.stringify({ version: 2, width: 80, height: 24, timestamp: Math.floor(now / 1000) }),
    JSON.stringify([0.5, 'o', 'operator@acme:~$ id\r\n']),
    JSON.stringify([1.0, 'o', 'uid=0(root) gid=0(root) groups=0(root)\r\n']),
    JSON.stringify([1.6, 'o', 'operator@acme:~$ ']),
  ].join('\n');
  const recording = await db.evidence.create({
    data: {
      engagementId: eng.id,
      operatorId: operator.id,
      contentType: 'terminal-recording',
      title: 'Root shell via sudo misconfiguration',
      description: 'Terminal recording of the privilege-escalation chain from www-data to root.',
      fullBlobKey: await putBlob(Buffer.from(cast, 'utf8')),
      occurredAt: at(60),
      tags: { create: [{ tagId: tagByName.get('priv-esc')!.id }] },
    },
  });

  // --- Finding categories (per-engagement) ---
  for (const c of CATEGORIES) {
    await db.findingCategory.upsert({
      where: { engagementId_category: { engagementId: eng.id, category: c } },
      create: { engagementId: eng.id, category: c },
      update: {},
    });
  }

  // --- Findings grouping some evidence ---
  const category = await db.findingCategory.findUnique({
    where: { engagementId_category: { engagementId: eng.id, category: 'Vulnerability' } },
  });
  // A fully CVSS-rated, report-ready finding (High 8.8, scope-changed local privesc).
  const privesc = scoreVector('CVSS:3.1/AV:L/AC:L/PR:L/UI:N/S:C/C:H/I:H/A:H')!;
  const finding = await db.finding.create({
    data: {
      engagementId: eng.id,
      title: 'Privilege escalation via sudo misconfiguration',
      // Tagged like the evidence behind it, so the demo shows finding tags on the
      // cards, in the filter facet and on the report's detail card.
      tags: { create: [{ tagId: tagByName.get('priv-esc')!.id }] },
      description:
        'A sudo rule allowed the low-priv user to run a shell as root without a password.',
      remediation:
        'Remove the overly-permissive sudo rule and grant only the specific commands each ' +
        'role requires, with NOPASSWD limited to non-interactive, non-shell binaries. Audit ' +
        '/etc/sudoers and sudoers.d for wildcard or shell entries, and add monitoring for ' +
        'privilege-escalation events.',
      categoryId: category?.id ?? null,
      severity: privesc.severity,
      cvssVector: privesc.vector,
      cvssScore: privesc.score,
      position: 0,
      readyToReport: true,
    },
  });
  await db.evidenceFinding.createMany({
    data: [
      { evidenceId: recording.id, findingId: finding.id, position: 0 },
      { evidenceId: codeblock.id, findingId: finding.id, position: 1 },
    ],
    skipDuplicates: true,
  });
  // A second finding rated with a simple (manual) severity, not yet report-ready.
  await db.finding.create({
    data: {
      engagementId: eng.id,
      title: 'Verbose error messages disclose stack traces',
      tags: { create: [{ tagId: tagByName.get('recon')!.id }] },
      description: 'Unhandled exceptions return full stack traces to unauthenticated users.',
      categoryId: category?.id ?? null,
      severity: 'medium',
      position: 1,
      readyToReport: false,
    },
  });
  void note;

  // --- API key for the operator ---
  const key = await generateApiKey(db, operator.id);

  // --- The one audit entry the seed leaves: a system row on the demo
  // engagement, with the per-model row counts the backstop tallied while it was
  // silent. Written through the recorder so it carries the same validation and
  // caps as every other row.
  const total = Object.values(counts).reduce((sum, c) => sum + c, 0);
  const ref = { id: eng.id, slug: eng.slug, name: eng.name };
  await recordAudit(auditCtxFromContext(db, log, ref), {
    action: 'import',
    entityType: 'engagement',
    entity: { id: String(eng.id), label: eng.name },
    summary: `Seeded the demo engagement ${q(eng.name)} (${n(total, 'row')})`,
    changes: Object.entries(counts).map(([model, count]) => ({
      kind: 'count',
      label: model,
      count,
    })),
  });

  console.log('\n✔ Seed complete.');
  console.log('  Admin login:    admin@reporter.local / reporter-dev');
  console.log('  Operator login: op@reporter.local / reporter-dev');
  console.log('  Demo engagement: acme-assessment');
  console.log('\n  Operator API key (for /verify-api and client apps):');
  console.log(`    REPORTER_ACCESS_KEY=${key.accessKey}`);
  console.log(`    REPORTER_SECRET_KEY=${key.secretKey}\n`);
}

main()
  .then(() => db.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await db.$disconnect();
    process.exit(1);
  });
