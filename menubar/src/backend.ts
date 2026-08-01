// Menubar backend: the Electron-free half of the menubar app.
//
// It drives the shared core (session scanning + SideChatService) and exposes a
// flat state object + commands the Electron main process bridges to the
// renderer over IPC. Keeping it Electron-free means it's unit-testable and the
// reuse of the TS core is exercised without spinning up a window.

import { scanAllSessions } from '../../dist/core/session-scanner.js';
import { SideChatService } from '../../dist/core/side-chat-service.js';
import { SideChatEngine } from '../../dist/core/side-chat-engine.js';
import { FileThreadStore } from '../../dist/core/thread-store.js';
import {
  ActivityLedger,
  InMemoryActivityLedgerStore,
  threadKey,
} from '../../dist/core/activity-ledger.js';
import {
  activityEvidenceRef,
  buildTodayDiary,
  countFacts,
} from '../../dist/core/today-diary.js';
import { buildActivityInsights } from '../../dist/core/activity-insights.js';
import { curateNarrativeActivity } from '../../dist/core/activity-narrative.js';
import { packActivityEvidence } from '../../dist/core/activity-evidence-pack.js';
import {
  FileGeneratedArtifactStore,
} from '../../dist/core/generated-artifact-store.js';
import {
  ObserverAnalysisEngine,
} from '../../dist/core/observer-analysis-engine.js';
import { TIMING } from '../../dist/config/defaults.js';
import {
  flattenModelCatalog,
  flattenModelCatalogWithLocal,
} from '../../dist/config/model-catalog.js';
import { FLEET_THREAD_ID, sessionThreadId } from '../../dist/types/chat.js';
import type { ModelOption } from '../../dist/config/model-catalog.js';
import type { TrackedSession } from '../../dist/types/session.js';
import type { ChatTurn } from '../../dist/types/chat.js';
import type {
  ActivityEventRecord,
  ThreadActivityCursor,
  ThreadAttentionKind,
} from '../../dist/types/activity.js';
import type {
  ActivityEvidenceRef,
  ActivityFactCounts,
  ActivityInsight,
  TodayDiary,
} from '../../dist/types/today.js';
import type {
  GeneratedArtifact,
  GeneratedDailyRecapArtifact,
  GeneratedThreadReviewArtifact,
} from '../../dist/types/generated-artifact.js';
import type {
  GeneratedArtifactStore,
} from '../../dist/core/generated-artifact-store.js';
import type {
  ObserverAnalysisEngineLike,
} from '../../dist/core/observer-analysis-engine.js';
import type {
  IndexableSideChat,
  SearchIndexStatus,
  ThreadSearchResult,
  ThreadSearchService,
} from './search-types.js';
import { ActivityDatabase } from './activity-database.js';

export interface SessionSummary {
  id: string;
  source: TrackedSession['source'];
  isInternal: boolean;
  parentSessionId?: string;
  projectName: string;
  /** Actual working folder when the transcript records one. */
  projectPath: string;
  title: string;
  status: TrackedSession['status'];
  currentActivity: string;
  /** Milliseconds since this session's last observed event. */
  idleForMs: number;
  threadId: string;
  needsUser: boolean;
  needsAttention: boolean;
  attentionKind: ThreadAttentionKind;
  attentionUnread: boolean;
  attentionObservedLive: boolean;
  attentionSince: number | null;
  attentionHeadline: string;
  attentionContext: string;
  attentionReason: string;
}

/** Everything the renderer needs to draw the dropdown. */
export interface MenubarState {
  sessions: SessionSummary[];
  /** Fleet or one session-specific durable side conversation. */
  activeThreadId: string;
  messages: ChatTurn[];
  thinking: boolean;
  provider: string;
  model: string;
  needsUserCount: number;
  attentionCount: number;
  unreadAttentionCount: number;
  attentionCounts: {
    waiting: number;
    failed: number;
    interrupted: number;
    completed: number;
    stalled: number;
    forgotten: number;
  };
  /** Threads whose transcript changed within the recent-activity window. */
  recentSessionCount: number;
  /** Where aside's own durable chats live. Agent/project files remain untouched. */
  storagePath: string;
  /** Every provider/model the observer can run on, for the picker. */
  models: ModelOption[];
  /** Local transcript-content indexing progress. */
  searchIndex: SearchIndexStatus;
  /** Monotonic ledger watermark used to refresh deterministic activity views. */
  activityHighWaterSeq: number;
  /** Changes when viewed/resolved cursors advance without a new event. */
  activityCursorRevision: string;
}

export interface BackendConfig {
  provider: string;
  model: string;
}

export interface MenubarThreadTarget {
  threadId: string;
  provider: string;
  model: string;
}

/**
 * Collision-safe identity for a watched agent session.
 *
 * Side-chat IDs predate multi-agent-source discovery and contain only the
 * vendor session ID. Requiring the source here prevents a Codex and Claude
 * session with the same ID from being silently conflated in activity reports.
 */
export interface MenubarSessionTarget {
  threadId: string;
  source: TrackedSession['source'];
}

export interface TodayViewState {
  diary: TodayDiary;
  insights: ActivityInsight[];
  provider: string;
  model: string;
  artifact: GeneratedDailyRecapArtifact | null;
  /** Evidence cited by the artifact and still present in today's ledger scope. */
  artifactEvidence: ActivityEvidenceRef[];
  artifactEvidenceMissingCount: number;
  /** Curated prompt/prose/attention/terminal facts eligible for a recap. */
  narrativeEventCount: number;
  newEventCount: number;
  artifactIsStale: boolean;
}

export interface ThreadReviewViewState {
  selection: MenubarSessionTarget;
  threadKey: string;
  rootThreadKey: string;
  isInternal: boolean;
  projectName: string;
  title: string;
  provider: string;
  model: string;
  /** Root reviews include current descendants; subagent reviews stay exact. */
  includedThreadKeys: string[];
  counts: ActivityFactCounts;
  insights: ActivityInsight[];
  /** Newest normalized facts only; raw transcript records are never returned. */
  evidence: ActivityEvidenceRef[];
  artifact: GeneratedThreadReviewArtifact | null;
  /** Evidence cited by the artifact and still present in this review scope. */
  artifactEvidence: ActivityEvidenceRef[];
  artifactEvidenceMissingCount: number;
  newEventCount: number;
  artifactIsStale: boolean;
}

/** Injection seam for tests (defaults wire up the real core). */
export interface BackendDeps {
  scan?: () => { sessions: TrackedSession[]; jsonlPaths: Map<string, string> };
  service?: SideChatService;
  models?: () => ModelOption[];
  search?: ThreadSearchService;
  activity?: ActivityLedger;
  artifacts?: GeneratedArtifactStore;
  analysis?: ObserverAnalysisEngineLike;
  now?: () => Date;
  timeZone?: string;
}

const THREAD_REVIEW_EVIDENCE_LIMIT = 240;

export class MenubarBackend {
  private readonly service: SideChatService;
  private readonly scan: () => { sessions: TrackedSession[]; jsonlPaths: Map<string, string> };
  /** Catalogued once: it's a static registry, not live state. */
  private models: ModelOption[];
  private readonly loadModels: (() => Promise<ModelOption[]>) | null;
  private readonly storagePath: string;
  private readonly search?: ThreadSearchService;
  private readonly activity: ActivityLedger;
  private readonly artifactStore: GeneratedArtifactStore;
  private readonly analysis: ObserverAnalysisEngineLike;
  private readonly now: () => Date;
  private readonly timeZone?: string;
  private readonly unsubscribeSearchStatus?: () => void;
  private artifacts: GeneratedArtifact[];
  private readonly analysisInFlight = new Map<string, Promise<unknown>>();
  private sessions: TrackedSession[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private config: BackendConfig,
    private readonly onUpdate: (state: MenubarState) => void,
    deps: BackendDeps = {},
  ) {
    this.now = deps.now ?? (() => new Date());
    this.timeZone = deps.timeZone;
    this.scan =
      deps.scan ??
      (() => scanAllSessions({}, { includeInternal: true }));
    this.search = deps.search;
    this.unsubscribeSearchStatus = this.search?.onStatus(() => this.emit());
    this.models = (deps.models ?? flattenModelCatalog)();
    this.loadModels = deps.models ? null : flattenModelCatalogWithLocal;
    this.activity =
      deps.activity ??
      new ActivityLedger(
        createActivityStore(),
        this.now,
        () => this.emit(),
      );
    this.artifactStore =
      deps.artifacts ??
      new FileGeneratedArtifactStore();
    this.artifacts = this.artifactStore.load();
    this.analysis =
      deps.analysis ??
      new ObserverAnalysisEngine(undefined, undefined, this.now);
    const store = new FileThreadStore();
    this.storagePath = store.location;
    this.service =
      deps.service ??
      new SideChatService(
        new SideChatEngine(config),
        {
          onChat: () => {
            this.syncSideChats();
            this.emit();
          },
          onThinking: () => this.emit(),
          onTranscript: () => this.emit(),
          onAttention: () => this.emit(),
          onThread: () => this.emit(),
          onActivity: (id, activity) => {
            const s = this.sessions.find((x) => x.id === id);
            if (s) {
              s.currentActivity = activity;
              s.status = 'active';
            }
            this.emit();
          },
          onEvent: (id, source, event, seeded, rawLine, ordinal) => {
            this.activity.recordAgentEvent({
              sessionId: id,
              source,
              event,
              seeded,
              rawLine,
              ordinal,
            });
          },
        },
        () => new Date(),
        { ...config, store },
      );
  }

  start(): void {
    this.refresh();
    void this.refreshModels();
    this.timer = setInterval(() => this.refresh(), TIMING.scanIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.service.dispose();
    this.activity.dispose();
    this.unsubscribeSearchStatus?.();
    this.search?.dispose();
  }

  /** Open the fleet conversation or one durable session side thread. */
  selectThread(threadId: string): void {
    const valid =
      threadId === FLEET_THREAD_ID ||
      this.sessions.some((session) => sessionThreadId(session.id) === threadId);
    const nextThreadId = valid ? threadId : FLEET_THREAD_ID;
    this.service.selectThread(nextThreadId);
    this.emit();
  }

  /** Mark evidence read only once the corresponding UI is actually visible. */
  markThreadViewed(threadId = this.service.getActiveThreadId()): void {
    if (!threadId.startsWith('session:')) return;
    const sessionId = threadId.slice('session:'.length);
    const selected = this.sessions.find((session) => session.id === sessionId);
    if (selected) this.activity.markViewed(selected);
  }

  /** Clear reviewed attention only through an explicit user action. */
  resolveThreadAttention(threadId = this.service.getActiveThreadId()): void {
    if (!threadId.startsWith('session:')) return;
    const sessionId = threadId.slice('session:'.length);
    const selected = this.sessions.find((session) => session.id === sessionId);
    if (selected) this.activity.markResolved(selected);
  }

  setModel(
    provider: string,
    model: string,
    target?: MenubarThreadTarget,
  ): void {
    if (!this.models.some((option) => option.provider === provider && option.model === model)) {
      return;
    }
    if (target && !this.threadStillMatches(target)) {
      throw new Error('This thread changed before the model could be applied.');
    }
    this.service.setModel(provider, model, target?.threadId);
    this.emit();
  }

  /**
   * Use a newly connected account for future and untouched conversations,
   * without changing threads that already have history or a custom model.
   */
  setDefaultModel(provider: string, model: string): void {
    if (!this.models.some((option) => option.provider === provider && option.model === model)) {
      return;
    }
    this.service.setDefaultModel(provider, model);
    this.emit();
  }

  /** Replace guessed Ollama entries with the models actually installed. */
  async refreshModels(): Promise<void> {
    if (!this.loadModels) return;
    const next = await this.loadModels();
    this.models = next;
    this.emit();
  }

  /** Ask inside the captured durable thread, never whichever thread is active later. */
  ask(question: string, target?: MenubarThreadTarget): Promise<void> {
    if (target && !this.threadStillMatches(target)) {
      return Promise.reject(
        new Error('This thread changed before the message could be sent.'),
      );
    }
    return this.service.ask(question, target?.threadId);
  }

  /**
   * The model/account the explicit Today generation action must authorize.
   * Callers should capture this, complete their provider auth guard, then pass
   * the same target to `generateTodayRecap`.
   */
  getTodayAnalysisTarget(): MenubarThreadTarget {
    return this.analysisTargetFor(FLEET_THREAD_ID);
  }

  /**
   * The selected session side-chat owns the model used for its explicit review.
   * Resolving the source as well as the side-chat ID prevents vendor-ID
   * collisions from selecting another agent's activity.
   */
  getThreadReviewAnalysisTarget(
    selection: MenubarSessionTarget,
  ): MenubarThreadTarget {
    const session = this.resolveReviewSession(selection);
    return this.analysisTargetFor(sessionThreadId(session.id));
  }

  /** Deterministic local Today state. This never calls a provider. */
  getToday(): TodayViewState {
    return this.buildTodayView(this.now().getTime());
  }

  /** Deterministic local review state. This never calls a provider. */
  getThreadReview(
    selection: MenubarSessionTarget,
  ): ThreadReviewViewState {
    const session = this.resolveReviewSession(selection);
    return this.buildThreadReviewView(selection, session);
  }

  /**
   * Generate one evidence-backed recap after an explicit UI action.
   * Repeated clicks for the same local day share one in-flight operation.
   */
  generateTodayRecap(
    target: MenubarThreadTarget,
  ): Promise<TodayViewState> {
    const nowMs = this.now().getTime();
    const before = this.buildTodayView(nowMs);
    const events = this.todayNarrativeEvents(before.diary);
    const evidence = packActivityEvidence(
      events.map(providerSafeActivityEvent),
    );

    // Entering Today is allowed to ask for a recap, but an empty narrative
    // scope must stay a completely local view. Likewise, reopening Today with
    // the same evidence should use its durable artifact rather than incur a
    // duplicate provider request.
    if (evidence.evidence.length === 0 || evidence.text.trim().length === 0) {
      return Promise.resolve(before);
    }
    if (
      before.artifact?.inputHash === evidence.inputHash &&
      before.artifactEvidenceMissingCount === 0
    ) {
      return Promise.resolve(before);
    }

    const scope = `daily:${before.diary.range.dateKey}`;
    this.assertAnalysisTarget(FLEET_THREAD_ID, target);
    const existing = this.analysisInFlight.get(scope);
    if (existing) return existing as Promise<TodayViewState>;

    const task = (async () => {
      const artifact = await this.analysis.generateDailyRecap({
        day: before.diary.range.dateKey,
        provider: target.provider,
        model: target.model,
        evidence,
      });
      assertGeneratedArtifactMatches(artifact, {
        kind: 'daily_recap',
        scope: before.diary.range.dateKey,
        target,
        highWaterSeq: evidence.highWaterSeq,
        inputHash: evidence.inputHash,
        evidenceIds: evidence.evidenceIds,
      });
      this.persistArtifact(artifact);
      return this.buildTodayView(nowMs);
    })();
    this.trackAnalysis(scope, task);
    return task;
  }

  /**
   * Generate one evidence-backed review after an explicit UI action.
   * Root reviews include descendant activity; subagent reviews stay exact.
   */
  generateThreadReview(
    selection: MenubarSessionTarget,
    target: MenubarThreadTarget,
  ): Promise<ThreadReviewViewState> {
    const session = this.resolveReviewSession(selection);
    const resolvedThreadId = sessionThreadId(session.id);
    const key = threadKey(session.source, session.id);
    const scope = `thread:${key}`;
    this.assertAnalysisTarget(resolvedThreadId, target);
    const existing = this.analysisInFlight.get(scope);
    if (existing) return existing as Promise<ThreadReviewViewState>;

    const events = this.threadReviewEvents(session);
    const evidence = packActivityEvidence(
      events.map(providerSafeActivityEvent),
    );
    const task = (async () => {
      const artifact = await this.analysis.generateThreadReview({
        threadKey: key,
        provider: target.provider,
        model: target.model,
        evidence,
      });
      assertGeneratedArtifactMatches(artifact, {
        kind: 'thread_review',
        scope: key,
        target,
        highWaterSeq: evidence.highWaterSeq,
        inputHash: evidence.inputHash,
        evidenceIds: evidence.evidenceIds,
      });
      this.persistArtifact(artifact);
      return this.buildThreadReviewView(selection, session);
    })();
    this.trackAnalysis(scope, task);
    return task;
  }

  /**
   * Search current metadata immediately and merge it with ranked local FTS
   * matches. The current scanner roster is authoritative, so stale index rows
   * can never resurrect a transcript that has disappeared.
   */
  async searchThreads(
    query: string,
    limit = 40,
  ): Promise<ThreadSearchResult[]> {
    const trimmed = query.trim();
    if (!trimmed || trimmed.length > 500) return [];
    const normalized = trimmed.toLocaleLowerCase();
    const metadata = this.sessions
      .filter((session) => {
        const attention = this.activity.attentionFor(
          session,
          this.service.getSessionAttention(session.id),
        );
        return [
          session.projectName,
          session.cwd || session.projectDir,
          session.title ?? '',
          session.source,
          session.id,
          session.status,
          session.currentActivity,
          attention.kind,
          attention.headline,
          attention.context,
          attention.reason,
        ].some((value) => value.toLocaleLowerCase().includes(normalized));
      })
      .map(
        (session): ThreadSearchResult => ({
          sessionId: session.id,
          source: session.source,
          kind: 'metadata',
          snippet: [],
          score: 0,
        }),
      );
    if (!this.search || normalized.length < 3) return metadata.slice(0, limit);

    const visible = new Set(
      this.sessions.map((session) => `${session.source}:${session.id}`),
    );
    const indexed = (await this.search.search(trimmed, limit)).filter((result) =>
      visible.has(`${result.source}:${result.sessionId}`),
    );
    const seen = new Set(
      indexed.map((result) => `${result.source}:${result.sessionId}`),
    );
    return [
      ...indexed,
      ...metadata.filter(
        (result) => !seen.has(`${result.source}:${result.sessionId}`),
      ),
    ].slice(0, limit);
  }

  rebuildSearchIndex(): void {
    this.search?.rebuild();
  }

  getState(): MenubarState {
    const now = Date.now();
    const active = this.service.getActiveThread();
    const sessions = this.sessions.map((s) => {
      const explicit = this.service.getSessionAttention(s.id);
      const attention = this.activity.attentionFor(s, explicit);
      return {
        id: s.id,
        source: s.source,
        isInternal: s.isInternal ?? false,
        parentSessionId: s.parentSessionId,
        projectName: s.projectName,
        projectPath: s.cwd || s.projectDir,
        title: s.title ?? '',
        status: s.status,
        currentActivity: s.currentActivity,
        idleForMs: Math.max(0, now - s.lastEventTime.getTime()),
        threadId: sessionThreadId(s.id),
        needsUser: explicit.needsUser,
        needsAttention: attention.kind !== 'none',
        attentionKind: attention.kind,
        attentionUnread: attention.unread,
        attentionObservedLive: attention.observedLive,
        attentionSince: attention.sinceMs,
        attentionHeadline: attention.headline,
        attentionContext: attention.context,
        attentionReason: attention.reason,
      };
    });
    const attentionCounts = {
      waiting: sessions.filter(
        (session) => session.attentionKind === 'waiting',
      ).length,
      failed: sessions.filter(
        (session) => session.attentionKind === 'failed',
      ).length,
      interrupted: sessions.filter(
        (session) => session.attentionKind === 'interrupted',
      ).length,
      completed: sessions.filter(
        (session) => session.attentionKind === 'completed',
      ).length,
      stalled: sessions.filter(
        (session) => session.attentionKind === 'stalled',
      ).length,
      forgotten: sessions.filter(
        (session) => session.attentionKind === 'forgotten',
      ).length,
    };
    return {
      sessions,
      activeThreadId: active.id,
      messages: active.turns,
      thinking: active.thinking,
      provider: active.provider,
      model: active.model,
      needsUserCount: sessions.filter(
        (session) => !session.isInternal && session.needsUser,
      ).length,
      attentionCount: Object.values(attentionCounts).reduce(
        (total, count) => total + count,
        0,
      ),
      unreadAttentionCount: sessions.filter(
        (session) =>
          session.needsAttention &&
          session.attentionUnread,
      ).length,
      attentionCounts,
      recentSessionCount: sessions.filter(
        (session) =>
          !session.isInternal &&
          (session.status === 'active' || session.status === 'idle'),
      ).length,
      storagePath: this.storagePath,
      models: this.models,
      searchIndex: this.search?.getStatus() ?? {
        phase: 'ready',
        indexedThreads: this.sessions.length,
        totalThreads: this.sessions.length,
        indexedBytes: 0,
        totalBytes: 0,
      },
      activityHighWaterSeq: this.activity.getHighWaterSeq(),
      activityCursorRevision: cursorRevision(this.activity.getCursors()),
    };
  }

  /** Rescan sessions, keep the selected thread valid, and re-sync the tailer. */
  refresh(): void {
    const { sessions, jsonlPaths } = this.scan();
    const previous = new Map(this.sessions.map((session) => [session.id, session]));
    this.sessions = sessions.map((session) => {
      const prior = previous.get(session.id);
      return prior?.currentActivity
        ? { ...session, currentActivity: prior.currentActivity }
        : session;
    });
    this.activity.syncSessions(this.sessions);
    this.service.syncSessions(this.sessions, jsonlPaths);
    this.search?.syncSessions(
      this.sessions.map((session) => ({
        sessionId: session.id,
        source: session.source,
        jsonlPath: session.jsonlPath,
        projectName: session.projectName,
        projectPath: session.cwd || session.projectDir,
        title: session.title ?? '',
        gitBranch: session.gitBranch,
        lastEventMs: session.lastEventTime.getTime(),
      })),
    );
    this.syncSideChats();
    const active = this.service.getActiveThread();
    const activeSessionId =
      active.scope.kind === 'session' ? active.scope.sessionId : null;
    if (
      activeSessionId !== null &&
      !sessions.some((session) => session.id === activeSessionId)
    ) {
      this.service.selectThread(FLEET_THREAD_ID);
    }
    this.emit();
  }

  private buildTodayView(nowMs: number): TodayViewState {
    const allEvents = this.activity.getEvents();
    const diary = buildTodayDiary(allEvents, {
      nowMs,
      timeZone: this.timeZone,
    });
    const events = this.todayEvents(diary);
    const narrativeEvents = curateNarrativeActivity(events);
    const narrativeEvidence = packActivityEvidence(
      narrativeEvents.map(providerSafeActivityEvent),
    );
    const insights = buildActivityInsights(events, {
      nowMs,
      cursors: this.activity.getCursors(),
    });
    const artifact = this.latestDailyArtifact(diary.range.dateKey);
    const artifactEvidence = this.resolveArtifactEvidence(artifact, events);
    const analysisTarget = this.getTodayAnalysisTarget();
    const artifactEvidenceMissingCount = artifact
      ? artifact.evidenceIds.length - artifactEvidence.length
      : 0;
    const newEventCount = countEventsAfterArtifact(narrativeEvents, artifact);
    const artifactInputChanged =
      artifact !== null &&
      narrativeEvidence.evidence.length > 0 &&
      artifact.inputHash !== narrativeEvidence.inputHash;
    return {
      diary,
      insights,
      provider: analysisTarget.provider,
      model: analysisTarget.model,
      artifact,
      artifactEvidence,
      artifactEvidenceMissingCount,
      narrativeEventCount: narrativeEvents.length,
      newEventCount,
      artifactIsStale:
        artifact !== null &&
        (newEventCount > 0 ||
          artifactEvidenceMissingCount > 0 ||
          artifactInputChanged),
    };
  }

  private todayEvents(diary: TodayDiary): ActivityEventRecord[] {
    return this.activity.getEvents({
      sinceMs: diary.range.startMs,
      untilMs: diary.range.endMs,
    });
  }

  private todayNarrativeEvents(diary: TodayDiary): ActivityEventRecord[] {
    return curateNarrativeActivity(this.todayEvents(diary));
  }

  private buildThreadReviewView(
    selection: MenubarSessionTarget,
    session: TrackedSession,
  ): ThreadReviewViewState {
    const key = threadKey(session.source, session.id);
    const events = this.threadReviewEvents(session);
    const rootThreadKey = this.rootThreadKeyFor(session, events);
    const includedThreadKeys = [...new Set(events.map((event) => event.threadKey))]
      .sort((left, right) => {
        if (left === key) return -1;
        if (right === key) return 1;
        return left.localeCompare(right);
      });
    if (!includedThreadKeys.includes(key)) includedThreadKeys.unshift(key);
    const artifact = this.latestThreadArtifact(key);
    const analysisTarget = this.analysisTargetFor(sessionThreadId(session.id));
    const artifactEvidence = this.resolveArtifactEvidence(artifact, events);
    const artifactEvidenceMissingCount = artifact
      ? artifact.evidenceIds.length - artifactEvidence.length
      : 0;
    const newEventCount = countEventsAfterArtifact(events, artifact);
    return {
      selection: { ...selection },
      threadKey: key,
      rootThreadKey,
      isInternal: session.isInternal ?? false,
      projectName: session.projectName,
      title: session.title ?? '',
      provider: analysisTarget.provider,
      model: analysisTarget.model,
      includedThreadKeys,
      counts: countFacts(events),
      insights: buildActivityInsights(events, {
        nowMs: this.now().getTime(),
        cursors: this.activity.getCursors(),
      }),
      evidence: events
        .slice(-THREAD_REVIEW_EVIDENCE_LIMIT)
        .map(activityEvidenceRef),
      artifact,
      artifactEvidence,
      artifactEvidenceMissingCount,
      newEventCount,
      artifactIsStale:
        artifact !== null &&
        (newEventCount > 0 || artifactEvidenceMissingCount > 0),
    };
  }

  private threadReviewEvents(session: TrackedSession): ActivityEventRecord[] {
    const key = threadKey(session.source, session.id);
    if (session.isInternal || session.parentSessionId) {
      return this.activity.getEvents({ threadKey: key });
    }

    const descendants = this.currentDescendantKeys(session);
    return this.activity
      .getEvents()
      .filter(
        (event) =>
          event.threadKey === key ||
          event.rootThreadKey === key ||
          descendants.has(event.threadKey),
      );
  }

  private currentDescendantKeys(root: TrackedSession): Set<string> {
    const rootKey = threadKey(root.source, root.id);
    const descendants = new Set<string>([rootKey]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const candidate of this.sessions) {
        if (
          candidate.source !== root.source ||
          !candidate.parentSessionId ||
          descendants.has(threadKey(candidate.source, candidate.id))
        ) {
          continue;
        }
        const parentKey = threadKey(
          candidate.source,
          candidate.parentSessionId,
        );
        if (!descendants.has(parentKey)) continue;
        descendants.add(threadKey(candidate.source, candidate.id));
        changed = true;
      }
    }
    return descendants;
  }

  private rootThreadKeyFor(
    session: TrackedSession,
    events: ReadonlyArray<ActivityEventRecord>,
  ): string {
    const key = threadKey(session.source, session.id);
    if (!session.isInternal && !session.parentSessionId) return key;
    const recorded = [...events]
      .reverse()
      .find((event) => event.threadKey === key)?.rootThreadKey;
    if (recorded) return recorded;

    let current = session;
    let rootKey = key;
    const seen = new Set<string>([key]);
    while (current.parentSessionId) {
      const parentKey = threadKey(current.source, current.parentSessionId);
      if (seen.has(parentKey)) break;
      seen.add(parentKey);
      rootKey = parentKey;
      const parent = this.sessions.find(
        (candidate) =>
          candidate.source === current.source &&
          candidate.id === current.parentSessionId,
      );
      if (!parent) break;
      current = parent;
    }
    return rootKey;
  }

  private resolveReviewSession(
    selection: MenubarSessionTarget,
  ): TrackedSession {
    if (
      !selection ||
      !['claude', 'codex', 'pi'].includes(selection.source) ||
      typeof selection.threadId !== 'string' ||
      !selection.threadId.startsWith('session:')
    ) {
      throw new Error('Choose a valid agent thread to review.');
    }
    const sessionId = selection.threadId.slice('session:'.length);
    if (!sessionId || sessionThreadId(sessionId) !== selection.threadId) {
      throw new Error('Choose a valid agent thread to review.');
    }
    const matches = this.sessions.filter(
      (session) =>
        session.id === sessionId &&
        session.source === selection.source,
    );
    if (matches.length !== 1) {
      throw new Error(
        matches.length === 0
          ? 'That agent thread is no longer available.'
          : 'That agent thread identity is ambiguous.',
      );
    }
    return matches[0]!;
  }

  private analysisTargetFor(threadId: string): MenubarThreadTarget {
    const thread = this.service.getThread(threadId);
    return {
      threadId: thread.id,
      provider: thread.provider,
      model: thread.model,
    };
  }

  private assertAnalysisTarget(
    expectedThreadId: string,
    target: MenubarThreadTarget,
  ): void {
    if (
      target.threadId !== expectedThreadId ||
      !this.threadStillMatches(target)
    ) {
      throw new Error(
        'This thread changed before the observer analysis could start.',
      );
    }
  }

  private latestDailyArtifact(
    day: string,
  ): GeneratedDailyRecapArtifact | null {
    return latestArtifact(
      this.artifacts.filter(
        (artifact): artifact is GeneratedDailyRecapArtifact =>
          artifact.kind === 'daily_recap' && artifact.day === day,
      ),
    );
  }

  private latestThreadArtifact(
    key: string,
  ): GeneratedThreadReviewArtifact | null {
    return latestArtifact(
      this.artifacts.filter(
        (artifact): artifact is GeneratedThreadReviewArtifact =>
          artifact.kind === 'thread_review' &&
          artifact.threadKey === key,
      ),
    );
  }

  private resolveArtifactEvidence(
    artifact:
      | GeneratedDailyRecapArtifact
      | GeneratedThreadReviewArtifact
      | null,
    scopedEvents: ReadonlyArray<ActivityEventRecord>,
  ): ActivityEvidenceRef[] {
    if (!artifact) return [];
    const scopedIds = new Set(scopedEvents.map((event) => event.eventId));
    const resolved: ActivityEvidenceRef[] = [];
    const seen = new Set<string>();
    for (const eventId of artifact.evidenceIds) {
      if (seen.has(eventId) || !scopedIds.has(eventId)) continue;
      seen.add(eventId);
      const event = this.activity.getEvent(eventId);
      if (event) resolved.push(activityEvidenceRef(event));
    }
    return resolved;
  }

  private persistArtifact(artifact: GeneratedArtifact): void {
    const next = [
      ...this.artifacts.filter((current) => current.id !== artifact.id),
      artifact,
    ];
    this.artifactStore.save(next);
    // The durable store applies its retention/size bounds. Mirror the
    // installed snapshot so a long-running app cannot keep an unbounded
    // pre-prune array in memory.
    this.artifacts = this.artifactStore.load();
  }

  private trackAnalysis<T>(scope: string, task: Promise<T>): void {
    this.analysisInFlight.set(scope, task);
    const clear = () => {
      if (this.analysisInFlight.get(scope) === task) {
        this.analysisInFlight.delete(scope);
      }
    };
    task.then(clear, clear);
  }

  private emit(): void {
    this.onUpdate(this.getState());
  }

  private syncSideChats(): void {
    if (!this.search) return;
    const chats: IndexableSideChat[] = this.service
      .getThreads()
      .flatMap((thread): IndexableSideChat[] =>
        thread.scope.kind === 'session'
          ? [{
              sessionId: thread.scope.sessionId,
              updatedAt: thread.updatedAt.toISOString(),
              turns: thread.turns.map((turn) => ({
                role: turn.role,
                content: turn.content,
                timestamp: turn.timestamp.toISOString(),
              })),
            }]
          : [],
      );
    this.search.syncSideChats(chats);
  }

  private threadStillMatches(target: MenubarThreadTarget): boolean {
    const thread = this.service.getThread(target.threadId);
    return (
      thread.provider === target.provider &&
      thread.model === target.model
    );
  }
}

function createActivityStore() {
  try {
    return new ActivityDatabase();
  } catch (error) {
    console.warn(
      '  • durable activity history unavailable:',
      error instanceof Error ? error.message : 'unknown error',
    );
    return new InMemoryActivityLedgerStore();
  }
}

function latestArtifact<T extends GeneratedArtifact>(
  artifacts: ReadonlyArray<T>,
): T | null {
  let latest: T | null = null;
  for (const artifact of artifacts) {
    if (
      !latest ||
      artifact.createdAt > latest.createdAt ||
      (artifact.createdAt === latest.createdAt && artifact.id > latest.id)
    ) {
      latest = artifact;
    }
  }
  return latest;
}

function countEventsAfterArtifact(
  events: ReadonlyArray<ActivityEventRecord>,
  artifact: GeneratedArtifact | null,
): number {
  const highWaterSeq = artifact?.inputHighWaterSeq ?? 0;
  return events.filter((event) => event.seq > highWaterSeq).length;
}

function cursorRevision(
  cursors: ReadonlyArray<ThreadActivityCursor>,
): string {
  let revision = 0n;
  for (const cursor of cursors) {
    revision += BigInt(cursor.viewedThroughSeq);
    revision += BigInt(cursor.resolvedThroughSeq);
  }
  return revision.toString();
}

/**
 * Provider-bound evidence should identify projects and activity without
 * disclosing the user's local home, temp, or volume layout. The shared packer
 * still performs credential redaction and clamps every field after this pass.
 */
function providerSafeActivityEvent(
  event: ActivityEventRecord,
): ActivityEventRecord {
  return {
    ...event,
    projectName: redactLocalPaths(event.projectName),
    title: redactLocalPaths(event.title),
    summary: redactLocalPaths(event.summary),
  };
}

function redactLocalPaths(value: string): string {
  const delimited = value
    .replace(
      /"((?:file:(?:\/\/[^/\s"]*)?\/|~\/|\/(?!\/)|[A-Za-z]:[\\/]|\\\\)[^"\r\n]+)"/gi,
      '"[LOCAL_PATH]"',
    )
    .replace(
      /'((?:file:(?:\/\/[^/\s']*)?\/|~\/|\/(?!\/)|[A-Za-z]:[\\/]|\\\\)[^'\r\n]+)'/gi,
      "'[LOCAL_PATH]'",
    )
    .replace(
      /`((?:file:(?:\/\/[^/\s`]*)?\/|~\/|\/(?!\/)|[A-Za-z]:[\\/]|\\\\)[^`\r\n]+)`/gi,
      '`[LOCAL_PATH]`',
    )
    .replace(
      /<((?:file:(?:\/\/[^/\s>]*)?\/|~\/|\/(?!\/)|[A-Za-z]:[\\/]|\\\\)[^>\r\n]+)>/gi,
      '<[LOCAL_PATH]>',
    );
  return redactUnquotedLocalPaths(delimited);
}

const LOCAL_PATH_LEFT_BOUNDARY =
  /(^|[\s("'`=:[,])(?:file:(?:\/\/[^/\s"'`]*)?\/|~\/|\/(?!\/)|[A-Za-z]:[\\/]|\\\\)/gi;
const LOCAL_PATH_HARD_STOP = /[\r\n"'`]/;
const PATH_TRAILING_EXTENSION = /\.[A-Za-z0-9_-]{1,16}(?::\d+(?::\d+)?)?$/;
const PATH_PROSE_BOUNDARIES = new Set([
  'after',
  'and',
  'at',
  'before',
  'because',
  'but',
  'by',
  'completed',
  'continue',
  'continued',
  'contains',
  'during',
  'exists',
  'failed',
  'finished',
  'for',
  'from',
  'had',
  'has',
  'into',
  'is',
  'missing',
  'now',
  'on',
  'or',
  'ready',
  'reported',
  'returned',
  'ran',
  'run',
  'saved',
  'see',
  'so',
  'started',
  'succeeded',
  'successfully',
  'then',
  'to',
  'using',
  'via',
  'was',
  'were',
  'when',
  'while',
  'with',
  'wrote',
]);

function redactUnquotedLocalPaths(value: string): string {
  LOCAL_PATH_LEFT_BOUNDARY.lastIndex = 0;
  let output = '';
  let copiedThrough = 0;
  let match: RegExpExecArray | null;
  while ((match = LOCAL_PATH_LEFT_BOUNDARY.exec(value)) !== null) {
    const prefix = match[1] ?? '';
    const pathStart = match.index + prefix.length;
    if (pathStart < copiedThrough) continue;
    const pathEnd = unquotedLocalPathEnd(value, pathStart);
    output += value.slice(copiedThrough, pathStart);
    output += '[LOCAL_PATH]';
    copiedThrough = pathEnd;
    LOCAL_PATH_LEFT_BOUNDARY.lastIndex = pathEnd;
  }
  return output + value.slice(copiedThrough);
}

function unquotedLocalPathEnd(value: string, start: number): number {
  let index = start;
  while (index < value.length) {
    const char = value[index]!;
    if (LOCAL_PATH_HARD_STOP.test(char)) break;
    if (
      char === ';' &&
      !pathSyntaxBeforeProseBoundary(value.slice(index + 1).trimStart())
    ) {
      break;
    }
    if (!/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char !== ' ' && char !== '\t') break;
    if (index > start && value[index - 1] === '\\') {
      index += 1;
      continue;
    }

    let nextStart = index;
    while (value[nextStart] === ' ' || value[nextStart] === '\t') {
      nextStart += 1;
    }
    let nextEnd = nextStart;
    while (
      nextEnd < value.length &&
      !/\s/.test(value[nextEnd]!) &&
      !LOCAL_PATH_HARD_STOP.test(value[nextEnd]!)
    ) {
      nextEnd += 1;
    }
    const nextWord = value.slice(nextStart, nextEnd);
    if (!nextWord) break;
    const normalizedWord = nextWord.toLocaleLowerCase().replace(/[.:]+$/, '');
    if (PATH_PROSE_BOUNDARIES.has(normalizedWord)) break;

    const currentPath = value.slice(start, index).replace(/\\ /g, ' ');
    const remainingLine = value.slice(nextStart).split(/[\r\n"'`]/, 1)[0] ?? '';
    const hasPathProof =
      /[\\/]/.test(nextWord) ||
      PATH_TRAILING_EXTENSION.test(nextWord) ||
      pathSyntaxBeforeProseBoundary(remainingLine);
    if (PATH_TRAILING_EXTENSION.test(currentPath) && !hasPathProof) break;
    index = nextStart;
  }
  return index;
}

function pathSyntaxBeforeProseBoundary(value: string): boolean {
  const words = value.split(/\s+/);
  const candidate: string[] = [];
  for (const word of words) {
    const normalized = word.toLocaleLowerCase().replace(/[.:]+$/, '');
    if (PATH_PROSE_BOUNDARIES.has(normalized)) break;
    candidate.push(word);
  }
  return /[\\/]/.test(candidate.join(' ')) ||
    candidate.some((word) => PATH_TRAILING_EXTENSION.test(word));
}

interface ExpectedGeneratedArtifact {
  kind: GeneratedArtifact['kind'];
  scope: string;
  target: MenubarThreadTarget;
  highWaterSeq: number;
  inputHash: string;
  evidenceIds: string[];
}

function assertGeneratedArtifactMatches(
  artifact: GeneratedArtifact,
  expected: ExpectedGeneratedArtifact,
): void {
  const scopeMatches =
    (expected.kind === 'daily_recap' &&
      artifact.kind === 'daily_recap' &&
      artifact.day === expected.scope) ||
    (expected.kind === 'thread_review' &&
      artifact.kind === 'thread_review' &&
      artifact.threadKey === expected.scope);
  const allowedEvidence = new Set(expected.evidenceIds);
  if (
    !scopeMatches ||
    artifact.provider !== expected.target.provider ||
    artifact.model !== expected.target.model ||
    artifact.inputHighWaterSeq !== expected.highWaterSeq ||
    artifact.inputHash !== expected.inputHash ||
    artifact.evidenceIds.some((eventId) => !allowedEvidence.has(eventId))
  ) {
    throw new Error(
      'The observer analysis did not match the requested evidence scope.',
    );
  }
}
