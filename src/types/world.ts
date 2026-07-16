import type { SessionEvent } from './events.js';
import type { SessionSource, SessionStatus, ContextHealth } from './session.js';

/**
 * One agent session as the observer sees it.
 *
 * This is deliberately *not* {@link TrackedSession}: it carries derived,
 * wall-clock state (`idleForMs`) that only makes sense relative to an instant.
 * Idleness is the thing the raw event stream can never tell you — nothing is
 * written to a transcript when nothing happens — so it has to be computed from
 * `lastEventTime` against a known "now" and handed to the model explicitly.
 */
export interface SessionSnapshot {
  id: string;
  source: SessionSource;
  projectName: string;
  gitBranch: string;
  model: string;
  status: SessionStatus;
  /** Milliseconds since this session's last observed event, at snapshot time. */
  idleForMs: number;
  /** Last thing the session was seen doing, one line. */
  currentActivity: string;
  contextUsedPercent: number;
  contextStatus: ContextHealth;
  /** Recent events for this session, oldest-first. */
  transcript: SessionEvent[];
}

/**
 * Everything the observer knows, at one instant.
 *
 * Scope note: this is every *agent session* aside can discover on disk — not
 * everything happening on the machine. It has no view of builds, containers, or
 * other terminals, and the prompt says so, so the model doesn't imply otherwise.
 */
export interface WorldSnapshot {
  /** The instant this snapshot describes; all idle math is relative to it. */
  now: Date;
  sessions: SessionSnapshot[];
  /**
   * Session the user has focused, if any. Focus only buys a deeper transcript
   * slice in the prompt — it never hides the other sessions.
   */
  focusId: string | null;
}
