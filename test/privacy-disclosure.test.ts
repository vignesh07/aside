import * as fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const indexHtml = fs.readFileSync(
  new URL('../menubar/index.html', import.meta.url),
  'utf8',
);
const renderer = fs.readFileSync(
  new URL('../menubar/src/renderer.ts', import.meta.url),
  'utf8',
);

describe('cloud privacy disclosure', () => {
  it('names the cloud recipient and the limit of automatic redaction on first run', () => {
    expect(indexHtml).toContain(
      'scoped transcript excerpts go to your selected provider',
    );
    expect(indexHtml).toContain(
      'automatic redaction can miss sensitive prose',
    );
  });

  it('explains that full-content indexing stays local and is redacted', () => {
    expect(indexHtml).toContain('indexed locally');
    expect(indexHtml).toContain(
      'Common credential patterns are redacted before indexing',
    );
    expect(indexHtml).toContain('rebuild-search-index');
  });

  it('asks before Today starts sending scoped activity automatically', () => {
    expect(renderer).toContain('Generate recaps when you open Today');
    expect(renderer).toContain(
      'This sends a limited, redacted set of the day’s activity to',
    );
    expect(renderer).toContain(
      'Aside stores the recap and its source links on this Mac.',
    );
  });
});
