import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_REPORT_SECTIONS, type ReportSectionEntry } from '@reporter/shared';
import { buildTestApp, seedUsers, truncateAll } from './helpers.js';
import { buildReportHtml } from '../src/services/findings-report.js';

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

const GENERATED_AT = new Date('2026-03-04T12:00:00.000Z');

/**
 * Markdown source carrying the three constructs that print literally when a
 * field is escaped instead of rendered: bold, an inline code span, and a bullet
 * list. `marker` makes each field's text unique, so an assertion about one field
 * can never be satisfied by another field's rendering.
 */
function md(marker: string): string {
  return `**Bold ${marker}** with \`code_${marker}()\`\n\n- list ${marker} one\n- list ${marker} two`;
}

/** Assert `marker`'s field rendered as markdown and printed none of its syntax. */
function expectRendered(html: string, marker: string): void {
  expect(html).toContain(`<strong>Bold ${marker}</strong>`);
  expect(html).toContain(`<code>code_${marker}()</code>`);
  expect(html).toContain(`<ul>\n<li>list ${marker} one</li>`);
  expect(html).not.toContain(`**Bold ${marker}**`);
  expect(html).not.toContain(`- list ${marker} one`);
}

/** A shell script, which must stay byte-for-byte source text. */
const SCRIPT_BODY = '#!/bin/bash\n# Deploy **the** key\n- not a list\necho "ok"\n';

/**
 * A HAR blob. Its `comment` field holds markdown syntax that must survive: a HAR
 * is a machine artifact, and rewriting its bytes would make the document disagree
 * with the file shipped in `supporting-files/` (and with its SHA-256).
 */
const HAR_BODY = '{"log":{"comment":"**not bold** and - not a list","entries":[]}}';

/**
 * One engagement in which every markdown-authored field, and every deliberately
 * verbatim one, carries markdown syntax:
 *
 * | surface                                   | marker / literal        |
 * | ----------------------------------------- | ----------------------- |
 * | evidence description (timeline item)      | `tl`                    |
 * | strength description (Summary of Strengths)| `st`                   |
 * | recommendation description                | `rc`                    |
 * | scope target description                  | `tg`                    |
 * | evidence caption (from the description)   | `cap`                   |
 * | attack-path step caption                  | `step`                  |
 * | evidence caption (from the title)         | stays source text       |
 * | objectives narrative                      | printed nowhere at all  |
 * | script body / HAR body                    | stay source text        |
 * | engagement + client name, watermark, every title | stay source text |
 */
async function setup() {
  const users = await seedUsers(app);
  const eng = await app.db.engagement.create({
    data: {
      slug: 'op1',
      // Verbatim: the cover title, the <title>, the TOC and the running header all
      // quote these, and the header goes into a CSS content: declaration.
      name: 'Op **One**',
      clientName: 'Acme **Co**',
      // Printed nowhere: no report has ever carried the objectives narrative, so
      // widening markdown must not be what starts printing it.
      objectivesNarrative: md('obj'),
      watermarkEnabled: true,
      watermarkText: 'Draft **Only**',
      strategicRecommendations: [
        { title: 'Rotate **keys**', description: md('rc'), findingUuids: [] },
      ],
      roles: { create: [{ userId: users.writer.id, role: 'write' }] },
    },
  });

  const target = await app.db.engagementTarget.create({
    data: { engagementId: eng.id, name: 'Gateway', description: md('tg'), position: 0 },
  });
  const activity = await app.db.targetActivity.create({
    data: { targetId: target.id, name: 'UDS', position: 0 },
  });
  await app.db.activityGoal.create({
    data: { activityId: activity.id, title: 'Boot integrity', position: 0 },
  });

  await app.db.finding.create({
    data: {
      engagementId: eng.id,
      kind: 'strength',
      title: 'Strength **title**',
      // Trailing raw HTML: the shared renderer sets `html: false`, so widening
      // markdown here cannot widen injection — it must come out escaped.
      description: `${md('st')}\n\n<img src=x onerror="alert(1)">`,
      readyToReport: true,
      position: 0,
    },
  });
  const weakness = await app.db.finding.create({
    data: {
      engagementId: eng.id,
      title: 'Weak **TLS**',
      description: 'The fleet API still negotiates 3DES.',
      severity: 'high',
      readyToReport: true,
      position: 1,
    },
  });

  const makeEvidence = async (data: {
    title: string;
    description: string;
    contentType: string;
    contentSubtype?: string;
    body: string;
  }) => {
    const blobKey = `blobs/${data.contentType}-${data.title || 'untitled'}`;
    await app.blobs.put(blobKey, Buffer.from(data.body));
    return app.db.evidence.create({
      data: {
        engagementId: eng.id,
        operatorId: users.writer.id,
        contentType: data.contentType,
        contentSubtype: data.contentSubtype ?? null,
        title: data.title,
        description: data.description,
        occurredAt: new Date('2026-03-01T09:00:00.000Z'),
        fullBlobKey: blobKey,
        sha256: 'a'.repeat(64),
        sizeBytes: Buffer.byteLength(data.body),
      },
    });
  };

  // Attached to the weakness with no title of its own, so its caption is built
  // from the description — the title-or-description caption under test.
  const captioned = await makeEvidence({
    title: '',
    description: md('cap'),
    contentType: 'none',
    body: 'A plain note body.',
  });
  // Titled and described: the title heads the timeline item verbatim, the
  // description is the markdown body under it.
  await makeEvidence({
    title: 'Capture **title**',
    description: md('tl'),
    contentType: 'none',
    body: 'Another plain note body.',
  });
  // Titled, with no description: its caption is built from the title, which is a
  // plain `<Input>` in every authoring surface and must print as typed. The text
  // is markdown on three counts — a leading `1. ` (ordered list), paired
  // underscores (emphasis) and a backtick pair — so any one of them rendering
  // fails the assertion.
  const titled = await makeEvidence({
    title: '1. Dump of _etc_shadow_ via `LFI`',
    description: '',
    contentType: 'none',
    body: 'A third plain note body.',
  });
  const script = await makeEvidence({
    title: 'Deploy script',
    description: '',
    contentType: 'script',
    contentSubtype: 'bash',
    body: SCRIPT_BODY,
  });
  await makeEvidence({
    title: 'Login exchange',
    description: '',
    contentType: 'http-request-cycle',
    body: HAR_BODY,
  });

  await app.db.evidenceFinding.createMany({
    data: [
      { evidenceId: captioned.id, findingId: weakness.id, inPath: false, position: 0 },
      { evidenceId: titled.id, findingId: weakness.id, inPath: false, position: 1 },
      {
        evidenceId: script.id,
        findingId: weakness.id,
        inPath: true,
        position: 0,
        caption: md('step'),
      },
    ],
  });

  return { users, eng, weakness };
}

/**
 * Render with every section on — Scope & Objectives Coverage ships disabled — plus
 * the whole-engagement evidence log, so all six converted surfaces and both
 * verbatim blob bodies are in one document.
 */
function render(eng: { id: number; slug: string; name: string }, userId: number): Promise<string> {
  const sections: ReportSectionEntry[] = DEFAULT_REPORT_SECTIONS.map((s) =>
    s.key === 'scopeCoverage' ? { ...s, enabled: true } : s,
  );
  return buildReportHtml(
    app,
    eng,
    GENERATED_AT,
    { includeAll: true, includeTimeline: true, sections, customSections: [] },
    userId,
  );
}

/** The body of a single CSS rule in the embedded stylesheet. */
function cssRule(html: string, selector: string): string {
  const m = html.match(new RegExp(`\\n${selector.replace(/\./g, '\\.')} \\{([^}]*)\\}`));
  expect(m, `no CSS rule for ${selector}`).not.toBeNull();
  return m![1]!;
}

describe('markdown-authored report fields render as markdown', () => {
  it("renders an evidence item's description in the evidence log", async () => {
    const { users, eng } = await setup();
    const html = await render(eng, users.writer.id);

    // A <div>, not a <p>: the renderer emits a block element, which would close a
    // <p class="tl-desc"> and orphan the class.
    expect(html).toContain('<div class="tl-desc"><div class="md"><p><strong>Bold tl</strong>');
    expect(html).not.toContain('<p class="tl-desc">');
    expectRendered(html, 'tl');
  });

  it("renders a strength's description in the Summary of Strengths table", async () => {
    const { users, eng } = await setup();
    const html = await render(eng, users.writer.id);

    expect(html).toContain('<td><div class="md"><p><strong>Bold st</strong>');
    expectRendered(html, 'st');
  });

  it("renders a recommendation's description in the Strategic Recommendations table", async () => {
    const { users, eng } = await setup();
    const html = await render(eng, users.writer.id);

    expect(html).toContain('<td><div class="md"><p><strong>Bold rc</strong>');
    expectRendered(html, 'rc');
  });

  it("renders a scope target's description in Scope & Objectives Coverage", async () => {
    const { users, eng } = await setup();
    const html = await render(eng, users.writer.id);

    expect(html).toContain('<div class="pp muted"><div class="md"><p><strong>Bold tg</strong>');
    expect(html).not.toContain('<p class="pp muted"><div class="md">');
    expectRendered(html, 'tg');
  });

  it("renders the evidence caption built from the item's description", async () => {
    const { users, eng } = await setup();
    const html = await render(eng, users.writer.id);

    expect(html).toContain('<figcaption><div class="md"><p><strong>Bold cap</strong>');
    expectRendered(html, 'cap');
  });

  it('renders an attack-path step caption', async () => {
    const { users, eng } = await setup();
    const html = await render(eng, users.writer.id);

    expect(html).toContain(
      '<div class="step-caption"><div class="md"><p><strong>Bold step</strong>',
    );
    expect(html).not.toContain('<p class="step-caption">');
    expectRendered(html, 'step');
  });

  it('never wraps a rendered block in a <p>, anywhere', async () => {
    const { users, eng } = await setup();
    const html = await render(eng, users.writer.id);

    // The whole class of bug: a <p class="…"> holding the renderer's <div> is
    // closed by the parser at the <div>, orphaning the class it was carrying.
    expect(html).not.toMatch(/<p class="[^"]*"><div class="md">/);
  });

  it('keeps raw HTML in a widened field escaped', async () => {
    const { users, eng } = await setup();
    const html = await render(eng, users.writer.id);

    // `html: false` in the shared markdown config, asserted on the output: the
    // strength description's trailing tag arrives as text.
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    expect(html).not.toContain('<img src=x');
  });

  it('lets nested markdown inherit its host’s size and colour', async () => {
    const { users, eng } = await setup();
    const html = await render(eng, users.writer.id);

    // The block `.md` style is 14.5px --fg-1 body prose; a table cell is 13.5px,
    // a timeline description 13px muted, a caption 12.5px. Without this rule the
    // converted fields jump to body size mid-table.
    expect(html).toContain('.step-caption > .md {');
    const nested = html.match(/\.step-caption > \.md \{([^}]*)\}/);
    expect(nested).not.toBeNull();
    expect(nested![1]).toContain('font-size: inherit');
    expect(nested![1]).toContain('color: inherit');
    // `breaks: true` already emits a <br> per single newline, so a host's
    // pre-wrap would double every line break. Neither converted-only class
    // declares it any more, and the nested rule undoes the one that still does.
    expect(nested![1]).toContain('white-space: normal');
    expect(cssRule(html, '.tl-desc')).not.toContain('pre-wrap');
    expect(cssRule(html, '.step-caption')).not.toContain('pre-wrap');
  });

  it('keeps a two-paragraph caption on two lines', async () => {
    const { users, eng } = await setup();
    const html = await render(eng, users.writer.id);

    // A one-paragraph caption is flowed inline so the language chip stays on its
    // line; a *second* paragraph goes back to being a block, or the blank line the
    // author typed is silently swallowed into one run-on caption.
    expect(cssRule(html, 'figcaption > .md, figcaption > .md > p')).toContain('display: inline');
    expect(cssRule(html, 'figcaption > .md > p \\+ p')).toContain('display: block');
  });
});

describe('deliberately verbatim report text', () => {
  it('leaves a script body as source text', async () => {
    const { users, eng } = await setup();
    const html = await render(eng, users.writer.id);

    // The sharp case the script type exists for: a `#` comment is a heading to the
    // renderer, and `- not a list` is a list — both must stay as typed.
    expect(html).toContain(
      '<pre class="ev-code">#!/bin/bash\n# Deploy **the** key\n- not a list\necho &quot;ok&quot;',
    );
    expect(html).not.toContain('<strong>the</strong>');
    expect(html).not.toContain('<h1>Deploy');
    expect(html).not.toContain('<li>not a list</li>');
  });

  it('leaves a HAR body as source text', async () => {
    const { users, eng } = await setup();
    const html = await render(eng, users.writer.id);

    expect(html).toContain(
      '<pre class="ev-code">{&quot;log&quot;:{&quot;comment&quot;:&quot;**not bold** and - not a list&quot;',
    );
    expect(html).not.toContain('<strong>not bold</strong>');
  });

  it('leaves the cover, the <title>, the running header and the watermark as source text', async () => {
    const { users, eng } = await setup();
    const html = await render(eng, users.writer.id);

    expect(html).toContain('<title>Op **One** — Findings Report</title>');
    expect(html).toContain('<h1 class="cover-title">Op **One**</h1>');
    expect(html).toContain('<p class="cover-sub">Acme **Co**</p>');
    // The running header is a CSS content: declaration — markup there would print
    // as literal text in every page margin.
    expect(html).toContain('content: "ACME **CO** — CONFIDENTIAL"');
    expect(html).toContain('<div class="watermark" aria-hidden="true">Draft **Only**</div>');
  });

  it('leaves every title and the TOC as source text', async () => {
    const { users, eng } = await setup();
    const html = await render(eng, users.writer.id);

    // A title is plain in the app too — it has no markdown editor behind it — so
    // none of these five quoting sites renders one.
    expect(html).toContain('<span class="finding-title">Weak **TLS**</span>');
    expect(html).toContain('<td class="title">Strength **title**</td>');
    expect(html).toContain('<td class="title">Rotate **keys**</td>');
    expect(html).toContain('<p class="tl-title">Capture **title**</p>');
    expect(html).toContain('<span class="toc-t">Weak **TLS**</span>');
    expect(html).not.toContain('<strong>TLS</strong>');
    expect(html).not.toContain('<strong>title</strong>');
    expect(html).not.toContain('<strong>keys</strong>');
  });

  it('leaves an evidence title verbatim when the title is the figure caption', async () => {
    const { users, eng } = await setup();
    const html = await render(eng, users.writer.id);

    // The caption is title-first, so for almost every attached figure the string
    // reaching the <figcaption> is the title — which the timeline prints verbatim
    // two sections earlier. Rendering it here would have the same evidence item
    // captioned two different ways in one document, and a title opening `1. `
    // would put a list (or, for `# `, a 20px <h1>) inside the caption, breaking
    // the inline flow the language chip depends on.
    expect(html).toContain('<figcaption>1. Dump of _etc_shadow_ via `LFI`</figcaption>');
    expect(html).toContain('<p class="tl-title">1. Dump of _etc_shadow_ via `LFI`</p>');
    expect(html).not.toContain('<em>etc_shadow</em>');
    expect(html).not.toContain('<code>LFI</code>');
    expect(html).not.toContain('<ol>');
  });

  it('prints the objectives narrative nowhere', async () => {
    const { users, eng } = await setup();
    const html = await render(eng, users.writer.id);

    // No report has ever carried `objectivesNarrative`; the Goals tab's hint
    // promising it is an unkept promise that needs its own opt-in flag, not a
    // paragraph that appears on every existing deliverable's next re-generation.
    expect(html).not.toContain('Bold obj');
    expect(html).not.toContain('list obj one');
  });

  it('puts no rendered markup in an image alt attribute', async () => {
    const { users, eng, weakness } = await setup();
    // A screenshot whose description becomes its caption: the caption is rendered
    // for the figcaption, but `alt` has to take the plain text — markup in an
    // attribute is read out as its own tags rather than as prose.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAABP0UbmAAAAEklEQVR42mP8z8DwnwEIGAEAFAwBAVf8xJIAAAAASUVORK5CYII=',
      'base64',
    );
    await app.blobs.put('blobs/shot', png);
    const shot = await app.db.evidence.create({
      data: {
        engagementId: eng.id,
        operatorId: users.writer.id,
        contentType: 'image',
        title: '',
        description: md('shot'),
        occurredAt: new Date('2026-03-02T09:00:00.000Z'),
        fullBlobKey: 'blobs/shot',
      },
    });
    // Attached to the weakness: the evidence log deliberately blanks an embedded
    // body's title/description (they head the item instead), so a finding's
    // attached evidence is where a caption of the author's own words renders.
    await app.db.evidenceFinding.create({
      data: { evidenceId: shot.id, findingId: weakness.id, inPath: false, position: 2 },
    });

    const html = await render(eng, users.writer.id);
    expect(html).toContain('alt="**Bold shot** with `code_shot()`');
    expect(html).not.toMatch(/alt="[^"]*<strong>/);
    // …while the visible caption beside it is still rendered.
    expect(html).toContain('<figcaption><div class="md"><p><strong>Bold shot</strong>');
  });
});
