import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  DEFAULT_REPORT_SECTIONS,
  reportPresetSections,
  type ReportSectionEntry,
} from '@reporter/shared';
import { WEB_HEADERS, buildTestApp, loginCookie, seedUsers, truncateAll } from './helpers.js';
import { buildReportHtml, type ReportOptions } from '../src/services/findings-report.js';

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

/** A fixed generation time, so two renders of the same config compare byte-for-byte. */
const GENERATED_AT = new Date('2026-03-04T12:00:00.000Z');

/**
 * One engagement with three tags, applied to findings only — never to evidence —
 * so every occurrence of a tag name in the rendered document is unambiguously a
 * finding's chip.
 *
 * The three tags are built so that **insertion order, name order and curated
 * order all disagree**: `can-bus` is inserted first but holds position 1,
 * `zeta-probe` is inserted second but holds position 0, and `_lateral_ move & <b>`
 * is last in both. Alphabetically the underscore sorts first, so name order is
 * lateral → can-bus → zeta; id order is can-bus → zeta → lateral; and the curated
 * order the chips must follow is zeta → can-bus → lateral. A renderer that orders
 * by any of the other two comes out in a different sequence than the one asserted.
 *
 * The third tag is sharp twice over. Its name carries markdown emphasis and raw
 * markup — a tag name is a verbatim label that must go through `esc()` and never
 * `prose()` — and its `colorName` is off the palette. `createTagInput` rejects an
 * off-palette name today, but the column is a plain string and rows written before
 * that constraint (or imported from a file) can still hold one, so it is written
 * straight to the table: the chip has to degrade to the slate swatch rather than
 * print an empty `background`.
 *
 * Findings: `w1` is the report-ready weakness carrying all three tags, with one
 * attached evidence item so the card is realistic; `w2` is ready and carries none;
 * `s1` is a strength carrying `can-bus` alone.
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

  const canBus = await app.db.tag.create({
    data: { engagementId: eng.id, name: 'can-bus', colorName: 'red', position: 1 },
  });
  const zeta = await app.db.tag.create({
    data: { engagementId: eng.id, name: 'zeta-probe', colorName: 'blue', position: 0 },
  });
  const lateral = await app.db.tag.create({
    data: {
      engagementId: eng.id,
      name: '_lateral_ move & <b>',
      colorName: 'chartreuse',
      position: 2,
    },
  });

  const w1 = await app.db.finding.create({
    data: {
      engagementId: eng.id,
      title: 'Weak TLS ciphers',
      description: 'The fleet API still negotiates 3DES.',
      impact: 'Traffic can be decrypted by a network attacker.',
      remediation: 'Restrict the cipher suite list.',
      severity: 'high',
      readyToReport: true,
      position: 0,
      // Linked in name order, so a join that returns rows in insertion order is
      // also wrong.
      tags: { create: [{ tagId: lateral.id }, { tagId: canBus.id }, { tagId: zeta.id }] },
    },
  });
  const w2 = await app.db.finding.create({
    data: {
      engagementId: eng.id,
      title: 'Verbose error pages',
      description: 'Stack traces reach the client.',
      severity: 'low',
      readyToReport: true,
      position: 1,
    },
  });
  const s1 = await app.db.finding.create({
    data: {
      engagementId: eng.id,
      kind: 'strength',
      title: 'Secure boot chain enforced',
      description: 'Every stage verifies the next before handing over control.',
      readyToReport: true,
      position: 2,
      tags: { create: [{ tagId: canBus.id }] },
    },
  });

  const blobKey = 'notes/cipher-scan-output';
  await app.blobs.put(blobKey, Buffer.from('ssl-enum-ciphers still offers 3DES.'));
  const ev = await app.db.evidence.create({
    data: {
      engagementId: eng.id,
      operatorId: users.writer.id,
      contentType: 'none',
      title: 'Cipher scan output',
      description: '',
      occurredAt: new Date('2026-03-01T09:00:00.000Z'),
      fullBlobKey: blobKey,
    },
  });
  await app.db.evidenceFinding.create({
    data: { evidenceId: ev.id, findingId: w1.id, inPath: false, caption: '', position: 0 },
  });

  const cookie = await loginCookie(app, 'writer@test.local', 'password123');
  return { users, eng, cookie, tags: { canBus, zeta, lateral }, w1, w2, s1 };
}

/**
 * Render a section-configured report, optionally with a Detailed Findings
 * `options` map and the strength-cards flag. Passing neither leaves the section
 * with no `options` map at all — the shape every engagement configured before the
 * `tags` sub-item existed has on disk.
 */
function render(
  eng: { id: number; slug: string; name: string },
  userId: number,
  opts: { options?: Record<string, boolean>; showStrengthDetailCards?: boolean } = {},
): Promise<string> {
  const sections: ReportSectionEntry[] = DEFAULT_REPORT_SECTIONS.map((s) =>
    s.key === 'detailedFindings' && opts.options ? { ...s, options: opts.options } : s,
  );
  const reportOptions: ReportOptions = {
    sections,
    customSections: [],
    showStrengthDetailCards: opts.showStrengthDetailCards,
  };
  return buildReportHtml(app, eng, GENERATED_AT, reportOptions, userId);
}

/**
 * The chip row's opening tag, matched as markup rather than as the bare class
 * name: the report's stylesheet declares `.finding-tags`, so an absence test on
 * the bare word would never be satisfiable, and one on this exact string cannot
 * be satisfied by the stylesheet.
 */
const TAGS_BLOCK = '<div class="finding-tags">';

/** The exact chip the red palette entry produces for `can-bus`. */
const CAN_BUS_CHIP = '<span class="chip" style="background:#e05252;color:#ffffff">can-bus</span>';

/** The inner HTML of the `<div class="finding">` card numbered `label` (W1, S1, …). */
function cardFor(html: string, label: string): string {
  const re = new RegExp(
    `<div class="finding">\\s*<div class="finding-head">\\s*<span class="finding-num">${label}</span>(.*?)\\n {4}</div>`,
    's',
  );
  const m = html.match(re);
  expect(m, `no ${label} card in the report`).not.toBeNull();
  return m![1]!;
}

/** The chip labels inside a card's tag row, in document order. */
function chipNames(card: string): string[] {
  const row = card.match(/<div class="finding-tags">(.*?)<\/div>/s);
  if (!row) return [];
  return [...row[1]!.matchAll(/<span class="chip"[^>]*>(.*?)<\/span>/g)].map((m) => m[1]!);
}

describe("a finding's tags in Detailed Findings", () => {
  it('prints the chips directly under the meta line, with no options map at all', async () => {
    const { users, eng } = await setup();
    const html = await render(eng, users.writer.id);
    const card = cardFor(html, 'W1');

    // Placement is part of the contract: after the meta paragraph is closed and
    // outside it (a div inside a `<p>` closes the paragraph early and orphans its
    // class), before Description. Exact adjacency, so no whitespace crept in
    // between either.
    expect(card).toContain(`</p>${TAGS_BLOCK}`);
    expect(card.indexOf(TAGS_BLOCK)).toBeLessThan(card.indexOf('<h4 class="sub">Description</h4>'));
    // The chip's swatch comes from the shared palette, not a local copy of it.
    expect(card).toContain(CAN_BUS_CHIP);
  });

  it("follows the engagement's curated tag order, and follows a reorder", async () => {
    const { users, eng, cookie, tags } = await setup();
    const before = await render(eng, users.writer.id);
    // Position order — not id order (can-bus first) and not name order (lateral
    // first). See the fixture comment.
    expect(chipNames(cardFor(before, 'W1'))).toEqual([
      'zeta-probe',
      'can-bus',
      '_lateral_ move &amp; &lt;b&gt;',
    ]);

    // The same reorder the Settings → Tags drag handle sends; the chips on the
    // next render must follow it, with nothing else about the card changing.
    const res = await app.inject({
      method: 'PATCH',
      url: '/web/engagements/op1/tags/reorder',
      headers: { ...WEB_HEADERS, cookie },
      payload: { orderedIds: [tags.canBus.id, tags.lateral.id, tags.zeta.id] },
    });
    expect(res.statusCode).toBe(200);

    const after = await render(eng, users.writer.id);
    expect(chipNames(cardFor(after, 'W1'))).toEqual([
      'can-bus',
      '_lateral_ move &amp; &lt;b&gt;',
      'zeta-probe',
    ]);
  });

  it('prints a tag name verbatim — escaped, never rendered as markdown', async () => {
    const { users, eng } = await setup();
    const html = await render(eng, users.writer.id);
    const row = cardFor(html, 'W1').match(/<div class="finding-tags">(.*?)<\/div>/s)![1]!;

    expect(row).toContain('_lateral_ move &amp; &lt;b&gt;');
    // Neither the markdown emphasis nor the raw markup reaches the document, and
    // no `prose()` wrapper does either — its block output would break the row.
    expect(row).not.toContain('<em>');
    expect(row).not.toContain('<b>');
    expect(row).not.toContain('<div class="md">');
  });

  it('falls back to the slate swatch for a color name outside the palette', async () => {
    const { users, eng } = await setup();
    const html = await render(eng, users.writer.id);

    expect(cardFor(html, 'W1')).toContain(
      '<span class="chip" style="background:#5b6472;color:#ffffff">_lateral_ move &amp; &lt;b&gt;</span>',
    );
  });

  it('emits nothing — not even the wrapper — for a finding with no tags', async () => {
    const { users, eng } = await setup();
    const html = await render(eng, users.writer.id);
    const card = cardFor(html, 'W2');

    // No empty row (a stray margin in the PDF), and no "No tags" — a deliverable
    // does not assert an absence, the same rule the evidence and goals blocks keep.
    expect(card).not.toContain(TAGS_BLOCK);
    expect(card).not.toContain('class="chip"');
    expect(html).not.toContain('No tags');
    expect(card).toContain('<span class="finding-title">Verbose error pages</span>');
  });

  it("tags a strength's card too, without reviving the fields a strength drops", async () => {
    const { users, eng } = await setup();
    const html = await render(eng, users.writer.id, { showStrengthDetailCards: true });
    const card = cardFor(html, 'S1');

    // A tag is kind-neutral: no `isStrength` guard belongs on the chip row…
    expect(card).toContain(CAN_BUS_CHIP);
    expect(chipNames(card)).toEqual(['can-bus']);
    // …and the strength card is otherwise what report-strengths.itest.ts pins.
    expect(card).not.toContain('<h4 class="sub">Impact</h4>');
    expect(card).not.toContain('class="pill pill-sev-');
  });

  it('drops the chips, and only the chips, when the Tags sub-item is off', async () => {
    const { users, eng } = await setup();
    const html = await render(eng, users.writer.id, { options: { tags: false } });

    expect(html).not.toContain(TAGS_BLOCK);
    expect(html).not.toContain('can-bus');
    expect(html).not.toContain('zeta-probe');
    // The card itself, its description and its evidence are untouched.
    const card = cardFor(html, 'W1');
    expect(card).toContain('<span class="finding-title">Weak TLS ciphers</span>');
    expect(card).toContain('<h4 class="sub">Description</h4>');
    expect(card).toContain('<h4 class="sub">Attached Evidence (1)</h4>');
  });
});

describe('backward compatibility of the rendered bytes', () => {
  it('leaves an untagged engagement byte-identical to the report it rendered before', async () => {
    const { users, eng } = await setup();
    await app.db.findingTag.deleteMany({});

    const absent = await render(eng, users.writer.id);
    const off = await render(eng, users.writer.id, { options: { tags: false } });
    expect(absent).toBe(off);
    expect(absent).not.toContain(TAGS_BLOCK);
    // The literal byte sequence the renderer emits between the meta line and the
    // Description heading. This is the real assertion: it fails if the chip row
    // was given its own template line and left a blank-but-indented line behind
    // in every card of every report.
    expect(absent).toContain('</p>\n      <h4 class="sub">Description</h4>');
  });

  it("turning the toggle off restores today's exact output", async () => {
    const { users, eng } = await setup();
    const off = await render(eng, users.writer.id, { options: { tags: false } });

    await app.db.findingTag.deleteMany({});
    const untagged = await render(eng, users.writer.id);
    // "Tagged but suppressed" and "no tags at all" are the same bytes: nothing
    // else in the report reads the join, and the generation time is fixed.
    expect(off).toBe(untagged);
  });

  it('leaves a configuration with no options map byte-identical to one that opts every item in', async () => {
    const { users, eng } = await setup();
    const absent = await render(eng, users.writer.id);
    const explicit = await render(eng, users.writer.id, {
      options: {
        tags: true,
        impact: true,
        standards: true,
        remediation: true,
        recommendations: true,
        attackPath: true,
        attachedEvidence: true,
      },
    });
    expect(absent).toBe(explicit);
  });
});

/*
 * A built-in report type fixes the section list, not what each section shows: the
 * engagement's sub-item choices ride along via `reportPresetSections`. That
 * carry-over was missing once, and an author who had turned script bodies off got
 * them printed in full by picking "Full report" from the dropdown. The chips are a
 * much smaller disclosure than a script body, but it is the same path.
 */
describe('the Tags sub-item survives the built-in report types', () => {
  const configured = DEFAULT_REPORT_SECTIONS.map((s) =>
    s.key === 'detailedFindings' ? { ...s, options: { tags: false } } : s,
  );

  it.each(['full', 'executive', 'findings'] as const)(
    'keeps the chips off under the %s preset',
    async (preset) => {
      const { users, eng } = await setup();
      const html = await buildReportHtml(
        app,
        eng,
        GENERATED_AT,
        { sections: reportPresetSections(preset, configured), customSections: [] },
        users.writer.id,
      );
      // Either the preset has no Detailed Findings section, or it does and the
      // engagement's choice stayed in force. Both are "no chips".
      expect(html).not.toContain(TAGS_BLOCK);
      expect(html).not.toContain('can-bus');
    },
  );

  it('still prints the chips under a preset when the engagement never turned them off', async () => {
    const { users, eng } = await setup();
    const html = await buildReportHtml(
      app,
      eng,
      GENERATED_AT,
      { sections: reportPresetSections('full', DEFAULT_REPORT_SECTIONS), customSections: [] },
      users.writer.id,
    );
    // The carry-over is a carry-over, not a blanket suppression.
    expect(cardFor(html, 'W1')).toContain(CAN_BUS_CHIP);
  });
});

describe('a configuration saved before the key existed', () => {
  it('renders the chips through the real route (default ON)', async () => {
    const { eng, cookie } = await setup();
    // A stored config with no `options` map anywhere: the key is absent, which the
    // renderer reads as on. This engagement gains the chips in its next report —
    // the accepted behaviour change for an opt-out sub-item.
    await app.db.engagement.update({
      where: { id: eng.id },
      data: {
        reportConfig: {
          sections: DEFAULT_REPORT_SECTIONS,
          findingGroup: 'severity',
          readinessNa: ['watermark'],
        },
      },
    });

    // The section preview composes options exactly as the PDF/ZIP/JSON routes do
    // (`reportOptionsFromConfig`), without needing headless Chromium.
    const res = await app.inject({
      method: 'GET',
      url: '/web/engagements/op1/report/section-preview.html?section=detailedFindings',
      headers: { ...WEB_HEADERS, cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(cardFor(res.body, 'W1')).toContain(CAN_BUS_CHIP);
  });
});
