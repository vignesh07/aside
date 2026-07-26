/**
 * Explicitly generated, private local artifacts.
 *
 * These records contain generated prose, never source transcript records. The
 * evidence IDs and input watermark make every saved artifact traceable back to
 * the normalized activity ledger that produced its prompt.
 */
export interface GeneratedArtifactBase {
  id: string;
  createdAt: string;
  provider: string;
  model: string;
  inputHighWaterSeq: number;
  inputHash: string;
  evidenceIds: string[];
  markdown: string;
}

export interface GeneratedDailyRecapArtifact extends GeneratedArtifactBase {
  kind: 'daily_recap';
  /** Local calendar day in YYYY-MM-DD form. */
  day: string;
}

export interface GeneratedThreadReviewArtifact extends GeneratedArtifactBase {
  kind: 'thread_review';
  /** Source-qualified activity-ledger thread key. */
  threadKey: string;
}

export type GeneratedArtifact =
  | GeneratedDailyRecapArtifact
  | GeneratedThreadReviewArtifact;
