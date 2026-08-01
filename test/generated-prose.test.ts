import { describe, expect, it } from 'vitest';
import { parseGeneratedProse } from '../menubar/src/generated-prose.js';

describe('parseGeneratedProse', () => {
  it('turns the observer format into titled prose and lists', () => {
    expect(
      parseGeneratedProse(
        'Summary\nThree conversations moved forward. [1]\n\n' +
          'Highlights\n• Search shipped. [2]\n• Release checks passed. [3]',
      ),
    ).toEqual([
      {
        heading: 'Summary',
        paragraphs: ['Three conversations moved forward. [1]'],
        items: [],
      },
      {
        heading: 'Highlights',
        paragraphs: [],
        items: ['Search shipped. [2]', 'Release checks passed. [3]'],
      },
    ]);
  });

  it('keeps unstructured generated text as safe paragraph content', () => {
    expect(parseGeneratedProse('<img src=x onerror=alert(1)>')).toEqual([
      {
        heading: '',
        paragraphs: ['<img src=x onerror=alert(1)>'],
        items: [],
      },
    ]);
  });

  it('normalizes CRLF and ignores empty blocks', () => {
    expect(parseGeneratedProse('\r\nGoal\r\nKeep the recap useful.\r\n\r\n')).toEqual([
      {
        heading: 'Goal',
        paragraphs: ['Keep the recap useful.'],
        items: [],
      },
    ]);
  });
});
