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
const main = fs.readFileSync(
  new URL('../menubar/src/main.ts', import.meta.url),
  'utf8',
);
const preload = fs.readFileSync(
  new URL('../menubar/preload.cjs', import.meta.url),
  'utf8',
);
const todayAuthorization = fs.readFileSync(
  new URL('../menubar/src/today-authorization.ts', import.meta.url),
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

  it('keeps Today and thread review as explicit destinations', () => {
    expect(indexHtml).toContain('id="analysis-view"');
    expect(indexHtml).toContain('id="review-thread"');
    expect(renderer).toContain(
      "type ActiveView = 'thread' | 'today' | 'review' | 'usage'",
    );
    expect(renderer).toContain("title: 'Today'");
    expect(renderer).toContain("activeView = 'review'");
    expect(renderer).toContain("composerShellEl.hidden = activeView !== 'thread'");
  });

  it('builds Today as an automatic diary instead of a writing surface', () => {
    const todayRenderer = renderer.slice(
      renderer.indexOf('function renderTodayContent'),
      renderer.indexOf('function renderReviewContent'),
    );
    const diaryRowRenderer = renderer.slice(
      renderer.indexOf('function makeThreadDiaryRow'),
      renderer.indexOf('function appendTodayProject'),
    );
    expect(renderer).toContain('todayEntryGenerationAttempted = true');
    expect(renderer).toContain('shouldGenerateTodayOnEntry');
    expect(renderer).toContain('eventCount: todayView.narrativeEventCount');
    expect(todayRenderer).toContain(
      'view.artifact || view.narrativeEventCount > 0',
    );
    expect(renderer).toContain("buttonId: 'update-today-recap'");
    expect(renderer).toContain("buttonId: 'generate-review'");
    expect(renderer).toContain('window.aside.generateTodayRecap()');
    expect(renderer).toContain(
      'window.aside.generateThreadReview(threadId, source)',
    );
    expect(todayRenderer).toContain("title: 'Daily recap'");
    expect(renderer).toContain("'Needs attention'");
    expect(todayRenderer).not.toContain("'Events'");
    expect(diaryRowRenderer).not.toContain('makeEvidenceControl');
    expect(renderer).not.toContain('Write recap');
    expect(renderer).not.toContain('Write review');
    expect(indexHtml).toContain('a cloud model or open Today');
  });

  it('requires a separate durable permission before automatic cloud recaps', () => {
    expect(renderer).toContain('Generate recaps when you open Today');
    expect(renderer).toContain('Allow Today recaps');
    expect(renderer).toContain('consentGranted:');
    expect(renderer).toContain('window.aside.allowTodayGeneration(provider)');
    expect(preload).toContain("'aside:today:consent:get'");
    expect(preload).toContain("'aside:today:consent:allow'");
    expect(main).toContain('providerAuth.todayRecapsEnabled(provider)');
    expect(main).toContain('runAuthorizedTodayRecap(');
    expect(todayAuthorization).toContain(
      "throw new Error('Allow Today recaps before generating.')",
    );
  });

  it('refreshes activity views for ledger, read-state, and local-day changes', () => {
    expect(renderer).toContain('state.activityHighWaterSeq');
    expect(renderer).toContain('state.activityCursorRevision');
    expect(renderer).toContain('localDateKey()');
    expect(renderer).toContain('todayFailedRevision === revision');
    expect(renderer).toContain('reviewFailedRevision === revision');
  });

  it('announces generated evidence citation numbers accessibly', () => {
    expect(renderer).toContain('`Evidence ${citationNumber}, `');
  });

  it('keeps token analytics local, filterable, and visibly estimated', () => {
    expect(indexHtml).toContain('id="open-usage"');
    expect(indexHtml).toContain('id="usage-provider-filters"');
    expect(indexHtml).toContain('id="usage-model-filter"');
    expect(indexHtml).toContain('id="usage-grid"');
    expect(indexHtml).toContain('API equivalent');
    expect(indexHtml).toContain('Local equivalent');
    expect(renderer).toContain('window.aside.getUsage(usageQuery())');
    expect(renderer).toContain('unknown cloud models stay unpriced');
  });
});
