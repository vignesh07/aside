import { scanClaudeSessions } from './claude-scanner.js';
import { scanCodexSessions } from './codex-scanner.js';
import { scanPiSessions } from './pi-scanner.js';
import type { TrackedSession, ScopeFilter } from '../types/session.js';

export interface ScanResult {
  sessions: TrackedSession[];
  jsonlPaths: Map<string, string>; // sessionId → jsonlPath
}

export function scanAllSessions(filter: ScopeFilter): ScanResult {
  const sessions: TrackedSession[] = [];
  const jsonlPaths = new Map<string, string>();

  // Scan both sources unless filtered
  if (filter.source !== 'codex' && filter.source !== 'pi') {
    for (const { session, jsonlPath } of scanClaudeSessions()) {
      if (matchesFilter(session, filter)) {
        sessions.push(session);
        jsonlPaths.set(session.id, jsonlPath);
      }
    }
  }

  if (filter.source !== 'claude' && filter.source !== 'pi') {
    for (const { session, jsonlPath } of scanCodexSessions()) {
      if (matchesFilter(session, filter)) {
        sessions.push(session);
        jsonlPaths.set(session.id, jsonlPath);
      }
    }
  }

  if (filter.source !== 'claude' && filter.source !== 'codex') {
    for (const { session, jsonlPath } of scanPiSessions()) {
      if (matchesFilter(session, filter)) {
        sessions.push(session);
        jsonlPaths.set(session.id, jsonlPath);
      }
    }
  }

  // Sort: active first, then idle, then by last event time (newest first)
  sessions.sort((a, b) => {
    const statusOrder = { active: 0, idle: 1, ended: 2 };
    const statusDiff = statusOrder[a.status] - statusOrder[b.status];
    if (statusDiff !== 0) return statusDiff;
    return b.lastEventTime.getTime() - a.lastEventTime.getTime();
  });

  return { sessions, jsonlPaths };
}

function matchesFilter(session: TrackedSession, filter: ScopeFilter): boolean {
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
