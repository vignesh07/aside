// Framework-agnostic side-chat service.
//
// aside has one durable thread for the whole fleet and one durable side thread
// per agent session. Selecting a session changes the chat scope; it does not
// merely highlight the same global conversation.

import {
  MAX_CANONICAL_RESET_BYTES,
  MAX_CANONICAL_RESET_LINES,
  SessionTailer,
  tryReadJsonlTailLines,
} from './session-tailer.js';
import * as fs from 'node:fs';
import { classifyEvents, activityFromEvent } from './event-classifier.js';
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
const SEARCH_STOP_WORDS = new Set([
  'about', 'agent', 'agents', 'across', 'all', 'and', 'are', 'did', 'find',
  'for', 'from', 'have', 'machine', 'other', 'session', 'sessions', 'show',
  'that', 'the', 'this', 'thread', 'threads', 'was', 'what', 'which', 'with',
  'work', 'working',
]);

interface TranscriptGeneration {
  path: string;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

interface ProjectionReplacementOptions {
  hydrated: boolean;
  retainTranscript?: boolean;
  attentionSeeded?: boolean;
  historicalHeuristic?: boolean;
  /** Whether the read covered the entire current projection. */
  readComplete?: boolean;
}

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
    /** Seeded activity was reconstructed from a canonical replay, not live. */
    seeded: boolean,
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
  /** Canonical transcript replacement; clear derived durable state first. */
  onProjectionReset?: (sessionId: string, source: SessionSource) => void;
  /** Replay failed before a canonical replacement could be committed. */
  onProjectionResetAbort?: (
    sessionId: string,
    source: SessionSource,
  ) => void;
  /** Canonical replacement replay finished; prune events that did not survive. */
  onProjectionResetComplete?: (
    sessionId: string,
    source: SessionSource,
    canonicalComplete: boolean,
    discardMissing: boolean,
  ) => void;
  /** Every normalized agent event, including restart-time transcript seeds. */
  onEvent?: (
    sessionId: string,
    source: SessionSource,
    event: SessionEvent,
    isSeed: boolean,
    rawLine: string,
    ordinal: number,
  ) => void;
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
  private readonly attentionSeededSessions = new Set<string>();
  /** Failed reads are deferred until the next scanner sync, not hot-looped. */
  private readonly attentionDeferredSessions = new Set<string>();
  private readonly threads = new Map<string, ChatThread>();
  private readonly hydratedSessions = new Set<string>();
  private readonly transcriptGenerations = new Map<
    string,
    TranscriptGeneration
  >();
  private readonly searchCache = new Map<
    string,
    { dev: number; ino: number; mtimeMs: number; size: number; text: string }
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
      ({ sessionId: sessionKey, line, isSeed }: { sessionId: string; line: string; isSeed: boolean }) => {
        this.consumeLine(sessionKey, line, isSeed);
      },
    );
    this.tailer.on(
      'reset',
      ({
        sessionId: sessionKey,
        lines,
        complete,
      }: {
        sessionId: string;
        lines: string[];
        complete: boolean;
      }) => {
        this.replaceSessionProjection(sessionKey, lines, {
          hydrated: true,
          readComplete: complete,
        });
      },
    );
  }

  /** Select the fleet thread or a concrete session thread. */
  selectThread(threadId: string): void {
    const normalized = this.normalizeSelectedThreadId(threadId);
    this.ensureThread(normalized);
    this.activeThreadId = normalized;
    const scope = scopeFromThreadId(normalized);
    if (scope.kind === 'session' && scope.source) {
      this.hydrateSession(scope.source, scope.sessionId);
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
    return this.ensureThread(this.normalizeSelectedThreadId(threadId));
  }

  getThreads(): ChatThread[] {
    return [...this.threads.values()];
  }

  /** Backward-compatible alias: null means fleet, an id means that session's thread. */
  setFocus(sessionId: string | null): void {
    if (!sessionId) {
      this.selectThread(FLEET_THREAD_ID);
      return;
    }
    const matches = this.sessions.filter((session) => session.id === sessionId);
    this.selectThread(
      matches.length === 1
        ? sessionThreadId(matches[0]!.source, sessionId)
        : legacySessionThreadId(sessionId),
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
    session: string | Pick<TrackedSession, 'id' | 'source'>,
    source?: SessionSource,
  ): SessionEvent[] {
    const key = this.resolveSessionKey(session, source);
    return key ? this.transcripts.get(key) ?? [] : [];
  }

  getChat(threadId = this.activeThreadId): ChatTurn[] {
    return this.ensureThread(threadId).turns;
  }

  isThinking(threadId = this.activeThreadId): boolean {
    return this.ensureThread(threadId).thinking;
  }

  getSessionAttention(
    session: string | Pick<TrackedSession, 'id' | 'source'>,
    source?: SessionSource,
  ): SessionAttention {
    const key = this.resolveSessionKey(session, source);
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
    const previousPaths = this.jsonlPaths;
    const nextJsonlPaths = normalizeTranscriptPaths(sessions, jsonlPaths);
    const sessionsByKey = new Map(
      sessions.map((session) => [sessionIdentity(session), session]),
    );
    const visibleKeys = new Set(sessions.map(sessionIdentity));
    const removedKeys = new Set(
      [...this.sources.keys()].filter((sessionKey) => !visibleKeys.has(sessionKey)),
    );
    const retargetedKeys = new Set(
      [...visibleKeys].filter((sessionKey) => {
        const previous = previousPaths.get(sessionKey);
        return previous !== undefined && previous !== nextJsonlPaths.get(sessionKey);
      }),
    );
    const activeScope = scopeFromThreadId(this.activeThreadId);
    const selectedKey =
      activeScope.kind === 'session' && activeScope.source
        ? sessionThreadId(activeScope.source, activeScope.sessionId)
        : null;
    const currentlyTailed = new Set(this.tailer.tailedSessionIds);
    const nextGenerations = new Map<string, TranscriptGeneration>();
    const generationChangedKeys = new Set<string>();
    for (const session of sessions) {
      const sessionKey = sessionIdentity(session);
      const transcriptPath = nextJsonlPaths.get(sessionKey);
      if (!transcriptPath) continue;
      const nextGeneration = transcriptGeneration(transcriptPath);
      if (!nextGeneration) continue;
      nextGenerations.set(sessionKey, nextGeneration);
      const previousGeneration = this.transcriptGenerations.get(sessionKey);
      if (!previousGeneration || retargetedKeys.has(sessionKey)) continue;
      const remainsTailed = shouldTail(session, selectedKey);
      if (
        generationNeedsReplay(
          previousGeneration,
          nextGeneration,
          currentlyTailed.has(sessionKey) && remainsTailed,
        )
      ) {
        generationChangedKeys.add(sessionKey);
      }
    }
    const changedKeys = new Set([
      ...removedKeys,
      ...retargetedKeys,
      ...generationChangedKeys,
    ]);

    for (const sessionKey of this.tailer.tailedSessionIds) {
      if (changedKeys.has(sessionKey)) {
        this.tailer.stopTailing(sessionKey);
      }
    }

    // A removed key is a canonical empty projection. Clear it while the old
    // source namespace is still available to the durable-state handlers.
    for (const sessionKey of removedKeys) {
      this.replaceSessionProjection(sessionKey, [], {
        hydrated: false,
        attentionSeeded: false,
      });
      this.transcriptGenerations.delete(sessionKey);
    }

    this.sessions = sessions;
    this.jsonlPaths = nextJsonlPaths;
    this.sources.clear();
    this.attentionDeferredSessions.clear();
    for (const sessionKey of this.attention.keys()) {
      if (!visibleKeys.has(sessionKey)) this.attention.delete(sessionKey);
    }
    for (const sessionKey of this.attentionSeededSessions) {
      if (!visibleKeys.has(sessionKey)) this.attentionSeededSessions.delete(sessionKey);
    }
    for (const session of sessions) {
      this.sources.set(sessionIdentity(session), session.source);
    }

    for (const sessionKey of changedKeys) {
      const oldPath = previousPaths.get(sessionKey);
      if (oldPath) this.searchCache.delete(oldPath);
    }
    const failedGenerationReads = new Set<string>();
    for (const sessionKey of new Set([
      ...retargetedKeys,
      ...generationChangedKeys,
    ])) {
      const nextPath = this.jsonlPaths.get(sessionKey);
      const session = sessionsByKey.get(sessionKey);
      const retainTranscript =
        this.hydratedSessions.has(sessionKey) ||
        (session ? shouldTail(session, selectedKey) : false) ||
        sessionKey === selectedKey;
      const replacement = nextPath
        ? tryReadJsonlTailLines(
            nextPath,
            MAX_CANONICAL_RESET_LINES,
            MAX_CANONICAL_RESET_BYTES,
          )
        : { lines: [], success: false, complete: false };
      if (!replacement.success) failedGenerationReads.add(sessionKey);
      const allowHistoricalHeuristic = session
        ? Math.max(
            0,
            this.now().getTime() - session.lastEventTime.getTime(),
          ) <= HISTORICAL_HEURISTIC_MAX_AGE_MS
        : false;
      // Once a generation changed, stale private state is no longer valid.
      // An unreadable replacement clears it but remains unhydrated so the
      // same generation is retried on the next scan.
      this.replaceSessionProjection(
        sessionKey,
        replacement.lines,
        {
          hydrated: replacement.success && retainTranscript,
          retainTranscript,
          attentionSeeded: replacement.success,
          historicalHeuristic:
            !retainTranscript && allowHistoricalHeuristic,
          readComplete: replacement.complete,
        },
      );
    }

    for (const [sessionKey, generation] of nextGenerations) {
      if (!failedGenerationReads.has(sessionKey)) {
        this.transcriptGenerations.set(sessionKey, generation);
      }
    }
    for (const sessionKey of visibleKeys) {
      if (!nextJsonlPaths.has(sessionKey)) {
        this.transcriptGenerations.delete(sessionKey);
      }
    }

    this.migrateLegacyThreads();

    if (activeScope.kind === 'session' && activeScope.source) {
      this.hydrateSession(activeScope.source, activeScope.sessionId);
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
    const scopedSession =
      thread.scope.kind === 'session' && thread.scope.source
        ? thread.scope
        : null;
    const sourceSessions =
      scopedSession === null
        ? this.fleetContextSessions(question)
        : this.sessions.filter(
            (session) =>
              session.id === scopedSession.sessionId &&
              session.source === scopedSession.source,
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
      transcript: this.getTranscript(session),
    }));
    return {
      now,
      totalSessionCount:
        scopedSession === null
          ? this.sessions.filter((session) => !session.isInternal).length
          : sourceSessions.length,
      sessions,
      focusId:
        thread.scope.kind === 'session' && thread.scope.source
          ? thread.scope.sessionId
          : null,
      focusSource:
        thread.scope.kind === 'session' && thread.scope.source
          ? thread.scope.source
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

  private normalizeSelectedThreadId(threadId: string): string {
    if (threadId === FLEET_THREAD_ID) return threadId;
    const scope = scopeFromThreadId(threadId);
    if (scope.kind !== 'session') return FLEET_THREAD_ID;
    if (scope.source) return sessionThreadId(scope.source, scope.sessionId);
    const matches = this.sessions.filter(
      (session) => session.id === scope.sessionId,
    );
    if (matches.length === 1) return sessionIdentity(matches[0]!);
    // Preserve the historical programmatic API before the first scan. Once a
    // catalog exists, an ambiguous bare id must fail closed to the fleet.
    return matches.length === 0 && this.sessions.length === 0
      ? legacySessionThreadId(scope.sessionId)
      : FLEET_THREAD_ID;
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

  /**
   * Move pre-source side chats only when the current catalog proves that one
   * and only one vendor owns the recorded id. Ambiguous legacy chats stay
   * untouched instead of being attached to whichever source happened to scan
   * first.
   */
  private migrateLegacyThreads(): void {
    const sessionsById = new Map<string, TrackedSession[]>();
    for (const session of this.sessions) {
      const matches = sessionsById.get(session.id) ?? [];
      matches.push(session);
      sessionsById.set(session.id, matches);
    }

    const migrations = new Map<string, string>();
    for (const [legacyId, legacy] of [...this.threads]) {
      const scope = scopeFromThreadId(legacyId);
      if (scope.kind !== 'session' || scope.source !== null) continue;
      const matches = sessionsById.get(scope.sessionId) ?? [];
      if (matches.length !== 1) continue;
      const canonicalId = sessionThreadId(
        matches[0]!.source,
        matches[0]!.id,
      );
      const canonical = this.threads.get(canonicalId);
      this.threads.set(
        canonicalId,
        mergeMigratedThreads(legacy, canonical, canonicalId),
      );
      this.threads.delete(legacyId);
      if (this.activeThreadId === legacyId) this.activeThreadId = canonicalId;
      migrations.set(legacyId, canonicalId);
    }

    if (migrations.size > 0) {
      this.store?.save([...this.threads.values()], { migrations });
    }
  }

  private resolveSessionKey(
    session: string | Pick<TrackedSession, 'id' | 'source'>,
    source?: SessionSource,
  ): string | null {
    if (typeof session !== 'string') return sessionIdentity(session);
    if (source) return sessionThreadId(source, session);
    const matches = this.sessions.filter((candidate) => candidate.id === session);
    return matches.length === 1 ? sessionIdentity(matches[0]!) : null;
  }

  private consumeLine(sessionKey: string, line: string, isSeed: boolean): void {
    const source = this.sources.get(sessionKey);
    const scope = scopeFromThreadId(sessionKey);
    if (!source || scope.kind !== 'session' || !scope.source) return;
    const sessionId = scope.sessionId;
    const events = classifyEvents(line, source);
    if (events.length === 0) return;

    const buf = this.transcripts.get(sessionKey) ?? [];
    for (const [ordinal, event] of events.entries()) {
      buf.push(event);
      this.handlers.onEvent?.(sessionId, source, event, isSeed, line, ordinal);
      this.updateAttention(sessionKey, event);
      if (!isSeed) {
        const activity = activityFromEvent(event);
        if (activity) {
          this.handlers.onActivity?.(sessionId, activity, source, false);
        }
      }
    }
    if (buf.length > MAX_TRANSCRIPT) buf.splice(0, buf.length - MAX_TRANSCRIPT);
    this.transcripts.set(sessionKey, buf);
    this.handlers.onTranscript?.(sessionId, source);
  }

  /** Atomically replace stale in-memory state after a projected JSONL rewrite. */
  private replaceSessionProjection(
    sessionKey: string,
    lines: string[],
    options: ProjectionReplacementOptions,
  ): void {
    const source = this.sources.get(sessionKey);
    const scope = scopeFromThreadId(sessionKey);
    if (!source || scope.kind !== 'session' || !scope.source) return;

    this.handlers.onProjectionReset?.(scope.sessionId, source);
    const transcript: SessionEvent[] = [];
    let attention: SessionAttention = { needsUser: false, reason: '' };
    let latestActivity = '';
    try {
      for (const line of lines) {
        for (const [ordinal, event] of classifyEvents(line, source).entries()) {
          if (options.retainTranscript !== false) {
            transcript.push(event);
            if (transcript.length > MAX_TRANSCRIPT) transcript.shift();
          }
          attention = options.historicalHeuristic === undefined
            ? attentionAfterEvent(attention, event)
            : attentionAfterHistoricalEvent(
                attention,
                event,
                options.historicalHeuristic,
              );
          latestActivity = activityFromEvent(event) || latestActivity;
          this.handlers.onEvent?.(
            scope.sessionId,
            source,
            event,
            true,
            line,
            ordinal,
          );
        }
      }
    } catch (error) {
      this.handlers.onProjectionResetAbort?.(scope.sessionId, source);
      throw error;
    }
    try {
      const sourceProjectionComplete = projectionIsComplete(lines, source);
      const readComplete = options.readComplete ?? true;
      this.handlers.onProjectionResetComplete?.(
        scope.sessionId,
        source,
        readComplete && sourceProjectionComplete,
        // A complete read is authoritative even when OpenCode intentionally
        // publishes a header-only "building" projection. A bounded tail is
        // not allowed to delete durable activity it never observed.
        readComplete,
      );
    } catch (error) {
      this.handlers.onProjectionResetAbort?.(scope.sessionId, source);
      throw error;
    }
    if (latestActivity) {
      this.handlers.onActivity?.(
        scope.sessionId,
        latestActivity,
        source,
        true,
      );
    }
    // Swap transcript and attention once so an unchanged wait never flickers
    // through a false cleared/new transition during replay.
    if (options.retainTranscript === false) {
      this.transcripts.delete(sessionKey);
    } else {
      this.transcripts.set(sessionKey, transcript);
    }
    this.setAttention(sessionKey, attention);
    if (options.hydrated) {
      this.hydratedSessions.add(sessionKey);
    } else {
      this.hydratedSessions.delete(sessionKey);
    }
    if (options.attentionSeeded ?? options.hydrated) {
      this.attentionSeededSessions.add(sessionKey);
    } else {
      this.attentionSeededSessions.delete(sessionKey);
    }
    this.attentionDeferredSessions.delete(sessionKey);
    const jsonlPath = this.jsonlPaths.get(sessionKey);
    if (jsonlPath) this.searchCache.delete(jsonlPath);
    this.handlers.onTranscript?.(scope.sessionId, source);
  }

  private hydrateSession(source: SessionSource, sessionId: string): void {
    const sessionKey = sessionThreadId(source, sessionId);
    if (this.hydratedSessions.has(sessionKey)) return;
    const jsonlPath = this.jsonlPaths.get(sessionKey);
    if (!jsonlPath) return;
    const result = tryReadJsonlTailLines(
      jsonlPath,
      MAX_CANONICAL_RESET_LINES,
      MAX_CANONICAL_RESET_BYTES,
    );
    if (!result.success) return;
    this.replaceSessionProjection(sessionKey, result.lines, {
      hydrated: true,
      attentionSeeded: true,
      readComplete: result.complete,
    });
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
      MAX_CANONICAL_RESET_LINES,
      MAX_CANONICAL_RESET_BYTES,
    );
    if (!result.success) return false;

    const allowHeuristic =
      Math.max(0, this.now().getTime() - session.lastEventTime.getTime()) <=
      HISTORICAL_HEURISTIC_MAX_AGE_MS;
    this.replaceSessionProjection(sessionIdentity(session), result.lines, {
      hydrated: false,
      retainTranscript: false,
      attentionSeeded: true,
      historicalHeuristic: allowHeuristic,
      readComplete: result.complete,
    });
    return true;
  }

  /** Process one bounded chunk, returning whether another chunk is ready. */
  private seedHistoricalAttentionBatch(): boolean {
    let attempts = 0;
    for (const session of this.sessions) {
      const sessionKey = sessionIdentity(session);
      if (
        session.isInternal ||
        session.status !== 'history' ||
        this.attentionSeededSessions.has(sessionKey) ||
        this.attentionDeferredSessions.has(sessionKey)
      ) {
        continue;
      }

      const jsonlPath = this.jsonlPaths.get(sessionKey);
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
      this.hydrateSession(session.source, session.id);
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
    const selectedSessionKey =
      activeScope.kind === 'session' && activeScope.source
        ? sessionThreadId(activeScope.source, activeScope.sessionId)
        : null;
    const activeIds = new Set<string>();

    for (const session of this.sessions) {
      const isLive = session.status === 'active' || session.status === 'idle';
      const sessionKey = sessionIdentity(session);
      if (!isLive || (session.isInternal && sessionKey !== selectedSessionKey)) {
        continue;
      }
      activeIds.add(sessionKey);
      const jsonlPath = this.jsonlPaths.get(sessionKey);
      if (jsonlPath && !this.tailer.tailedSessionIds.includes(sessionKey)) {
        const alreadyHydrated = this.hydratedSessions.has(sessionKey);
        const readable = this.tailer.startTailing(sessionKey, jsonlPath, {
          seed: !alreadyHydrated,
        });
        if (alreadyHydrated || readable) {
          this.attentionSeededSessions.add(sessionKey);
          this.attentionDeferredSessions.delete(sessionKey);
          this.hydratedSessions.add(sessionKey);
        }
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
    const jsonlPath = this.jsonlPaths.get(sessionIdentity(session));
    if (!jsonlPath) return '';
    let stat: fs.Stats;
    try {
      stat = fs.statSync(jsonlPath);
    } catch {
      return '';
    }
    const cached = this.searchCache.get(jsonlPath);
    if (
      cached &&
      cached.dev === stat.dev &&
      cached.ino === stat.ino &&
      cached.mtimeMs === stat.mtimeMs &&
      cached.size === stat.size
    ) {
      return cached.text;
    }
    let fd: number | undefined;
    let text: string;
    try {
      const bytes = Math.min(stat.size, SEARCH_TAIL_BYTES);
      const offset = stat.size - bytes;
      fd = fs.openSync(jsonlPath, 'r');
      const buf = Buffer.alloc(bytes);
      const read = fs.readSync(fd, buf, 0, bytes, offset);
      if (read !== bytes) return '';
      text = buf.toString('utf-8').toLowerCase();
    } catch {
      return '';
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* ignore */ }
      }
    }
    this.searchCache.set(jsonlPath, {
      dev: stat.dev,
      ino: stat.ino,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      text,
    });
    return text;
  }

  private updateAttention(sessionKey: string, event: SessionEvent): void {
    const previous = this.attention.get(sessionKey) ?? {
      needsUser: false,
      reason: '',
    };
    const next = attentionAfterEvent(previous, event);
    this.setAttention(sessionKey, next);
  }

  private setAttention(sessionKey: string, next: SessionAttention): void {
    const previous = this.attention.get(sessionKey) ?? {
      needsUser: false,
      reason: '',
    };
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

function sessionIdentity(
  session: Pick<TrackedSession, 'id' | 'source'>,
): string {
  return sessionThreadId(session.source, session.id);
}

function normalizeTranscriptPaths(
  sessions: readonly TrackedSession[],
  paths: ReadonlyMap<string, string>,
): Map<string, string> {
  const normalized = new Map<string, string>();
  const counts = new Map<string, number>();
  for (const session of sessions) {
    counts.set(session.id, (counts.get(session.id) ?? 0) + 1);
  }
  for (const session of sessions) {
    const key = sessionIdentity(session);
    const transcriptPath = paths.get(key) ??
      (counts.get(session.id) === 1 ? paths.get(session.id) : undefined);
    if (transcriptPath) normalized.set(key, transcriptPath);
  }
  return normalized;
}

function shouldTail(session: TrackedSession, selectedKey: string | null): boolean {
  const live = session.status === 'active' || session.status === 'idle';
  if (!live) return false;
  return !session.isInternal || sessionIdentity(session) === selectedKey;
}

function transcriptGeneration(jsonlPath: string): TranscriptGeneration | null {
  try {
    const stat = fs.statSync(jsonlPath);
    if (!stat.isFile()) return null;
    return {
      path: jsonlPath,
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
    };
  } catch {
    return null;
  }
}

function generationNeedsReplay(
  previous: TranscriptGeneration,
  next: TranscriptGeneration,
  activelyTailed: boolean,
): boolean {
  if (
    previous.path !== next.path ||
    previous.dev !== next.dev ||
    previous.ino !== next.ino ||
    next.size < previous.size
  ) {
    return true;
  }
  const metadataChanged =
    previous.size !== next.size ||
    previous.mtimeMs !== next.mtimeMs ||
    previous.ctimeMs !== next.ctimeMs;
  if (!metadataChanged) return false;
  // An active tailer owns monotonic appends. Historical/temporarily untailed
  // sessions need a canonical replay because no append observer is present.
  if (!activelyTailed) return true;
  return next.size === previous.size;
}

function projectionIsComplete(
  lines: readonly string[],
  source: SessionSource,
): boolean {
  if (source !== 'opencode') return true;
  for (const line of lines.slice(0, 2)) {
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (
        value['schema'] === 'aside.opencode.v1' &&
        value['type'] === 'session' &&
        (value['projectionState'] === 'building' ||
          value['projectionState'] === 'partial')
      ) {
        return false;
      }
    } catch {
      // Classification already treats malformed records as non-events.
    }
  }
  return true;
}

function mergeMigratedThreads(
  legacy: ChatThread,
  canonical: ChatThread | undefined,
  canonicalId: string,
): ChatThread {
  const newer =
    canonical && canonical.updatedAt >= legacy.updatedAt ? canonical : legacy;
  const turns = new Map(legacy.turns.map((turn) => [turn.id, turn]));
  for (const turn of canonical?.turns ?? []) turns.set(turn.id, turn);
  return {
    ...newer,
    id: canonicalId,
    scope: scopeFromThreadId(canonicalId),
    turns: [...turns.values()].sort(
      (left, right) => left.timestamp.getTime() - right.timestamp.getTime(),
    ),
    thinking: false,
  };
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
  if (event.kind === 'turn_failed' || event.kind === 'turn_interrupted') {
    return { needsUser: false, reason: '' };
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
