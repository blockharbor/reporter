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
  type SanitizeToggles,
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
  /**
   * A configuration carrying only the choices this warning reads. `sections` is
   * required because "Script contents" lives on the Assessment Execution entry's
   * `options` map, and an empty list means the same as a list with no `options` on
   * that entry: script bodies render (absent-means-on).
   */
  function toggles(
    over: Partial<SanitizeToggles> & { scriptBodies?: boolean } = {},
  ): SanitizeToggles {
    const { scriptBodies, ...rest } = over;
    return {
      showEvidenceTimestamps: false,
      showEvidenceOperators: false,
      sections:
        scriptBodies === undefined
          ? []
          : [{ key: 'assessmentExecution', enabled: true, options: { scriptBodies } }],
      ...rest,
    };
  }
  const off = toggles();

  it('stays silent when the template reveals nothing new', () => {
    expect(templateSanitizeWarning(off, off)).toBeNull();
    // Already on here, and the template leaves it on: no new disclosure.
    expect(
      templateSanitizeWarning(
        toggles({ showEvidenceTimestamps: true, showEvidenceOperators: true }),
        toggles({ showEvidenceTimestamps: true, showEvidenceOperators: true }),
      ),
    ).toBeNull();
    // A template that turns an option *off* is a tightening, not a leak.
    expect(templateSanitizeWarning(toggles({ showEvidenceTimestamps: true }), off)).toBeNull();
  });

  it('names timestamps when only timestamps would switch on', () => {
    const msg = templateSanitizeWarning(off, toggles({ showEvidenceTimestamps: true }));
    expect(msg).toContain('a sanitize option');
    expect(msg).toContain('evidence capture dates and times');
    expect(msg).not.toContain('operator');
  });

  it('names the operator when only the operator would switch on', () => {
    const msg = templateSanitizeWarning(off, toggles({ showEvidenceOperators: true }));
    expect(msg).toContain('a sanitize option');
    expect(msg).toContain('the operator who captured each evidence item');
    expect(msg).not.toContain('capture dates');
  });

  it('names both when both would switch on', () => {
    const msg = templateSanitizeWarning(
      off,
      toggles({ showEvidenceTimestamps: true, showEvidenceOperators: true }),
    );
    expect(msg).toContain('both sanitize options');
    expect(msg).toContain('evidence capture dates and times');
    expect(msg).toContain('the operator who captured each evidence item');
  });

  it('warns about the one option that is new when the other is already on', () => {
    const msg = templateSanitizeWarning(
      toggles({ showEvidenceTimestamps: true }),
      toggles({ showEvidenceTimestamps: true, showEvidenceOperators: true }),
    );
    expect(msg).toContain('a sanitize option');
    expect(msg).toContain('the operator who captured each evidence item');
  });

  /*
   * Regression: applying a template replaces the Assessment Execution entry
   * wholesale, so a template with script bodies on (which is every template saved
   * before the sub-item existed — it has no `options` map at all) silently turns
   * them back on for an engagement that suppressed them to keep a credential out of
   * the deliverable. The warning is the only thing standing between that and a
   * confirmed apply.
   */
  it('warns when the template would print suppressed script bodies again', () => {
    const msg = templateSanitizeWarning(toggles({ scriptBodies: false }), toggles());
    expect(msg).toContain('Script contents');
    expect(msg).toContain('This template turns');
    // Not a sanitize option, so it must not borrow that wording.
    expect(msg).not.toContain('sanitize');
  });

  it('warns about script bodies alongside a sanitize option', () => {
    const msg = templateSanitizeWarning(
      toggles({ scriptBodies: false }),
      toggles({ showEvidenceOperators: true, scriptBodies: true }),
    );
    expect(msg).toContain('the operator who captured each evidence item');
    expect(msg).toContain('It also turns');
    expect(msg).toContain('Script contents');
  });

  it('stays silent when the template suppresses script bodies too, or the engagement never did', () => {
    // Both suppress: nothing new.
    expect(
      templateSanitizeWarning(toggles({ scriptBodies: false }), toggles({ scriptBodies: false })),
    ).toBeNull();
    // The engagement already prints them, so the template reveals nothing.
    expect(templateSanitizeWarning(off, toggles({ scriptBodies: true }))).toBeNull();
    // A template that starts suppressing them is a tightening.
    expect(templateSanitizeWarning(off, toggles({ scriptBodies: false }))).toBeNull();
  });

  it('reads a real configuration pair, not just the hand-built shape', () => {
    const suppressed = engagementConfig({
      sections: [{ key: 'assessmentExecution', enabled: true, options: { scriptBodies: false } }],
    });
    // A template saved before the sub-item existed: default sections, no options.
    expect(templateSanitizeWarning(suppressed, templateConfig())).toContain('Script contents');
    expect(templateSanitizeWarning(engagementConfig(), templateConfig())).toBeNull();
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
