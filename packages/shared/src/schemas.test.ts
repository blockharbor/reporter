import { describe, it, expect } from 'vitest';
import {
  DEFAULT_REPORT_SECTIONS,
  executionSubsectionSchema,
  recommendationItemSchema,
  reportConfigSchema,
  reportPresetSections,
  reportSectionEntrySchema,
  updateEngagementInput,
} from './schemas.js';
import { WATERMARK_MAX_CHARS } from './enums.js';

describe('recommendationItemSchema', () => {
  it('defaults findingUuids to [] for a legacy recommendation (no links)', () => {
    const parsed = recommendationItemSchema.parse({ title: 'Patch TLS' });
    expect(parsed.findingUuids).toEqual([]);
    expect(parsed.description).toBe('');
  });

  it('keeps the linked finding uuids when provided', () => {
    const uuid = '11111111-1111-4111-8111-111111111111';
    const parsed = recommendationItemSchema.parse({ title: 'Patch TLS', findingUuids: [uuid] });
    expect(parsed.findingUuids).toEqual([uuid]);
  });

  it('rejects a non-uuid finding link', () => {
    expect(
      recommendationItemSchema.safeParse({ title: 'Patch TLS', findingUuids: ['nope'] }).success,
    ).toBe(false);
  });
});

describe('reportConfigSchema', () => {
  it('defaults readinessNa to [] for an unconfigured engagement', () => {
    expect(reportConfigSchema.parse({}).readinessNa).toEqual([]);
  });

  it('round-trips readiness N/A overrides', () => {
    expect(
      reportConfigSchema.parse({ readinessNa: ['watermark', 'threatModel'] }).readinessNa,
    ).toEqual(['watermark', 'threatModel']);
  });
});

describe('executionSubsectionSchema', () => {
  it('defaults a legacy subsection (no kind) to narrative', () => {
    const parsed = executionSubsectionSchema.parse({ title: 'CAN bus analysis' });
    expect(parsed.kind).toBe('narrative');
    expect(parsed.body).toBe('');
    expect(parsed.evidence).toEqual([]);
    expect(parsed.timeline).toBeUndefined();
  });

  it('parses a timeline subsection and fills timeline-config defaults', () => {
    const parsed = executionSubsectionSchema.parse({
      kind: 'timeline',
      title: 'Activity timeline',
      timeline: { tags: ['can'], starredOnly: true },
    });
    expect(parsed.kind).toBe('timeline');
    expect(parsed.timeline).toEqual({
      tags: ['can'],
      types: [],
      group: 'chronological',
      includeComments: false,
      starredOnly: true,
    });
  });

  it('still requires a title', () => {
    expect(executionSubsectionSchema.safeParse({ kind: 'timeline' }).success).toBe(false);
  });
});

describe('reportSectionEntrySchema', () => {
  it('accepts per-section sub-item option overrides', () => {
    const parsed = reportSectionEntrySchema.parse({
      key: 'detailedFindings',
      enabled: true,
      options: { attackPath: false, remediation: true },
    });
    expect(parsed.options).toEqual({ attackPath: false, remediation: true });
  });

  it('leaves options undefined when omitted', () => {
    const parsed = reportSectionEntrySchema.parse({ key: 'executiveSummary' });
    expect(parsed.options).toBeUndefined();
    expect(parsed.enabled).toBe(true);
  });
});

describe('watermarkText cap', () => {
  it('rejects text longer than WATERMARK_MAX_CHARS', () => {
    const tooLong = 'X'.repeat(WATERMARK_MAX_CHARS + 1);
    expect(updateEngagementInput.safeParse({ watermarkText: tooLong }).success).toBe(false);
    const ok = 'X'.repeat(WATERMARK_MAX_CHARS);
    expect(updateEngagementInput.safeParse({ watermarkText: ok }).success).toBe(true);
  });
});

describe('reportPresetSections', () => {
  it('reproduces the default section list for `full`, and subsets for the rest', () => {
    expect(reportPresetSections('full').map((s) => s.key)).toEqual(
      DEFAULT_REPORT_SECTIONS.map((s) => s.key),
    );
    expect(reportPresetSections('executive').map((s) => s.key)).toEqual(['executiveSummary']);
    expect(reportPresetSections('findings').map((s) => s.key)).toEqual([
      'assessmentFindings',
      'detailedFindings',
    ]);
    // `enabled` is the preset's, not the engagement's: `scopeCoverage` ships off.
    expect(reportPresetSections('full').find((s) => s.key === 'scopeCoverage')?.enabled).toBe(
      false,
    );
  });

  /*
   * Regression: a built-in report type used to drop the engagement's per-section
   * sub-items entirely, because its entries carry no `options` map and the renderer
   * reads an absent key as on. For a *suppression* sub-item that is a disclosure —
   * an author who turned "Script contents" off to keep a hardcoded credential out of
   * the deliverable got every script body printed in full the moment they picked
   * "Full report" from the Report type dropdown.
   */
  it("carries the engagement's per-section sub-items onto the preset's sections", () => {
    const configured = [
      { key: 'assessmentExecution', enabled: true, options: { scriptBodies: false } },
      { key: 'assessmentFindings', enabled: false, options: { standards: false } },
    ];
    const full = reportPresetSections('full', configured);
    expect(full.find((s) => s.key === 'assessmentExecution')?.options).toEqual({
      scriptBodies: false,
    });
    // Order and `enabled` stay the preset's; only `options` is carried.
    expect(full.find((s) => s.key === 'assessmentFindings')).toEqual({
      key: 'assessmentFindings',
      enabled: true,
      options: { standards: false },
    });

    // A preset that doesn't include the section simply has nowhere to put it.
    expect(reportPresetSections('executive', configured).map((s) => s.key)).toEqual([
      'executiveSummary',
    ]);
  });

  it('leaves `options` absent rather than undefined when the engagement set none', () => {
    const entry = reportPresetSections('full', [
      { key: 'assessmentExecution', enabled: true },
    ]).find((s) => s.key === 'assessmentExecution')!;
    // Absent, not present-and-undefined: these entries are persisted in the report
    // history and compared as JSON.
    expect('options' in entry).toBe(false);
  });

  it('copies the options map instead of sharing the engagement’s object', () => {
    const options = { scriptBodies: false };
    const entry = reportPresetSections('full', [
      { key: 'assessmentExecution', enabled: true, options },
    ]).find((s) => s.key === 'assessmentExecution')!;
    expect(entry.options).not.toBe(options);
  });
});
