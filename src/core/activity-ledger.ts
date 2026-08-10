import { createHash } from 'node:crypto';
import type {
  ActivityEventKind,
  ActivityEventRecord,
  ActivityLedgerState,
  ActivityLifecycle,
  ActivitySessionMetadata,
  ActivitySeverity,
  ThreadActivityCursor,
  ThreadAttentionState,
} from '../types/activity.js';
import type { SessionEvent } from '../types/events.js';
import type { SessionSource, TrackedSession } from '../types/session.js';

export const ACTIVITY_MAX_RECORDS = 20_000;
const RECORD_MAX_AGE_MS = 90 * 24 * 60 * 60_000;
const AGE_PRUNE_INTERVAL_MS = 60 * 60_000;
export const STALLED_AFTER_MS = 20 * 60_000;
export const FORGOTTEN_AFTER_MS = 24 * 60 * 60_000;
const MAX_SUMMARY_LENGTH = 240;

interface ProjectionIdentity {
  seq: number;
  evidenceHash: string;
}

export interface ActivityLedgerStore {
  load(): ActivityLedgerState;
  append(events: ActivityEventRecord[]): void;
  saveCursors(cursors: ThreadActivityCursor[]): void;
  deleteThreadEvents(threadKey: string): void;
  replaceThreadEvents(
    threadKey: string,
    events: ActivityEventRecord[],
  ): void;
  prune(cutoffOccurredAtMs: number, keepNewest: number): void;
  close?(): void;
}

/** Test and fail-safe implementation; production uses the private SQLite store. */
export class InMemoryActivityLedgerStore implements ActivityLedgerStore {
  private readonly events = new Map<string, ActivityEventRecord>();
  private readonly cursors = new Map<string, ThreadActivityCursor>();

  constructor(initial: ActivityLedgerState = { events: [], cursors: [] }) {
    for (const event of initial.events) this.events.set(event.eventId, { ...event });
    for (const cursor of initial.cursors) {
      this.cursors.set(cursor.threadKey, { ...cursor });
    }
  }

  load(): ActivityLedgerState {
    return {
      events: [...this.events.values()].map((event) => ({ ...event })),
      cursors: [...this.cursors.values()].map((cursor) => ({ ...cursor })),
    };
  }

  append(events: ActivityEventRecord[]): void {
    for (const event of events) {
      if (!this.events.has(event.eventId)) {
        this.events.set(event.eventId, { ...event });
      }
    }
  }

  saveCursors(cursors: ThreadActivityCursor[]): void {
    for (const cursor of cursors) {
      this.cursors.set(cursor.threadKey, { ...cursor });
    }
  }

  deleteThreadEvents(threadKey: string): void {
    for (const [eventId, event] of this.events) {
      if (event.threadKey === threadKey) this.events.delete(eventId);
    }
  }

  replaceThreadEvents(
    threadKey: string,
    events: ActivityEventRecord[],
  ): void {
    this.deleteThreadEvents(threadKey);
    for (const event of events) this.events.set(event.eventId, { ...event });
  }

  prune(cutoffOccurredAtMs: number, keepNewest: number): void {
    const kept = [...this.events.values()]
      .filter((event) => event.occurredAtMs >= cutoffOccurredAtMs)
      .sort((a, b) => b.seq - a.seq)
      .slice(0, keepNewest);
    this.events.clear();
    for (const event of kept) this.events.set(event.eventId, event);
  }
}

export interface RecordedAgentEvent {
  sessionId: string;
  source: SessionSource;
  event: SessionEvent;
  seeded: boolean;
  rawLine: string;
  ordinal: number;
}

/**
 * Bounded, non-rebuildable lifecycle history shared by the attention inbox,
 * Today diary, and future evidence-linked insights.
 */
export class ActivityLedger {
  private readonly events = new Map<string, ActivityEventRecord>();
  private readonly eventsByThread = new Map<
    string,
    Map<string, ActivityEventRecord>
  >();
  private readonly latestByThread = new Map<string, ActivityEventRecord>();
  private readonly latestPhaseByThread = new Map<string, ActivityEventRecord>();
  private readonly cursors = new Map<string, ThreadActivityCursor>();
  private readonly sessions = new Map<string, ActivitySessionMetadata>();
  private readonly pendingEvents: ActivityEventRecord[] = [];
  /** Surviving stable ids retain their original sequence during a rewrite. */
  private readonly projectionRebases = new Map<
    string,
    {
      priorEvents: Map<string, ActivityEventRecord>;
      identities: Map<string, ProjectionIdentity>;
      nextCanonicalOrder: number;
    }
  >();
  /**
   * Identity-only bridge across OpenCode's intentionally empty/header-only
   * invalidation projection and its bounded final rebuild. No transcript text
   * or summaries are retained here.
   */
  private readonly retainedProjectionIdentities = new Map<
    string,
    Map<string, ProjectionIdentity>
  >();
  private readonly nextCanonicalOrderByThread = new Map<string, number>();
  private readonly firstImport: boolean;
  private readonly startedAtMs: number;
  private nextSeq = 1;
  private persistImmediate: ReturnType<typeof setImmediate> | null = null;
  private changeImmediate: ReturnType<typeof setImmediate> | null = null;
  private disposed = false;
  private firstSync = true;
  private cursorsDirty = false;
  private lastAgePruneAtMs = 0;

  constructor(
    private readonly store: ActivityLedgerStore,
    private readonly now: () => Date = () => new Date(),
    private readonly onChange?: () => void,
  ) {
    this.startedAtMs = this.now().getTime();
    const restored = store.load();
    for (const event of [...restored.events].sort(compareCanonicalEvents)) {
      this.addEvent(event);
    }
    for (const cursor of restored.cursors) {
      this.cursors.set(cursor.threadKey, cursor);
    }
    this.nextSeq =
      Math.max(
        0,
        ...restored.events.map((event) => event.seq),
        ...restored.cursors.flatMap((cursor) => [
          cursor.viewedThroughSeq,
          cursor.resolvedThroughSeq,
        ]),
      ) + 1;
    this.firstImport =
      restored.events.length === 0 && restored.cursors.length === 0;
    this.pruneInMemory(true);
  }

  syncSessions(
    sessions: TrackedSession[],
    authoritativeSources: ReadonlySet<SessionSource> = new Set([
      'claude',
      'codex',
      'pi',
      'opencode',
    ]),
  ): void {
    const byThread = new Map(
      sessions.map((session) => [threadKey(session.source, session.id), session]),
    );
    // OpenCode's SQLite catalog is the source of truth. If a session no longer
    // exists there, remove its derived private summaries as well as its cache.
    // Other adapters predate this authoritative deletion contract and retain
    // their existing bounded-history behavior.
    const visibleOpenCode = new Set(
      sessions
        .filter((session) => session.source === 'opencode')
        .map((session) => threadKey(session.source, session.id)),
    );
    const missingOpenCode = authoritativeSources.has('opencode')
      ? new Set(
          [...this.eventsByThread.keys()].filter(
            (key) => key.startsWith('opencode:') && !visibleOpenCode.has(key),
          ),
        )
      : new Set<string>();
    for (const key of missingOpenCode) this.deleteThreadProjection(key);

    this.sessions.clear();
    for (const session of sessions) {
      const key = threadKey(session.source, session.id);
      const parentThreadKey = session.parentSessionId
        ? threadKey(session.source, session.parentSessionId)
        : undefined;
      this.sessions.set(key, {
        threadKey: key,
        sessionId: session.id,
        source: session.source,
        parentThreadKey,
        rootThreadKey: resolveRootThreadKey(key, byThread),
        projectName: session.projectName,
        projectPath: session.cwd || session.projectDir,
        title: session.title ?? '',
        status: session.status,
        currentActivity: session.currentActivity,
        lastEventAtMs: session.lastEventTime.getTime(),
      });
      if (!this.cursors.has(key)) {
        this.cursors.set(key, {
          threadKey: key,
          baselineAtMs:
            this.firstImport && this.firstSync
              ? Math.max(
                  session.lastEventTime.getTime(),
                  this.now().getTime(),
                )
              : 0,
          viewedThroughSeq: 0,
          resolvedThroughSeq: 0,
        });
        this.cursorsDirty = true;
      }
    }
    this.firstSync = false;
    if (this.cursorsDirty) this.schedulePersist();
  }

  recordAgentEvent(input: RecordedAgentEvent): void {
    const metadata = this.sessions.get(threadKey(input.source, input.sessionId));
    if (!metadata) return;
    const key = threadKey(input.source, input.sessionId);
    const rebase = this.projectionRebases.get(key);
    const canonicalOrder = rebase
      ? rebase.nextCanonicalOrder++
      : this.takeNextCanonicalOrder(key);
    const normalized = normalizeEvent(
      metadata,
      input,
      this.nextSeq,
      canonicalOrder,
      this.now().getTime(),
    );
    if (!normalized || this.events.has(normalized.eventId)) return;
    const prior = rebase?.identities.get(normalized.eventId);
    if (prior && prior.evidenceHash === normalized.evidenceHash) {
      // Stable identity preserves only ordering/user cursors. The projected
      // payload may have changed in place and must replace stale private text.
      this.addEvent({ ...normalized, seq: prior.seq });
      return;
    }
    if (
      normalized.occurredAtMs <
      normalized.observedAtMs - RECORD_MAX_AGE_MS
    ) {
      return;
    }
    if (
      normalized.kind === 'turn_completed' &&
      this.latestPhaseByThread.get(normalized.threadKey)?.kind ===
        'turn_completed'
    ) {
      return;
    }
    this.nextSeq += 1;
    this.addEvent(normalized);
    this.pendingEvents.push(normalized);
    this.pruneInMemory();
    this.schedulePersist();
    this.scheduleChange();
  }

  /**
   * Begin a canonical projection replay. Existing events leave the live view,
   * but remain available by stable event id so survivors can keep their
   * original sequence numbers and user-owned viewed/resolved cursors.
   */
  beginAgentProjectionRebase(sessionId: string, source: SessionSource): void {
    const key = threadKey(source, sessionId);
    if (this.projectionRebases.has(key)) return;
    const existing = [...(this.eventsByThread.get(key)?.values() ?? [])];
    const identities = new Map(this.retainedProjectionIdentities.get(key));
    for (const event of existing) {
      identities.set(event.eventId, {
        seq: event.seq,
        evidenceHash: event.evidenceHash,
      });
    }
    this.projectionRebases.set(
      key,
      {
        priorEvents: new Map(existing.map((event) => [event.eventId, event])),
        identities,
        nextCanonicalOrder: 1,
      },
    );
    for (const event of existing) this.removeEvent(event);
    for (let index = this.pendingEvents.length - 1; index >= 0; index -= 1) {
      if (this.pendingEvents[index]?.threadKey === key) {
        this.pendingEvents.splice(index, 1);
      }
    }
  }

  /** Finish a replay and atomically replace the durable thread projection. */
  finishAgentProjectionRebase(
    sessionId: string,
    source: SessionSource,
    canonicalComplete = true,
    discardMissing = true,
  ): void {
    const key = threadKey(source, sessionId);
    const rebase = this.projectionRebases.get(key);
    if (!rebase) return;

    // New replay events may already be queued by recordAgentEvent. Persist one
    // canonical thread snapshot instead of appending them after the replace.
    for (let index = this.pendingEvents.length - 1; index >= 0; index -= 1) {
      if (this.pendingEvents[index]?.threadKey === key) {
        this.pendingEvents.splice(index, 1);
      }
    }
    const replayed = [...(this.eventsByThread.get(key)?.values() ?? [])]
      .sort(compareCanonicalEvents);
    const replayedIds = new Set(replayed.map((event) => event.eventId));
    const retained = discardMissing
      ? []
      : [...rebase.priorEvents.values()]
          .filter((event) => !replayedIds.has(event.eventId))
          .sort(compareCanonicalEvents);
    // A bounded suffix cannot prove which absent events were deleted versus
    // merely outside its read window. Retain them conservatively until a later
    // complete replay removes true deletions; normal 90-day/20k bounds apply.
    const replacement = [...retained, ...replayed].map((event, index) => ({
      ...event,
      canonicalOrder: index + 1,
    }));
    for (const event of replayed) this.removeEvent(event);
    for (const event of replacement) this.addEvent(event);
    try {
      this.store.replaceThreadEvents(key, replacement);
    } catch (error) {
      // The durable transaction rolled back. Restore the same canonical view
      // in memory so Today/attention cannot disagree with disk, then allow the
      // next scanner pass to retry from a clean rebase.
      for (const event of [
        ...(this.eventsByThread.get(key)?.values() ?? []),
      ]) this.removeEvent(event);
      for (const event of rebase.priorEvents.values()) this.addEvent(event);
      this.projectionRebases.delete(key);
      throw error;
    }
    this.projectionRebases.delete(key);
    this.nextCanonicalOrderByThread.set(
      key,
      Math.max(0, ...replacement.map(eventCanonicalOrder)) + 1,
    );
    if (canonicalComplete) {
      this.retainedProjectionIdentities.delete(key);
    } else {
      const retained = new Map(rebase.identities);
      for (const event of replacement) {
        retained.set(event.eventId, {
          seq: event.seq,
          evidenceHash: event.evidenceHash,
        });
      }
      this.retainedProjectionIdentities.set(key, retained);
    }
    this.scheduleChange();
  }

  /** Restore the prior in-memory view when canonical replay itself fails. */
  abortAgentProjectionRebase(sessionId: string, source: SessionSource): void {
    const key = threadKey(source, sessionId);
    const rebase = this.projectionRebases.get(key);
    if (!rebase) return;
    for (const event of [...(this.eventsByThread.get(key)?.values() ?? [])]) {
      this.removeEvent(event);
    }
    for (const event of rebase.priorEvents.values()) this.addEvent(event);
    this.nextCanonicalOrderByThread.set(
      key,
      Math.max(
        0,
        ...[...rebase.priorEvents.values()].map(eventCanonicalOrder),
      ) + 1,
    );
    for (let index = this.pendingEvents.length - 1; index >= 0; index -= 1) {
      if (this.pendingEvents[index]?.threadKey === key) {
        this.pendingEvents.splice(index, 1);
      }
    }
    this.projectionRebases.delete(key);
    this.scheduleChange();
  }

  /** Destructive compatibility helper for callers that intentionally replay nothing. */
  resetAgentProjection(sessionId: string, source: SessionSource): void {
    this.beginAgentProjectionRebase(sessionId, source);
    this.finishAgentProjectionRebase(sessionId, source);
  }

  private deleteThreadProjection(key: string): void {
    for (const event of [...(this.eventsByThread.get(key)?.values() ?? [])]) {
      this.removeEvent(event);
    }
    for (let index = this.pendingEvents.length - 1; index >= 0; index -= 1) {
      if (this.pendingEvents[index]?.threadKey === key) {
        this.pendingEvents.splice(index, 1);
      }
    }
    this.projectionRebases.delete(key);
    this.retainedProjectionIdentities.delete(key);
    this.nextCanonicalOrderByThread.delete(key);
    this.store.deleteThreadEvents(key);
  }

  markViewed(session: Pick<TrackedSession, 'id' | 'source'>): void {
    const key = threadKey(session.source, session.id);
    const cursor = this.cursorFor(key);
    const newestSeq = this.latestEvent(key)?.seq ?? cursor.viewedThroughSeq;
    if (newestSeq <= cursor.viewedThroughSeq) return;
    cursor.viewedThroughSeq = newestSeq;
    this.cursorsDirty = true;
    this.schedulePersist();
    this.scheduleChange();
  }

  /** Explicitly clear reviewed evidence; merely opening a thread never calls this. */
  markResolved(session: Pick<TrackedSession, 'id' | 'source'>): void {
    const key = threadKey(session.source, session.id);
    const cursor = this.cursorFor(key);
    const newestSeq = this.latestEvent(key)?.seq ?? cursor.resolvedThroughSeq;
    if (
      newestSeq <= cursor.resolvedThroughSeq &&
      newestSeq <= cursor.viewedThroughSeq
    ) {
      return;
    }
    cursor.viewedThroughSeq = Math.max(cursor.viewedThroughSeq, newestSeq);
    cursor.resolvedThroughSeq = Math.max(cursor.resolvedThroughSeq, newestSeq);
    this.cursorsDirty = true;
    this.schedulePersist();
    this.scheduleChange();
  }

  attentionFor(
    session: TrackedSession,
    explicitWaiting?: { needsUser: boolean; reason: string },
  ): ThreadAttentionState {
    const key = threadKey(session.source, session.id);
    const cursor = this.cursorFor(key);
    const events = [...(this.eventsByThread.get(key)?.values() ?? [])]
      .sort(compareCanonicalEvents);
    const phase = reduceLifecycle(events);
    const latestSeq = Math.max(0, ...events.map((event) => event.seq));
    const beyondBaseline =
      phase !== null &&
      (!phase.seeded || phase.occurredAtMs > cursor.baselineAtMs);
    const unresolved =
      beyondBaseline && latestSeq > cursor.resolvedThroughSeq;
    const unread = beyondBaseline && latestSeq > cursor.viewedThroughSeq;
    const observedLive =
      phase !== null &&
      !phase.seeded &&
      phase.observedAtMs >= this.startedAtMs;

    if (explicitWaiting?.needsUser) {
      const evidence = latestWaitingEvidence(events, explicitWaiting.reason);
      const reason = clamp(
        explicitWaiting.reason ||
        evidence?.summary ||
        'The agent is waiting for your input.',
      );
      return {
        kind: 'waiting',
        headline: 'Waiting for you',
        context: reason,
        reason,
        sinceMs:
          evidence?.occurredAtMs ??
          phase?.occurredAtMs ??
          session.lastEventTime.getTime(),
        unread,
        inferred: false,
        observedLive,
      };
    }
    if (phase?.kind === 'input_requested') {
      return {
        kind: 'waiting',
        headline: 'Waiting for you',
        context: phase.summary,
        reason: phase.summary,
        sinceMs: phase.occurredAtMs,
        unread,
        inferred: false,
        observedLive,
      };
    }

    if (!unresolved || !phase) return noAttention();
    const quietForMs = Math.max(0, this.now().getTime() - phase.occurredAtMs);

    if (phase.kind === 'turn_failed') {
      return attentionFromEvent('failed', phase, unread, observedLive);
    }
    if (phase.kind === 'turn_interrupted') {
      return attentionFromEvent('interrupted', phase, unread, observedLive);
    }
    if (phase.kind === 'turn_completed') {
      const context =
        contextBefore(events, phase) ||
        'The latest agent turn is ready for review.';
      if (quietForMs >= FORGOTTEN_AFTER_MS) {
        return {
          kind: 'forgotten',
          headline: 'Still waiting for review',
          context,
          reason: 'A completed turn has been waiting for review',
          sinceMs: phase.occurredAtMs,
          unread,
          inferred: true,
          observedLive,
        };
      }
      return {
        kind: 'completed',
        headline: 'Last turn ended',
        context,
        reason: 'Latest turn ended — ready to review',
        sinceMs: phase.occurredAtMs,
        unread,
        inferred: false,
        observedLive,
      };
    }

    // A stall is inferred only from work Aside observed live. Historical tool
    // calls and generic transcript silence cannot establish that a task hung.
    if (
      phase.kind === 'work_started' &&
      !phase.seeded &&
      quietForMs >= STALLED_AFTER_MS
    ) {
      if (quietForMs >= FORGOTTEN_AFTER_MS) {
        return {
          kind: 'forgotten',
          headline: 'Still waiting for review',
          context:
            session.currentActivity ||
            phase.summary ||
            'Observed work has been quiet without an outcome.',
          reason: 'Observed work has been quiet for a day without an outcome',
          sinceMs: phase.occurredAtMs,
          unread,
          inferred: true,
          observedLive,
        };
      }
      return {
        kind: 'stalled',
        headline: 'Work may be stalled',
        context:
          session.currentActivity ||
          phase.summary ||
          'Observed work has been quiet without an outcome.',
        reason: session.currentActivity
          ? `No outcome after 20 minutes · ${session.currentActivity}`
          : 'No outcome after 20 minutes',
        sinceMs: phase.occurredAtMs,
        unread,
        inferred: true,
        observedLive,
      };
    }
    return noAttention();
  }

  getEvents(options: {
    sinceMs?: number;
    untilMs?: number;
    threadKey?: string;
  } = {}): ActivityEventRecord[] {
    const since = options.sinceMs ?? Number.NEGATIVE_INFINITY;
    const until = options.untilMs ?? Number.POSITIVE_INFINITY;
    const source = options.threadKey
      ? [...(this.eventsByThread.get(options.threadKey)?.values() ?? [])]
      : [...this.events.values()];
    return source
      .filter(
        (event) =>
          event.occurredAtMs >= since && event.occurredAtMs < until,
      )
      .sort(
        (a, b) =>
          a.occurredAtMs - b.occurredAtMs ||
          a.seq - b.seq,
      );
  }

  getHighWaterSeq(): number {
    return Math.max(0, this.nextSeq - 1);
  }

  getEvent(eventId: string): ActivityEventRecord | null {
    const event = this.events.get(eventId);
    return event ? { ...event } : null;
  }

  getCursors(): ThreadActivityCursor[] {
    return [...this.cursors.values()].map((cursor) => ({ ...cursor }));
  }

  flush(): void {
    if (this.persistImmediate) {
      clearImmediate(this.persistImmediate);
      this.persistImmediate = null;
    }
    const pending = this.pendingEvents.splice(0);
    if (pending.length > 0) this.store.append(pending);
    if (this.cursorsDirty) {
      this.store.saveCursors([...this.cursors.values()]);
      this.cursorsDirty = false;
    }
    this.store.prune(
      this.now().getTime() - RECORD_MAX_AGE_MS,
      ACTIVITY_MAX_RECORDS,
    );
  }

  dispose(): void {
    this.disposed = true;
    if (this.changeImmediate) {
      clearImmediate(this.changeImmediate);
      this.changeImmediate = null;
    }
    this.flush();
    this.store.close?.();
  }

  private addEvent(event: ActivityEventRecord): void {
    if (this.events.has(event.eventId)) return;
    this.events.set(event.eventId, event);
    const threadEvents =
      this.eventsByThread.get(event.threadKey) ??
      new Map<string, ActivityEventRecord>();
    threadEvents.set(event.eventId, event);
    this.eventsByThread.set(event.threadKey, threadEvents);
    this.nextCanonicalOrderByThread.set(
      event.threadKey,
      Math.max(
        this.nextCanonicalOrderByThread.get(event.threadKey) ?? 1,
        eventCanonicalOrder(event) + 1,
      ),
    );
    const latest = this.latestByThread.get(event.threadKey);
    if (!latest || event.seq > latest.seq) {
      this.latestByThread.set(event.threadKey, event);
    }
    const latestPhase = this.latestPhaseByThread.get(event.threadKey);
    if (
      event.kind !== 'tool_warning' &&
      (!latestPhase || compareCanonicalEvents(event, latestPhase) > 0)
    ) {
      this.latestPhaseByThread.set(event.threadKey, event);
    }
  }

  private latestEvent(key: string): ActivityEventRecord | null {
    return this.latestByThread.get(key) ?? null;
  }

  private cursorFor(key: string): ThreadActivityCursor {
    const existing = this.cursors.get(key);
    if (existing) return existing;
    const created: ThreadActivityCursor = {
      threadKey: key,
      baselineAtMs: 0,
      viewedThroughSeq: 0,
      resolvedThroughSeq: 0,
    };
    this.cursors.set(key, created);
    this.cursorsDirty = true;
    return created;
  }

  private pruneInMemory(forceAgeSweep = false): void {
    const nowMs = this.now().getTime();
    if (
      forceAgeSweep ||
      nowMs < this.lastAgePruneAtMs ||
      nowMs - this.lastAgePruneAtMs >= AGE_PRUNE_INTERVAL_MS
    ) {
      const cutoff = nowMs - RECORD_MAX_AGE_MS;
      for (const event of [...this.events.values()]) {
        if (event.occurredAtMs < cutoff) this.removeEvent(event);
      }
      this.lastAgePruneAtMs = nowMs;
    }
    while (this.events.size > ACTIVITY_MAX_RECORDS) {
      const oldest = this.events.values().next().value as
        | ActivityEventRecord
        | undefined;
      if (!oldest) break;
      this.removeEvent(oldest);
    }
  }

  private removeEvent(event: ActivityEventRecord): void {
    this.events.delete(event.eventId);
    const threadEvents = this.eventsByThread.get(event.threadKey);
    if (!threadEvents) return;
    threadEvents.delete(event.eventId);
    if (threadEvents.size === 0) {
      this.eventsByThread.delete(event.threadKey);
      this.latestByThread.delete(event.threadKey);
      this.latestPhaseByThread.delete(event.threadKey);
    } else if (
      this.latestByThread.get(event.threadKey)?.eventId === event.eventId
    ) {
      let latest: ActivityEventRecord | undefined;
      for (const candidate of threadEvents.values()) {
        if (!latest || candidate.seq > latest.seq) latest = candidate;
      }
      if (latest) this.latestByThread.set(event.threadKey, latest);
    }
    if (
      this.latestPhaseByThread.get(event.threadKey)?.eventId === event.eventId
    ) {
      let latestPhase: ActivityEventRecord | undefined;
      for (const candidate of threadEvents.values()) {
        if (
          candidate.kind !== 'tool_warning' &&
          (!latestPhase || compareCanonicalEvents(candidate, latestPhase) > 0)
        ) {
          latestPhase = candidate;
        }
      }
      if (latestPhase) {
        this.latestPhaseByThread.set(event.threadKey, latestPhase);
      } else {
        this.latestPhaseByThread.delete(event.threadKey);
      }
    }
  }

  private schedulePersist(): void {
    if (this.disposed || this.persistImmediate) return;
    this.persistImmediate = setImmediate(() => {
      this.persistImmediate = null;
      if (!this.disposed) this.flush();
    });
  }

  private scheduleChange(): void {
    if (this.disposed || !this.onChange || this.changeImmediate) return;
    this.changeImmediate = setImmediate(() => {
      this.changeImmediate = null;
      if (!this.disposed) this.onChange?.();
    });
  }

  private takeNextCanonicalOrder(key: string): number {
    const next = this.nextCanonicalOrderByThread.get(key) ?? 1;
    this.nextCanonicalOrderByThread.set(key, next + 1);
    return next;
  }
}

export function threadKey(
  source: TrackedSession['source'],
  sessionId: string,
): string {
  return `${source}:${sessionId}`;
}

function normalizeEvent(
  metadata: ActivitySessionMetadata,
  input: RecordedAgentEvent,
  seq: number,
  canonicalOrder: number,
  observedAtMs: number,
): ActivityEventRecord | null {
  const normalized = normalizedKindAndSummary(input.event);
  if (!normalized) return null;
  const occurredAtMs = validTime(input.event.ts)
    ? Date.parse(input.event.ts)
    : metadata.lastEventAtMs;
  const evidenceHash = createHash('sha256')
    .update(input.rawLine)
    .digest('hex');
  const originId = extractOriginId(input.rawLine);
  const identity = [
    metadata.threadKey,
    originId ?? evidenceHash,
    input.ordinal,
    normalized.kind,
  ].join('\u0000');
  return {
    seq,
    canonicalOrder,
    eventId: createHash('sha256').update(identity).digest('hex').slice(0, 32),
    threadKey: metadata.threadKey,
    source: metadata.source,
    sessionId: metadata.sessionId,
    parentThreadKey: metadata.parentThreadKey,
    rootThreadKey: metadata.rootThreadKey,
    projectName: clamp(metadata.projectName),
    projectPath: clamp(metadata.projectPath),
    title: clamp(metadata.title),
    occurredAtMs,
    observedAtMs,
    kind: normalized.kind,
    originKind: input.event.kind,
    lifecycle: normalized.lifecycle,
    severity: normalized.severity,
    summary: clamp(normalized.summary),
    originId,
    evidenceHash,
    seeded: input.seeded,
  };
}

function normalizedKindAndSummary(event: SessionEvent): {
  kind: ActivityEventKind;
  lifecycle: ActivityLifecycle;
  severity: ActivitySeverity;
  summary: string;
} | null {
  switch (event.kind) {
    case 'session_started':
      return lifecycle('session_started', 'start', 'info', 'Session started');
    case 'user_prompt':
      return lifecycle('prompt', 'start', 'info', event.summary || 'New prompt');
    case 'assistant_text':
      return lifecycle('progress', 'progress', 'info', event.preview || 'Agent responded');
    case 'tool_call':
      return lifecycle(
        'work_started',
        'progress',
        'info',
        event.target ? `${event.tool}: ${event.target}` : event.tool,
      );
    case 'tool_result_ok':
      return lifecycle('progress', 'progress', 'info', `${event.tool || 'Tool'} completed`);
    case 'tool_result_error':
      return lifecycle(
        'tool_warning',
        'progress',
        'warning',
        event.error || `${event.tool || 'Tool'} failed`,
      );
    case 'tool_rejected':
      return lifecycle('tool_warning', 'progress', 'warning', `${event.tool} was rejected`);
    case 'needs_input':
      return lifecycle('input_requested', 'blocked', 'attention', event.reason);
    case 'bash_running':
      return lifecycle('work_started', 'progress', 'info', `Running: ${event.command}`);
    case 'bash_complete':
      return event.exitCode === 0
        ? lifecycle('progress', 'progress', 'info', `Command completed: ${event.command}`)
        : lifecycle(
            'tool_warning',
            'progress',
            'warning',
            `Command exited ${event.exitCode}: ${event.command}`,
          );
    case 'file_written':
      return lifecycle('progress', 'progress', 'info', `Wrote ${event.path}`);
    case 'file_edited':
      return lifecycle('progress', 'progress', 'info', `Edited ${event.path}`);
    case 'turn_complete':
      return lifecycle('turn_completed', 'terminal', 'info', 'Latest turn ended');
    case 'turn_failed':
      return lifecycle('turn_failed', 'terminal', 'error', event.error);
    case 'turn_interrupted':
      return lifecycle('turn_interrupted', 'terminal', 'attention', event.reason);
    default:
      return null;
  }
}

function lifecycle(
  kind: ActivityEventKind,
  phase: ActivityLifecycle,
  severity: ActivitySeverity,
  summary: string,
) {
  return { kind, lifecycle: phase, severity, summary };
}

function reduceLifecycle(events: ActivityEventRecord[]): ActivityEventRecord | null {
  let phase: ActivityEventRecord | null = null;
  for (const event of events) {
    if (event.kind === 'tool_warning') continue;
    phase = event;
  }
  return phase;
}

function eventCanonicalOrder(event: ActivityEventRecord): number {
  return event.canonicalOrder ?? event.seq;
}

function compareCanonicalEvents(
  left: ActivityEventRecord,
  right: ActivityEventRecord,
): number {
  return (
    left.threadKey.localeCompare(right.threadKey) ||
    eventCanonicalOrder(left) - eventCanonicalOrder(right) ||
    left.seq - right.seq ||
    left.eventId.localeCompare(right.eventId)
  );
}

function attentionFromEvent(
  kind: 'failed' | 'interrupted',
  event: ActivityEventRecord,
  unread: boolean,
  observedLive = false,
): ThreadAttentionState {
  return {
    kind,
    headline: kind === 'failed' ? 'Turn failed' : 'Turn interrupted',
    context: event.summary,
    reason: event.summary,
    sinceMs: event.occurredAtMs,
    unread,
    inferred: false,
    observedLive,
  };
}

function noAttention(): ThreadAttentionState {
  return {
    kind: 'none',
    headline: '',
    context: '',
    reason: '',
    sinceMs: null,
    unread: false,
    inferred: false,
    observedLive: false,
  };
}

function latestWaitingEvidence(
  events: ActivityEventRecord[],
  reason: string,
): ActivityEventRecord | null {
  const expected = clamp(reason);
  let crossedCurrentTerminal = false;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (
      event.kind === 'turn_completed' ||
      event.kind === 'turn_failed' ||
      event.kind === 'turn_interrupted'
    ) {
      if (crossedCurrentTerminal) return null;
      crossedCurrentTerminal = true;
      continue;
    }
    if (event.kind === 'prompt' || event.kind === 'session_started') {
      return null;
    }
    if (
      (event.kind === 'input_requested' &&
        (!expected || event.summary === expected)) ||
      (event.kind === 'progress' &&
        expected.length > 0 &&
        event.summary === expected)
    ) {
      return event;
    }
  }
  return null;
}

function contextBefore(
  events: ActivityEventRecord[],
  phase: ActivityEventRecord,
): string {
  let fallback = '';
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (eventCanonicalOrder(event) >= eventCanonicalOrder(phase)) continue;
    if (
      event.kind === 'turn_completed' ||
      event.kind === 'turn_failed' ||
      event.kind === 'turn_interrupted'
    ) {
      return fallback;
    }
    if (event.kind === 'progress' || event.kind === 'input_requested') {
      return event.summary;
    }
    if (
      event.kind === 'work_started' ||
      event.kind === 'tool_warning'
    ) {
      fallback ||= event.summary;
    }
    if (event.kind === 'prompt' || event.kind === 'session_started') {
      return fallback || event.summary;
    }
  }
  return fallback;
}

function resolveRootThreadKey(
  key: string,
  sessions: Map<string, TrackedSession>,
): string | undefined {
  let current = sessions.get(key);
  if (!current?.parentSessionId) return undefined;
  let root = key;
  const seen = new Set<string>();
  while (current?.parentSessionId) {
    const parent = threadKey(current.source, current.parentSessionId);
    if (seen.has(parent)) break;
    seen.add(parent);
    root = parent;
    current = sessions.get(parent);
  }
  return root === key ? undefined : root;
}

function extractOriginId(rawLine: string): string | undefined {
  try {
    const parsed = JSON.parse(rawLine) as Record<string, unknown>;
    const payload = isRecord(parsed['payload']) ? parsed['payload'] : undefined;
    const candidate =
      parsed['uuid'] ??
      parsed['id'] ??
      payload?.['id'] ??
      payload?.['call_id'] ??
      payload?.['turn_id'];
    return typeof candidate === 'string' && candidate.length <= 500
      ? candidate
      : undefined;
  } catch {
    return undefined;
  }
}

function clamp(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length <= MAX_SUMMARY_LENGTH
    ? compact
    : `${compact.slice(0, MAX_SUMMARY_LENGTH - 3)}...`;
}

function validTime(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
