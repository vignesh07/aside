import { describe, it, expect } from 'vitest';
import { stripMarkdown } from '../src/utils/markdown.js';

describe('stripMarkdown', () => {
  it('unwraps bold without leaving stray asterisks', () => {
    expect(stripMarkdown('**fold agent:** running tests')).toBe('fold agent: running tests');
    expect(stripMarkdown('__fold__ is idle')).toBe('fold is idle');
  });

  it('unwraps italics', () => {
    expect(stripMarkdown('it is *probably* fine')).toBe('it is probably fine');
  });

  it('unwraps inline code', () => {
    expect(stripMarkdown('ran `npm run build` twice')).toBe('ran npm run build twice');
  });

  it('keeps heading words and drops the hashes', () => {
    expect(stripMarkdown('## Agent status')).toBe('Agent status');
    expect(stripMarkdown('###### deep')).toBe('deep');
  });

  it('drops horizontal rules entirely', () => {
    expect(stripMarkdown('a\n\n---\n\nb')).toBe('a\n\nb');
    expect(stripMarkdown('a\n***\nb')).toBe('a\nb');
  });

  it('normalizes bullets to a single dash', () => {
    expect(stripMarkdown('* one\n+ two\n- three')).toBe('- one\n- two\n- three');
  });

  it('preserves bullet indentation', () => {
    expect(stripMarkdown('  * nested')).toBe('- nested');
  });

  it('keeps link text and drops the target', () => {
    expect(stripMarkdown('see [the docs](https://example.com) for more')).toBe(
      'see the docs for more',
    );
  });

  it('strips blockquote markers', () => {
    expect(stripMarkdown('> quoted')).toBe('quoted');
  });

  it('leaves plain prose untouched', () => {
    const prose = 'Nothing looks stuck. Both are moving.';
    expect(stripMarkdown(prose)).toBe(prose);
  });

  it('does not mangle standalone asterisks or math', () => {
    expect(stripMarkdown('2 * 3 = 6')).toBe('2 * 3 = 6');
  });

  it('does not mangle file globs', () => {
    expect(stripMarkdown('matched src/**/*.ts today')).toContain('src/');
  });

  it('collapses blank runs left behind by dropped syntax', () => {
    expect(stripMarkdown('a\n\n\n\nb')).toBe('a\n\nb');
  });

  it('handles empty input', () => {
    expect(stripMarkdown('')).toBe('');
  });

  it('flattens a realistic observer answer', () => {
    const answer = [
      '## Agent status',
      '',
      '**fold agent:** running `pnpm build` — exit 2.',
      '',
      '---',
      '',
      '**Nothing looks stuck.**',
    ].join('\n');
    const out = stripMarkdown(answer);
    expect(out).not.toMatch(/[#*`]|---/);
    expect(out).toContain('fold agent: running pnpm build');
    expect(out).toContain('Nothing looks stuck.');
  });
});
