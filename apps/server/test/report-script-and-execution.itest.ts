import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  DEFAULT_REPORT_SECTIONS,
  reportPresetSections,
  type ReportSectionEntry,
} from '@reporter/shared';
import { buildTestApp, seedUsers, truncateAll } from './helpers.js';
import {
  buildReportHtml,
  gatherSupportingFiles,
  type ReportOptions,
} from '../src/services/findings-report.js';

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

/**
 * A shell script with both a shebang and a `#` comment line. The comment is the
 * sharp half of the markdown assertion: a bare `#!/bin/bash` is not a heading to
 * the markdown renderer (no space after the `#`), but `# Deploy the key` is — so
 * a script that went through `prose()` would print an `<h1>` here.
 */
const SCRIPT_BODY = '#!/bin/bash\nset -euo pipefail\n# Deploy the key\necho "ok"\n';

/** A fixed generation time, so two renders of the same config compare byte-for-byte. */
const GENERATED_AT = new Date('2026-03-04T12:00:00.000Z');

/**
 * One engagement whose Assessment Execution narrative has two hand-authored
 * subsections — one of each `kind`, because numbering has to run across both:
 *
 *  1. "Recon" (narrative) embeds the script as a figure.
 *  2. "Execution timeline" (timeline) sweeps the engagement's evidence, which is
 *     the only place tag chips are rendered.
 *
 * The script is tagged and carries no `originalFilename`, so its
 * `supporting-files/` entry name is synthesized from its title and its recorded
 * interpreter (`bash` → `.sh`). A second, report-excluded script is seeded to
 * prove the new toggles cannot re-admit it.
 */
async function setup() {
  const users = await seedUsers(app);
  const eng = await app.db.engagement.create({
    data: {
      slug: 'op1',
      name: 'Op One',
      roles: { create: [{ userId: users.writer.id, role: 'write' }] },
    },
  });
  const tag = await app.db.tag.create({
    data: { engagementId: eng.id, name: 'can-fuzzing', colorName: 'red' },
  });

  const makeScript = async (
    title: string,
    body: string,
    extra: { excludeFromReport?: boolean; tagged?: boolean } = {},
  ) => {
    const blobKey = `scripts/${title.replace(/\s+/g, '-').toLowerCase()}`;
    const buf = Buffer.from(body);
    await app.blobs.put(blobKey, buf);
    return app.db.evidence.create({
      data: {
        engagementId: eng.id,
        operatorId: users.writer.id,
        contentType: 'script',
        contentSubtype: 'bash',
        title,
        description: '',
        occurredAt: new Date('2026-03-01T09:00:00.000Z'),
        fullBlobKey: blobKey,
        // Stored at upload for real evidence; without them `gatherSupportingFiles`
        // would read the blob instead of trusting the row.
        sha256: 'a'.repeat(64),
        sizeBytes: buf.length,
        excludeFromReport: extra.excludeFromReport ?? false,
        ...(extra.tagged ? { tags: { create: [{ tagId: tag.id }] } } : {}),
      },
    });
  };

  const script = await makeScript('Deploy script', SCRIPT_BODY, { tagged: true });
  const secret = await makeScript('Withheld script', 'cat /etc/withheld-shadow\n', {
    excludeFromReport: true,
  });

  await app.db.engagement.update({
    where: { id: eng.id },
    data: {
      executionNarrative: [
        {
          kind: 'narrative',
          title: 'Recon',
          body: 'We enumerated the fleet API.',
          evidence: [{ evidenceUuid: script.uuid, caption: '' }],
        },
        {
          kind: 'timeline',
          title: 'Execution timeline',
          body: '',
          evidence: [],
          timeline: {
            tags: [],
            types: [],
            group: 'chronological',
            includeComments: false,
            starredOnly: false,
          },
        },
      ],
    },
  });

  return { users, eng, script, secret };
}

/**
 * Render with a section-configured report, optionally overriding the Assessment
 * Execution sub-item toggles. Passing no overrides leaves the section with no
 * `options` map at all — the shape every engagement that predates these toggles
 * has on disk.
 */
function render(
  eng: { id: number; slug: string; name: string },
  userId: number,
  opts: {
    options?: Record<string, boolean>;
    numberExecutionSubsections?: boolean;
  } = {},
): Promise<string> {
  const sections: ReportSectionEntry[] = DEFAULT_REPORT_SECTIONS.map((s) =>
    s.key === 'assessmentExecution' && opts.options ? { ...s, options: opts.options } : s,
  );
  const reportOptions: ReportOptions = {
    includeAll: true,
    sections,
    customSections: [],
    numberExecutionSubsections: opts.numberExecutionSubsections,
  };
  return buildReportHtml(app, eng, GENERATED_AT, reportOptions, userId);
}

describe('script evidence renders verbatim in the report', () => {
  it('puts the script body in a <pre>, not through the markdown renderer', async () => {
    const { users, eng } = await setup();
    const html = await render(eng, users.writer.id);

    // Verbatim: the shebang and the comment survive as source text.
    expect(html).toContain('<pre class="ev-code">#!/bin/bash\nset -euo pipefail\n# Deploy the key');
    // …and the `#` comment never became a heading, which is the whole reason a
    // script is not a codeblock.
    expect(html).not.toContain('<h1>Deploy the key</h1>');
    expect(html).not.toContain('Deploy the key</h1>');
    // The recorded interpreter still shows as the language chip.
    expect(html).toContain('<span class="ev-lang">bash</span>');
  });

  it('names the script in supporting files with an interpreter-derived extension', async () => {
    const { eng, script } = await setup();
    const files = await gatherSupportingFiles(app, eng);
    expect(files).toHaveLength(1);
    // `bash` resolves through the shared interpreter table, so the client can run
    // the file with the right thing instead of guessing from `.txt`.
    expect(files[0]!.filename).toBe(`deploy-script-${script.uuid.slice(0, 8)}.sh`);
  });
});

describe('Assessment Execution display sub-items', () => {
  it('shows tag chips by default and drops them when evidenceTags is off', async () => {
    const { users, eng } = await setup();
    const shown = await render(eng, users.writer.id);
    expect(shown).toContain('<div class="tl-tags">');
    expect(shown).toContain('can-fuzzing');

    const hidden = await render(eng, users.writer.id, { options: { evidenceTags: false } });
    expect(hidden).not.toContain('<div class="tl-tags">');
    expect(hidden).not.toContain('can-fuzzing');
    // Only the chips go: the item itself, and the script in it, still render.
    expect(hidden).toContain('#!/bin/bash');
  });

  it('shows the evidence-type caption by default and drops it when typeCaptions is off', async () => {
    const { users, eng } = await setup();
    const shown = await render(eng, users.writer.id);
    // The timeline blanks title/description, so the caption is the type label.
    expect(shown).toContain('<figcaption>Script <span class="ev-lang">bash</span></figcaption>');

    const hidden = await render(eng, users.writer.id, { options: { typeCaptions: false } });
    expect(hidden).not.toContain('<figcaption>Script');
    // The language chip is a property of the content, not the type caption, so it
    // stays on a caption line of its own — and with no caption in front of it, that
    // line opens on the chip rather than on a stray separator space.
    expect(hidden).toContain('<figcaption><span class="ev-lang">bash</span></figcaption>');
    expect(hidden).toContain('#!/bin/bash');
  });

  it('numbers the subsection titles only when asked, across both kinds', async () => {
    const { users, eng } = await setup();
    const plain = await render(eng, users.writer.id);
    expect(plain).toContain('<h3 class="block-h">Recon</h3>');
    expect(plain).toContain('<h3 class="block-h">Execution timeline</h3>');

    const numbered = await render(eng, users.writer.id, { numberExecutionSubsections: true });
    expect(numbered).toContain('<h3 class="block-h">1. Recon</h3>');
    expect(numbered).toContain('<h3 class="block-h">2. Execution timeline</h3>');
    // Numbering is a labelling change: the evidence inside the subsections is
    // untouched, and no other heading picked up a number.
    expect(numbered).toContain('#!/bin/bash');
    expect(numbered).not.toContain('<h3 class="block-h">1. Files Attached</h3>');
  });

  it('leaves a report with no options map byte-identical to one that opts every item in', async () => {
    const { users, eng } = await setup();
    const absent = await render(eng, users.writer.id);
    const explicit = await render(eng, users.writer.id, {
      options: { evidenceTags: true, typeCaptions: true, scriptBodies: true },
    });
    // The absent-means-true convention, asserted on the bytes: every engagement
    // configured before these toggles existed keeps the report it already had.
    expect(absent).toBe(explicit);
  });
});

describe('a built-in report type honours the section sub-items', () => {
  /*
   * Regression for the leak the review found: `reportFor` builds a preset's section
   * list from `reportPresetSections`, whose entries carried no `options` map, so
   * `scriptBodies: false` was silently discarded and every body printed. The render
   * is asserted through the same composition the route performs — the PDF route
   * itself needs headless Chromium, which these tests don't run.
   */
  const configured: ReportSectionEntry[] = DEFAULT_REPORT_SECTIONS.map((s) =>
    s.key === 'assessmentExecution' ? { ...s, options: { scriptBodies: false } } : s,
  );

  it.each(['full', 'executive', 'findings'] as const)(
    'keeps a suppressed script body suppressed under preset "%s"',
    async (preset) => {
      const { users, eng } = await setup();
      const html = await buildReportHtml(
        app,
        eng,
        GENERATED_AT,
        {
          includeAll: true,
          sections: reportPresetSections(preset, configured),
          customSections: [],
        },
        users.writer.id,
      );
      // Either the section isn't in this preset at all, or it is and the body is
      // still withheld. What must never happen is the body printing.
      expect(html).not.toContain('#!/bin/bash');
    },
  );

  it('still prints the body under a preset when the engagement never suppressed it', async () => {
    const { users, eng } = await setup();
    const html = await buildReportHtml(
      app,
      eng,
      GENERATED_AT,
      {
        includeAll: true,
        sections: reportPresetSections('full', DEFAULT_REPORT_SECTIONS),
        customSections: [],
      },
      users.writer.id,
    );
    // The carry-over must not have become a blanket suppression: absent-means-on
    // still holds, so an engagement that set nothing gets the report it always had.
    expect(html).toContain('<pre class="ev-code">#!/bin/bash');
  });
});

describe('scripts suppressed from the report body', () => {
  it('replaces each body with a stub naming its real supporting-files entry', async () => {
    const { users, eng } = await setup();
    const files = await gatherSupportingFiles(app, eng);
    const entry = files[0]!.filename;

    const html = await render(eng, users.writer.id, { options: { scriptBodies: false } });
    // No body…
    expect(html).not.toContain('#!/bin/bash');
    expect(html).not.toContain('<pre class="ev-code">');
    // …but a line that points at the exact ZIP entry, so a PDF-only download and
    // the Files Attached table still agree about what was delivered.
    expect(html).toContain(
      `<span class="play">$</span> Script — provided as <span class="mono">supporting-files/${entry}</span> with this report.`,
    );
    expect(html).toContain(entry);
  });

  it('still bundles the suppressed script in the ZIP', async () => {
    const { users, eng, script } = await setup();
    await render(eng, users.writer.id, { options: { scriptBodies: false } });
    // The toggle is a display choice; `gatherSupportingFiles` is gated only by the
    // report-visibility filter, so the artifact is still delivered (and hashed).
    const files = await gatherSupportingFiles(app, eng);
    expect(files.map((f) => f.filename)).toEqual([`deploy-script-${script.uuid.slice(0, 8)}.sh`]);
    expect(await app.blobs.getBuffer(files[0]!.blobKey)).toEqual(Buffer.from(SCRIPT_BODY));
  });

  it('keeps an excluded script out of both the body and the ZIP, whatever the toggles say', async () => {
    const { users, eng, secret } = await setup();
    for (const options of [undefined, { scriptBodies: false }, { scriptBodies: true }]) {
      const html = await render(eng, users.writer.id, { options });
      expect(html).not.toContain('withheld-shadow');
      expect(html).not.toContain('Withheld script');
      expect(html).not.toContain(secret.uuid.slice(0, 8));
    }
    const files = await gatherSupportingFiles(app, eng);
    expect(files.some((f) => f.blobKey === secret.fullBlobKey)).toBe(false);
  });
});
