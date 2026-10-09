import { describe, it, expect } from 'vitest';
import {
  DEFAULT_REPORT_SECTIONS,
  executionSubsectionSchema,
  recommendationItemSchema,
  reportConfigSchema,
  reportPresetSections,
  reportSectionEntrySchema,
  createTagInput,
  mergeTagInput,
  tagReferences,
  tagSchema,
  updateEngagementInput,
  updateTagInput,
} from './schemas.js';
import { WATERMARK_MAX_CHARS } from './enums.js';
import { TAG_COLOR_NAMES } from './tags.js';

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

describe('tag inputs', () => {
  describe('updateTagInput', () => {
    it('trims the name, so "  alpha  " renames to the same label as "alpha"', () => {
      expect(updateTagInput.parse({ name: '  alpha  ' }).name).toBe('alpha');
    });

    it('rejects an empty patch (it used to be an expensive no-op UPDATE)', () => {
      expect(updateTagInput.safeParse({}).success).toBe(false);
    });

    it('rejects an empty name, including one that is only whitespace', () => {
      expect(updateTagInput.safeParse({ name: '' }).success).toBe(false);
      expect(updateTagInput.safeParse({ name: '   ' }).success).toBe(false);
    });

    it('rejects a name longer than 64 characters', () => {
      expect(updateTagInput.safeParse({ name: 'x'.repeat(65) }).success).toBe(false);
      expect(updateTagInput.safeParse({ name: 'x'.repeat(64) }).success).toBe(true);
    });

    it('rejects an off-palette colorName', () => {
      expect(updateTagInput.safeParse({ colorName: 'chartreuse' }).success).toBe(false);
    });

    it('accepts a name-only patch and a colorName-only patch', () => {
      expect(updateTagInput.parse({ name: 'omega' })).toEqual({ name: 'omega' });
      expect(updateTagInput.parse({ colorName: 'teal' })).toEqual({ colorName: 'teal' });
    });
  });

  describe('createTagInput', () => {
    it('accepts every palette name, so nothing the swatch picker can send is rejected', () => {
      for (const colorName of TAG_COLOR_NAMES) {
        expect(createTagInput.safeParse({ name: 'alpha', colorName }).success).toBe(true);
      }
    });

    it('rejects an off-palette colorName', () => {
      expect(createTagInput.safeParse({ name: 'alpha', colorName: 'chartreuse' }).success).toBe(
        false,
      );
    });
  });

  /*
   * Only the INPUT schemas gained the palette enum. The response schema must keep
   * accepting whatever is stored: rows written before palette validation existed,
   * and tags imported through `exportedTagSchema` (whose `colorName` is still a
   * free string), can hold an off-palette value that `tagColor()` degrades to
   * slate. Tightening `tagSchema.colorName` to the enum would make every one of
   * those engagements fail to load — this case is here to stop that.
   */
  it('tagSchema still accepts an off-palette colorName on the way out', () => {
    const parsed = tagSchema.safeParse({ id: 1, name: 'legacy', colorName: 'chartreuse' });
    expect(parsed.success).toBe(true);
  });

  describe('mergeTagInput', () => {
    it('rejects a zero or non-integer target id', () => {
      expect(mergeTagInput.safeParse({ intoTagId: 0 }).success).toBe(false);
      expect(mergeTagInput.safeParse({ intoTagId: 1.5 }).success).toBe(false);
      expect(mergeTagInput.safeParse({ intoTagId: 2 }).success).toBe(true);
    });
  });

  describe('tagReferences', () => {
    it('parses a representative references payload', () => {
      const refs = {
        savedQueries: [
          { id: 3, name: 'Starred CAN', type: 'evidence' },
          { id: 4, name: 'Open CAN findings', type: 'findings' },
        ],
        timelineSections: [{ index: 0, title: 'CAN bus activity' }],
      };
      expect(tagReferences.parse(refs)).toEqual(refs);
    });
  });
});
