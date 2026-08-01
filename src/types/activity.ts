import type { SessionSource, SessionStatus } from './session.js';
import type { SessionEvent } from './events.js';

export type ActivityEventKind =
  | 'session_started'
  | 'prompt'
  | 'work_started'
  | 'progress'
  | 'input_requested'
  | 'turn_completed'
  | 'turn_failed'
  | 'turn_interrupted'
  | 'tool_warning';

export type ActivityLifecycle = 'start' | 'progress' | 'blocked' | 'terminal';
export type ActivitySeverity = 'info' | 'attention' | 'warning' | 'error';

export type ThreadAttentionKind =
  | 'none'
  | 'waiting'
  | 'failed'
  | 'interrupted'
  | 'completed'
  | 'stalled'
  | 'forgotten';

export interface ActivityEventRecord {
  /** Monotonic local ordering, independent of vendor clock skew. */
  seq: number;
  /** Stable across restarts and repeated transcript-tail hydration. */
  eventId: string;
  threadKey: string;
  source: SessionSource;
  sessionId: string;
  parentThreadKey?: string;
  rootThreadKey?: string;
  projectName: string;
  projectPath: string;
  title: string;
  occurredAtMs: number;
  observedAtMs: number;
  kind: ActivityEventKind;
  /** Original normalized scanner event kind when known (v3+ ledger rows). */
  originKind?: SessionEvent['kind'];
  lifecycle: ActivityLifecycle;
  severity: ActivitySeverity;
  summary: string;
  /** Vendor UUID/call id when one exists. */
  originId?: string;
  /** Hash of the source JSONL record; the raw record is never copied here. */
  evidenceHash: string;
  seeded: boolean;
}

export interface ActivitySessionMetadata {
  threadKey: string;
  sessionId: string;
  source: SessionSource;
  parentThreadKey?: string;
  rootThreadKey?: string;
  projectName: string;
  projectPath: string;
  title: string;
  status: SessionStatus;
  currentActivity: string;
  lastEventAtMs: number;
}

export interface ThreadActivityCursor {
  threadKey: string;
  /** Existing history at first install is factual context, not unread work. */
  baselineAtMs: number;
  /** Evidence the user has opened; this changes badge emphasis only. */
  viewedThroughSeq: number;
  /** Evidence the user explicitly reviewed; opening never advances this. */
  resolvedThroughSeq: number;
}

export interface ThreadAttentionState {
  kind: ThreadAttentionKind;
  /** Short, stable status copy for the selected-thread surface. */
  headline: string;
  /** Factual context derived from the local session log. */
  context: string;
  reason: string;
  sinceMs: number | null;
  unread: boolean;
  inferred: boolean;
  /** True only when the decisive event was observed live in this app run. */
  observedLive: boolean;
}

export interface ActivityLedgerState {
  events: ActivityEventRecord[];
  cursors: ThreadActivityCursor[];
}
