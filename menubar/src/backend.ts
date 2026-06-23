// Menubar backend: the Electron-free half of the menubar app.
//
// It drives the shared core (session scanning + SideChatService) and exposes a
// flat state object + commands the Electron main process bridges to the
// renderer over IPC. Keeping it Electron-free means it's unit-testable and the
// reuse of the TS core is exercised without spinning up a window.

import { scanAllSessions } from '../../dist/core/session-scanner.js';
import { SideChatService } from '../../dist/core/side-chat-service.js';
import { SideChatEngine } from '../../dist/core/side-chat-engine.js';
import { TIMING } from '../../dist/config/defaults.js';
import type { TrackedSession } from '../../dist/types/session.js';
import type { ChatTurn } from '../../dist/types/chat.js';

export interface SessionSummary {
  id: string;
  source: string;
  projectName: string;
  status: string;
  currentActivity: string;
}

/** Everything the renderer needs to draw the dropdown. */
export interface MenubarState {
  sessions: SessionSummary[];
  selectedId: string | null;
  messages: ChatTurn[];
  thinking: boolean;
  provider: string;
  model: string;
}

export interface BackendConfig {
  provider: string;
  model: string;
  authFile?: string;
}

/** Injection seam for tests (defaults wire up the real core). */
export interface BackendDeps {
  scan?: () => { sessions: TrackedSession[]; jsonlPaths: Map<string, string> };
  service?: SideChatService;
}

export class MenubarBackend {
  private readonly service: SideChatService;
  private readonly scan: () => { sessions: TrackedSession[]; jsonlPaths: Map<string, string> };
  private sessions: TrackedSession[] = [];
  private selectedId: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private config: BackendConfig,
    private readonly onUpdate: (state: MenubarState) => void,
    deps: BackendDeps = {},
  ) {
    this.scan = deps.scan ?? (() => scanAllSessions({}));
    this.service =
      deps.service ??
      new SideChatService(new SideChatEngine(config), {
        onChat: () => this.emit(),
        onThinking: () => this.emit(),
        onActivity: (id, activity) => {
          const s = this.sessions.find((x) => x.id === id);
          if (s) {
            s.currentActivity = activity;
            s.status = 'active';
          }
          this.emit();
        },
      });
  }

  start(): void {
    this.refresh();
    this.timer = setInterval(() => this.refresh(), TIMING.scanIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.service.dispose();
  }

  selectSession(id: string): void {
    this.selectedId = id;
    this.emit();
  }

  setModel(provider: string, model: string): void {
    this.config = { ...this.config, provider, model };
    this.service.setModel(provider, model);
    this.emit();
  }

  ask(question: string): Promise<void> {
    return this.service.ask(this.selectedId, question);
  }

  getState(): MenubarState {
    return {
      sessions: this.sessions.map((s) => ({
        id: s.id,
        source: s.source,
        projectName: s.projectName,
        status: s.status,
        currentActivity: s.currentActivity,
      })),
      selectedId: this.selectedId,
      messages: this.selectedId ? this.service.getChat(this.selectedId) : [],
      thinking: this.service.isThinking(),
      provider: this.config.provider,
      model: this.config.model,
    };
  }

  /** Rescan sessions, keep a valid selection, and re-sync the tailer. */
  refresh(): void {
    const { sessions, jsonlPaths } = this.scan();
    this.sessions = sessions;
    if (!this.selectedId || !sessions.some((s) => s.id === this.selectedId)) {
      this.selectedId = sessions[0]?.id ?? null;
    }
    this.service.syncSessions(sessions, jsonlPaths);
    this.emit();
  }

  private emit(): void {
    this.onUpdate(this.getState());
  }
}
