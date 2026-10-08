import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_REPORT_SECTIONS, GOAL_STATUS_LABELS } from '@reporter/shared';
import { WEB_HEADERS, buildTestApp, loginCookie, seedUsers, truncateAll } from './helpers.js';
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

/**
 * One engagement whose goal tree is built so that **position order and insertion
 * order disagree everywhere** — targets, activities and goals are each created in
 * reverse position order, and the goal→finding links are created in a third,
 * unrelated order. Anything that lists these goals by id, or by whatever the join
 * returns, comes out in a different sequence than the one asserted below.
 *
 * `W1` is the report-ready weakness the goals hang off; `W2` is ready but has no
 * goals at all; `draft` is a linked-but-not-ready finding, which is what the
 * coverage count asserts on.
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

  // Targets: created Fleet (position 1) first, so position ≠ id order. The
  // gateway's name carries an ampersand — the report has to escape it.
  const fleet = await app.db.engagementTarget.create({
    data: { engagementId: eng.id, name: 'Fleet API', description: '', position: 1 },
  });
  const gateway = await app.db.engagementTarget.create({
    data: { engagementId: eng.id, name: 'CAN & LIN Gateway', description: '', position: 0 },
  });

  const rest = await app.db.targetActivity.create({
    data: { targetId: fleet.id, name: 'REST API', position: 1 },
  });
  const mqtt = await app.db.targetActivity.create({
    data: { targetId: fleet.id, name: 'MQTT', position: 0 },
  });
  const uds = await app.db.targetActivity.create({
    data: { targetId: gateway.id, name: 'UDS', position: 0 },
  });

  // `complete` and a retest goal are both in here on purpose: neither the status
  // nor the Retest marker may reach the finding block.
  const auth = await app.db.activityGoal.create({
    data: { activityId: rest.id, title: 'Authentication', position: 1, status: 'complete' },
  });
  const crypto = await app.db.activityGoal.create({
    data: {
      activityId: rest.id,
      // Escaping: a title the author typed with markup characters in it.
      title: 'Crypto <weak> & stale',
      position: 0,
      isRetest: true,
    },
  });
  const broker = await app.db.activityGoal.create({
    data: { activityId: mqtt.id, title: 'Broker ACLs', position: 0 },
  });
  const session = await app.db.activityGoal.create({
    data: { activityId: uds.id, title: 'Session control', position: 0 },
  });

  const w1 = await app.db.finding.create({
    data: {
      engagementId: eng.id,
      title: 'Weak TLS ciphers',
      severity: 'high',
      readyToReport: true,
      position: 0,
    },
  });
  const w2 = await app.db.finding.create({
    data: {
      engagementId: eng.id,
      title: 'Verbose error pages',
      severity: 'low',
      readyToReport: true,
      position: 1,
    },
  });
  const draft = await app.db.finding.create({
    data: { engagementId: eng.id, title: 'Still being written', severity: 'critical', position: 2 },
  });

  // Scrambled link order: whatever order the rows were written in, the block has
  // to print them by target → activity → goal position.
  await app.db.goalFinding.createMany({
    data: [
      { goalId: auth.id, findingId: w1.id },
      { goalId: session.id, findingId: w1.id },
      { goalId: crypto.id, findingId: w1.id },
      { goalId: broker.id, findingId: w1.id },
      // The not-ready finding shares the Authentication goal with W1.
      { goalId: auth.id, findingId: draft.id },
    ],
  });

  const cookie = await loginCookie(app, 'writer@test.local', 'password123');
  return { users, eng, cookie, goals: { auth, crypto, broker, session }, w1, w2, draft };
}

/**
 * The block's heading, matched as markup rather than as the bare phrase, so an
 * absence test is about the rendered heading and not about any occurrence of the
 * words elsewhere in the document (prose, a stylesheet comment, a finding title).
 */
const GOALS_HEADING = '<h4 class="sub">Linked Goals</h4>';

/** The inner HTML of every "Linked Goals" list in a rendered report. */
function linkedGoalsBlocks(html: string): string[] {
  const re = /<h4 class="sub">Linked Goals<\/h4><ul class="rec-links">(.*?)<\/ul>/gs;
  return [...html.matchAll(re)].map((m) => m[1]!);
}

describe("a finding's linked goals in Detailed Findings", () => {
  it('renders the block by default, with no flag passed at all', async () => {
    const { users, eng } = await setup();
    const html = await buildReportHtml(app, eng, new Date(), {}, users.writer.id);

    const blocks = linkedGoalsBlocks(html);
    // Exactly one: W1 has goals, W2 has none, and the draft finding is not in a
    // report that only gathers "Ready to report" findings.
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain('Session control');
    expect(blocks[0]).toContain('Broker ACLs');
    expect(blocks[0]).toContain('Authentication');
  });

  it('prints the goal title over a muted Target · Activity line, escaped', async () => {
    const { users, eng } = await setup();
    const html = await buildReportHtml(app, eng, new Date(), {}, users.writer.id);
    const block = linkedGoalsBlocks(html)[0]!;

    expect(block).toContain(
      '<li>Session control<br /><span class="muted">CAN &amp; LIN Gateway · UDS</span></li>',
    );
    // Title, target name and activity name are all escaped; none of the three
    // reaches the document as markup.
    expect(block).toContain('Crypto &lt;weak&gt; &amp; stale');
    expect(block).not.toContain('<weak>');
    expect(html).not.toContain('CAN & LIN Gateway');
  });

  it('never prints the goal status or the Retest marker', async () => {
    const { users, eng } = await setup();
    const html = await buildReportHtml(app, eng, new Date(), {}, users.writer.id);
    const block = linkedGoalsBlocks(html)[0]!;

    // Workflow state is deliberately absent from a signed deliverable — see the
    // comment on the block in `renderFinding`.
    for (const label of Object.values(GOAL_STATUS_LABELS)) {
      expect(block).not.toContain(label);
    }
    expect(block).not.toContain('Retest');
  });

  it('orders the goals by target → activity → goal position', async () => {
    const { users, eng } = await setup();
    const html = await buildReportHtml(app, eng, new Date(), {}, users.writer.id);
    const block = linkedGoalsBlocks(html)[0]!;

    const at = (title: string) => {
      const i = block.indexOf(title);
      expect(i).toBeGreaterThan(-1);
      return i;
    };
    // Gateway (position 0) before Fleet; within Fleet, MQTT (0) before REST API
    // (1); within REST API, Crypto (0) before Authentication (1).
    expect(at('Session control')).toBeLessThan(at('Broker ACLs'));
    expect(at('Broker ACLs')).toBeLessThan(at('Crypto &lt;weak&gt;'));
    expect(at('Crypto &lt;weak&gt;')).toBeLessThan(at('Authentication'));
  });

  it('emits nothing — not even the heading — for a finding with no goals', async () => {
    const { users, eng, w1 } = await setup();
    await app.db.goalFinding.deleteMany({ where: { findingId: w1.id } });

    const html = await buildReportHtml(app, eng, new Date(), {}, users.writer.id);
    // No goals anywhere in the report now: the heading itself is gone, and the
    // report never asserts the absence the way the app's finding page does.
    expect(html).not.toContain(GOALS_HEADING);
    expect(html).not.toContain('Not linked to any goal');
    expect(html).toContain('Weak TLS ciphers'); // the finding still renders
  });

  it('disappears when the flag is off', async () => {
    const { users, eng } = await setup();
    const html = await buildReportHtml(
      app,
      eng,
      new Date(),
      { showFindingLinkedGoals: false },
      users.writer.id,
    );
    expect(html).not.toContain(GOALS_HEADING);
    expect(html).not.toContain('Session control');
    expect(html).toContain('Weak TLS ciphers');
  });

  it('renders for a configuration saved before the flag existed (default ON)', async () => {
    const { eng, cookie } = await setup();
    // A stored config written before `showFindingLinkedGoals` was a field: the key
    // is simply absent, which the schema default resolves to ON. This engagement
    // gains the block in its next report, by design.
    await app.db.engagement.update({
      where: { id: eng.id },
      data: {
        reportConfig: {
          sections: DEFAULT_REPORT_SECTIONS,
          findingGroup: 'severity',
          showEvidenceOperators: true,
          readinessNa: ['watermark'],
        },
      },
    });

    // The section preview renders through the same `reportOptionsFromConfig` path
    // the PDF/ZIP/JSON routes use, without needing Puppeteer.
    const res = await app.inject({
      method: 'GET',
      url: '/web/engagements/op1/report/section-preview.html?section=detailedFindings',
      headers: { ...WEB_HEADERS, cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(linkedGoalsBlocks(res.body)).toHaveLength(1);
  });
});

describe('Scope & Objectives Coverage finding count', () => {
  it('counts only findings the report includes, while the Goals page keeps the total', async () => {
    const { users, eng, cookie } = await setup();

    // The coverage section ships disabled, so turn it on for this report.
    const sections = DEFAULT_REPORT_SECTIONS.map((s) =>
      s.key === 'scopeCoverage' ? { ...s, enabled: true } : s,
    );
    const html = await buildReportHtml(app, eng, new Date(), { sections }, users.writer.id);

    // The Authentication goal carries two findings, one of them not ready to
    // report: counting it would point the reader at a finding that appears nowhere
    // in the document. "Findings / Evidence" therefore reads 1 / 0.
    expect(html).toContain('<td>Authentication</td>');
    expect(html).toContain('<td class="num">1 / 0</td>');
    expect(html).not.toContain('<td class="num">2 / 0</td>');
    expect(html).not.toContain('Still being written');

    // The interactive Goals page still shows the true total — it is where an
    // author goes to see what is outstanding.
    const tree = await app
      .inject({
        method: 'GET',
        url: '/web/engagements/op1/goals',
        headers: { ...WEB_HEADERS, cookie },
      })
      .then((r) => r.json());
    const fleet = tree.targets.find((t: { name: string }) => t.name === 'Fleet API');
    const rest = fleet.activities.find((a: { name: string }) => a.name === 'REST API');
    const auth = rest.goals.find((g: { title: string }) => g.title === 'Authentication');
    expect(auth.numFindings).toBe(2);
  });

  it('counts every linked finding when the report itself includes every finding', async () => {
    const { users, eng } = await setup();
    const sections = DEFAULT_REPORT_SECTIONS.map((s) =>
      s.key === 'scopeCoverage' ? { ...s, enabled: true } : s,
    );
    // `includeAll` is the option that drops the "Ready to report" filter from the
    // gathered findings, so the tally has to drop it too: a coverage table that
    // omitted a finding printed two sections below would be the same defect in the
    // other direction.
    const html = await buildReportHtml(
      app,
      eng,
      new Date(),
      { sections, includeAll: true },
      users.writer.id,
    );

    expect(html).toContain('Still being written'); // the not-ready finding is printed
    expect(html).toContain('<td>Authentication</td>');
    // Authentication is the only goal with two links; the other three carry just
    // W1, so "1 / 0" legitimately appears elsewhere in the table.
    expect(html).toContain('<td class="num">2 / 0</td>');
  });
});

describe('cross-engagement goal links', () => {
  it('never prints a goal that belongs to another engagement', async () => {
    const { users, eng, w1 } = await setup();

    // A goal tree in a *different* engagement. The link routes can't create a row
    // like the one below (they resolve the goal through the engagement first), so
    // write it straight to the table: the composite key permits it, and this query
    // feeds a signed deliverable, so it is the one that must not take it on trust.
    const other = await app.db.engagement.create({ data: { slug: 'op2', name: 'Op Two' } });
    const otherTarget = await app.db.engagementTarget.create({
      data: { engagementId: other.id, name: 'Other Target', description: '', position: 0 },
    });
    const otherActivity = await app.db.targetActivity.create({
      data: { targetId: otherTarget.id, name: 'Other Activity', position: 0 },
    });
    const otherGoal = await app.db.activityGoal.create({
      data: { activityId: otherActivity.id, title: 'Goal of another engagement', position: 0 },
    });
    await app.db.goalFinding.create({ data: { goalId: otherGoal.id, findingId: w1.id } });

    const html = await buildReportHtml(app, eng, new Date(), {}, users.writer.id);
    const block = linkedGoalsBlocks(html)[0]!;
    expect(block).toContain('Session control'); // this engagement's goals still print
    expect(block).not.toContain('Goal of another engagement');
    expect(block).not.toContain('Other Target');
    expect(html).not.toContain('Goal of another engagement');
  });
});

describe('the finding page and the report list one finding’s goals in the same order', () => {
  /** Titles as the `for-*` routes return them — raw, not HTML-escaped. */
  const EXPECTED = ['Session control', 'Broker ACLs', 'Crypto <weak> & stale', 'Authentication'];

  it('orders the finding detail view by target → activity → goal position', async () => {
    const { cookie, w1 } = await setup();
    const linked = await app
      .inject({
        method: 'GET',
        url: `/web/engagements/op1/goals/for-finding/${w1.uuid}`,
        headers: { ...WEB_HEADERS, cookie },
      })
      .then((r) => r.json());
    expect(linked.map((g: { title: string }) => g.title)).toEqual(EXPECTED);
  });

  it('orders the evidence detail view the same way', async () => {
    const { cookie, eng, goals } = await setup();
    const ev = await app.db.evidence.create({
      data: {
        engagementId: eng.id,
        title: 'Capture',
        contentType: 'note',
        occurredAt: new Date(),
      },
    });
    // Linked in a scrambled order, like the finding links in `setup`.
    await app.db.goalEvidence.createMany({
      data: [goals.auth, goals.session, goals.crypto, goals.broker].map((g) => ({
        goalId: g.id,
        evidenceId: ev.id,
      })),
    });

    const linked = await app
      .inject({
        method: 'GET',
        url: `/web/engagements/op1/goals/for-evidence/${ev.uuid}`,
        headers: { ...WEB_HEADERS, cookie },
      })
      .then((r) => r.json());
    expect(linked.map((g: { title: string }) => g.title)).toEqual(EXPECTED);
  });
});
