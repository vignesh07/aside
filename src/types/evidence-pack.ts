import type {
  ActivityEventKind,
  ActivityLifecycle,
  ActivitySeverity,
} from './activity.js';
import type { SessionSource } from './session.js';

export interface ActivityEvidenceItem {
  /** Stable citation token suitable for generated prose. */
  ref: string;
  eventId: string;
  seq: number;
  occurredAtMs: number;
  source: SessionSource;
  /** Redacted, clamped display label; never a filesystem path. */
  projectName: string;
  /** Redacted, clamped display label; never a raw transcript record. */
  title: string;
  kind: ActivityEventKind;
  lifecycle: ActivityLifecycle;
  severity: ActivitySeverity;
  /** Redacted normalized activity summary, never a raw transcript record. */
  summary: string;
  /** Hash retained by the ledger; the source record itself is not copied. */
  evidenceHash: string;
  truncated: boolean;
}

export interface ActivityEvidencePack {
  version: 1;
  /**
   * Highest input sequence considered before budgets were applied. This lets
   * callers detect new activity even when a tight pack omitted older evidence.
   */
  highWaterSeq: number;
  /** SHA-256 of the canonical, selected evidence input. */
  inputHash: string;
  evidenceIds: string[];
  evidence: ActivityEvidenceItem[];
  /**
   * Provider-ready evidence text. This is the only field governed by the
   * character budget and the only evidence field intended for model input.
   */
  text: string;
  characterCount: number;
  omittedEventCount: number;
}

export interface ActivityEvidencePackBudget {
  maxEvents: number;
  maxCharacters: number;
}
