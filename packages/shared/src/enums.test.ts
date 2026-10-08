import { describe, it, expect } from 'vitest';
import {
  EDITABLE_TEXT_EVIDENCE_TYPES,
  EVIDENCE_TEXT_EDITABLE,
  EVIDENCE_TYPES,
  EVIDENCE_TYPE_EXTENSIONS,
  EVIDENCE_TYPE_ICONS,
  EVIDENCE_TYPE_LABELS,
  REPORT_SECTION_ITEMS,
  SCRIPT_INTERPRETER_EXTENSIONS,
  evidenceFileExtension,
  isEditableTextEvidence,
  isEvidenceType,
} from './enums.js';
import { reportConfigSchema, reportTemplateConfigSchema } from './schemas.js';

/**
 * The per-type maps are exhaustive `Record<EvidenceType, …>` so that adding an
 * evidence type is a compile error until each one is updated. These assertions
 * are the runtime half of that guarantee: they catch a key that was added to a
 * map but *not* to `EVIDENCE_TYPES` (which type-checks fine as an excess
 * property on an object literal in some positions, and would then never be
 * reachable), and they fail loudly if a map is ever widened back to
 * `Record<string, …>`.
 */
describe('evidence-type maps', () => {
  const maps = {
    EVIDENCE_TYPE_LABELS,
    EVIDENCE_TYPE_ICONS,
    EVIDENCE_TEXT_EDITABLE,
    EVIDENCE_TYPE_EXTENSIONS,
  };

  for (const [name, map] of Object.entries(maps)) {
    it(`${name} has exactly one entry per evidence type`, () => {
      expect(Object.keys(map).sort()).toEqual([...EVIDENCE_TYPES].sort());
    });
  }

  it('includes script as a top-level type, next to codeblock', () => {
    expect(EVIDENCE_TYPES).toContain('script');
    expect(EVIDENCE_TYPES.indexOf('script')).toBe(EVIDENCE_TYPES.indexOf('codeblock') + 1);
  });

  it('labels script distinctly from a code block, and never duplicates a label', () => {
    expect(EVIDENCE_TYPE_LABELS.script).toBe('Script');
    expect(EVIDENCE_TYPE_LABELS.script).not.toBe(EVIDENCE_TYPE_LABELS.codeblock);
    const labels = Object.values(EVIDENCE_TYPE_LABELS);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('gives every type a non-empty icon', () => {
    for (const t of EVIDENCE_TYPES) expect(EVIDENCE_TYPE_ICONS[t]).not.toBe('');
  });

  it('gives script an icon distinct from every other type', () => {
    const icons = Object.values(EVIDENCE_TYPE_ICONS);
    expect(new Set(icons).size).toBe(icons.length);
  });
});

describe('editable-text evidence types', () => {
  it('derives the list from the exhaustive map, in EVIDENCE_TYPES order', () => {
    expect(EDITABLE_TEXT_EVIDENCE_TYPES).toEqual([
      'codeblock',
      'script',
      'http-request-cycle',
      'event',
      'none',
    ]);
  });

  it('treats a script as editable text — an uploaded one is decoded and stored as text', () => {
    expect(isEditableTextEvidence('script')).toBe(true);
  });

  it('leaves opaque-byte types read-only', () => {
    expect(isEditableTextEvidence('image')).toBe(false);
    expect(isEditableTextEvidence('terminal-recording')).toBe(false);
  });

  it('refuses an unrecognized content type (the column is plain TEXT)', () => {
    expect(isEditableTextEvidence('not-a-type')).toBe(false);
    expect(isEvidenceType('not-a-type')).toBe(false);
    expect(isEvidenceType('script')).toBe(true);
  });
});

describe('evidenceFileExtension', () => {
  it('names a script from its recorded interpreter', () => {
    expect(evidenceFileExtension('script', 'bash')).toBe('.sh');
    expect(evidenceFileExtension('script', 'Python 3')).toBe('.py');
    expect(evidenceFileExtension('script', 'PowerShell')).toBe('.ps1');
    expect(evidenceFileExtension('script', 'node')).toBe('.js');
  });

  it('falls back to .txt for a script with no usable interpreter, not .sh', () => {
    expect(evidenceFileExtension('script')).toBe('.txt');
    expect(evidenceFileExtension('script', null)).toBe('.txt');
    expect(evidenceFileExtension('script', '   ')).toBe('.txt');
  });

  /*
   * Regression: an unmapped interpreter must NOT become the extension. The field
   * is free text, so a typo, a long-form name or a language with punctuation in it
   * would otherwise name the client-facing file — inventing `.pyton`, truncating to
   * `.bourneag`, or (worst) producing the plausible-but-wrong `.c` for a C# script.
   * `.txt` is the only honest answer for an interpreter this build cannot name.
   */
  it('falls back to .txt for an interpreter the map does not know', () => {
    expect(evidenceFileExtension('script', 'pyton')).toBe('.txt');
    expect(evidenceFileExtension('script', 'Bourne Again Shell')).toBe('.txt');
    expect(evidenceFileExtension('script', 'C#')).toBe('.txt');
    expect(evidenceFileExtension('script', 'rust')).toBe('.txt');
    expect(evidenceFileExtension('script', 'averylonginterpretername')).toBe('.txt');
  });

  it('never returns an extension a script could not have been written in', () => {
    // Every mapped value is a real extension, and nothing else can come out.
    for (const token of Object.keys(SCRIPT_INTERPRETER_EXTENSIONS)) {
      expect(evidenceFileExtension('script', token)).toBe(
        '.' + SCRIPT_INTERPRETER_EXTENSIONS[token],
      );
    }
  });

  // Regression guard: codeblock ZIP entry names are already in delivered
  // archives and their "Files Attached" tables, so generalising the helper must
  // not start mapping `python` to `.py` for them.
  it('keeps the historical raw-token behaviour for a code block', () => {
    expect(evidenceFileExtension('codeblock', 'python')).toBe('.python');
    expect(evidenceFileExtension('codeblock', 'C#')).toBe('.c');
    expect(evidenceFileExtension('codeblock')).toBe('.txt');
  });

  it('ignores contentSubtype for types that do not carry a language', () => {
    expect(evidenceFileExtension('terminal-recording', 'bash')).toBe('.cast');
    expect(evidenceFileExtension('http-request-cycle', 'json')).toBe('.har');
    expect(evidenceFileExtension('event', 'python')).toBe('.txt');
  });

  it('yields no extension for a screenshot or an unknown type', () => {
    expect(evidenceFileExtension('image')).toBe('');
    expect(evidenceFileExtension('future-type', 'bash')).toBe('');
  });
});

describe('REPORT_SECTION_ITEMS.assessmentExecution', () => {
  const items = REPORT_SECTION_ITEMS.assessmentExecution ?? [];

  it('declares the three display sub-items', () => {
    expect(items.map((i) => i.key)).toEqual(['evidenceTags', 'typeCaptions', 'scriptBodies']);
  });

  /**
   * Absent means true, so every key has to name content that *renders*. A key
   * phrased as a suppression ("hideScripts", "noTags") would be read as
   * "suppression enabled" for every configuration written before it existed.
   */
  it('phrases every key as content shown, never as a suppression', () => {
    for (const item of items) {
      expect(item.key).not.toMatch(/^(hide|no|omit|exclude|suppress)/i);
      expect(item.label).toBeTruthy();
      expect(item.sample).toBeTruthy();
    }
  });
});

/*
 * The execution-subsection numbering flag ships with the `script` vocabulary, and
 * `enums.test.ts` is where that vocabulary is covered; these two assertions are
 * about the flag's default and its reach, not about the report config's shape.
 */
describe('numberExecutionSubsections', () => {
  it('defaults to false, so an unconfigured engagement keeps unnumbered headings', () => {
    expect(reportConfigSchema.parse({}).numberExecutionSubsections).toBe(false);
  });

  it('travels with a report template (derived via .omit, so no restating needed)', () => {
    expect(reportTemplateConfigSchema.parse({}).numberExecutionSubsections).toBe(false);
    expect(
      reportTemplateConfigSchema.parse({ numberExecutionSubsections: true })
        .numberExecutionSubsections,
    ).toBe(true);
  });
});
