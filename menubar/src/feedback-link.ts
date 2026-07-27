export type FeedbackKind = 'bug' | 'feature';

const ISSUE_URL = 'https://github.com/vignesh07/aside/issues/new';
const ISSUE_TEMPLATES: Record<FeedbackKind, string> = {
  bug: 'bug_report.yml',
  feature: 'feature_request.yml',
};

/**
 * Keep external feedback navigation on a fixed allowlist. The renderer chooses
 * only the feedback kind; it can never supply an arbitrary URL to Electron.
 */
export function feedbackIssueUrl(value: unknown): string | null {
  if (value !== 'bug' && value !== 'feature') return null;

  const url = new URL(ISSUE_URL);
  url.searchParams.set('template', ISSUE_TEMPLATES[value]);
  return url.href;
}
