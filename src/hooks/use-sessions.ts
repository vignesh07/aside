import { useState, useEffect, useCallback, useRef } from 'react';
import { scanAllSessions } from '../core/session-scanner.js';
import { TIMING } from '../config/defaults.js';
import type { TrackedSession, ScopeFilter } from '../types/session.js';

interface UseSessionsResult {
  sessions: TrackedSession[];
  selectedId: string | null;
  /** null selects the fleet thread. */
  selectSession: (id: string | null) => void;
  selectNext: () => void;
  selectPrev: () => void;
  setSessionActivity: (sessionId: string, activity: string) => void;
  jsonlPaths: Map<string, string>;
}

export function useSessions(scopeFilter: ScopeFilter): UseSessionsResult {
  const [sessions, setSessions] = useState<TrackedSession[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const jsonlPathsRef = useRef<Map<string, string>>(new Map());

  const refresh = useCallback(() => {
    const result = scanAllSessions(scopeFilter);
    setSessions((prev) => {
      const prevById = new Map(prev.map((s) => [s.id, s]));
      return result.sessions.map((s) => {
        const previous = prevById.get(s.id);
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
      prev && result.sessions.some((session) => session.id === prev) ? prev : null,
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
      if (prev === null) return sessions[0]!.id;
      const idx = sessions.findIndex((s) => s.id === prev);
      if (idx < 0 || idx === sessions.length - 1) return null;
      return sessions[idx + 1]!.id;
    });
  }, [sessions]);

  const selectPrev = useCallback(() => {
    setSelectedId((prev) => {
      if (sessions.length === 0) return null;
      if (prev === null) return sessions.at(-1)!.id;
      const idx = sessions.findIndex((s) => s.id === prev);
      if (idx <= 0) return null;
      return sessions[idx - 1]!.id;
    });
  }, [sessions]);

  const setSessionActivity = useCallback((sessionId: string, activity: string) => {
    setSessions((current) =>
      current.map((s) => {
        if (s.id !== sessionId) return s;
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
