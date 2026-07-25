// Framework-agnostic side-chat service.
//
// aside has one durable thread for the whole fleet and one durable side thread
// per agent session. Selecting a session changes the chat scope; it does not
// merely highlight the same global conversation.

import {
  SessionTailer,
  readJsonlTailLines,
  tryReadJsonlTailLines,
} from './session-tailer.js';
import * as fs from 'node:fs';
import { classifyLine, activityFromEvent } from './event-classifier.js';
import { disposeClaudeSession } from './providers/index.js';
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from '../config/defaults.js';
import {
  FLEET_THREAD_ID,
  legacySessionThreadId,
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
/**
 * Restart-time attention reconstruction is deliberately incremental. Each
 * chunk examines a small, fixed tail from at most this many historical
 * transcripts. The first chunk runs with the scanner sync; remaining chunks
 * yield through setImmediate. This covers the whole catalog promptly without
 * opening watchers for old files or blocking the event loop for the full scan.
 */
export const MAX_ATTENTION_SEEDS_PER_SYNC = 32;
export const HISTORICAL_HEURISTIC_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const ATTENTION_SEED_LINES = 100;
const ATTENTION_SEED_BYTES = 128 * 1024;
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
  onTranscript?: (sessionId: string, source: SessionSource) => void;
  onActivity?: (
    sessionId: string,
    activity: string,
    source: SessionSource,
  ) => void;
  onAttention?: (
    sessionId: string,
    attention: SessionAttention,
    becameNeedsUser: boolean,
    source: SessionSource,
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
  /** Session-scoped maps use `session:<source>:<id>` keys throughout. */
  private readonly transcripts = new Map<string, SessionEvent[]>();
  private readonly sources = new Map<string, SessionSource>();
  private readonly attention = new Map<string, SessionAttention>();
  private readonly attentionSeededSessions = new Set<string>();
  /** Failed reads are deferred until the next scanner sync, not hot-looped. */
  private readonly attentionDeferredSessions = new Set<string>();
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
  private attentionDrainImmediate: ReturnType<typeof setImmediate> | null = null;
  private disposed = false;
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
      // Re-derive scope from the durable id. Old stores did not include the
      // provider in either place; they remain unresolved until the next scan.
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
    const parsed = scopeFromThreadId(threadId);
    const normalized =
      threadId === FLEET_THREAD_ID || parsed.kind === 'session'
        ? this.resolveLegacyThreadId(threadId, parsed)
        : FLEET_THREAD_ID;
    this.ensureThread(normalized);
    this.activeThreadId = normalized;
    const scope = scopeFromThreadId(normalized);
    if (scope.kind === 'session' && scope.source) {
      this.hydrateSession(sessionThreadId(scope.source, scope.sessionId));
    }
    this.reconcileTailers();
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

  /** Backward-compatible alias: null means fleet. New callers must include the source. */
  setFocus(sessionId: string | null, source?: SessionSource): void {
    this.selectThread(
      sessionId
        ? source
          ? sessionThreadId(source, sessionId)
          : legacySessionThreadId(sessionId)
        : FLEET_THREAD_ID,
    );
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

  getTranscript(
    sessionId: string,
    source?: SessionSource,
  ): SessionEvent[] {
    const key = this.resolveSessionKey(sessionId, source);
    return key ? this.transcripts.get(key) ?? [] : [];
  }

  getChat(threadId = this.activeThreadId): ChatTurn[] {
    return this.ensureThread(threadId).turns;
  }

  isThinking(threadId = this.activeThreadId): boolean {
    return this.ensureThread(threadId).thinking;
  }

  getSessionAttention(
    sessionId: string,
    source?: SessionSource,
  ): SessionAttention {
    const key = this.resolveSessionKey(sessionId, source);
    return (key ? this.attention.get(key) : undefined) ?? {
      needsUser: false,
      reason: '',
    };
  }

  /** Reconcile the set of tailed sessions with the currently active ones. */
  syncSessions(sessions: TrackedSession[], jsonlPaths: Map<string, string>): void {
    if (this.attentionDrainImmediate) {
      clearImmediate(this.attentionDrainImmediate);
      this.attentionDrainImmediate = null;
    }
    this.sessions = sessions;
    this.jsonlPaths = new Map(jsonlPaths);
    this.migrateUnambiguousLegacyThreads();
    this.sources.clear();
    this.attentionDeferredSessions.clear();
    const visibleKeys = new Set(
      sessions.map((session) => sessionThreadId(session.source, session.id)),
    );
    for (const sessionKey of this.attention.keys()) {
      if (!visibleKeys.has(sessionKey)) this.attention.delete(sessionKey);
    }
    for (const sessionKey of this.attentionSeededSessions) {
      if (!visibleKeys.has(sessionKey)) {
        this.attentionSeededSessions.delete(sessionKey);
      }
    }
    for (const session of sessions) {
      const key = sessionThreadId(session.source, session.id);
      this.sources.set(key, session.source);
    }

    this.reconcileTailers();
    if (this.seedHistoricalAttentionBatch()) this.scheduleAttentionDrain();
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
    const scopedSource =
      thread.scope.kind === 'session' ? thread.scope.source : undefined;
    const sourceSessions =
      scopedSessionId === null
        ? this.fleetContextSessions(question)
        : this.sessions.filter(
            (session) =>
              session.id === scopedSessionId &&
              (!scopedSource || session.source === scopedSource),
          );
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
      transcript: this.getTranscript(session.id, session.source),
    }));
    return {
      now,
      totalSessionCount:
        scopedSessionId === null
          ? this.sessions.filter((session) => !session.isInternal).length
          : sourceSessions.length,
      sessions,
      focusThreadId:
        thread.scope.kind === 'session' && sourceSessions.length === 1
          ? sessionThreadId(
              sourceSessions[0]!.source,
              sourceSessions[0]!.id,
            )
          : null,
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
    this.disposed = true;
    if (this.attentionDrainImmediate) {
      clearImmediate(this.attentionDrainImmediate);
      this.attentionDrainImmediate = null;
    }
    this.tailer.stopAll();
    disposeClaudeSession();
  }

  private ensureThread(threadId: string): ChatThread {
    const scope = scopeFromThreadId(threadId);
    if (scope.kind === 'session' && scope.source) {
      this.claimLegacyThread(scope.source, scope.sessionId);
    }
    const existing = this.threads.get(threadId);
    if (existing) return existing;
    const created: ChatThread = {
      id: threadId,
      scope,
      provider: this.defaults.provider,
      model: this.defaults.model,
      turns: [],
      thinking: false,
      updatedAt: this.now(),
    };
    this.threads.set(threadId, created);
    return created;
  }

  /**
   * Resolve an old `session:<id>` selection once its owning provider is known.
   * If two providers genuinely use the same id, retain the legacy thread until
   * the user chooses one of the qualified targets; that explicit choice then
   * safely claims the old history.
   */
  private resolveLegacyThreadId(
    threadId: string,
    scope: ChatThread['scope'],
  ): string {
    if (scope.kind !== 'session') return FLEET_THREAD_ID;
    if (scope.source) {
      const canonical = sessionThreadId(scope.source, scope.sessionId);
      this.claimLegacyThread(scope.source, scope.sessionId);
      return canonical;
    }

    const sources = new Set(
      this.sessions
        .filter((session) => session.id === scope.sessionId)
        .map((session) => session.source),
    );
    if (sources.size !== 1) return threadId;
    const [source] = sources;
    const canonical = sessionThreadId(source!, scope.sessionId);
    this.claimLegacyThread(source!, scope.sessionId);
    return canonical;
  }

  /** Migrate every legacy thread whose source can be inferred without guessing. */
  private migrateUnambiguousLegacyThreads(): void {
    let changed = false;
    for (const thread of [...this.threads.values()]) {
      const scope = scopeFromThreadId(thread.id);
      if (scope.kind !== 'session' || scope.source) continue;
      const sources = new Set(
        this.sessions
          .filter((session) => session.id === scope.sessionId)
          .map((session) => session.source),
      );
      if (sources.size !== 1) continue;
      const [source] = sources;
      changed =
        this.claimLegacyThread(source!, scope.sessionId, false) || changed;
    }
    if (changed) this.persist();
  }

  /**
   * Move a legacy thread onto one canonical provider-qualified id. Existing
   * canonical turns are merged by turn id so neither history can overwrite the
   * other during an upgrade or concurrent frontend launch.
   */
  private claimLegacyThread(
    source: SessionSource,
    sessionId: string,
    persist = true,
  ): boolean {
    const legacyId = legacySessionThreadId(sessionId);
    const legacy = this.threads.get(legacyId);
    if (!legacy) return false;

    const canonicalId = sessionThreadId(source, sessionId);
    const canonical = this.threads.get(canonicalId);
    const newer =
      canonical && canonical.updatedAt >= legacy.updatedAt
        ? canonical
        : legacy;
    const turns = new Map(
      (canonical?.turns ?? []).map((turn) => [turn.id, turn]),
    );
    for (const turn of legacy.turns) turns.set(turn.id, turn);

    this.threads.set(canonicalId, {
      ...newer,
      id: canonicalId,
      scope: { kind: 'session', source, sessionId },
      turns: [...turns.values()].sort(
        (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
      ),
      thinking: canonical?.thinking ?? false,
    });
    this.threads.delete(legacyId);
    if (this.activeThreadId === legacyId) this.activeThreadId = canonicalId;
    if (persist) this.persist();
    return true;
  }

  /**
   * Compatibility lookup for old callers that only have a session id.
   * Qualified callers never pass through this inference path.
   */
  private resolveSessionKey(
    sessionId: string,
    source?: SessionSource,
  ): string | null {
    if (source) return sessionThreadId(source, sessionId);
    const sources = new Set(
      this.sessions
        .filter((session) => session.id === sessionId)
        .map((session) => session.source),
    );
    if (sources.size === 1) {
      return sessionThreadId([...sources][0]!, sessionId);
    }

    const keys = new Set<string>();
    for (const key of [
      ...this.transcripts.keys(),
      ...this.attention.keys(),
      ...this.sources.keys(),
    ]) {
      const scope = scopeFromThreadId(key);
      if (
        scope.kind === 'session' &&
        scope.source &&
        scope.sessionId === sessionId
      ) {
        keys.add(key);
      }
    }
    return keys.size === 1 ? [...keys][0]! : null;
  }

  private sessionForKey(sessionKey: string): TrackedSession | undefined {
    const scope = scopeFromThreadId(sessionKey);
    if (scope.kind !== 'session') return undefined;
    return this.sessions.find(
      (session) =>
        session.id === scope.sessionId &&
        (!scope.source || session.source === scope.source),
    );
  }

  private jsonlPathFor(
    session: TrackedSession,
    sessionKey = sessionThreadId(session.source, session.id),
  ): string | undefined {
    return (
      this.jsonlPaths.get(sessionKey) ||
      // Compatibility with scanner results produced before path namespacing.
      this.jsonlPaths.get(session.id)
    );
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

  private consumeLine(sessionKey: string, line: string, isSeed: boolean): void {
    const scope = scopeFromThreadId(sessionKey);
    if (scope.kind !== 'session' || !scope.source) return;
    const source = this.sources.get(sessionKey) ?? scope.source;
    const event = classifyLine(line, source);
    if (!event) return;

    const buf = this.transcripts.get(sessionKey) ?? [];
    buf.push(event);
    if (buf.length > MAX_TRANSCRIPT) buf.splice(0, buf.length - MAX_TRANSCRIPT);
    this.transcripts.set(sessionKey, buf);

    this.updateAttention(sessionKey, event);
    if (!isSeed) {
      const activity = activityFromEvent(event);
      if (activity) {
        this.handlers.onActivity?.(scope.sessionId, activity, source);
      }
    }
    this.handlers.onTranscript?.(scope.sessionId, source);
  }

  private hydrateSession(sessionKey: string): void {
    if (this.hydratedSessions.has(sessionKey)) return;
    const session = this.sessionForKey(sessionKey);
    if (!session) return;
    const jsonlPath = this.jsonlPathFor(session, sessionKey);
    if (!jsonlPath) return;
    this.hydratedSessions.add(sessionKey);
    this.attentionSeededSessions.add(sessionKey);
    this.attentionDeferredSessions.delete(sessionKey);
    for (const line of readJsonlTailLines(jsonlPath, MAX_TRANSCRIPT)) {
      this.consumeLine(sessionKey, line, true);
    }
  }

  /**
   * Recover only the final attention state for a historical session. Unlike
   * hydrateSession this does not retain transcript events, and unlike the
   * active-session path it does not install a file watcher or poll timer.
   */
  private seedHistoricalAttention(
    session: TrackedSession,
    jsonlPath: string,
  ): boolean {
    const result = tryReadJsonlTailLines(
      jsonlPath,
      ATTENTION_SEED_LINES,
      ATTENTION_SEED_BYTES,
    );
    if (!result.success) return false;

    const allowHeuristic =
      Math.max(0, this.now().getTime() - session.lastEventTime.getTime()) <=
      HISTORICAL_HEURISTIC_MAX_AGE_MS;
    let next: SessionAttention = { needsUser: false, reason: '' };
    for (const line of result.lines) {
      const event = classifyLine(line, session.source);
      if (!event) continue;
      next = attentionAfterHistoricalEvent(next, event, allowHeuristic);
    }
    this.setAttention(sessionThreadId(session.source, session.id), next);
    return true;
  }

  /** Process one bounded chunk, returning whether another chunk is ready. */
  private seedHistoricalAttentionBatch(): boolean {
    let attempts = 0;
    for (const session of this.sessions) {
      const sessionKey = sessionThreadId(session.source, session.id);
      if (
        session.isInternal ||
        session.status !== 'history' ||
        this.attentionSeededSessions.has(sessionKey) ||
        this.attentionDeferredSessions.has(sessionKey)
      ) {
        continue;
      }

      const jsonlPath = this.jsonlPathFor(session, sessionKey);
      if (!jsonlPath) {
        this.attentionDeferredSessions.add(sessionKey);
        continue;
      }
      if (attempts >= MAX_ATTENTION_SEEDS_PER_SYNC) return true;
      attempts += 1;

      if (this.seedHistoricalAttention(session, jsonlPath)) {
        this.attentionSeededSessions.add(sessionKey);
      } else {
        this.attentionDeferredSessions.add(sessionKey);
      }
    }
    return false;
  }

  private scheduleAttentionDrain(): void {
    if (this.disposed || this.attentionDrainImmediate) return;
    this.attentionDrainImmediate = setImmediate(() => {
      this.attentionDrainImmediate = null;
      if (this.disposed) return;
      if (this.seedHistoricalAttentionBatch()) this.scheduleAttentionDrain();
    });
  }

  /**
   * Select the fleet prompt subset. Recent sessions are always present; older
   * history is ranked against the question and recency. This lets the model
   * search hundreds of local threads without creating an unbounded prompt.
   */
  private fleetContextSessions(question: string): TrackedSession[] {
    const userSessions = this.sessions.filter((session) => !session.isInternal);
    const recent = userSessions.filter((session) => session.status !== 'history');
    const history = userSessions.filter((session) => session.status === 'history');
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
    for (const { session } of hydrate) {
      this.hydrateSession(sessionThreadId(session.source, session.id));
    }

    return [...recent, ...selectedHistory.map(({ session }) => session)];
  }

  /**
   * User-owned live sessions stay tailed for activity and attention. Internal
   * workers remain lightweight until selected; the selected worker is tailed
   * so its dedicated side chat still follows live transcript updates.
   */
  private reconcileTailers(): void {
    const activeScope = scopeFromThreadId(this.activeThreadId);
    const selectedSessionId =
      activeScope.kind === 'session' ? activeScope.sessionId : null;
    const selectedSource =
      activeScope.kind === 'session' ? activeScope.source : undefined;
    const activeIds = new Set<string>();

    for (const session of this.sessions) {
      const sessionKey = sessionThreadId(session.source, session.id);
      const isLive = session.status === 'active' || session.status === 'idle';
      const isSelected =
        session.id === selectedSessionId &&
        (!selectedSource || session.source === selectedSource);
      if (!isLive || (session.isInternal && !isSelected)) {
        continue;
      }
      activeIds.add(sessionKey);
      const jsonlPath = this.jsonlPathFor(session, sessionKey);
      if (jsonlPath && !this.tailer.tailedSessionIds.includes(sessionKey)) {
        this.attentionSeededSessions.add(sessionKey);
        this.attentionDeferredSessions.delete(sessionKey);
        this.hydratedSessions.add(sessionKey);
        this.tailer.startTailing(sessionKey, jsonlPath);
      }
    }

    for (const id of this.tailer.tailedSessionIds) {
      if (!activeIds.has(id)) this.tailer.stopTailing(id);
    }
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
    const jsonlPath = this.jsonlPathFor(session);
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

  private updateAttention(sessionKey: string, event: SessionEvent): void {
    const previous =
      this.attention.get(sessionKey) ?? { needsUser: false, reason: '' };
    const next = attentionAfterEvent(previous, event);
    this.setAttention(sessionKey, next);
  }

  private setAttention(sessionKey: string, next: SessionAttention): void {
    const previous =
      this.attention.get(sessionKey) ?? { needsUser: false, reason: '' };
    if (next.needsUser === previous.needsUser && next.reason === previous.reason) return;
    this.attention.set(sessionKey, next);
    const scope = scopeFromThreadId(sessionKey);
    if (scope.kind !== 'session' || !scope.source) return;
    this.handlers.onAttention?.(
      scope.sessionId,
      next,
      !previous.needsUser && next.needsUser,
      scope.source,
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

function attentionAfterHistoricalEvent(
  current: SessionAttention,
  event: SessionEvent,
  allowAssistantHeuristic: boolean,
): SessionAttention {
  // A conversational question at the end of a long-closed thread is not an
  // actionable inbox item. Explicit input-request tools remain authoritative
  // regardless of age.
  if (!allowAssistantHeuristic && event.kind === 'assistant_text') {
    return { needsUser: false, reason: '' };
  }
  return attentionAfterEvent(current, event);
}

function looksLikeInputRequest(text: string): boolean {
  const compact = text.replace(/\s+/g, ' ').trim();
  return (
    /\?\s*$/.test(compact) ||
    /\b(?:need|waiting for|requires?) (?:your|user) (?:input|approval|confirmation|decision|response)\b/i.test(compact) ||
    /\b(?:please|can you|could you|would you) (?:choose|confirm|approve|provide|tell|let me know)\b/i.test(compact)
  );
}
