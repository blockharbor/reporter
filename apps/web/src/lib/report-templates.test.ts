import { describe, expect, it } from 'vitest';
import {
  MAX_REPORT_CUSTOM_SECTIONS,
  reportConfigSchema,
  reportTemplateConfigSchema,
  type ReportConfig,
  type ReportTemplateConfig,
} from '@reporter/shared';
import {
  applyTemplateConfig,
  configSummary,
  overflowReason,
  templateSanitizeWarning,
} from './report-templates.js';

/** An engagement configuration, defaults filled in by the schema. */
function engagementConfig(over: Partial<ReportConfig> = {}): ReportConfig {
  return reportConfigSchema.parse(over);
}

/** A template configuration (no `readinessNa`), defaults filled in by the schema. */
function templateConfig(over: Partial<ReportTemplateConfig> = {}): ReportTemplateConfig {
  return reportTemplateConfigSchema.parse(over);
}

describe('templateSanitizeWarning', () => {
  const off = { showEvidenceTimestamps: false, showEvidenceOperators: false };

  it('stays silent when the template reveals nothing new', () => {
    expect(templateSanitizeWarning(off, off)).toBeNull();
    // Already on here, and the template leaves it on: no new disclosure.
    expect(
      templateSanitizeWarning(
        { showEvidenceTimestamps: true, showEvidenceOperators: true },
        { showEvidenceTimestamps: true, showEvidenceOperators: true },
      ),
    ).toBeNull();
    // A template that turns an option *off* is a tightening, not a leak.
    expect(
      templateSanitizeWarning({ showEvidenceTimestamps: true, showEvidenceOperators: false }, off),
    ).toBeNull();
  });

  it('names timestamps when only timestamps would switch on', () => {
    const msg = templateSanitizeWarning(off, {
      showEvidenceTimestamps: true,
      showEvidenceOperators: false,
    });
    expect(msg).toContain('a sanitize option');
    expect(msg).toContain('evidence capture dates and times');
    expect(msg).not.toContain('operator');
  });

  it('names the operator when only the operator would switch on', () => {
    const msg = templateSanitizeWarning(off, {
      showEvidenceTimestamps: false,
      showEvidenceOperators: true,
    });
    expect(msg).toContain('a sanitize option');
    expect(msg).toContain('the operator who captured each evidence item');
    expect(msg).not.toContain('capture dates');
  });

  it('names both when both would switch on', () => {
    const msg = templateSanitizeWarning(off, {
      showEvidenceTimestamps: true,
      showEvidenceOperators: true,
    });
    expect(msg).toContain('both sanitize options');
    expect(msg).toContain('evidence capture dates and times');
    expect(msg).toContain('the operator who captured each evidence item');
  });

  it('warns about the one option that is new when the other is already on', () => {
    const msg = templateSanitizeWarning(
      { showEvidenceTimestamps: true, showEvidenceOperators: false },
      { showEvidenceTimestamps: true, showEvidenceOperators: true },
    );
    expect(msg).toContain('a sanitize option');
    expect(msg).toContain('the operator who captured each evidence item');
  });
});

describe('applyTemplateConfig', () => {
  it("replaces the section selection and order with the template's", () => {
    const current = engagementConfig({
      sections: [
        { key: 'executiveSummary', enabled: true },
        { key: 'methodology', enabled: true },
      ],
    });
    const next = applyTemplateConfig(
      current,
      templateConfig({
        sections: [
          { key: 'detailedFindings', enabled: true },
          { key: 'executiveSummary', enabled: false },
        ],
      }),
    );
    expect(next.sections).toEqual([
      { key: 'detailedFindings', enabled: true },
      { key: 'executiveSummary', enabled: false },
    ]);
  });

  it("preserves the engagement's custom sections the template never mentions", () => {
    const current = engagementConfig({
      customSections: [{ id: 'mine', title: 'Retest notes', body: 'Authored by hand.' }],
      sections: [{ key: 'custom:mine', enabled: true }],
    });
    const next = applyTemplateConfig(
      current,
      templateConfig({ sections: [{ key: 'executiveSummary', enabled: true }] }),
    );
    // The prose survives, byte for byte — losing it would destroy work the
    // template says nothing about.
    expect(next.customSections).toEqual([
      { id: 'mine', title: 'Retest notes', body: 'Authored by hand.' },
    ]);
    // And it keeps a row in the section list, disabled: visible and re-enablable
    // rather than an invisible orphan.
    expect(next.sections).toEqual([
      { key: 'executiveSummary', enabled: true },
      { key: 'custom:mine', enabled: false },
    ]);
  });

  it("lets the template's version win on an id collision", () => {
    const current = engagementConfig({
      customSections: [{ id: 'shared', title: 'Ours', body: 'Our words.' }],
    });
    const next = applyTemplateConfig(
      current,
      templateConfig({
        customSections: [{ id: 'shared', title: 'Theirs', body: 'Template words.' }],
        sections: [{ key: 'custom:shared', enabled: true }],
      }),
    );
    expect(next.customSections).toEqual([
      { id: 'shared', title: 'Theirs', body: 'Template words.' },
    ]);
    // Referenced by the template, so no extra disabled row is appended.
    expect(next.sections).toEqual([{ key: 'custom:shared', enabled: true }]);
  });

  it("keeps the engagement's order and appends the template's own custom sections", () => {
    const current = engagementConfig({
      customSections: [
        { id: 'a', title: 'A', body: '' },
        { id: 'b', title: 'B', body: '' },
      ],
      sections: [
        { key: 'custom:a', enabled: true },
        { key: 'custom:b', enabled: true },
      ],
    });
    const next = applyTemplateConfig(
      current,
      templateConfig({
        customSections: [
          { id: 'b', title: 'B (template)', body: '' },
          { id: 'c', title: 'C', body: '' },
        ],
        sections: [
          { key: 'custom:c', enabled: true },
          { key: 'custom:b', enabled: true },
        ],
      }),
    );
    expect(next.customSections.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    expect(next.customSections[1]!.title).toBe('B (template)');
    // Only `a` is unreferenced, so only `a` gains a disabled row.
    expect(next.sections).toEqual([
      { key: 'custom:c', enabled: true },
      { key: 'custom:b', enabled: true },
      { key: 'custom:a', enabled: false },
    ]);
  });

  it("carries the engagement's readinessNa across untouched", () => {
    const current = engagementConfig({ readinessNa: ['watermark', 'threatModel'] });
    const next = applyTemplateConfig(current, templateConfig());
    expect(next.readinessNa).toEqual(['watermark', 'threatModel']);
  });

  it('adopts every other reporting choice from the template', () => {
    const next = applyTemplateConfig(
      engagementConfig({
        findingGroup: 'severity',
        includeAllFindings: false,
        includeEvidenceTimeline: false,
        evidenceGroup: 'chronological',
        showEvidenceTimestamps: false,
        showEvidenceOperators: false,
      }),
      templateConfig({
        findingGroup: 'target',
        includeAllFindings: true,
        includeEvidenceTimeline: true,
        evidenceGroup: 'tag',
        showEvidenceTimestamps: true,
        showEvidenceOperators: true,
      }),
    );
    expect(next.findingGroup).toBe('target');
    expect(next.includeAllFindings).toBe(true);
    expect(next.includeEvidenceTimeline).toBe(true);
    expect(next.evidenceGroup).toBe('tag');
    expect(next.showEvidenceTimestamps).toBe(true);
    expect(next.showEvidenceOperators).toBe(true);
  });

  it('produces a configuration the engagement schema accepts', () => {
    const next = applyTemplateConfig(
      engagementConfig({
        customSections: [{ id: 'mine', title: 'Mine', body: '' }],
        readinessNa: ['watermark'],
      }),
      templateConfig({ customSections: [{ id: 'theirs', title: 'Theirs', body: '' }] }),
    );
    expect(() => reportConfigSchema.parse(next)).not.toThrow();
  });
});

describe('overflowReason', () => {
  it('passes a configuration that fits', () => {
    expect(overflowReason(engagementConfig())).toBeNull();
  });

  it('refuses a merge past the custom-section cap, naming the real counts', () => {
    const tooMany = {
      ...engagementConfig(),
      customSections: Array.from({ length: MAX_REPORT_CUSTOM_SECTIONS + 1 }, (_, i) => ({
        id: `s${i}`,
        title: `S${i}`,
        body: '',
      })),
    };
    const reason = overflowReason(tooMany);
    expect(reason).toContain(String(MAX_REPORT_CUSTOM_SECTIONS + 1));
    expect(reason).toContain(String(MAX_REPORT_CUSTOM_SECTIONS));
    // The cap it reports is the one the schema actually enforces.
    expect(() => reportConfigSchema.parse(tooMany)).toThrow();
  });
});

describe('configSummary', () => {
  it('counts enabled sections and names the findings grouping', () => {
    expect(
      configSummary(
        templateConfig({
          sections: [
            { key: 'executiveSummary', enabled: true },
            { key: 'methodology', enabled: false },
          ],
          findingGroup: 'severity',
        }),
      ),
    ).toBe('1 of 2 sections · findings by severity');
  });

  it('mentions custom sections, the evidence log and every-finding when they are on', () => {
    const summary = configSummary(
      templateConfig({
        customSections: [{ id: 'a', title: 'A', body: '' }],
        includeEvidenceTimeline: true,
        includeAllFindings: true,
      }),
    );
    expect(summary).toContain('1 custom section');
    expect(summary).toContain('evidence log');
    expect(summary).toContain('every finding');
  });
});
