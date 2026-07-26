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
} from '../../dist/core/activity-ledger.js';
import { TIMING } from '../../dist/config/defaults.js';
import {
  flattenModelCatalog,
  flattenModelCatalogWithLocal,
} from '../../dist/config/model-catalog.js';
import { FLEET_THREAD_ID, sessionThreadId } from '../../dist/types/chat.js';
import type { ModelOption } from '../../dist/config/model-catalog.js';
import type { TrackedSession } from '../../dist/types/session.js';
import type { ChatTurn } from '../../dist/types/chat.js';
import type { ThreadAttentionKind } from '../../dist/types/activity.js';
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

/** Injection seam for tests (defaults wire up the real core). */
export interface BackendDeps {
  scan?: () => { sessions: TrackedSession[]; jsonlPaths: Map<string, string> };
  service?: SideChatService;
  models?: () => ModelOption[];
  search?: ThreadSearchService;
  activity?: ActivityLedger;
}

export class MenubarBackend {
  private readonly service: SideChatService;
  private readonly scan: () => { sessions: TrackedSession[]; jsonlPaths: Map<string, string> };
  /** Catalogued once: it's a static registry, not live state. */
  private models: ModelOption[];
  private readonly loadModels: (() => Promise<ModelOption[]>) | null;
  private readonly storagePath: string;
  private readonly search?: ThreadSearchService;
  private readonly activity: ActivityLedger;
  private readonly unsubscribeSearchStatus?: () => void;
  private sessions: TrackedSession[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private config: BackendConfig,
    private readonly onUpdate: (state: MenubarState) => void,
    deps: BackendDeps = {},
  ) {
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
        () => new Date(),
        () => this.emit(),
      );
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
