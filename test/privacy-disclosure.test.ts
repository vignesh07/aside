import * as fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const indexHtml = fs.readFileSync(
  new URL('../menubar/index.html', import.meta.url),
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
});
