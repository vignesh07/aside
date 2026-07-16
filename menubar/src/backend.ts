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
  /** Milliseconds since this session's last observed event. */
  idleForMs: number;
}

/** Everything the renderer needs to draw the dropdown. */
export interface MenubarState {
  sessions: SessionSummary[];
  /** Focused session — deepens its transcript in the prompt; never scopes the chat. */
  focusId: string | null;
  /** The single bird's-eye conversation, spanning every session. */
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
  private focusId: string | null = null;
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

  /** Focus a session (or null for none) to deepen its transcript in the prompt. */
  selectSession(id: string | null): void {
    this.focusId = id;
    this.service.setFocus(id);
    this.emit();
  }

  setModel(provider: string, model: string): void {
    this.config = { ...this.config, provider, model };
    this.service.setModel(provider, model);
    this.emit();
  }

  /** Ask about the whole world. No session selection required. */
  ask(question: string): Promise<void> {
    return this.service.ask(question);
  }

  getState(): MenubarState {
    const now = Date.now();
    return {
      sessions: this.sessions.map((s) => ({
        id: s.id,
        source: s.source,
        projectName: s.projectName,
        status: s.status,
        currentActivity: s.currentActivity,
        idleForMs: Math.max(0, now - s.lastEventTime.getTime()),
      })),
      focusId: this.focusId,
      messages: this.service.getChat(),
      thinking: this.service.isThinking(),
      provider: this.config.provider,
      model: this.config.model,
    };
  }

  /** Rescan sessions, keep the focus valid, and re-sync the tailer. */
  refresh(): void {
    const { sessions, jsonlPaths } = this.scan();
    this.sessions = sessions;
    // Focus defaults to the top-ranked session for transcript depth, but the
    // chat works regardless — an invalid focus degrades to "no focus", not to a
    // broken chat.
    if (!this.focusId || !sessions.some((s) => s.id === this.focusId)) {
      this.focusId = sessions[0]?.id ?? null;
      this.service.setFocus(this.focusId);
    }
    this.service.syncSessions(sessions, jsonlPaths);
    this.emit();
  }

  private emit(): void {
    this.onUpdate(this.getState());
  }
}
