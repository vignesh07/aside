import { describe, it, expect } from 'vitest';
import { wrapText } from '../src/utils/wrap-text.js';

describe('wrapText', () => {
  it('never exceeds the target width', () => {
    const text = 'the observer watches every agent session and answers questions about them';
    for (const line of wrapText(text, 20)) {
      expect(line.length).toBeLessThanOrEqual(20);
    }
  });

  it('breaks on words, not mid-word, when the word fits', () => {
    expect(wrapText('alpha beta gamma', 11)).toEqual(['alpha beta', 'gamma']);
  });

  it('hard-splits a word too long to ever fit, rather than overflowing', () => {
    // Long paths and URLs are common in transcripts and must not break layout.
    const lines = wrapText('/Users/vignesh/aside/src/core/side-chat-service.ts', 12);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(12);
    expect(lines.join('')).toBe('/Users/vignesh/aside/src/core/side-chat-service.ts');
  });

  it('keeps a long word split adjacent to surrounding words', () => {
    const lines = wrapText('see aaaaaaaaaaaaaaaa now', 8);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(8);
    expect(lines.join(' ')).toContain('see');
    expect(lines.join(' ')).toContain('now');
  });

  it('preserves hard newlines as breaks', () => {
    expect(wrapText('one\ntwo', 40)).toEqual(['one', 'two']);
  });

  it('preserves blank lines between paragraphs', () => {
    expect(wrapText('a\n\nb', 40)).toEqual(['a', '', 'b']);
  });

  it('collapses runs of spaces rather than emitting ragged gaps', () => {
    expect(wrapText('a     b', 40)).toEqual(['a b']);
  });

  it('returns nothing for empty text', () => {
    expect(wrapText('', 40)).toEqual(['']);
  });

  it('returns nothing for a non-positive width instead of looping forever', () => {
    expect(wrapText('hello', 0)).toEqual([]);
    expect(wrapText('hello', -5)).toEqual([]);
  });

  it('fits exactly at the boundary without wrapping early', () => {
    expect(wrapText('abcde fghij', 11)).toEqual(['abcde fghij']);
    expect(wrapText('abcde fghij', 10)).toEqual(['abcde', 'fghij']);
  });
});
