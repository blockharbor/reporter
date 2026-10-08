import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_REPORT_SECTIONS, type ReportSectionEntry } from '@reporter/shared';
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
 * One engagement with two strengths and one weakness.
 *
 * `S1` ("Secure boot chain enforced") is the fully-furnished strength: a
 * description, an affected target, a category, a standards mapping, one attached
 * evidence item, one attack-path evidence item, and two linked goals.
 *
 * `S2` is the sharp one. It is written straight through Prisma with a severity, a
 * CVSS vector/score, a fix effort, an impact and a remediation — values the
 * create/update routes clear on a strength. No route can produce this row today,
 * but a row written before that clearing existed can hold exactly this, and it is
 * the only way to prove the card drops those fields *by kind* rather than by
 * happening to find them empty.
 *
 * The goal tree is built with position order against insertion order (the Fleet
 * target is created first but sorts second) so the goals line can only come out
 * in the asserted sequence if it is ordered the way `fetchFindingGoals` orders it.
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
  const category = await app.db.findingCategory.create({
    data: { engagementId: eng.id, category: 'Secure boot' },
  });

  const fleet = await app.db.engagementTarget.create({
    data: { engagementId: eng.id, name: 'Fleet API', description: '', position: 1 },
  });
  const gateway = await app.db.engagementTarget.create({
    data: { engagementId: eng.id, name: 'Gateway', description: '', position: 0 },
  });
  const rest = await app.db.targetActivity.create({
    data: { targetId: fleet.id, name: 'REST API', position: 0 },
  });
  const uds = await app.db.targetActivity.create({
    data: { targetId: gateway.id, name: 'UDS', position: 0 },
  });
  const authGoal = await app.db.activityGoal.create({
    data: { activityId: rest.id, title: 'Authentication', position: 0 },
  });
  const bootGoal = await app.db.activityGoal.create({
    data: { activityId: uds.id, title: 'Boot integrity', position: 0 },
  });

  const strength = await app.db.finding.create({
    data: {
      engagementId: eng.id,
      categoryId: category.id,
      kind: 'strength',
      title: 'Secure boot chain enforced',
      description: 'Every stage verifies the next before handing over control.',
      affectedTarget: 'Gateway ECU',
      iso21434Refs: ['iso-15-01'],
      readyToReport: true,
      position: 0,
    },
  });
  const staleStrength = await app.db.finding.create({
    data: {
      engagementId: eng.id,
      kind: 'strength',
      title: 'Hardened debug interfaces',
      description: 'JTAG and the OBD debug pins are fused shut on production units.',
      // Weakness-only values a strength is not supposed to carry — see the
      // function comment. Every one of them must stay off the card.
      severity: 'high',
      cvssVector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
      cvssScore: 8.8,
      fixEffort: 'high',
      impact: 'Leftover impact text from when this was filed as a weakness.',
      remediation: 'Leftover remediation text from when this was filed as a weakness.',
      readyToReport: true,
      position: 1,
    },
  });
  const weakness = await app.db.finding.create({
    data: {
      engagementId: eng.id,
      title: 'Weak TLS ciphers',
      description: 'The fleet API still negotiates 3DES.',
      impact: 'Traffic can be decrypted by a network attacker.',
      remediation: 'Restrict the cipher suite list.',
      severity: 'high',
      fixEffort: 'low',
      readyToReport: true,
      position: 2,
    },
  });

  // Scrambled link order: the Fleet goal is linked first but must print second.
  await app.db.goalFinding.createMany({
    data: [
      { goalId: authGoal.id, findingId: strength.id },
      { goalId: bootGoal.id, findingId: strength.id },
      { goalId: authGoal.id, findingId: weakness.id },
    ],
  });

  const makeEvidence = async (title: string, body: string, inPath: boolean) => {
    const blobKey = `notes/${title.replace(/\s+/g, '-').toLowerCase()}`;
    await app.blobs.put(blobKey, Buffer.from(body));
    const ev = await app.db.evidence.create({
      data: {
        engagementId: eng.id,
        operatorId: users.writer.id,
        contentType: 'none',
        title,
        description: '',
        occurredAt: new Date('2026-03-01T09:00:00.000Z'),
        fullBlobKey: blobKey,
      },
    });
    await app.db.evidenceFinding.create({
      data: {
        evidenceId: ev.id,
        findingId: strength.id,
        inPath,
        caption: inPath ? 'A step that should never print on a strength.' : '',
        position: 0,
      },
    });
    return ev;
  };
  await makeEvidence('Boot log transcript', 'Verified stage 2 signature.', false);
  await makeEvidence('Fuse map readout', 'All debug fuses blown.', true);

  const cookie = await loginCookie(app, 'writer@test.local', 'password123');
  return { users, eng, cookie, strength, staleStrength, weakness };
}

/**
 * Render a section-configured report, optionally flipping the new flag or the
 * Assessment Findings sub-items. Passing neither leaves the section with no
 * `options` map and the flag unset — the shape every engagement configured before
 * this feature has on disk.
 */
function render(
  eng: { id: number; slug: string; name: string },
  userId: number,
  opts: { showStrengthDetailCards?: boolean; options?: Record<string, boolean> } = {},
): Promise<string> {
  const sections: ReportSectionEntry[] = DEFAULT_REPORT_SECTIONS.map((s) =>
    s.key === 'assessmentFindings' && opts.options ? { ...s, options: opts.options } : s,
  );
  const reportOptions: ReportOptions = {
    sections,
    customSections: [],
    showStrengthDetailCards: opts.showStrengthDetailCards,
  };
  return buildReportHtml(app, eng, GENERATED_AT, reportOptions, userId);
}

/**
 * The heading the strength cards render under, matched as markup rather than as
 * the bare word, so an absence test is about the rendered heading and not about
 * any occurrence of "Strengths" elsewhere in the document (the summary table's
 * own heading, a stylesheet comment, a finding title).
 */
const CARDS_HEADING = '<h3 class="block-h">Strengths <span class="group-count">(2)</span></h3>';

/** The inner HTML of each `<div class="finding">` card whose number is an S#. */
function strengthCards(html: string): string[] {
  const re =
    /<div class="finding">\s*<div class="finding-head">\s*<span class="finding-num">S\d+<\/span>(.*?)\n {4}<\/div>/gs;
  return [...html.matchAll(re)].map((m) => m[1]!);
}

describe('strength detail cards in Detailed Findings', () => {
  it('renders none at all by default, with no flag passed', async () => {
    const { users, eng } = await setup();
    const html = await render(eng, users.writer.id);

    expect(html).not.toContain(CARDS_HEADING);
    expect(strengthCards(html)).toHaveLength(0);
    // The strengths are still in the report — as rows in the summary table, which
    // is all any report has ever shown.
    expect(html).toContain('<td class="title">Secure boot chain enforced</td>');
    // …and the weakness card is untouched by the new code path.
    expect(html).toContain('<span class="finding-title">Weak TLS ciphers</span>');
  });

  it('renders one card per strength, numbered to match the summary table, when enabled', async () => {
    const { users, eng } = await setup();
    const html = await render(eng, users.writer.id, { showStrengthDetailCards: true });

    expect(html).toContain(CARDS_HEADING);
    const cards = strengthCards(html);
    expect(cards).toHaveLength(2);
    expect(cards[0]).toContain('<span class="finding-title">Secure boot chain enforced</span>');
    expect(cards[1]).toContain('<span class="finding-title">Hardened debug interfaces</span>');

    // S1/S2 mean the same finding in the table and on the cards: the table's row
    // for S1 is the first strength by author order, and so is the first card.
    const tableS1 = html.indexOf(
      '<td class="num">S1</td>\n        <td class="title">Secure boot chain enforced</td>',
    );
    expect(tableS1).toBeGreaterThan(-1);
    expect(html).toContain('<span class="finding-num">S1</span>');
    expect(html).toContain('<span class="finding-num">S2</span>');

    // The cards come after every weakness, so the W-sequence the TOC indexes is
    // never interrupted.
    expect(html.indexOf('<span class="finding-num">W1</span>')).toBeLessThan(
      html.indexOf(CARDS_HEADING),
    );
  });

  it('carries only what a strength has — no severity, impact, remediation or attack path', async () => {
    const { users, eng } = await setup();
    const html = await render(eng, users.writer.id, { showStrengthDetailCards: true });
    const cards = strengthCards(html);

    for (const card of cards) {
      // No heading with nothing under it, and no heading at all for the three
      // sub-items a strength cannot fill.
      expect(card).not.toContain('<h4 class="sub">Impact</h4>');
      expect(card).not.toContain('<h4 class="sub">Remediation</h4>');
      expect(card).not.toContain('<h4 class="sub">Attack Path');
      // No severity pill — not even the "Unrated" one a null severity would print.
      expect(card).not.toContain('class="pill pill-sev-');
      expect(card).not.toContain('Unrated');
    }

    // The stale row's weakness-only values are dropped by kind, not by emptiness:
    // every one of them is present in the database (see `setup`).
    const stale = cards[1]!;
    expect(stale).not.toContain('Leftover impact text');
    expect(stale).not.toContain('Leftover remediation text');
    expect(stale).not.toContain('<strong>CVSS:</strong>');
    expect(stale).not.toContain('CVSS:3.1/AV:N');
    expect(stale).not.toContain('<strong>Fix effort:</strong>');
    expect(stale).not.toContain('8.8');

    // What a strength does carry.
    const first = cards[0]!;
    expect(first).toContain('<strong>Category:</strong> Secure boot');
    expect(first).toContain('<strong>Affected target:</strong> Gateway ECU');
    expect(first).toContain('<h4 class="sub">Description</h4>');
    expect(first).toContain('Every stage verifies the next before handing over control.');
    expect(first).toContain('<h4 class="sub">Standards Mapping</h4>');
    expect(first).toContain('<h4 class="sub">Attached Evidence (1)</h4>');
    expect(first).toContain('<h4 class="sub">Linked Goals</h4>');
    expect(first).toContain('Boot integrity');
  });

  it('never claims a strength has no evidence just because its attack path is hidden', async () => {
    const { users, eng } = await setup();
    const html = await render(eng, users.writer.id, { showStrengthDetailCards: true });
    const cards = strengthCards(html);

    // S1 has one attached item and one attack-path item. The path bucket is not
    // printed, and its caption goes with it…
    expect(cards[0]).not.toContain('A step that should never print on a strength.');
    // …but S2, which has no evidence links at all, is the only card allowed to say
    // so, and the hidden-path card must not.
    expect(cards[0]).not.toContain('No evidence attached.');
    expect(cards[1]).toContain('No evidence attached.');
  });

  it('honours the section sub-items a strength can fill', async () => {
    const { users, eng } = await setup();
    const sections: ReportSectionEntry[] = DEFAULT_REPORT_SECTIONS.map((s) =>
      s.key === 'detailedFindings'
        ? { ...s, options: { standards: false, attachedEvidence: false } }
        : s,
    );
    const html = await buildReportHtml(
      app,
      eng,
      GENERATED_AT,
      { sections, customSections: [], showStrengthDetailCards: true },
      users.writer.id,
    );
    const first = strengthCards(html)[0]!;

    expect(first).not.toContain('<h4 class="sub">Standards Mapping</h4>');
    expect(first).not.toContain('<h4 class="sub">Attached Evidence');
    // Still a card, still the description, still the goals.
    expect(first).toContain('<h4 class="sub">Description</h4>');
    expect(first).toContain('<h4 class="sub">Linked Goals</h4>');
  });

  it('prints no per-card goal block when the report opted out of linked goals', async () => {
    const { users, eng } = await setup();
    // `showFindingLinkedGoals: false` with the strengths table's goals line still
    // on: the goals are loaded for the table, so a card must not help itself to
    // them. (This is the regression the shared map makes possible.)
    const html = await buildReportHtml(
      app,
      eng,
      GENERATED_AT,
      {
        sections: DEFAULT_REPORT_SECTIONS,
        customSections: [],
        showStrengthDetailCards: true,
        showFindingLinkedGoals: false,
      },
      users.writer.id,
    );

    expect(html).not.toContain('<h4 class="sub">Linked Goals</h4>');
    // The table's line is a different control and is still there.
    expect(html).toContain(
      '<p class="cell-goals">Linked goals: Boot integrity; Authentication</p>',
    );
  });

  it('renders through a saved configuration, for a config written before the flag existed', async () => {
    const { eng, cookie } = await setup();
    // A stored config with no `showStrengthDetailCards` key at all: the schema
    // default resolves it to off, so this engagement's report is unchanged.
    await app.db.engagement.update({
      where: { id: eng.id },
      data: { reportConfig: { sections: DEFAULT_REPORT_SECTIONS, findingGroup: 'severity' } },
    });
    const off = await app.inject({
      method: 'GET',
      url: '/web/engagements/op1/report/section-preview.html?section=detailedFindings',
      headers: { ...WEB_HEADERS, cookie },
    });
    expect(off.statusCode).toBe(200);
    expect(strengthCards(off.body)).toHaveLength(0);

    // Opting in through the saved configuration reaches the renderer: the
    // section-preview route composes options exactly as the PDF/ZIP/JSON routes do.
    await app.db.engagement.update({
      where: { id: eng.id },
      data: {
        reportConfig: {
          sections: DEFAULT_REPORT_SECTIONS,
          findingGroup: 'severity',
          showStrengthDetailCards: true,
        },
      },
    });
    const on = await app.inject({
      method: 'GET',
      url: '/web/engagements/op1/report/section-preview.html?section=detailedFindings',
      headers: { ...WEB_HEADERS, cookie },
    });
    expect(on.statusCode).toBe(200);
    expect(strengthCards(on.body)).toHaveLength(2);
  });
});

describe('linked goals on the Summary of Strengths table', () => {
  it('prints one muted line inside the description cell by default', async () => {
    const { users, eng } = await setup();
    const html = await render(eng, users.writer.id);

    // Ordered target → activity → goal position, the order `fetchFindingGoals`
    // returns and the detail card uses: Gateway (position 0) before Fleet (1).
    expect(html).toContain(
      '<p class="cell-goals">Linked goals: Boot integrity; Authentication</p>',
    );
    // Not a fourth column: the table still has its three headers.
    expect(html).toContain(
      '<thead><tr><th class="num">#</th><th>Strength</th><th>Description</th></tr></thead>',
    );
    // A strength with no linked goals prints nothing — never "No linked goals".
    expect(html).not.toContain('No linked goals');
    expect(html.match(/class="cell-goals"/g)).toHaveLength(1);
  });

  it('disappears when the strengthGoals sub-item is off', async () => {
    const { users, eng } = await setup();
    const html = await render(eng, users.writer.id, { options: { strengthGoals: false } });

    expect(html).not.toContain('class="cell-goals"');
    expect(html).not.toContain('Boot integrity');
    // Only the line goes: the row, and the rest of the table, still render.
    expect(html).toContain('<td class="title">Secure boot chain enforced</td>');
  });

  it('keeps the goals line when the strengths table is the only reader of the goals', async () => {
    const { users, eng } = await setup();
    // Detailed Findings off entirely, so the per-card block cannot be what loads
    // the goals — the table has to ask for them itself.
    const sections: ReportSectionEntry[] = DEFAULT_REPORT_SECTIONS.map((s) =>
      s.key === 'detailedFindings' ? { ...s, enabled: false } : s,
    );
    const html = await buildReportHtml(
      app,
      eng,
      GENERATED_AT,
      { sections, customSections: [] },
      users.writer.id,
    );

    expect(html).toContain(
      '<p class="cell-goals">Linked goals: Boot integrity; Authentication</p>',
    );
    expect(html).not.toContain('<h4 class="sub">Linked Goals</h4>');
  });

  it('leaves a configuration carrying neither new key byte-identical to one that states both defaults', async () => {
    const { users, eng } = await setup();
    const absent = await render(eng, users.writer.id);
    const explicit = await render(eng, users.writer.id, {
      showStrengthDetailCards: false,
      options: { strengths: true, strengthGoals: true },
    });
    // The absent-means-default convention, asserted on the bytes: every
    // engagement configured before this feature keeps the report it already had.
    expect(absent).toBe(explicit);
  });
});
