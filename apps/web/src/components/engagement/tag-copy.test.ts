import type { MergeTagResult, Tag } from '@reporter/shared';
import { describe, expect, it } from 'vitest';
import {
  activityTagHint,
  deleteTagMessage,
  deleteTagReferencesNote,
  mergeTagMessage,
  mergeTagToast,
  tagUsageSentence,
  tagUsageShort,
  unapplyTagMessage,
  unapplyTagToast,
} from './tag-copy.js';

/** A tag with only the fields the copy reads set; counts default to absent. */
function tag(name: string, counts: Partial<Pick<Tag, 'evidenceCount' | 'findingCount'>> = {}): Tag {
  return { id: 1, name, colorName: 'teal', ...counts };
}

describe('tagUsageSentence', () => {
  it('reads absent counts as zero', () => {
    expect(tagUsageSentence({})).toBe('not applied to anything yet');
    expect(tagUsageSentence({ evidenceCount: 0, findingCount: 0 })).toBe(
      'not applied to anything yet',
    );
  });

  it('pluralises evidence at one and two, with findings absent', () => {
    expect(tagUsageSentence({ evidenceCount: 1 })).toBe('on 1 piece of evidence');
    expect(tagUsageSentence({ evidenceCount: 2 })).toBe('on 2 pieces of evidence');
  });

  it('pluralises findings at one and two, with no evidence', () => {
    expect(tagUsageSentence({ evidenceCount: 0, findingCount: 1 })).toBe('on 1 finding');
    expect(tagUsageSentence({ findingCount: 2 })).toBe('on 2 findings');
  });

  it('joins both halves when both are present', () => {
    expect(tagUsageSentence({ evidenceCount: 3, findingCount: 1 })).toBe(
      'on 3 pieces of evidence and 1 finding',
    );
    expect(tagUsageSentence({ evidenceCount: 1, findingCount: 2 })).toBe(
      'on 1 piece of evidence and 2 findings',
    );
  });
});

describe('deleteTagMessage', () => {
  it('asks a plain question when the tag is on nothing', () => {
    expect(deleteTagMessage(tag('recon'))).toBe(
      'Delete the tag “recon”? It isn’t applied to anything yet.',
    );
  });

  it('states the blast radius when the tag is in use', () => {
    // A single item gets a singular pronoun; "all of them" needs more than one.
    expect(deleteTagMessage(tag('recon', { evidenceCount: 1 }))).toBe(
      'The tag “recon” is on 1 piece of evidence. Deleting it removes it from that item. This cannot be undone.',
    );
    expect(deleteTagMessage(tag('recon', { evidenceCount: 4, findingCount: 2 }))).toBe(
      'The tag “recon” is on 4 pieces of evidence and 2 findings. Deleting it removes it from all of them. This cannot be undone.',
    );
  });
});

describe('deleteTagReferencesNote', () => {
  it('is null when nothing names the tag', () => {
    expect(deleteTagReferencesNote({ savedQueries: [], timelineSections: [] })).toBeNull();
  });

  it('names saved queries and timeline sections, singular and plural', () => {
    expect(
      deleteTagReferencesNote({ savedQueries: [{ name: 'Recon items' }], timelineSections: [] }),
    ).toBe(
      'It is also referred to by name: the saved query “Recon items” will stop matching (saved queries are not rewritten).',
    );
    expect(
      deleteTagReferencesNote({
        savedQueries: [{ name: 'A' }, { name: 'B' }],
        timelineSections: [{ title: 'Day 1' }, { title: 'Day 2' }],
      }),
    ).toBe(
      'It is also referred to by name: the saved queries “A”, “B” will stop matching (saved queries are not rewritten); the report timeline sections “Day 1”, “Day 2” will drop it from their filter.',
    );
    expect(
      deleteTagReferencesNote({ savedQueries: [], timelineSections: [{ title: 'Day 1' }] }),
    ).toBe(
      'It is also referred to by name: the report timeline section “Day 1” will drop it from its filter.',
    );
  });
});

describe('unapplyTagMessage', () => {
  it('says there is nothing to remove for an unused tag', () => {
    expect(unapplyTagMessage(tag('recon'))).toBe(
      '“recon” isn’t applied to anything yet, so there is nothing to remove.',
    );
  });

  it('states the blast radius and that the tag itself survives', () => {
    expect(unapplyTagMessage(tag('recon', { evidenceCount: 2, findingCount: 1 }))).toBe(
      'Remove “recon” from everything it is applied to? It is on 2 pieces of evidence and 1 finding. The tag itself stays, so you can apply it again. This cannot be undone.',
    );
  });
});

describe('tagUsageShort', () => {
  it('fits a Settings row: a word for nothing, otherwise terse counts', () => {
    expect(tagUsageShort(tag('a'))).toBe('unused');
    expect(tagUsageShort(tag('a', { evidenceCount: 1 }))).toBe('1 evidence');
    expect(tagUsageShort(tag('a', { evidenceCount: 2 }))).toBe('2 evidence');
    expect(tagUsageShort(tag('a', { evidenceCount: 2, findingCount: 1 }))).toBe(
      '2 evidence · 1 finding',
    );
    expect(tagUsageShort(tag('a', { findingCount: 3 }))).toBe('3 findings');
  });
});

describe('mergeTagMessage', () => {
  it('sums both tags’ counts and prints both halves of the split', () => {
    const source = tag('recon', { evidenceCount: 2, findingCount: 1 });
    const target = tag('osint', { evidenceCount: 3 });
    expect(mergeTagMessage(source, target)).toBe(
      'Everything tagged “recon” will be tagged “osint” instead. Afterwards “osint” is on up to 5 pieces of evidence and 1 finding — items already carrying both keep a single chip.',
    );
  });

  it('keeps the singular when the sum is one, and drops the zero half', () => {
    // No "and 0 findings": until findings can carry tags that clause would read
    // as a warning about findings on every merge.
    expect(mergeTagMessage(tag('a', { evidenceCount: 1 }), tag('b'))).toBe(
      'Everything tagged “a” will be tagged “b” instead. Afterwards “b” is on up to 1 piece of evidence — items already carrying both keep a single chip.',
    );
  });

  it('says so when neither tag is applied to anything', () => {
    expect(mergeTagMessage(tag('a'), tag('b'))).toBe(
      'Everything tagged “a” will be tagged “b” instead. Neither tag is applied to anything yet.',
    );
  });
});

describe('activityTagHint', () => {
  it('is null when no activity uses the tag', () => {
    expect(activityTagHint([])).toBeNull();
  });

  it('names a single activity in the singular', () => {
    expect(activityTagHint(['Recon'])).toBe(
      "Used as the correlation tag for the activity “Recon”. Renaming it here keeps that link — but renaming the activity itself on the Goals tab will create a new tag under the activity's new name rather than following this one.",
    );
  });

  it('lists two activities in the plural', () => {
    expect(activityTagHint(['Recon', 'Phishing'])).toBe(
      "Used as the correlation tag for the activities “Recon”, “Phishing”. Renaming it here keeps that link — but renaming the activity itself on the Goals tab will create a new tag under the activity's new name rather than following this one.",
    );
  });
});

describe('unapplyTagToast', () => {
  it('quotes what was stripped, singular and plural', () => {
    expect(unapplyTagToast('recon', { evidenceCleared: 1, findingsCleared: 0 })).toBe(
      'Removed “recon” from 1 piece of evidence.',
    );
    expect(unapplyTagToast('recon', { evidenceCleared: 2, findingsCleared: 3 })).toBe(
      'Removed “recon” from 2 pieces of evidence and 3 findings.',
    );
  });

  it('admits when nothing was stripped', () => {
    expect(unapplyTagToast('recon', { evidenceCleared: 0, findingsCleared: 0 })).toBe(
      '“recon” wasn’t applied to anything.',
    );
  });
});

describe('mergeTagToast', () => {
  const base: MergeTagResult = {
    tag: tag('osint'),
    movedEvidence: 0,
    evidenceAlreadyTagged: 0,
    movedFindings: 0,
    findingsAlreadyTagged: 0,
    repointedActivities: 0,
    rewrittenTimelineSections: 0,
  };

  it('drops every zero clause', () => {
    expect(mergeTagToast('recon', 'osint', base)).toBe(
      'Merged “recon” into “osint” — nothing to retag.',
    );
  });

  it('names every non-zero clause, singular and plural', () => {
    expect(
      mergeTagToast('recon', 'osint', {
        ...base,
        movedEvidence: 1,
        evidenceAlreadyTagged: 1,
        movedFindings: 2,
        findingsAlreadyTagged: 1,
        repointedActivities: 1,
        rewrittenTimelineSections: 2,
      }),
    ).toBe(
      'Merged “recon” into “osint” — 1 piece of evidence and 2 findings retagged, 2 items already carried both, 1 activity re-pointed, 2 report timeline sections updated.',
    );
  });
});
