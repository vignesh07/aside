import { scanClaudeSessions } from './claude-scanner.js';
import { scanCodexSessions } from './codex-scanner.js';
import { scanPiSessions } from './pi-scanner.js';
import { scanOpenCodeSessionsWithStatus } from './opencode-scanner.js';
import type { OpenCodeScanStatus } from './opencode-scanner.js';
import { OBSERVER_PROJECT_MARKER } from './providers/claude-cli.js';
import { sessionThreadId } from '../types/chat.js';
import type {
  TrackedSession,
  ScopeFilter,
  SessionSource,
} from '../types/session.js';

export interface ScanResult {
  sessions: TrackedSession[];
  /** Canonical source-qualified session thread id → transcript path. */
  jsonlPaths: Map<string, string>;
  /** Sources whose current roster may authoritatively add and remove rows. */
  authoritativeSources: Set<SessionSource>;
}

export interface ScanOptions {
  /** Include vendor worker transcripts for consumers such as content search. */
  includeInternal?: boolean;
  /** @deprecated Use `includeInternal`; retained for older callers. */
  includeInternalCodex?: boolean;
  /** Menubar supplies OpenCode from a worker so SQLite never blocks its UI loop. */
  includeOpenCode?: boolean;
}

export function scanAllSessions(
  filter: ScopeFilter,
  options: ScanOptions = {},
): ScanResult {
  const sessions: TrackedSession[] = [];
  const jsonlPaths = new Map<string, string>();
  const authoritativeSources = new Set<SessionSource>();

  if (!filter.source || filter.source === 'claude') {
    authoritativeSources.add('claude');
    for (const { session, jsonlPath } of scanClaudeSessions({
      includeInternal: options.includeInternal,
    })) {
      if (matchesFilter(session, filter)) {
        sessions.push(session);
        jsonlPaths.set(sessionThreadId(session.source, session.id), jsonlPath);
      }
    }
  }

  if (!filter.source || filter.source === 'codex') {
    authoritativeSources.add('codex');
    for (const { session, jsonlPath } of scanCodexSessions({
      includeInternal:
        options.includeInternal ?? options.includeInternalCodex,
    })) {
      if (matchesFilter(session, filter)) {
        sessions.push(session);
        jsonlPaths.set(sessionThreadId(session.source, session.id), jsonlPath);
      }
    }
  }

  if (!filter.source || filter.source === 'pi') {
    authoritativeSources.add('pi');
    for (const { session, jsonlPath } of scanPiSessions()) {
      if (matchesFilter(session, filter)) {
        sessions.push(session);
        jsonlPaths.set(sessionThreadId(session.source, session.id), jsonlPath);
      }
    }
  }

  if (
    options.includeOpenCode !== false &&
    (!filter.source || filter.source === 'opencode')
  ) {
    const openCode = scanOpenCodeSessionsWithStatus({
      includeInternal: options.includeInternal,
    });
    if (openCode.authoritative) authoritativeSources.add('opencode');
    for (const { session, jsonlPath } of openCode.sessions) {
      if (matchesFilter(session, filter)) {
        sessions.push(session);
        jsonlPaths.set(sessionThreadId(session.source, session.id), jsonlPath);
      }
    }
  }

  // Sort recent activity first, then searchable history, newest first per tier.
  sessions.sort(compareSessionsForDisplay);

  return { sessions, jsonlPaths, authoritativeSources };
}

/** Keep live work ahead of searchable history, newest first within each tier. */
export function compareSessionsForDisplay(
  left: TrackedSession,
  right: TrackedSession,
): number {
  const statusOrder = { active: 0, idle: 1, history: 2 } as const;
  const statusDiff = statusOrder[left.status] - statusOrder[right.status];
  if (statusDiff !== 0) return statusDiff;
  return right.lastEventTime.getTime() - left.lastEventTime.getTime();
}

/** Merge a completed worker snapshot into a synchronous vendor scan. */
export function mergeOpenCodeScanResult(
  result: ScanResult,
  openCode: OpenCodeScanStatus,
  filter: ScopeFilter,
): ScanResult {
  if (openCode.authoritative) result.authoritativeSources.add('opencode');
  const existing = new Set(
    result.sessions.map((session) => sessionThreadId(session.source, session.id)),
  );
  for (const { session, jsonlPath } of openCode.sessions) {
    if (!matchesFilter(session, filter)) continue;
    const threadId = sessionThreadId(session.source, session.id);
    if (!existing.has(threadId)) {
      result.sessions.push(session);
      existing.add(threadId);
    }
    result.jsonlPaths.set(threadId, jsonlPath);
  }
  result.sessions.sort(compareSessionsForDisplay);
  return result;
}

/**
 * True for sessions aside itself created.
 *
 * The claude-cli provider answers by running `claude -p`, and every such run
 * writes a transcript indistinguishable from any other Claude Code session. Left
 * alone, aside would discover its own answers, list itself as one of the user's
 * agents, and describe its own observations back to them — each question
 * spawning another session to notice next time. Those runs use a dedicated cwd
 * so they can be recognised by project path and dropped here, at the source.
 */
export function isObserverSession(session: TrackedSession): boolean {
  return (
    session.projectDir.includes(OBSERVER_PROJECT_MARKER) ||
    session.cwd.includes(OBSERVER_PROJECT_MARKER) ||
    session.projectName.includes(OBSERVER_PROJECT_MARKER)
  );
}

function matchesFilter(session: TrackedSession, filter: ScopeFilter): boolean {
  if (isObserverSession(session)) return false;
  if (filter.projectName && session.projectName !== filter.projectName) {
    return false;
  }

  if (filter.sessionIds && filter.sessionIds.length > 0) {
    const matches = filter.sessionIds.some((id) => session.id.startsWith(id));
    if (!matches) return false;
  }

  if (filter.source && session.source !== filter.source) {
    return false;
  }

  return true;
}
