import { scanClaudeSessions } from './claude-scanner.js';
import { scanCodexSessions } from './codex-scanner.js';
import { scanPiSessions } from './pi-scanner.js';
import { OBSERVER_PROJECT_MARKER } from './providers/claude-cli.js';
import { sessionThreadId } from '../types/chat.js';
import type { TrackedSession, ScopeFilter } from '../types/session.js';

export interface ScanResult {
  sessions: TrackedSession[];
  /** Provider-qualified session thread id → jsonlPath. */
  jsonlPaths: Map<string, string>;
}

export interface ScanOptions {
  /** Include vendor worker transcripts for consumers such as content search. */
  includeInternal?: boolean;
  /** @deprecated Use `includeInternal`; retained for older callers. */
  includeInternalCodex?: boolean;
}

export function scanAllSessions(
  filter: ScopeFilter,
  options: ScanOptions = {},
): ScanResult {
  const sessions: TrackedSession[] = [];
  const jsonlPaths = new Map<string, string>();

  // Scan both sources unless filtered
  if (filter.source !== 'codex' && filter.source !== 'pi') {
    for (const { session, jsonlPath } of scanClaudeSessions({
      includeInternal: options.includeInternal,
    })) {
      if (matchesFilter(session, filter)) {
        sessions.push(session);
        jsonlPaths.set(
          sessionThreadId(session.source, session.id),
          jsonlPath,
        );
      }
    }
  }

  if (filter.source !== 'claude' && filter.source !== 'pi') {
    for (const { session, jsonlPath } of scanCodexSessions({
      includeInternal:
        options.includeInternal ?? options.includeInternalCodex,
    })) {
      if (matchesFilter(session, filter)) {
        sessions.push(session);
        jsonlPaths.set(
          sessionThreadId(session.source, session.id),
          jsonlPath,
        );
      }
    }
  }

  if (filter.source !== 'claude' && filter.source !== 'codex') {
    for (const { session, jsonlPath } of scanPiSessions()) {
      if (matchesFilter(session, filter)) {
        sessions.push(session);
        jsonlPaths.set(
          sessionThreadId(session.source, session.id),
          jsonlPath,
        );
      }
    }
  }

  // Sort recent activity first, then searchable history, newest first per tier.
  sessions.sort((a, b) => {
    const statusOrder = { active: 0, idle: 1, history: 2 };
    const statusDiff = statusOrder[a.status] - statusOrder[b.status];
    if (statusDiff !== 0) return statusDiff;
    return b.lastEventTime.getTime() - a.lastEventTime.getTime();
  });

  return { sessions, jsonlPaths };
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
