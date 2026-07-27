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

describe('menubar product surfaces', () => {
  it('keeps account management global instead of duplicating it in the composer', () => {
    expect(indexHtml).toContain('id="accounts-button"');
    expect(indexHtml).not.toContain('id="account-inline"');
    expect(renderer).not.toContain('accountInlineEl');
  });

  it('uses a multiline Mac-style composer with Enter and Shift-Enter semantics', () => {
    expect(indexHtml).toContain('<textarea');
    expect(indexHtml).toContain('aria-label="Message Aside"');
    expect(renderer).toContain("event.key === 'Enter'");
    expect(renderer).toContain('!event.shiftKey');
    expect(renderer).toContain('formEl.requestSubmit()');
  });

  it('exposes explicit Keep Open and Attention controls', () => {
    expect(indexHtml).toContain('id="keep-open"');
    expect(indexHtml).toContain('Keep Aside open when switching apps');
    expect(renderer).toContain("title: 'Attention'");
    expect(renderer).toContain('attentionOnly = !attentionOnly');
    expect(renderer).toContain("'aria-pressed'");
  });

  it('keeps attention visible after opening and shows local context with age', () => {
    expect(indexHtml).toContain('.attention-card');
    expect(indexHtml).toContain('.attention-review');
    expect(renderer).toContain('attentionHeadline');
    expect(renderer).toContain('attentionContext');
    expect(renderer).toContain('Waiting for ${elapsed}');
    expect(renderer).toContain("review.textContent = 'Mark reviewed'");
    expect(renderer).toContain(
      'window.aside.resolveAttention(session.threadId)',
    );
    expect(renderer.indexOf('for (const turn of state.messages)')).toBeLessThan(
      renderer.indexOf('if (attentionCard)'),
    );
  });

  it('offers explicit feedback actions without attaching local context', () => {
    expect(indexHtml).toContain('id="report-bug"');
    expect(indexHtml).toContain('id="request-feature"');
    expect(indexHtml).toContain('Aside never attaches logs or thread content.');
    expect(renderer).toContain("openFeedback('bug')");
    expect(renderer).toContain("openFeedback('feature')");
  });
});
