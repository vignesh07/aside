import type {
  ActivityEventKind,
  ActivitySeverity,
  ThreadActivityCursor,
} from './activity.js';
import type { SessionSource } from './session.js';

/**
 * A compact pointer back to the private activity ledger.
 *
 * Reporting code deliberately carries identifiers and hashes, never raw
 * transcript content.
 */
export interface ActivityEvidenceRef {
  eventId: string;
  evidenceHash: string;
  threadKey: string;
  kind: ActivityEventKind;
  occurredAtMs: number;
  observedAtMs: number;
  summary: string;
}

export interface ActivityFactCounts {
  eventCount: number;
  waitingCount: number;
  errorCount: number;
  warningCount: number;
  completionCount: number;
}

export interface LocalDayRange {
  /** ISO-like local calendar date, independent of the host locale. */
  dateKey: string;
  timeZone: string;
  startMs: number;
  endMs: number;
}

export interface TodayThreadMember {
  threadKey: string;
  parentThreadKey?: string;
  source: SessionSource;
  sessionId: string;
  title: string;
  isRoot: boolean;
  counts: ActivityFactCounts;
  /** Timestamp from the latest prompt/work/progress evidence. */
  lastObservedWorkAtMs: number | null;
  evidence: ActivityEvidenceRef[];
}

/**
 * One root conversation in Today. Subagent evidence is rolled into counts and
 * also retained in `subagents` so the UI can disclose where work happened.
 */
export interface TodayThreadDiary {
  threadKey: string;
  projectName: string;
  projectPath: string;
  title: string;
  sources: SessionSource[];
  memberThreadCount: number;
  memberThreadKeys: string[];
  counts: ActivityFactCounts;
  lastObservedWorkAtMs: number | null;
  evidence: ActivityEvidenceRef[];
  subagents: TodayThreadMember[];
}

export interface TodayProjectDiary {
  projectKey: string;
  projectName: string;
  projectPath: string;
  threadCount: number;
  memberThreadCount: number;
  counts: ActivityFactCounts;
  lastObservedWorkAtMs: number | null;
  threads: TodayThreadDiary[];
}

export interface TodayDiary {
  range: LocalDayRange;
  projectCount: number;
  /** Number of rolled-up root conversations. */
  threadCount: number;
  /** Root conversations plus their visible subagent threads. */
  memberThreadCount: number;
  counts: ActivityFactCounts;
  lastObservedWorkAtMs: number | null;
  projects: TodayProjectDiary[];
}

export type ActivityInsightKind =
  | 'waiting'
  | 'terminal_failure'
  | 'warning_burst'
  | 'quiet_work'
  | 'unreviewed_completion';

export interface ActivityInsight {
  /** Stable for a rule and its decisive evidence. */
  insightId: string;
  kind: ActivityInsightKind;
  severity: ActivitySeverity;
  threadKey: string;
  /** Root key used to place subagent insights beneath their conversation. */
  rootThreadKey: string;
  projectName: string;
  projectPath: string;
  title: string;
  occurredAtMs: number;
  headline: string;
  detail: string;
  evidence: ActivityEvidenceRef[];
}

export interface ActivityInsightOptions {
  nowMs?: number;
  cursors?: Iterable<ThreadActivityCursor>;
  quietAfterMs?: number;
  warningBurstCount?: number;
  warningBurstWindowMs?: number;
  warningBurstFreshnessMs?: number;
}
