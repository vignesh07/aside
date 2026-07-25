import { useState, useEffect, useCallback, useRef } from 'react';
import { scanAllSessions } from '../core/session-scanner.js';
import { TIMING } from '../config/defaults.js';
import { sessionThreadId } from '../types/chat.js';
import type {
  TrackedSession,
  ScopeFilter,
  SessionSource,
} from '../types/session.js';

interface UseSessionsResult {
  sessions: TrackedSession[];
  /** Provider-qualified session thread id, or null for fleet. */
  selectedId: string | null;
  /** null selects the fleet thread. */
  selectSession: (threadId: string | null) => void;
  selectNext: () => void;
  selectPrev: () => void;
  setSessionActivity: (
    sessionId: string,
    activity: string,
    source: SessionSource,
  ) => void;
  jsonlPaths: Map<string, string>;
}

export function useSessions(scopeFilter: ScopeFilter): UseSessionsResult {
  const [sessions, setSessions] = useState<TrackedSession[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const jsonlPathsRef = useRef<Map<string, string>>(new Map());

  const refresh = useCallback(() => {
    const result = scanAllSessions(scopeFilter);
    setSessions((prev) => {
      const prevById = new Map(
        prev.map((s) => [sessionThreadId(s.source, s.id), s]),
      );
      return result.sessions.map((s) => {
        const previous = prevById.get(sessionThreadId(s.source, s.id));
        if (!previous) return s;
        return {
          ...s,
          currentActivity: previous.currentActivity,
          eventCount: previous.eventCount,
        };
      });
    });
    jsonlPathsRef.current = result.jsonlPaths;

    // Fleet is a real thread, represented by null. If a selected session
    // disappears, return to fleet rather than silently opening another chat.
    setSelectedId((prev) =>
      prev &&
      result.sessions.some(
        (session) => sessionThreadId(session.source, session.id) === prev,
      )
        ? prev
        : null,
    );
  }, [scopeFilter]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, TIMING.scanIntervalMs);
    return () => clearInterval(interval);
  }, [refresh]);

  const selectNext = useCallback(() => {
    setSelectedId((prev) => {
      if (sessions.length === 0) return null;
      if (prev === null) {
        const first = sessions[0]!;
        return sessionThreadId(first.source, first.id);
      }
      const idx = sessions.findIndex(
        (s) => sessionThreadId(s.source, s.id) === prev,
      );
      if (idx < 0 || idx === sessions.length - 1) return null;
      const next = sessions[idx + 1]!;
      return sessionThreadId(next.source, next.id);
    });
  }, [sessions]);

  const selectPrev = useCallback(() => {
    setSelectedId((prev) => {
      if (sessions.length === 0) return null;
      if (prev === null) {
        const last = sessions.at(-1)!;
        return sessionThreadId(last.source, last.id);
      }
      const idx = sessions.findIndex(
        (s) => sessionThreadId(s.source, s.id) === prev,
      );
      if (idx <= 0) return null;
      const previous = sessions[idx - 1]!;
      return sessionThreadId(previous.source, previous.id);
    });
  }, [sessions]);

  const setSessionActivity = useCallback((
    sessionId: string,
    activity: string,
    source: SessionSource,
  ) => {
    setSessions((current) =>
      current.map((s) => {
        if (s.id !== sessionId || s.source !== source) return s;
        return {
          ...s,
          currentActivity: activity,
          eventCount: s.eventCount + 1,
          status: 'active',
          lastEventTime: new Date(),
        };
      })
    );
  }, []);

  return {
    sessions,
    selectedId,
    selectSession: setSelectedId,
    selectNext,
    selectPrev,
    setSessionActivity,
    jsonlPaths: jsonlPathsRef.current,
  };
}
