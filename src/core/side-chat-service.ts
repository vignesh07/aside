// Framework-agnostic side-chat service.
//
// This owns everything the side chat needs that has nothing to do with how it's
// rendered: tailing every discoverable session, accumulating their transcripts,
// holding the chat history, and asking the engine. The Ink TUI hook and the
// Electron menubar both drive the *same* instance, so there's one copy of the
// logic regardless of frontend.
//
// The chat is a bird's-eye view: one conversation about all sessions, not one
// conversation per session. Focus is a lens that buys a session more transcript
// detail in the prompt — it never scopes the chat to that session.

import { SessionTailer } from './session-tailer.js';
import { classifyLine, activityFromEvent } from './event-classifier.js';
import { disposeClaudeSession } from './providers/index.js';
import type { AskParams } from './side-chat-engine.js';
import type { SessionEvent } from '../types/events.js';
import type { ChatTurn } from '../types/chat.js';
import type { TrackedSession, SessionSource } from '../types/session.js';
import type { SessionSnapshot, WorldSnapshot } from '../types/world.js';

/** Max transcript events retained per session. The prompt budget cuts further at render time. */
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
  /** The side-chat history changed (new question or answer). */
  onChat?: () => void;
  /** The engine started/finished answering. */
  onThinking?: (thinking: boolean) => void;
}

export class SideChatService {
  private readonly tailer = new SessionTailer();
  private readonly transcripts = new Map<string, SessionEvent[]>();
  private readonly sources = new Map<string, SessionSource>();
  private chat: ChatTurn[] = [];
  private sessions: TrackedSession[] = [];
  private focusId: string | null = null;
  private thinking = false;
  private turnSeq = 0;

  constructor(
    private readonly engine: AskEngine,
    private readonly handlers: SideChatServiceHandlers = {},
    /** Injectable clock so idle math is deterministic in tests. */
    private readonly now: () => Date = () => new Date(),
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

  /**
   * Focus a session, or null for none. Focus only deepens that session's
   * transcript in the prompt; the chat still spans every session.
   */
  setFocus(sessionId: string | null): void {
    this.focusId = sessionId;
  }

  getFocus(): string | null {
    return this.focusId;
  }

  getTranscript(sessionId: string): SessionEvent[] {
    return this.transcripts.get(sessionId) ?? [];
  }

  /** The one bird's-eye conversation. */
  getChat(): ChatTurn[] {
    return this.chat;
  }

  isThinking(): boolean {
    return this.thinking;
  }

  /** Everything the observer can see right now. */
  snapshot(): WorldSnapshot {
    const now = this.now();
    const sessions: SessionSnapshot[] = this.sessions.map((s) => ({
      id: s.id,
      source: s.source,
      projectName: s.projectName,
      gitBranch: s.gitBranch,
      model: s.model,
      status: s.status,
      idleForMs: Math.max(0, now.getTime() - s.lastEventTime.getTime()),
      currentActivity: s.currentActivity,
      contextUsedPercent: s.usedPercent,
      contextStatus: s.contextStatus,
      transcript: this.getTranscript(s.id),
    }));
    return { now, sessions, focusId: this.focusId };
  }

  /**
   * Ask the observer a question about the sessions it can see. Needs no session
   * selection — the whole world is in scope. Resolves when answered.
   */
  async ask(question: string): Promise<void> {
    const trimmed = question.trim();
    if (!trimmed) return;

    // History is the conversation *before* this question.
    const history = [...this.chat];
    this.appendTurn(this.newTurn('user', trimmed));
    this.setThinking(true);

    try {
      const answer = await this.engine.ask({ world: this.snapshot(), history, question: trimmed });
      this.appendTurn(this.newTurn('assistant', answer));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.appendTurn(this.newTurn('assistant', `⚠ ${message}`, true));
    } finally {
      this.setThinking(false);
    }
  }

  dispose(): void {
    this.tailer.stopAll();
    // The observer may be holding a live CLI process open for continuity. It's a
    // child of ours, so nothing else will reap it.
    disposeClaudeSession();
  }

  private appendTurn(turn: ChatTurn): void {
    this.chat = [...this.chat, turn];
    this.handlers.onChat?.();
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
