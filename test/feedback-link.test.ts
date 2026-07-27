import { describe, expect, it } from 'vitest';
import { feedbackIssueUrl } from '../menubar/src/feedback-link.js';

describe('feedback issue links', () => {
  it.each([
    ['bug', 'bug_report.yml'],
    ['feature', 'feature_request.yml'],
  ] as const)('opens the fixed GitHub %s form', (kind, template) => {
    const value = feedbackIssueUrl(kind);
    expect(value).not.toBeNull();

    const url = new URL(value!);
    expect(url.protocol).toBe('https:');
    expect(url.hostname).toBe('github.com');
    expect(url.pathname).toBe('/vignesh07/aside/issues/new');
    expect(url.searchParams.get('template')).toBe(template);
  });

  it.each([undefined, null, '', 'security', 'https://example.com'])(
    'rejects arbitrary renderer input: %j',
    (value) => {
      expect(feedbackIssueUrl(value)).toBeNull();
    },
  );
});
