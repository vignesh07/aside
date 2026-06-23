// Framework-agnostic side-chat service.
//
// This owns everything the side chat needs that has nothing to do with how it's
// rendered: tailing watched sessions, accumulating their transcripts, holding
// per-session chat history, and asking the engine. The Ink TUI hook and the
// Electron menubar both drive the *same* instance of this, so there's one copy
// of the logic regardless of frontend.

import { SessionTailer } from './session-tailer.js';
import { classifyLine, activityFromEvent } from './event-classifier.js';
import type { AskParams } from './side-chat-engine.js';
import type { SessionEvent } from '../types/events.js';
import type { ChatTurn } from '../types/chat.js';
import type { TrackedSession, SessionSource } from '../types/session.js';

/** Max transcript events kept per session, to bound the prompt sent to the model. */
const MAX_TRANSCRIPT = 150;

/** The slice of the engine the service depends on — injected so it can be faked in tests. */
export interface AskEngine {
  ask(params: AskParams): Promise<string>;
  setModel(provider: string, model: string): void;
}

/** Notifications the host (hook / Electron main) subscribes to. */
export interface SideChatServiceHandlers {
  /** A watched session's transcript grew. */
  onTranscript?: (sessionId: string) => void;
  /** A live (non-seed) event suggests new activity for a session. */
  onActivity?: (sessionId: string, activity: string) => void;
  /** A session's side-chat history changed (new question or answer). */
  onChat?: (sessionId: string) => void;
  /** The engine started/finished answering. */
  onThinking?: (thinking: boolean) => void;
}

export class SideChatService {
  private readonly tailer = new SessionTailer();
  private readonly transcripts = new Map<string, SessionEvent[]>();
  private readonly chats = new Map<string, ChatTurn[]>();
  private readonly sources = new Map<string, SessionSource>();
  private sessions: TrackedSession[] = [];
  private thinking = false;
  private turnSeq = 0;

  constructor(
    private readonly engine: AskEngine,
    private readonly handlers: SideChatServiceHandlers = {},
  ) {
    this.tailer.on(
      'line',
      ({ sessionId, line, isSeed }: { sessionId: string; line: string; isSeed: boolean }) => {
        const source = this.sources.get(sessionId) ?? 'claude';
        const event = classifyLine(line, source);
        if (!event) return;

        const buf = this.transcripts.get(sessionId) ?? [];
        buf.push(event);
        if (buf.length > MAX_TRANSCRIPT) buf.splice(0, buf.length - MAX_TRANSCRIPT);
        this.transcripts.set(sessionId, buf);

        if (!isSeed) {
          const activity = activityFromEvent(event);
          if (activity) this.handlers.onActivity?.(sessionId, activity);
        }
        this.handlers.onTranscript?.(sessionId);
      },
    );
  }

  setModel(provider: string, model: string): void {
    this.engine.setModel(provider, model);
  }

  /** Reconcile the set of tailed sessions with the currently active ones. */
  syncSessions(sessions: TrackedSession[], jsonlPaths: Map<string, string>): void {
    this.sessions = sessions;
    this.sources.clear();
    for (const s of sessions) this.sources.set(s.id, s.source);

    const activeIds = new Set<string>();
    for (const s of sessions) {
      if (s.status === 'active' || s.status === 'idle') {
        activeIds.add(s.id);
        const jsonlPath = jsonlPaths.get(s.id);
        if (jsonlPath && !this.tailer.tailedSessionIds.includes(s.id)) {
          this.tailer.startTailing(s.id, jsonlPath);
        }
      }
    }
    for (const id of this.tailer.tailedSessionIds) {
      if (!activeIds.has(id)) this.tailer.stopTailing(id);
    }
  }

  getTranscript(sessionId: string): SessionEvent[] {
    return this.transcripts.get(sessionId) ?? [];
  }

  getChat(sessionId: string): ChatTurn[] {
    return this.chats.get(sessionId) ?? [];
  }

  isThinking(): boolean {
    return this.thinking;
  }

  /** Ask the observer a question about a watched session. Resolves when answered. */
  async ask(sessionId: string | null, question: string): Promise<void> {
    const trimmed = question.trim();
    if (!sessionId || !trimmed) return;

    // History is the conversation *before* this question.
    const history = [...(this.chats.get(sessionId) ?? [])];
    this.appendTurn(sessionId, this.newTurn('user', trimmed));
    this.setThinking(true);

    const session = this.sessions.find((s) => s.id === sessionId);
    const projectName = session
      ? `${session.projectName}${session.gitBranch ? ` (${session.gitBranch})` : ''}`
      : 'unknown';
    const transcript = [...this.getTranscript(sessionId)];

    try {
      const answer = await this.engine.ask({ projectName, transcript, history, question: trimmed });
      this.appendTurn(sessionId, this.newTurn('assistant', answer));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.appendTurn(sessionId, this.newTurn('assistant', `⚠ ${message}`, true));
    } finally {
      this.setThinking(false);
    }
  }

  dispose(): void {
    this.tailer.stopAll();
  }

  private appendTurn(sessionId: string, turn: ChatTurn): void {
    const next = [...(this.chats.get(sessionId) ?? []), turn];
    this.chats.set(sessionId, next);
    this.handlers.onChat?.(sessionId);
  }

  private setThinking(thinking: boolean): void {
    this.thinking = thinking;
    this.handlers.onThinking?.(thinking);
  }

  private newTurn(role: ChatTurn['role'], content: string, error = false): ChatTurn {
    this.turnSeq += 1;
    return { id: `t${this.turnSeq}-${Date.now()}`, role, content, timestamp: new Date(), error };
  }
}
