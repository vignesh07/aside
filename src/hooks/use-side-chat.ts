import { useState, useEffect, useRef, useCallback } from 'react';
import { SideChatEngine } from '../core/side-chat-engine.js';
import { SideChatService } from '../core/side-chat-service.js';
import type { SessionEvent } from '../types/events.js';
import type { ChatTurn } from '../types/chat.js';
import type { TrackedSession } from '../types/session.js';

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

/**
 * Thin React wrapper over {@link SideChatService}: it owns a single service
 * instance and re-renders when the service reports changes. All real logic
 * lives in the service so the Electron menubar can reuse it untouched.
 */
export function useSideChat({
  sessions,
  jsonlPaths,
  selectedId,
  provider,
  model,
  authFile,
  onSessionActivity,
}: UseSideChatProps): UseSideChatResult {
  const [, bump] = useState(0);
  const rerender = useCallback(() => bump((v) => v + 1), []);

  const onActivityRef = useRef(onSessionActivity);
  onActivityRef.current = onSessionActivity;
  const selectedIdRef = useRef<string | null>(selectedId);
  selectedIdRef.current = selectedId;

  const serviceRef = useRef<SideChatService | null>(null);

  // One service for the lifetime of the hook; the engine is swapped on model change.
  if (serviceRef.current === null) {
    serviceRef.current = new SideChatService(new SideChatEngine({ provider, model, authFile }), {
      onActivity: (id, activity) => onActivityRef.current(id, activity),
      onThinking: rerender,
      onChat: (id) => {
        if (id === selectedIdRef.current) rerender();
      },
      onTranscript: (id) => {
        if (id === selectedIdRef.current) rerender();
      },
    });
  }

  useEffect(() => {
    serviceRef.current?.setModel(provider, model);
  }, [provider, model, authFile]);

  useEffect(() => {
    serviceRef.current?.syncSessions(sessions, jsonlPaths);
  }, [sessions, jsonlPaths]);

  useEffect(() => {
    return () => {
      serviceRef.current?.dispose();
      serviceRef.current = null;
    };
  }, []);

  const ask = useCallback((question: string) => {
    void serviceRef.current?.ask(selectedIdRef.current, question);
  }, []);

  const service = serviceRef.current;
  return {
    transcript: selectedId && service ? service.getTranscript(selectedId) : [],
    messages: selectedId && service ? service.getChat(selectedId) : [],
    isThinking: service?.isThinking() ?? false,
    ask,
  };
}
