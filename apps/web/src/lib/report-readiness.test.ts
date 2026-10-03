import { describe, expect, it } from 'vitest';
import {
  computeFindingWarnings,
  computeReadiness,
  type FindingWarningSubject,
  type ReadinessInput,
} from './report-readiness.js';

/** A fully-complete input; individual tests knock out one field at a time. */
const complete: ReadinessInput = {
  clientName: 'Acme',
  assessmentType: 'External Penetration Assessment',
  location: 'AWS us-east-1',
  scope: 'The public web estate.',
  executiveSummary: 'We assessed…',
  methodology: 'Recon, testing, verification.',
  watermarkEnabled: true,
  scopeTargets: [{ name: 'Web app' }],
  recommendations: [{ title: 'Patch TLS', findingUuids: ['f-1'] }],
  threatModelNarrative: 'Adversary model…',
  threatModelDiagrams: [],
  executionNarrative: [{ title: 'CAN bus analysis' }],
  providerContacts: [{ name: 'Alice' }],
  clientContacts: [{ name: 'Bob' }],
  thirdPartySoftware: [{ name: 'Burp Suite' }],
  readyFindingCount: 2,
};

const keyOf = (r: ReturnType<typeof computeReadiness>, key: string) =>
  r.items.find((i) => i.key === key)!;

describe('computeReadiness', () => {
  it('is ready when every item is complete', () => {
    const r = computeReadiness(complete, []);
    expect(r.ready).toBe(true);
    expect(r.satisfiedCount).toBe(r.total);
    expect(r.percent).toBe(100);
    expect(r.total).toBe(15);
  });

  it('flags a missing scalar field and is not ready', () => {
    const r = computeReadiness({ ...complete, clientName: '  ' }, []);
    expect(r.ready).toBe(false);
    expect(keyOf(r, 'clientName').complete).toBe(false);
    expect(r.satisfiedCount).toBe(r.total - 1);
  });

  it('requires each recommendation to link at least one finding', () => {
    const unlinked = computeReadiness(
      { ...complete, recommendations: [{ title: 'Patch TLS', findingUuids: [] }] },
      [],
    );
    expect(keyOf(unlinked, 'recommendations').complete).toBe(false);

    const empty = computeReadiness({ ...complete, recommendations: [] }, []);
    expect(keyOf(empty, 'recommendations').complete).toBe(false);

    const linked = computeReadiness(
      { ...complete, recommendations: [{ title: 'Patch TLS', findingUuids: ['f-9'] }] },
      [],
    );
    expect(keyOf(linked, 'recommendations').complete).toBe(true);
  });

  it('treats the watermark as complete only when enabled', () => {
    const off = computeReadiness({ ...complete, watermarkEnabled: false }, []);
    expect(keyOf(off, 'watermark').complete).toBe(false);
  });

  it('accepts a threat model via narrative or a diagram', () => {
    const viaDiagram = computeReadiness(
      {
        ...complete,
        threatModelNarrative: '',
        threatModelDiagrams: [{ imageDataUri: 'data:image/png;base64,AAAA' }],
      },
      [],
    );
    expect(keyOf(viaDiagram, 'threatModel').complete).toBe(true);

    const neither = computeReadiness(
      { ...complete, threatModelNarrative: '', threatModelDiagrams: [] },
      [],
    );
    expect(keyOf(neither, 'threatModel').complete).toBe(false);
  });

  it('requires at least one ready-to-report finding', () => {
    const r = computeReadiness({ ...complete, readyFindingCount: 0 }, []);
    expect(keyOf(r, 'readyFinding').complete).toBe(false);
  });

  it('counts a Not-applicable item as satisfied but not complete', () => {
    const r = computeReadiness({ ...complete, watermarkEnabled: false }, ['watermark']);
    const wm = keyOf(r, 'watermark');
    expect(wm.complete).toBe(false);
    expect(wm.na).toBe(true);
    expect(wm.satisfied).toBe(true);
    expect(r.ready).toBe(true);
  });
});

/** A ready weakness with nothing wrong with it; each case breaks one thing. */
const soundFinding: FindingWarningSubject = {
  uuid: 'f-ok',
  title: 'Unauthenticated diagnostic service',
  kind: 'weakness',
  readyToReport: true,
  severity: 'high',
  remediation: 'Require authentication on the diagnostic port.',
  numEvidence: 3,
  numEvidenceInReport: 3,
};

const kinds = (r: ReturnType<typeof computeFindingWarnings>) => r.groups.map((g) => g.kind);

describe('computeFindingWarnings', () => {
  it('says nothing about a sound finding', () => {
    const r = computeFindingWarnings([soundFinding]);
    expect(r.groups).toEqual([]);
    expect(r.total).toBe(0);
    expect(r.findingCount).toBe(0);
  });

  it('warns when every linked evidence item is withheld from the report', () => {
    const r = computeFindingWarnings([{ ...soundFinding, numEvidence: 2, numEvidenceInReport: 0 }]);
    expect(kinds(r)).toEqual(['evidenceAllWithheld']);
    expect(r.groups[0]!.findings).toEqual([{ uuid: 'f-ok', title: soundFinding.title }]);
  });

  it('does not warn when only some evidence is withheld', () => {
    // The report still renders an evidence section, and the finding page already
    // badges the excluded items — warning here would be crying wolf.
    const r = computeFindingWarnings([{ ...soundFinding, numEvidence: 3, numEvidenceInReport: 1 }]);
    expect(r.groups).toEqual([]);
  });

  it('warns about no evidence, an unrated severity and a missing remediation', () => {
    expect(
      kinds(computeFindingWarnings([{ ...soundFinding, numEvidence: 0, numEvidenceInReport: 0 }])),
    ).toEqual(['noEvidence']);
    expect(kinds(computeFindingWarnings([{ ...soundFinding, severity: null }]))).toEqual([
      'noSeverity',
    ]);
    // Whitespace is not remediation guidance.
    expect(kinds(computeFindingWarnings([{ ...soundFinding, remediation: '  \n' }]))).toEqual([
      'noRemediation',
    ]);
  });

  it('reports every warning a single finding raises, counting the finding once', () => {
    const r = computeFindingWarnings([
      {
        ...soundFinding,
        numEvidence: 0,
        numEvidenceInReport: 0,
        severity: null,
        remediation: '',
      },
    ]);
    // Groups come back in FINDING_WARNING_KINDS order, not the order they fired.
    expect(kinds(r)).toEqual(['noEvidence', 'noSeverity', 'noRemediation']);
    expect(r.total).toBe(3);
    expect(r.findingCount).toBe(1);
  });

  it('ignores findings the report will not render in full', () => {
    const broken = { numEvidence: 0, numEvidenceInReport: 0, severity: null, remediation: '' };
    const r = computeFindingWarnings([
      // Not ready: still being written, so none of this is news to the author.
      { ...soundFinding, uuid: 'f-draft', readyToReport: false, ...broken },
      // A strength renders as one row of the Summary of Strengths table — no
      // severity pill, no Remediation section, no evidence section to be empty.
      { ...soundFinding, uuid: 'f-strength', kind: 'strength', ...broken },
    ]);
    expect(r.groups).toEqual([]);
  });

  it('groups several findings under one warning, in list order', () => {
    const r = computeFindingWarnings([
      { ...soundFinding, uuid: 'f-1', title: 'First', numEvidence: 0, numEvidenceInReport: 0 },
      soundFinding,
      { ...soundFinding, uuid: 'f-2', title: 'Second', numEvidence: 0, numEvidenceInReport: 0 },
    ]);
    expect(kinds(r)).toEqual(['noEvidence']);
    expect(r.groups[0]!.findings.map((f) => f.uuid)).toEqual(['f-1', 'f-2']);
    expect(r.findingCount).toBe(2);
  });
});
