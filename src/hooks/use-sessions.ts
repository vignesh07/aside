import { useState, useEffect, useCallback, useRef } from 'react';
import {
  mergeOpenCodeScanResult,
  scanAllSessions,
} from '../core/session-scanner.js';
import { OpenCodeScanCoordinator } from '../core/opencode-scan-coordinator.js';
import { TIMING } from '../config/defaults.js';
import { sessionThreadId } from '../types/chat.js';
import type { TrackedSession, ScopeFilter } from '../types/session.js';

interface UseSessionsResult {
  sessions: TrackedSession[];
  selectedId: string | null;
  /** null selects the fleet thread. */
  selectSession: (id: string | null) => void;
  selectNext: () => void;
  selectPrev: () => void;
  setSessionActivity: (
    sessionId: string,
    activity: string,
    source: TrackedSession['source'],
  ) => void;
  jsonlPaths: Map<string, string>;
}

export function useSessions(scopeFilter: ScopeFilter): UseSessionsResult {
  const [sessions, setSessions] = useState<TrackedSession[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const jsonlPathsRef = useRef<Map<string, string>>(new Map());
  const openCodeScanRef = useRef<OpenCodeScanCoordinator | null>(null);

  const refresh = useCallback(() => {
    const result = scanAllSessions(
      scopeFilter,
      { includeOpenCode: false },
    );
    const openCode = openCodeScanRef.current?.scan();
    if (openCode) mergeOpenCodeScanResult(result, openCode, scopeFilter);
    setSessions((prev) => {
      const prevById = new Map(
        prev.map((session) => [
          sessionThreadId(session.source, session.id),
          session,
        ]),
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
      prev && result.sessions.some(
        (session) => sessionThreadId(session.source, session.id) === prev,
      ) ? prev : null,
    );
  }, [scopeFilter]);

  useEffect(() => {
    let coordinator: OpenCodeScanCoordinator | null = null;
    try {
      coordinator = new OpenCodeScanCoordinator(refresh);
    } catch {
      // Other session sources remain usable if worker threads are unavailable.
    }
    openCodeScanRef.current = coordinator;
    refresh();
    const interval = setInterval(refresh, TIMING.scanIntervalMs);
    return () => {
      clearInterval(interval);
      coordinator?.dispose();
      if (openCodeScanRef.current === coordinator) openCodeScanRef.current = null;
    };
  }, [refresh]);

  const selectNext = useCallback(() => {
    setSelectedId((prev) => {
      if (sessions.length === 0) return null;
      if (prev === null) {
        return sessionThreadId(sessions[0]!.source, sessions[0]!.id);
      }
      const idx = sessions.findIndex(
        (session) => sessionThreadId(session.source, session.id) === prev,
      );
      if (idx < 0 || idx === sessions.length - 1) return null;
      return sessionThreadId(sessions[idx + 1]!.source, sessions[idx + 1]!.id);
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
        (session) => sessionThreadId(session.source, session.id) === prev,
      );
      if (idx <= 0) return null;
      return sessionThreadId(sessions[idx - 1]!.source, sessions[idx - 1]!.id);
    });
  }, [sessions]);

  const setSessionActivity = useCallback((
    sessionId: string,
    activity: string,
    source: TrackedSession['source'],
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
