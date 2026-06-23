import { useState, useEffect, useCallback, useRef } from 'react';
import { scanAllSessions } from '../core/session-scanner.js';
import { TIMING } from '../config/defaults.js';
import type { TrackedSession, ScopeFilter } from '../types/session.js';

interface UseSessionsResult {
  sessions: TrackedSession[];
  selectedId: string | null;
  selectSession: (id: string) => void;
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

    // Auto-select first session if nothing selected or selection disappeared
    if (result.sessions.length > 0) {
      setSelectedId((prev) => {
        if (prev && result.sessions.some((s) => s.id === prev)) return prev;
        return result.sessions[0]!.id;
      });
    } else {
      setSelectedId(null);
    }
  }, [scopeFilter]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, TIMING.scanIntervalMs);
    return () => clearInterval(interval);
  }, [refresh]);

  const selectNext = useCallback(() => {
    setSelectedId((prev) => {
      if (sessions.length === 0) return prev;
      const idx = sessions.findIndex((s) => s.id === prev);
      const nextIdx = idx < 0 ? 0 : (idx + 1) % sessions.length;
      return sessions[nextIdx]!.id;
    });
  }, [sessions]);

  const selectPrev = useCallback(() => {
    setSelectedId((prev) => {
      if (sessions.length === 0) return prev;
      const idx = sessions.findIndex((s) => s.id === prev);
      const prevIdx = idx < 0
        ? 0
        : (idx - 1 + sessions.length) % sessions.length;
      return sessions[prevIdx]!.id;
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
