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
import { TIMING } from '../../dist/config/defaults.js';
import {
  flattenModelCatalog,
  flattenModelCatalogWithLocal,
} from '../../dist/config/model-catalog.js';
import { FLEET_THREAD_ID, sessionThreadId } from '../../dist/types/chat.js';
import type { ModelOption } from '../../dist/config/model-catalog.js';
import type { TrackedSession } from '../../dist/types/session.js';
import type { ChatTurn } from '../../dist/types/chat.js';

export interface SessionSummary {
  id: string;
  source: string;
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
  /** Threads whose transcript changed within the recent-activity window. */
  recentSessionCount: number;
  /** Where aside's own durable chats live. Agent/project files remain untouched. */
  storagePath: string;
  /** Every provider/model the observer can run on, for the picker. */
  models: ModelOption[];
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
}

export class MenubarBackend {
  private readonly service: SideChatService;
  private readonly scan: () => { sessions: TrackedSession[]; jsonlPaths: Map<string, string> };
  /** Catalogued once: it's a static registry, not live state. */
  private models: ModelOption[];
  private readonly loadModels: (() => Promise<ModelOption[]>) | null;
  private readonly storagePath: string;
  private sessions: TrackedSession[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private config: BackendConfig,
    private readonly onUpdate: (state: MenubarState) => void,
    deps: BackendDeps = {},
  ) {
    this.scan = deps.scan ?? (() => scanAllSessions({}));
    this.models = (deps.models ?? flattenModelCatalog)();
    this.loadModels = deps.models ? null : flattenModelCatalogWithLocal;
    const store = new FileThreadStore();
    this.storagePath = store.location;
    this.service =
      deps.service ??
      new SideChatService(
        new SideChatEngine(config),
        {
          onChat: () => this.emit(),
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
  }

  /** Open the fleet conversation or one durable session side thread. */
  selectThread(threadId: string): void {
    const valid =
      threadId === FLEET_THREAD_ID ||
      this.sessions.some((session) => sessionThreadId(session.id) === threadId);
    this.service.selectThread(valid ? threadId : FLEET_THREAD_ID);
    this.emit();
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

  getState(): MenubarState {
    const now = Date.now();
    const active = this.service.getActiveThread();
    const sessions = this.sessions.map((s) => {
      const attention = this.service.getSessionAttention(s.id);
      return {
        id: s.id,
        source: s.source,
        projectName: s.projectName,
        projectPath: s.cwd || s.projectDir,
        title: s.title ?? '',
        status: s.status,
        currentActivity: s.currentActivity,
        idleForMs: Math.max(0, now - s.lastEventTime.getTime()),
        threadId: sessionThreadId(s.id),
        needsUser: attention.needsUser,
        attentionReason: attention.reason,
      };
    });
    return {
      sessions,
      activeThreadId: active.id,
      messages: active.turns,
      thinking: active.thinking,
      provider: active.provider,
      model: active.model,
      needsUserCount: sessions.filter((session) => session.needsUser).length,
      recentSessionCount: sessions.filter(
        (session) => session.status === 'active' || session.status === 'idle',
      ).length,
      storagePath: this.storagePath,
      models: this.models,
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
    this.service.syncSessions(this.sessions, jsonlPaths);
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

  private threadStillMatches(target: MenubarThreadTarget): boolean {
    const thread = this.service.getThread(target.threadId);
    return (
      thread.provider === target.provider &&
      thread.model === target.model
    );
  }
}
