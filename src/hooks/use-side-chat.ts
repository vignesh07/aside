import { useState, useEffect, useRef, useCallback } from 'react';
import { SessionTailer } from '../core/session-tailer.js';
import { classifyLine, activityFromEvent } from '../core/event-classifier.js';
import { SideChatEngine } from '../core/side-chat-engine.js';
import type { SessionEvent } from '../types/events.js';
import type { ChatTurn } from '../types/chat.js';
import type { TrackedSession, SessionSource } from '../types/session.js';

/** Max transcript events kept per session, to bound the prompt sent to the model. */
const MAX_TRANSCRIPT = 150;

interface UseSideChatProps {
  sessions: TrackedSession[];
  jsonlPaths: Map<string, string>;
  selectedId: string | null;
  provider: string;
  model: string;
  authFile?: string;
  onSessionActivity: (sessionId: string, activity: string) => void;
}

interface UseSideChatResult {
  /** Recent activity of the selected session, oldest-first. */
  transcript: SessionEvent[];
  /** Side-chat turns for the selected session. */
  messages: ChatTurn[];
  isThinking: boolean;
  ask: (question: string) => void;
}

let turnSeq = 0;
function newTurn(role: ChatTurn['role'], content: string, error = false): ChatTurn {
  turnSeq += 1;
  return { id: `t${turnSeq}-${Date.now()}`, role, content, timestamp: new Date(), error };
}

export function useSideChat({
  sessions,
  jsonlPaths,
  selectedId,
  provider,
  model,
  authFile,
  onSessionActivity,
}: UseSideChatProps): UseSideChatResult {
  // Per-session transcript buffers live in a ref (high-churn, read at ask-time);
  // a version counter pushes the selected one into render state.
  const transcriptsRef = useRef<Map<string, SessionEvent[]>>(new Map());
  const [, bumpVersion] = useState(0);

  // Chat histories are keyed by session so switching sessions keeps separate threads.
  const [chats, setChats] = useState<Record<string, ChatTurn[]>>({});
  const [isThinking, setIsThinking] = useState(false);

  const engineRef = useRef<SideChatEngine | null>(null);
  const tailerRef = useRef<SessionTailer | null>(null);
  const sourceMapRef = useRef<Map<string, SessionSource>>(new Map());
  const selectedIdRef = useRef<string | null>(selectedId);
  selectedIdRef.current = selectedId;
  const sessionsRef = useRef<TrackedSession[]>(sessions);
  sessionsRef.current = sessions;
  const chatsRef = useRef<Record<string, ChatTurn[]>>(chats);
  chatsRef.current = chats;

  // (Re)build the engine when the model changes.
  useEffect(() => {
    engineRef.current = new SideChatEngine({ provider, model, authFile });
    return () => {
      engineRef.current = null;
    };
  }, [provider, model, authFile]);

  // Tailer: classify every line into the watched session's transcript buffer.
  useEffect(() => {
    const tailer = new SessionTailer();
    tailerRef.current = tailer;

    tailer.on('line', ({ sessionId, line, isSeed }: { sessionId: string; line: string; isSeed: boolean }) => {
      const source = sourceMapRef.current.get(sessionId) ?? 'claude';
      const event = classifyLine(line, source);
      if (!event) return;

      const buf = transcriptsRef.current.get(sessionId) ?? [];
      buf.push(event);
      if (buf.length > MAX_TRANSCRIPT) buf.splice(0, buf.length - MAX_TRANSCRIPT);
      transcriptsRef.current.set(sessionId, buf);

      if (!isSeed) {
        const activity = activityFromEvent(event);
        if (activity) onSessionActivity(sessionId, activity);
      }

      if (sessionId === selectedIdRef.current) {
        bumpVersion((v) => v + 1);
      }
    });

    return () => {
      tailer.stopAll();
      tailerRef.current = null;
    };
  }, [onSessionActivity]);

  // Sync which sessions are being tailed with the active set.
  useEffect(() => {
    const tailer = tailerRef.current;
    if (!tailer) return;

    const sourceMap = new Map<string, SessionSource>();
    for (const s of sessions) sourceMap.set(s.id, s.source);
    sourceMapRef.current = sourceMap;

    const activeIds = new Set<string>();
    for (const s of sessions) {
      if (s.status === 'active' || s.status === 'idle') {
        activeIds.add(s.id);
        const jsonlPath = jsonlPaths.get(s.id);
        if (jsonlPath && !tailer.tailedSessionIds.includes(s.id)) {
          tailer.startTailing(s.id, jsonlPath);
        }
      }
    }
    for (const id of tailer.tailedSessionIds) {
      if (!activeIds.has(id)) tailer.stopTailing(id);
    }
  }, [sessions, jsonlPaths]);

  const ask = useCallback((question: string) => {
    const sessionId = selectedIdRef.current;
    const trimmed = question.trim();
    if (!sessionId || !trimmed) return;
    const engine = engineRef.current;
    if (!engine) return;

    const history = chatsRef.current[sessionId] ?? [];
    const userTurn = newTurn('user', trimmed);
    setChats((prev) => ({ ...prev, [sessionId]: [...(prev[sessionId] ?? []), userTurn] }));
    setIsThinking(true);

    const session = sessionsRef.current.find((s) => s.id === sessionId);
    const projectName = session
      ? `${session.projectName}${session.gitBranch ? ` (${session.gitBranch})` : ''}`
      : 'unknown';
    const transcript = [...(transcriptsRef.current.get(sessionId) ?? [])];

    engine
      .ask({ projectName, transcript, history, question: trimmed })
      .then((answer) => {
        setChats((prev) => ({
          ...prev,
          [sessionId]: [...(prev[sessionId] ?? []), newTurn('assistant', answer)],
        }));
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        setChats((prev) => ({
          ...prev,
          [sessionId]: [...(prev[sessionId] ?? []), newTurn('assistant', `⚠ ${message}`, true)],
        }));
      })
      .finally(() => setIsThinking(false));
  }, []);

  const transcript = selectedId ? transcriptsRef.current.get(selectedId) ?? [] : [];
  const messages = selectedId ? chats[selectedId] ?? [] : [];

  return { transcript, messages, isThinking, ask };
}
