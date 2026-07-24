// Framework-agnostic side-chat service.
//
// aside has one durable thread for the whole fleet and one durable side thread
// per agent session. Selecting a session changes the chat scope; it does not
// merely highlight the same global conversation.

import { SessionTailer } from './session-tailer.js';
import { readJsonlTailLines } from './session-tailer.js';
import * as fs from 'node:fs';
import { classifyLine, activityFromEvent } from './event-classifier.js';
import { disposeClaudeSession } from './providers/index.js';
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from '../config/defaults.js';
import {
  FLEET_THREAD_ID,
  scopeFromThreadId,
  sessionThreadId,
} from '../types/chat.js';
import type { AskParams } from './side-chat-engine.js';
import type { SessionEvent } from '../types/events.js';
import type { ChatThread, ChatTurn } from '../types/chat.js';
import type {
  SessionAttention,
  TrackedSession,
  SessionSource,
} from '../types/session.js';
import type { SessionSnapshot, WorldSnapshot } from '../types/world.js';
import type { ThreadStore } from './thread-store.js';

/** Max transcript events retained per session. The prompt budget cuts further at render time. */
const MAX_TRANSCRIPT = 150;
/** Bound fleet prompt size while keeping the complete catalog in the UI. */
export const MAX_FLEET_CONTEXT_SESSIONS = 48;
/** Historical matches whose recent transcript is hydrated for one fleet ask. */
const MAX_SEARCH_HYDRATIONS = 8;
const SEARCH_TAIL_BYTES = 128 * 1024;
const SEARCH_STOP_WORDS = new Set([
  'about', 'agent', 'agents', 'across', 'all', 'and', 'are', 'did', 'find',
  'for', 'from', 'have', 'machine', 'other', 'session', 'sessions', 'show',
  'that', 'the', 'this', 'thread', 'threads', 'was', 'what', 'which', 'with',
  'work', 'working',
]);

export interface AskEngine {
  ask(params: AskParams): Promise<string>;
  setModel(provider: string, model: string): void;
}

export interface SideChatServiceHandlers {
  onTranscript?: (sessionId: string) => void;
  onActivity?: (sessionId: string, activity: string) => void;
  onAttention?: (
    sessionId: string,
    attention: SessionAttention,
    becameNeedsUser: boolean,
  ) => void;
  onChat?: (threadId: string) => void;
  onThinking?: (threadId: string, thinking: boolean) => void;
  onThread?: (threadId: string) => void;
}

export interface SideChatServiceOptions {
  store?: ThreadStore;
  provider?: string;
  model?: string;
}

export class SideChatService {
  private readonly tailer = new SessionTailer();
  private readonly transcripts = new Map<string, SessionEvent[]>();
  private readonly sources = new Map<string, SessionSource>();
  private readonly attention = new Map<string, SessionAttention>();
  private readonly threads = new Map<string, ChatThread>();
  private readonly hydratedSessions = new Set<string>();
  private readonly searchCache = new Map<
    string,
    { mtimeMs: number; size: number; text: string }
  >();
  private jsonlPaths = new Map<string, string>();
  private sessions: TrackedSession[] = [];
  private activeThreadId = FLEET_THREAD_ID;
  private turnSeq = 0;
  private readonly defaults: { provider: string; model: string };
  private readonly store?: ThreadStore;

  constructor(
    private readonly engine: AskEngine,
    private readonly handlers: SideChatServiceHandlers = {},
    /** Injectable clock so idle math is deterministic in tests. */
    private readonly now: () => Date = () => new Date(),
    options: SideChatServiceOptions = {},
  ) {
    this.defaults = {
      provider: options.provider ?? DEFAULT_PROVIDER,
      model: options.model ?? DEFAULT_MODEL,
    };
    this.store = options.store;

    for (const thread of this.store?.load() ?? []) {
      const scope = scopeFromThreadId(thread.id);
      this.threads.set(thread.id, { ...thread, scope, thinking: false });
      for (const turn of thread.turns) {
        const seq = Number.parseInt(turn.id.match(/^t(\d+)-/)?.[1] ?? '0', 10);
        this.turnSeq = Math.max(this.turnSeq, Number.isFinite(seq) ? seq : 0);
      }
    }
    this.ensureThread(FLEET_THREAD_ID);

    this.tailer.on(
      'line',
      ({ sessionId, line, isSeed }: { sessionId: string; line: string; isSeed: boolean }) => {
        this.consumeLine(sessionId, line, isSeed);
      },
    );
  }

  /** Select the fleet thread or a concrete session thread. */
  selectThread(threadId: string): void {
    const normalized = threadId === FLEET_THREAD_ID || threadId.startsWith('session:')
      ? threadId
      : FLEET_THREAD_ID;
    this.ensureThread(normalized);
    this.activeThreadId = normalized;
    const scope = scopeFromThreadId(normalized);
    if (scope.kind === 'session') this.hydrateSession(scope.sessionId);
    this.handlers.onThread?.(normalized);
  }

  getActiveThreadId(): string {
    return this.activeThreadId;
  }

  getActiveThread(): ChatThread {
    return this.ensureThread(this.activeThreadId);
  }

  getThread(threadId: string): ChatThread {
    return this.ensureThread(threadId);
  }

  getThreads(): ChatThread[] {
    return [...this.threads.values()];
  }

  /** Backward-compatible alias: null means fleet, an id means that session's thread. */
  setFocus(sessionId: string | null): void {
    this.selectThread(sessionId ? sessionThreadId(sessionId) : FLEET_THREAD_ID);
  }

  getFocus(): string | null {
    const scope = this.getActiveThread().scope;
    return scope.kind === 'session' ? scope.sessionId : null;
  }

  /** The model belongs to the active thread, not to the application globally. */
  setModel(provider: string, model: string, threadId = this.activeThreadId): void {
    const thread = this.ensureThread(threadId);
    thread.provider = provider;
    thread.model = model;
    thread.updatedAt = this.now();
    // Keep the engine's fallback configuration in sync for compatibility.
    this.engine.setModel(provider, model);
    this.persist();
    this.handlers.onThread?.(thread.id);
  }

  /**
   * Change the model assigned to future threads and untouched threads that
   * still carry the prior default. Existing conversations and explicit model
   * choices stay pinned.
   */
  setDefaultModel(provider: string, model: string): void {
    const previous = { ...this.defaults };
    this.defaults.provider = provider;
    this.defaults.model = model;

    const changed: string[] = [];
    for (const thread of this.threads.values()) {
      if (
        thread.turns.length === 0 &&
        thread.provider === previous.provider &&
        thread.model === previous.model
      ) {
        thread.provider = provider;
        thread.model = model;
        thread.updatedAt = this.now();
        changed.push(thread.id);
      }
    }

    this.engine.setModel(provider, model);
    if (changed.length > 0) this.persist();
    for (const threadId of changed) this.handlers.onThread?.(threadId);
  }

  getTranscript(sessionId: string): SessionEvent[] {
    return this.transcripts.get(sessionId) ?? [];
  }

  getChat(threadId = this.activeThreadId): ChatTurn[] {
    return this.ensureThread(threadId).turns;
  }

  isThinking(threadId = this.activeThreadId): boolean {
    return this.ensureThread(threadId).thinking;
  }

  getSessionAttention(sessionId: string): SessionAttention {
    return this.attention.get(sessionId) ?? { needsUser: false, reason: '' };
  }

  /** Reconcile the set of tailed sessions with the currently active ones. */
  syncSessions(sessions: TrackedSession[], jsonlPaths: Map<string, string>): void {
    this.sessions = sessions;
    this.jsonlPaths = new Map(jsonlPaths);
    this.sources.clear();
    for (const session of sessions) {
      this.sources.set(session.id, session.source);
      // Create the durable thread as soon as a session becomes visible.
      this.ensureThread(sessionThreadId(session.id));
    }

    const activeIds = new Set<string>();
    for (const session of sessions) {
      if (session.status === 'active' || session.status === 'idle') {
        activeIds.add(session.id);
        const jsonlPath = jsonlPaths.get(session.id);
        if (jsonlPath && !this.tailer.tailedSessionIds.includes(session.id)) {
          this.hydratedSessions.add(session.id);
          this.tailer.startTailing(session.id, jsonlPath);
        }
      }
    }
    for (const id of this.tailer.tailedSessionIds) {
      if (!activeIds.has(id)) this.tailer.stopTailing(id);
    }
  }

  /**
   * Snapshot the selected scope.
   *
   * Fleet chat receives all recent sessions plus a query-relevant history
   * slice. A session side chat receives only that session, preventing unrelated
   * transcripts from leaking into its context and making "it" unambiguous.
   */
  snapshot(threadId = this.activeThreadId, question = ''): WorldSnapshot {
    const thread = this.ensureThread(threadId);
    const now = this.now();
    const scopedSessionId =
      thread.scope.kind === 'session' ? thread.scope.sessionId : null;
    const sourceSessions =
      scopedSessionId === null
        ? this.fleetContextSessions(question)
        : this.sessions.filter((session) => session.id === scopedSessionId);
    const sessions: SessionSnapshot[] = sourceSessions.map((session) => ({
      id: session.id,
      source: session.source,
      projectName: session.projectName,
      title: session.title,
      gitBranch: session.gitBranch,
      model: session.model,
      status: session.status,
      idleForMs: Math.max(0, now.getTime() - session.lastEventTime.getTime()),
      currentActivity: session.currentActivity,
      contextUsedPercent: session.usedPercent,
      contextStatus: session.contextStatus,
      transcript: this.getTranscript(session.id),
    }));
    return {
      now,
      totalSessionCount: scopedSessionId === null ? this.sessions.length : sourceSessions.length,
      sessions,
      focusId: thread.scope.kind === 'session' ? thread.scope.sessionId : null,
    };
  }

  /** Ask inside the active durable thread. */
  async ask(question: string, threadId = this.activeThreadId): Promise<void> {
    const trimmed = question.trim();
    if (!trimmed) return;

    const thread = this.ensureThread(threadId);
    if (thread.thinking) return;

    const history = [...thread.turns];
    this.appendTurn(thread, this.newTurn('user', trimmed));
    this.setThinking(thread, true);

    try {
      const answer = await this.engine.ask({
        world: this.snapshot(thread.id, trimmed),
        history,
        question: trimmed,
        threadId: thread.id,
        scope: thread.scope,
        provider: thread.provider,
        model: thread.model,
      });
      this.appendTurn(thread, this.newTurn('assistant', answer));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.appendTurn(thread, this.newTurn('assistant', `⚠ ${message}`, true));
    } finally {
      this.setThinking(thread, false);
    }
  }

  dispose(): void {
    this.tailer.stopAll();
    disposeClaudeSession();
  }

  private ensureThread(threadId: string): ChatThread {
    const existing = this.threads.get(threadId);
    if (existing) return existing;
    const created: ChatThread = {
      id: threadId,
      scope: scopeFromThreadId(threadId),
      provider: this.defaults.provider,
      model: this.defaults.model,
      turns: [],
      thinking: false,
      updatedAt: this.now(),
    };
    this.threads.set(threadId, created);
    return created;
  }

  private appendTurn(thread: ChatThread, turn: ChatTurn): void {
    thread.turns = [...thread.turns, turn];
    thread.updatedAt = this.now();
    this.persist();
    this.handlers.onChat?.(thread.id);
  }

  private setThinking(thread: ChatThread, thinking: boolean): void {
    thread.thinking = thinking;
    this.handlers.onThinking?.(thread.id, thinking);
  }

  private newTurn(role: ChatTurn['role'], content: string, error = false): ChatTurn {
    this.turnSeq += 1;
    const timestamp = this.now();
    return {
      // The process suffix prevents TUI and menubar turns created in the same
      // millisecond from colliding when their stores merge.
      id: `t${this.turnSeq}-${timestamp.getTime()}-${process.pid}`,
      role,
      content,
      timestamp,
      error,
    };
  }

  private persist(): void {
    this.store?.save([...this.threads.values()]);
  }

  private consumeLine(sessionId: string, line: string, isSeed: boolean): void {
    const source = this.sources.get(sessionId) ?? 'claude';
    const event = classifyLine(line, source);
    if (!event) return;

    const buf = this.transcripts.get(sessionId) ?? [];
    buf.push(event);
    if (buf.length > MAX_TRANSCRIPT) buf.splice(0, buf.length - MAX_TRANSCRIPT);
    this.transcripts.set(sessionId, buf);

    this.updateAttention(sessionId, event);
    if (!isSeed) {
      const activity = activityFromEvent(event);
      if (activity) this.handlers.onActivity?.(sessionId, activity);
    }
    this.handlers.onTranscript?.(sessionId);
  }

  private hydrateSession(sessionId: string): void {
    if (this.hydratedSessions.has(sessionId)) return;
    const jsonlPath = this.jsonlPaths.get(sessionId);
    if (!jsonlPath) return;
    this.hydratedSessions.add(sessionId);
    for (const line of readJsonlTailLines(jsonlPath, MAX_TRANSCRIPT)) {
      this.consumeLine(sessionId, line, true);
    }
  }

  /**
   * Select the fleet prompt subset. Recent sessions are always present; older
   * history is ranked against the question and recency. This lets the model
   * search hundreds of local threads without creating an unbounded prompt.
   */
  private fleetContextSessions(question: string): TrackedSession[] {
    const recent = this.sessions.filter((session) => session.status !== 'history');
    const history = this.sessions.filter((session) => session.status === 'history');
    const tokens = searchTokens(question);
    const ranked = history
      .map((session) => ({ session, score: this.searchScore(session, tokens) }))
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.session.lastEventTime.getTime() - a.session.lastEventTime.getTime(),
      );
    const slots = Math.max(0, MAX_FLEET_CONTEXT_SESSIONS - recent.length);
    const selectedHistory = ranked.slice(0, slots);

    const hydrate = selectedHistory
      .filter((candidate, index) => candidate.score > 0 || index < 3)
      .slice(0, MAX_SEARCH_HYDRATIONS);
    for (const { session } of hydrate) this.hydrateSession(session.id);

    return [...recent, ...selectedHistory.map(({ session }) => session)];
  }

  private searchScore(session: TrackedSession, tokens: string[]): number {
    if (tokens.length === 0) return 0;
    const metadata = [
      session.id,
      session.source,
      session.projectName,
      session.title ?? '',
      session.cwd,
      session.gitBranch,
      session.currentActivity,
    ].join(' ').toLowerCase();
    const transcript = this.searchableTail(session);
    let score = 0;
    for (const token of tokens) {
      if (metadata.includes(token)) score += 8;
      if (transcript.includes(token)) score += 2;
    }
    return score;
  }

  private searchableTail(session: TrackedSession): string {
    const jsonlPath = this.jsonlPaths.get(session.id);
    if (!jsonlPath) return '';
    let stat: fs.Stats;
    try {
      stat = fs.statSync(jsonlPath);
    } catch {
      return '';
    }
    const cached = this.searchCache.get(jsonlPath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.text;
    }
    let fd: number | undefined;
    let text = '';
    try {
      const bytes = Math.min(stat.size, SEARCH_TAIL_BYTES);
      const offset = stat.size - bytes;
      fd = fs.openSync(jsonlPath, 'r');
      const buf = Buffer.alloc(bytes);
      fs.readSync(fd, buf, 0, bytes, offset);
      text = buf.toString('utf-8').toLowerCase();
    } catch {
      text = '';
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* ignore */ }
      }
    }
    this.searchCache.set(jsonlPath, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      text,
    });
    return text;
  }

  private updateAttention(sessionId: string, event: SessionEvent): void {
    const previous = this.getSessionAttention(sessionId);
    const next = attentionAfterEvent(previous, event);
    if (next.needsUser === previous.needsUser && next.reason === previous.reason) return;
    this.attention.set(sessionId, next);
    this.handlers.onAttention?.(
      sessionId,
      next,
      !previous.needsUser && next.needsUser,
    );
  }
}

function searchTokens(question: string): string[] {
  return [...new Set(
    (question.toLowerCase().match(/[a-z0-9][a-z0-9._/-]{2,}/g) ?? [])
      .filter((token) => !SEARCH_STOP_WORDS.has(token)),
  )];
}

export function attentionAfterEvent(
  current: SessionAttention,
  event: SessionEvent,
): SessionAttention {
  if (event.kind === 'needs_input') {
    return { needsUser: true, reason: event.reason };
  }
  if (event.kind === 'assistant_text' && looksLikeInputRequest(event.preview)) {
    return { needsUser: true, reason: event.preview };
  }
  if (event.kind === 'turn_complete' || event.kind === 'context_health') {
    return current;
  }
  if (
    event.kind === 'session_started' ||
    event.kind === 'user_prompt' ||
    event.kind === 'tool_call' ||
    event.kind === 'tool_result_ok' ||
    event.kind === 'tool_result_error' ||
    event.kind === 'tool_rejected' ||
    event.kind === 'bash_running' ||
    event.kind === 'bash_complete' ||
    event.kind === 'file_written' ||
    event.kind === 'file_edited'
  ) {
    return { needsUser: false, reason: '' };
  }
  if (event.kind === 'assistant_text') {
    return { needsUser: false, reason: '' };
  }
  return current;
}

function looksLikeInputRequest(text: string): boolean {
  const compact = text.replace(/\s+/g, ' ').trim();
  return (
    /\?\s*$/.test(compact) ||
    /\b(?:need|waiting for|requires?) (?:your|user) (?:input|approval|confirmation|decision|response)\b/i.test(compact) ||
    /\b(?:please|can you|could you|would you) (?:choose|confirm|approve|provide|tell|let me know)\b/i.test(compact)
  );
}
