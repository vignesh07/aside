import { useState, useEffect, useRef, useCallback } from 'react';
import { SideChatEngine } from '../core/side-chat-engine.js';
import { SideChatService } from '../core/side-chat-service.js';
import { FileThreadStore } from '../core/thread-store.js';
import { FLEET_THREAD_ID, sessionThreadId } from '../types/chat.js';
import type { ChatTurn } from '../types/chat.js';
import type {
  SessionAttention,
  TrackedSession,
  SessionSource,
} from '../types/session.js';

interface UseSideChatProps {
  sessions: TrackedSession[];
  jsonlPaths: Map<string, string>;
  /** Provider-qualified session thread id, or null for fleet. */
  selectedThreadId: string | null;
  defaultProvider: string;
  defaultModel: string;
  onSessionActivity: (
    sessionId: string,
    activity: string,
    source: SessionSource,
  ) => void;
}

interface UseSideChatResult {
  messages: ChatTurn[];
  isThinking: boolean;
  provider: string;
  model: string;
  attentionBySession: Map<string, SessionAttention>;
  ask: (question: string) => void;
  setModel: (provider: string, model: string) => void;
}

/** Thin React wrapper over the shared durable threaded service. */
export function useSideChat({
  sessions,
  jsonlPaths,
  selectedThreadId,
  defaultProvider,
  defaultModel,
  onSessionActivity,
}: UseSideChatProps): UseSideChatResult {
  const [, bump] = useState(0);
  const rerender = useCallback(() => bump((value) => value + 1), []);

  const onActivityRef = useRef(onSessionActivity);
  onActivityRef.current = onSessionActivity;
  const serviceRef = useRef<SideChatService | null>(null);

  if (serviceRef.current === null) {
    serviceRef.current = new SideChatService(
      new SideChatEngine({ provider: defaultProvider, model: defaultModel }),
      {
        onActivity: (id, activity, source) =>
          onActivityRef.current(id, activity, source),
        onThinking: rerender,
        onChat: rerender,
        onTranscript: rerender,
        onAttention: rerender,
        onThread: rerender,
      },
      () => new Date(),
      {
        provider: defaultProvider,
        model: defaultModel,
        store: new FileThreadStore(),
      },
    );
  }

  useEffect(() => {
    serviceRef.current?.syncSessions(sessions, jsonlPaths);
  }, [sessions, jsonlPaths]);

  useEffect(() => {
    serviceRef.current?.selectThread(
      selectedThreadId ?? FLEET_THREAD_ID,
    );
  }, [selectedThreadId]);

  useEffect(() => {
    return () => {
      serviceRef.current?.dispose();
      serviceRef.current = null;
    };
  }, []);

  const ask = useCallback((question: string) => {
    void serviceRef.current?.ask(question);
  }, []);

  const setModel = useCallback((provider: string, model: string) => {
    serviceRef.current?.setModel(provider, model);
  }, []);

  const service = serviceRef.current;
  const active = service?.getActiveThread();
  return {
    messages: active?.turns ?? [],
    isThinking: active?.thinking ?? false,
    provider: active?.provider ?? defaultProvider,
    model: active?.model ?? defaultModel,
    attentionBySession: new Map(
      sessions.map((session) => [
        sessionThreadId(session.source, session.id),
        service?.getSessionAttention(session.id, session.source) ?? {
          needsUser: false,
          reason: '',
        },
      ]),
    ),
    ask,
    setModel,
  };
}
