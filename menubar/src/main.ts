// Electron menubar shell. Thin: it owns the tray + dropdown window and bridges
// IPC to MenubarBackend, which does the real work via the shared core.

import {
  app,
  Tray,
  BrowserWindow,
  ipcMain,
  nativeImage,
  screen,
  Menu,
  Notification,
  shell,
  protocol,
  nativeTheme,
} from 'electron';
import electronUpdater from 'electron-updater';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  MenubarBackend,
  type MenubarState,
  type MenubarThreadTarget,
} from './backend.js';
import { importShellEnv, isMissingShellEnv } from './shell-env.js';
import {
  ProviderAuthCoordinator,
  ProviderAuthError,
  type ProviderAuthId,
  type ProviderAuthStatus,
} from './provider-auth.js';
import {
  requireUsableProvider,
  validatedProviderId,
} from './auth-guard.js';
import {
  disposeClaudeSession,
} from '../../dist/core/providers/index.js';
import {
  canAskWithProvider,
  providerHelpLink,
  recommendedModelForProvider,
} from './auth-ui.js';
import {
  AppUpdateController,
  downloadUrlForArch,
  type AppUpdateStatus,
  type AutoUpdaterLike,
} from './app-update.js';
import {
  attentionNotificationKey,
  shouldNotifyForAttention,
} from './attention-notification.js';
import {
  makeAvailableOnCurrentSpace,
  WindowRecoveryController,
} from './window-recovery.js';
import {
  DEFAULT_WINDOW_SIZE,
  MIN_WINDOW_SIZE,
  parseWindowSize,
  windowBoundsAtPosition,
  windowBoundsBelowTray,
  windowSizeForWorkArea,
  type WindowSize,
} from './window-layout.js';
import { FileWindowSizeStore } from './window-size-store.js';
import {
  FileWindowModeStore,
  type WindowPosition,
} from './window-mode-store.js';
import {
  shouldHideOnBlur,
  shouldRestoreDetachedPosition,
} from './window-presentation.js';
import { DEFAULT_PROVIDER, DEFAULT_MODEL } from '../../dist/config/defaults.js';
import {
  ActivityLedger,
  InMemoryActivityLedgerStore,
} from '../../dist/core/activity-ledger.js';
import { createThreadSearchService } from './search-coordinator.js';
import { feedbackIssueUrl } from './feedback-link.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const UPDATE_INITIAL_DELAY_MS = 15_000;
const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const { autoUpdater } = electronUpdater;

/**
 * Dev flag: pin the dropdown open at a fixed position instead of hanging it off
 * the tray and hiding it on blur. A tray dropdown is otherwise impossible to
 * inspect or screenshot — it vanishes the moment anything else takes focus.
 *
 *   npx electron dist/main.js --show
 */
const DEV_SHOW = process.argv.includes('--show');
const DEV_SHOW_POSITION = { x: 80, y: 80 };

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'aside',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      codeCache: true,
    },
  },
]);

function flagValue(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : (process.argv[i + 1] ?? null);
}

function integerFlagValue(name: string): number | null {
  const raw = flagValue(name);
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Dev flags for inspecting the dropdown without a human at the machine.
 *
 *   --capture <png>   render, screenshot the window, quit
 *   --ask "<q>"       ask a real question first, so the shot shows an answer
 *   --search "<q>"    filter the machine-wide thread list before capture
 *   --older            expand and scroll to the 7d+ section before capture
 *   --settings         open settings before capture
 *   --settings-bottom  open settings and scroll to its final sections
 *   --accounts         open the account popover before capture
 *   --keep-open        render the detached-window control as active
 *   --attention        render representative attention states
 *   --attention-view   render and open the attention inbox
 *   --width <px>       override the window width for responsive QA
 *   --height <px>      override the window height for responsive QA
 *   --theme <mode>     force light or dark appearance for responsive QA
 *
 * capturePage() photographs our own web contents, which — unlike the system
 * `screencapture` — needs no screen-recording permission.
 */
const CAPTURE_PATH = flagValue('--capture');
const CAPTURE_ASK = flagValue('--ask');
const CAPTURE_THREAD = flagValue('--thread');
const CAPTURE_SEARCH = flagValue('--search');
const CAPTURE_OLDER = process.argv.includes('--older');
const CAPTURE_SETTINGS_BOTTOM = process.argv.includes('--settings-bottom');
const CAPTURE_SETTINGS =
  process.argv.includes('--settings') || CAPTURE_SETTINGS_BOTTOM;
const CAPTURE_ACCOUNTS = process.argv.includes('--accounts');
const CAPTURE_KEEP_OPEN = process.argv.includes('--keep-open');
const CAPTURE_ATTENTION_VIEW = process.argv.includes('--attention-view');
const CAPTURE_ATTENTION =
  process.argv.includes('--attention') || CAPTURE_ATTENTION_VIEW;
const CAPTURE_THEME = flagValue('--theme');
const DEV_WINDOW_SIZE = parseWindowSize({
  width: integerFlagValue('--width') ?? DEFAULT_WINDOW_SIZE.width,
  height: integerFlagValue('--height') ?? DEFAULT_WINDOW_SIZE.height,
});

let tray: Tray | null = null;
let win: BrowserWindow | null = null;
let backend: MenubarBackend | null = null;
let providerAuth: ProviderAuthCoordinator | null = null;
let appUpdates: AppUpdateController | null = null;
let lastNotifiedAttention = new Set<string>();
let attentionInitialized = false;
let authFlowActive = false;
let updateCheckTimer: ReturnType<typeof setTimeout> | null = null;
let updateCheckInterval: ReturnType<typeof setInterval> | null = null;
let windowSizeStore: FileWindowSizeStore | null = null;
let windowModeStore: FileWindowModeStore | null = null;
let preferredWindowSize: WindowSize = { ...DEFAULT_WINDOW_SIZE };
let keepOpen = false;
let rememberedWindowPosition: WindowPosition | null = null;

const ownsSingleInstanceLock = app.requestSingleInstanceLock();
const windowRecovery = new WindowRecoveryController(() => showWindow());
const releaseArch = process.arch === 'arm64' ? 'arm64' : 'x64';

if (!ownsSingleInstanceLock) {
  app.quit();
} else {
  // Finder and Spotlight activate the existing macOS app process. Direct
  // launches are covered by Electron's single-instance event as well.
  app.on('activate', () => {
    windowRecovery.request();
  });
  app.on('second-instance', () => {
    windowRecovery.request();
  });
}

/**
 * The menubar icon.
 *
 * macOS picks the @2x file next to it automatically, and treats the image as a
 * template (auto-inverted for light/dark menubars and the clicked state) because
 * of the "Template" filename. setTemplateImage is belt-and-braces.
 *
 * Falls back to a text label if the asset is missing: an empty tray image is an
 * *invisible* menubar item, which reads as the app failing to launch at all.
 */
function trayImage(): Electron.NativeImage {
  const image = nativeImage.createFromPath(path.join(here, '..', 'assets', 'trayTemplate.png'));
  if (image.isEmpty()) return nativeImage.createEmpty();
  image.setTemplateImage(true);
  return image;
}

function createWindow(initialSize: WindowSize): BrowserWindow {
  const window = new BrowserWindow({
    width: initialSize.width,
    height: initialSize.height,
    minWidth: MIN_WINDOW_SIZE.width,
    minHeight: MIN_WINDOW_SIZE.height,
    show: false,
    frame: false,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    roundedCorners: true,
    hasShadow: true,
    backgroundColor: '#1c1c1e',
    webPreferences: {
      preload: path.join(here, '..', 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  // A menu-bar dropdown should open on the Space where it was invoked. Without
  // this, focusing the reused BrowserWindow makes macOS jump back to the Space
  // where the window was first shown.
  makeAvailableOnCurrentSpace(window);
  window.loadURL('aside://app/index.html');
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('aside://app/')) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.on('blur', () => {
    if (shouldHideOnBlur({
      authFlowActive,
      keepOpen,
      developmentShow: DEV_SHOW,
    })) {
      window.hide();
    }
  });
  let manualResizePending = false;
  window.on('will-resize', () => {
    // Electron only emits will-resize for an interactive edge/corner drag.
    // Programmatic fitting for a smaller display must not replace the user's
    // preferred dimensions.
    manualResizePending = true;
  });
  window.on('resized', () => {
    if (!manualResizePending) return;
    manualResizePending = false;
    const bounds = window.getBounds();
    const next = parseWindowSize({
      width: bounds.width,
      height: bounds.height,
    });
    if (!next) return;
    preferredWindowSize = next;
    windowSizeStore?.save(next);
  });
  window.on('focus', () => {
    backend?.markThreadViewed();
  });
  window.on('moved', () => {
    if (!keepOpen) return;
    const bounds = window.getBounds();
    rememberedWindowPosition = { x: bounds.x, y: bounds.y };
    persistWindowMode();
  });
  return window;
}

/** Restore a detached window, or drop the transient popover under the tray. */
function positionWindow(window: BrowserWindow, trayInstance: Tray): void {
  const trayBounds = trayInstance.getBounds();
  const restoreDetached = shouldRestoreDetachedPosition(
    keepOpen,
    rememberedWindowPosition !== null,
  );
  const anchor = restoreDetached && rememberedWindowPosition
    ? rememberedWindowPosition
    : { x: trayBounds.x, y: trayBounds.y };
  const display = screen.getDisplayNearestPoint(anchor);
  window.setBounds(
    restoreDetached && rememberedWindowPosition
      ? windowBoundsAtPosition(
          preferredWindowSize,
          rememberedWindowPosition,
          display.workArea,
        )
      : windowBoundsBelowTray(
          preferredWindowSize,
          trayBounds,
          display.workArea,
        ),
    false,
  );
}

function persistWindowMode(): void {
  windowModeStore?.save({
    keepOpen,
    position: rememberedWindowPosition,
  });
}

function broadcastWindowMode(): void {
  if (win && !win.isDestroyed()) {
    win.webContents.send('aside:window-mode', { keepOpen });
  }
}

function setKeepOpen(next: boolean): { keepOpen: boolean } {
  keepOpen = next;
  if (win && !win.isDestroyed()) {
    if (keepOpen) {
      const bounds = win.getBounds();
      rememberedWindowPosition = { x: bounds.x, y: bounds.y };
    } else if (tray) {
      positionWindow(win, tray);
    }
  }
  persistWindowMode();
  broadcastWindowMode();
  return { keepOpen };
}

function toggleWindow(): void {
  if (!win || !tray) return;
  if (win.isVisible()) {
    win.hide();
    return;
  }
  positionWindow(win, tray);
  win.show();
  win.focus();
  win.webContents.send('aside:update', stateForRenderer(backend?.getState()));
  void refreshProviderAuth();
}

function showWindow(openSettings = false, refreshAuth = true): boolean {
  if (!win || !tray) return false;
  positionWindow(win, tray);
  win.show();
  win.focus();
  win.webContents.send('aside:update', stateForRenderer(backend?.getState()));
  broadcastWindowMode();
  if (refreshAuth) void refreshProviderAuth();
  if (openSettings) win.webContents.send('aside:show-settings');
  return true;
}

function broadcastProviderAuth(statuses: ProviderAuthStatus[]): void {
  if (win && !win.isDestroyed()) {
    win.webContents.send('aside:auth:update', statuses);
  }
}

function broadcastAppUpdate(status: AppUpdateStatus): void {
  if (win && !win.isDestroyed()) {
    win.webContents.send('aside:app-update', status);
  }
  updateTrayToolTip();
}

function updateTrayToolTip(state = backend?.getState()): void {
  if (!tray) return;
  const update = appUpdates?.getStatus();
  if (update?.phase === 'ready') {
    tray.setToolTip(
      `Aside ${update.latestVersion ?? 'update'} is ready — restart to install`,
    );
    return;
  }
  tray.setToolTip(
    state && state.attentionCount > 0
      ? `aside — ${state.attentionCount} thread${state.attentionCount === 1 ? '' : 's'} need attention`
      : 'aside — your agent threads, one side chat away',
  );
}

function checkForUpdatesInBackground(): void {
  void appUpdates?.checkForUpdates().catch((error: unknown) => {
    console.warn(
      '  • automatic update check failed:',
      error instanceof Error ? error.message : 'unknown error',
    );
  });
}

async function refreshProviderAuth(): Promise<ProviderAuthStatus[]> {
  if (!providerAuth) return [];
  const statuses = await providerAuth.getStatuses();
  broadcastProviderAuth(statuses);
  return statuses;
}

function validatedProvider(value: unknown): ProviderAuthId | null {
  return validatedProviderId(value);
}

function safeProviderError(error: unknown): Error {
  return new Error(
    error instanceof ProviderAuthError
      ? error.message
      : 'Aside could not update provider access.',
  );
}

function threadTarget(state: MenubarState): MenubarThreadTarget {
  return {
    threadId: state.activeThreadId,
    provider: state.provider,
    model: state.model,
  };
}

function stateForRenderer(state: MenubarState | undefined): MenubarState | undefined {
  if (!state || !CAPTURE_ATTENTION) return state;
  const fixtures = [
    {
      kind: 'waiting',
      headline: 'Approval requested',
      context: 'Allow Aside to inspect the signing identities on this Mac?',
      reason: 'Allow Aside to inspect the signing identities on this Mac?',
    },
    {
      kind: 'completed',
      headline: 'Last turn ended',
      context: 'Added thread content search and verified the result ranking.',
      reason: 'Latest turn ended — ready to review',
    },
    {
      kind: 'failed',
      headline: 'Turn failed',
      context: 'The provider stopped before returning a response.',
      reason: 'The provider stopped before returning a response.',
    },
    {
      kind: 'interrupted',
      headline: 'Turn interrupted',
      context: 'The latest agent turn was interrupted.',
      reason: 'The latest agent turn was interrupted.',
    },
    {
      kind: 'stalled',
      headline: 'Work may be stalled',
      context: 'Running the release verification suite.',
      reason: 'Observed work is still quiet',
    },
    {
      kind: 'forgotten',
      headline: 'Still waiting for review',
      context: 'The completed work has not been reviewed yet.',
      reason: 'A completed turn has been waiting for review',
    },
  ] as const;
  let index = 0;
  const sessions = state.sessions.map((session) => {
    if (session.isInternal || index >= fixtures.length) return session;
    const fixture = fixtures[index++]!;
    return {
      ...session,
      needsUser: fixture.kind === 'waiting',
      needsAttention: true,
      attentionKind: fixture.kind,
      attentionUnread: session.threadId !== state.activeThreadId,
      attentionObservedLive: true,
      attentionSince: Date.now() - index * 60_000,
      attentionHeadline: fixture.headline,
      attentionContext: fixture.context,
      attentionReason: fixture.reason,
    };
  });
  const attentionCounts = {
    waiting: sessions.filter((session) => session.attentionKind === 'waiting' && !session.isInternal).length,
    failed: sessions.filter((session) => session.attentionKind === 'failed' && !session.isInternal).length,
    interrupted: sessions.filter((session) => session.attentionKind === 'interrupted' && !session.isInternal).length,
    completed: sessions.filter((session) => session.attentionKind === 'completed' && !session.isInternal).length,
    stalled: sessions.filter((session) => session.attentionKind === 'stalled' && !session.isInternal).length,
    forgotten: sessions.filter((session) => session.attentionKind === 'forgotten' && !session.isInternal).length,
  };
  const attentionCount = Object.values(attentionCounts).reduce(
    (total, count) => total + count,
    0,
  );
  return {
    ...state,
    sessions,
    needsUserCount: attentionCounts.waiting,
    attentionCount,
    unreadAttentionCount: sessions.filter(
      (session) => session.needsAttention && session.attentionUnread,
    ).length,
    attentionCounts,
  };
}

function handleBackendUpdate(state: MenubarState): void {
  if (win && !win.isDestroyed()) {
    win.webContents.send('aside:update', stateForRenderer(state));
  }
  updateTrayToolTip(state);

  const next = new Set(
    state.sessions.flatMap((session) => {
      if (session.isInternal) return [];
      const key = attentionNotificationKey(session);
      return key ? [key] : [];
    }),
  );
  if (attentionInitialized && Notification.isSupported()) {
    for (const session of state.sessions) {
      if (session.isInternal) continue;
      // Historical reconstruction powers the sidebar inbox, but must never
      // manufacture a delayed macOS alert for a stale thread after launch.
      if (!shouldNotifyForAttention(session, lastNotifiedAttention)) continue;
      const title =
        session.attentionKind === 'completed'
          ? `${session.projectName} is ready to review`
          : session.attentionKind === 'failed'
            ? `${session.projectName} hit a terminal error`
            : session.attentionKind === 'interrupted'
              ? `${session.projectName} was interrupted`
              : `${session.projectName} needs you`;
      const notification = new Notification({
        title,
        body: session.attentionReason || 'This agent is waiting for your input.',
        silent: false,
      });
      notification.on('click', () => {
        backend?.selectThread(session.threadId);
        showWindow();
      });
      notification.show();
    }
  }
  attentionInitialized = true;
  lastNotifiedAttention = next;
}

app.whenReady().then(() => {
  if (!ownsSingleInstanceLock) return;

  // Menubar-only app: no dock icon.
  app.dock?.hide();

  if (
    (CAPTURE_PATH || DEV_SHOW) &&
    (CAPTURE_THEME === 'light' || CAPTURE_THEME === 'dark')
  ) {
    nativeTheme.themeSource = CAPTURE_THEME;
  }

  // Finder launches receive launchd's minimal PATH, which cannot locate vendor
  // CLIs in Homebrew or user bin directories. Import PATH only. Credentials
  // are deliberately excluded: existing vendor sign-in and explicit Aside
  // consent are the only account path in the Mac app.
  if (isMissingShellEnv()) {
    const { imported, error } = importShellEnv();
    if (imported.length > 0) console.log(`  • imported from login shell: ${imported.join(', ')}`);
    else if (error) console.warn(`  • shell env import failed: ${error}`);
  }
  // The Mac UI promises that Ollama keeps transcript context on this machine.
  // Ignore a terminal-only remote OLLAMA_HOST override in the GUI process.
  process.env['OLLAMA_HOST'] = 'http://127.0.0.1:11434';

  const appRoot = path.resolve(here, '..');
  protocol.handle('aside', (request) => {
    try {
      const url = new URL(request.url);
      if (url.host !== 'app') return new Response('Not found', { status: 404 });
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const filePath = path.resolve(appRoot, relative || 'index.html');
      if (filePath !== appRoot && !filePath.startsWith(`${appRoot}${path.sep}`)) {
        return new Response('Forbidden', { status: 403 });
      }
      const contentType = new Map([
        ['.html', 'text/html; charset=utf-8'],
        ['.js', 'text/javascript; charset=utf-8'],
        ['.png', 'image/png'],
      ]).get(path.extname(filePath));
      return new Response(new Uint8Array(fs.readFileSync(filePath)), {
        headers: contentType ? { 'content-type': contentType } : undefined,
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });

  // QA windows are deterministic and must never overwrite the user's real
  // preference. Normal launches restore only dimensions; position is always
  // recalculated beneath the menu item on the current display.
  if (!CAPTURE_PATH && !DEV_SHOW) {
    windowSizeStore = new FileWindowSizeStore();
    preferredWindowSize = windowSizeStore.load();
    windowModeStore = new FileWindowModeStore();
    const mode = windowModeStore.load();
    keepOpen = mode.keepOpen;
    rememberedWindowPosition = mode.position;
  } else {
    preferredWindowSize = DEV_WINDOW_SIZE ?? { ...DEFAULT_WINDOW_SIZE };
    keepOpen = CAPTURE_KEEP_OPEN;
  }
  win = createWindow(
    windowSizeForWorkArea(
      preferredWindowSize,
      screen.getPrimaryDisplay().workArea,
    ),
  );

  backend = new MenubarBackend(
    { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL },
    handleBackendUpdate,
    {
      search: createThreadSearchService(),
      activity: CAPTURE_PATH
        ? new ActivityLedger(new InMemoryActivityLedgerStore())
        : undefined,
    },
  );
  backend.start();
  providerAuth = new ProviderAuthCoordinator();
  appUpdates = new AppUpdateController({
    updater: autoUpdater as unknown as AutoUpdaterLike,
    currentVersion: app.getVersion(),
    arch: releaseArch,
    enabled: app.isPackaged && process.platform === 'darwin',
    onStatus: broadcastAppUpdate,
  });

  ipcMain.handle('aside:get-state', () => stateForRenderer(backend?.getState()));
  ipcMain.handle('aside:select-thread', (_e, threadId: unknown) => {
    if (typeof threadId === 'string' && threadId.length <= 500) {
      backend?.selectThread(threadId);
      if (win?.isVisible() && win.isFocused()) {
        backend?.markThreadViewed(threadId);
      }
    }
  });
  ipcMain.handle('aside:attention:resolve', (_e, threadId: unknown) => {
    if (
      typeof threadId === 'string' &&
      threadId.startsWith('session:') &&
      threadId.length <= 500
    ) {
      backend?.resolveThreadAttention(threadId);
    }
  });
  ipcMain.handle('aside:search-threads', (_e, query: unknown) => {
    if (typeof query !== 'string' || query.length > 500 || !backend) return [];
    return backend.searchThreads(query);
  });
  ipcMain.handle('aside:search-rebuild', () => {
    backend?.rebuildSearchIndex();
  });
  ipcMain.handle('aside:ask', async (_e, question: unknown) => {
    if (
      typeof question !== 'string' ||
      question.length > 20_000 ||
      !backend
    ) {
      return;
    }
    const state = backend.getState();
    const target = threadTarget(state);
    await requireUsableProvider(
      target.provider,
      providerAuth,
      'Connect this thread’s provider before chatting.',
    );
    return backend.ask(question, target);
  });
  ipcMain.handle('aside:set-model', async (_e, provider: unknown, model: unknown) => {
    if (
      typeof provider !== 'string' ||
      typeof model !== 'string' ||
      provider.length > 100 ||
      model.length > 300 ||
      !backend
    ) {
      return;
    }
    const target = threadTarget(backend.getState());
    await requireUsableProvider(
      provider,
      providerAuth,
      'Connect that provider before selecting its model.',
    );
    backend.setModel(provider, model, target);
  });
  ipcMain.handle('aside:auth:get', () => refreshProviderAuth());
  ipcMain.handle('aside:auth:refresh', () => refreshProviderAuth());
  ipcMain.handle('aside:auth:connect', async (_e, value: unknown) => {
    const provider = validatedProvider(value);
    if (!provider || !providerAuth) {
      throw new Error('That provider is not supported.');
    }
    authFlowActive = true;
    try {
      await providerAuth.connect(provider);
      if (provider === 'ollama') await backend?.refreshModels();
      const statuses = await refreshProviderAuth();
      const state = backend?.getState();
      if (backend && state && !canAskWithProvider(statuses, state.provider)) {
        const recommended = recommendedModelForProvider(state.models, provider);
        if (recommended) {
          backend.setDefaultModel(recommended.provider, recommended.model);
          backend.setModel(recommended.provider, recommended.model);
        }
      }
      return statuses;
    } catch (error) {
      throw safeProviderError(error);
    } finally {
      authFlowActive = false;
      // Re-present the account surface after a browser flow without starting a
      // racing refresh that could erase the renderer's success/failure message.
      showWindow(false, false);
    }
  });
  ipcMain.handle('aside:auth:disconnect', async (_e, value: unknown) => {
    const provider = validatedProvider(value);
    if (!provider || !providerAuth) {
      throw new Error('That provider is not supported.');
    }
    try {
      await providerAuth.disconnect(provider);
      if (provider === 'claude-cli') disposeClaudeSession();
      return await refreshProviderAuth();
    } catch (error) {
      throw safeProviderError(error);
    }
  });
  ipcMain.handle('aside:auth:help', async (_e, value: unknown) => {
    const provider = validatedProvider(value);
    const help = provider ? providerHelpLink(provider) : undefined;
    if (!help) {
      throw new Error('No setup guide is available for that provider.');
    }
    try {
      await shell.openExternal(help.url);
    } catch {
      throw new Error('Aside could not open the provider setup guide.');
    }
  });
  ipcMain.handle('aside:app-version', () => app.getVersion());
  ipcMain.handle('aside:window-mode:get', () => ({ keepOpen }));
  ipcMain.handle('aside:window-mode:set', (_e, value: unknown) => {
    if (typeof value !== 'boolean') {
      throw new Error('Keep Open must be on or off.');
    }
    return setKeepOpen(value);
  });
  ipcMain.handle('aside:update:get', () => appUpdates?.getStatus());
  ipcMain.handle('aside:update:check', () => appUpdates?.checkForUpdates());
  ipcMain.handle('aside:update:restart', () => appUpdates?.restartToInstall());
  ipcMain.handle('aside:update:manual-download', async () => {
    try {
      await shell.openExternal(downloadUrlForArch(releaseArch));
    } catch {
      throw new Error('Aside could not open the signed installer download.');
    }
  });
  ipcMain.handle('aside:feedback:open', async (_e, value: unknown) => {
    const url = feedbackIssueUrl(value);
    if (!url) {
      throw new Error('That feedback option is not supported.');
    }
    try {
      await shell.openExternal(url);
    } catch {
      throw new Error('Aside could not open GitHub Issues.');
    }
  });
  ipcMain.handle('aside:open-data', () => {
    const storagePath = backend?.getState().storagePath;
    if (!storagePath) return;
    if (fs.existsSync(storagePath)) {
      shell.showItemInFolder(storagePath);
      return;
    }
    const dir = path.dirname(storagePath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    void shell.openPath(dir);
  });
  ipcMain.handle('aside:quit', () => app.quit());

  const icon = trayImage();
  tray = new Tray(icon);
  // Without an icon there'd be nothing to click, so label it instead.
  if (icon.isEmpty()) tray.setTitle('Aside');
  updateTrayToolTip();
  tray.on('click', toggleWindow);
  tray.on('right-click', () => {
    const update = appUpdates?.getStatus();
    const menu = Menu.buildFromTemplate([
      { label: 'Open aside', click: () => showWindow() },
      {
        label: 'Keep Aside Open',
        type: 'checkbox',
        checked: keepOpen,
        click: (item) => setKeepOpen(item.checked),
      },
      { label: 'Aside Settings…', click: () => showWindow(true) },
      ...(update?.phase === 'ready'
        ? [
            {
              label: `Restart to Update to ${update.latestVersion ?? 'Latest'}`,
              click: () => appUpdates?.restartToInstall(),
            },
          ]
        : []),
      { type: 'separator' },
      { label: 'Quit aside', role: 'quit' },
    ]);
    tray?.popUpContextMenu(menu);
  });

  if (!DEV_SHOW && !CAPTURE_PATH) {
    // A manual app launch must always produce visible feedback, including when
    // accounts are already connected and the status item sits behind a notch.
    windowRecovery.request();
  } else {
    void refreshProviderAuth();
  }

  if (DEV_SHOW || CAPTURE_PATH) {
    if (!keepOpen || !rememberedWindowPosition) {
      win.setPosition(DEV_SHOW_POSITION.x, DEV_SHOW_POSITION.y, false);
    }
    win.show();
    win.webContents.once('did-finish-load', () => {
      win?.webContents.send('aside:update', stateForRenderer(backend?.getState()));
      broadcastWindowMode();
    });
  }

  if (app.isPackaged && !CAPTURE_PATH) {
    updateCheckTimer = setTimeout(
      checkForUpdatesInBackground,
      UPDATE_INITIAL_DELAY_MS,
    );
    updateCheckInterval = setInterval(
      checkForUpdatesInBackground,
      UPDATE_INTERVAL_MS,
    );
  }

  if (CAPTURE_PATH) {
    void captureAndQuit(
      win,
      CAPTURE_PATH,
      CAPTURE_ASK,
      CAPTURE_THREAD,
      CAPTURE_SEARCH,
      CAPTURE_OLDER,
      CAPTURE_SETTINGS,
      CAPTURE_ACCOUNTS,
    );
  }
});

app.on('before-quit', () => {
  if (updateCheckTimer) clearTimeout(updateCheckTimer);
  if (updateCheckInterval) clearInterval(updateCheckInterval);
  updateCheckTimer = null;
  updateCheckInterval = null;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Render, optionally ask a real question, screenshot the window, and quit. */
async function captureAndQuit(
  window: BrowserWindow,
  target: string,
  question: string | null,
  thread: string | null,
  search: string | null,
  showOlder: boolean,
  showSettings: boolean,
  showAccounts: boolean,
) {
  let exitCode = 0;
  try {
    await new Promise<void>((resolve) => {
      if (!window.webContents.isLoading()) return resolve();
      window.webContents.once('did-finish-load', () => resolve());
    });
    // Let the first session scan land and paint.
    await sleep(1500);

    if (search) {
      await window.webContents.executeJavaScript(`
        (() => {
          const input = document.getElementById('thread-search');
          input.value = ${JSON.stringify(search)};
          input.dispatchEvent(new Event('input', { bubbles: true }));
        })()
      `);
      await sleep(250);
    }

    if (showOlder) {
      await window.webContents.executeJavaScript(`
        (() => {
          let button = document.querySelector('.thread-group.older');
          if (button?.getAttribute('aria-expanded') === 'false') {
            button.click();
            button = document.querySelector('.thread-group.older');
          }
          button?.scrollIntoView({ block: 'start' });
        })()
      `);
      await sleep(250);
    }

    if (thread) {
      await window.webContents.executeJavaScript(`
        (() => {
          const requested = ${JSON.stringify(thread)};
          const button = requested === 'first'
            ? document.querySelector('.thread[data-thread-id^="session:"]')
            : document.querySelector(
                '.thread[data-thread-id="' + CSS.escape(requested) + '"]',
              );
          button?.click();
        })()
      `);
      await sleep(250);
    }

    if (showSettings) {
      await window.webContents.executeJavaScript(
        `document.getElementById('settings-button')?.click()`,
      );
      await sleep(250);
      if (CAPTURE_SETTINGS_BOTTOM) {
        await window.webContents.executeJavaScript(`
          (() => {
            const settings = document.querySelector('.settings-card');
            settings?.scrollTo({ top: settings.scrollHeight });
          })()
        `);
        await sleep(250);
      }
    }

    if (showAccounts) {
      await window.webContents.executeJavaScript(
        `document.getElementById('accounts-button')?.click()`,
      );
      await sleep(250);
    }

    if (CAPTURE_ATTENTION_VIEW) {
      await window.webContents.executeJavaScript(
        `document.querySelector('.thread.attention-smart')?.click()`,
      );
      await sleep(250);
    }

    if (question) {
      await window.webContents.executeJavaScript(`
        (() => {
          document.getElementById('input').value = ${JSON.stringify(question)};
          document.getElementById('composer').dispatchEvent(
            new Event('submit', { cancelable: true }),
          );
        })()
      `);
      // Poll until the answer lands rather than guessing a fixed delay.
      for (let i = 0; i < 60; i += 1) {
        await sleep(1000);
        const busy = await window.webContents.executeJavaScript(
          `!!document.querySelector('.thinking')`,
        );
        const answered = await window.webContents.executeJavaScript(
          `!!document.querySelector('.turn.assistant')`,
        );
        if (!busy && answered) break;
      }
      await sleep(500);
    }

    const layoutIssues = await captureLayoutIssues(window);
    if (layoutIssues.length > 0) {
      throw new Error(`responsive layout failed: ${layoutIssues.join('; ')}`);
    }

    const image = await window.webContents.capturePage();
    fs.writeFileSync(target, image.toPNG());
    console.log(`captured -> ${target}`);
  } catch (err) {
    exitCode = 1;
    console.error('capture failed:', err);
  } finally {
    app.exit(exitCode);
  }
}

async function captureLayoutIssues(window: BrowserWindow): Promise<string[]> {
  const result = await window.webContents.executeJavaScript(`
    (() => {
      const issues = [];
      const visible = (element) =>
        element instanceof HTMLElement &&
        !element.hidden &&
        element.getClientRects().length > 0;
      const insideViewport = (name, element) => {
        if (!visible(element)) return;
        const rect = element.getBoundingClientRect();
        if (
          rect.left < -1 ||
          rect.top < -1 ||
          rect.right > window.innerWidth + 1 ||
          rect.bottom > window.innerHeight + 1
        ) {
          issues.push(name + ' leaves viewport');
        }
      };

      if (document.documentElement.scrollWidth > window.innerWidth + 1) {
        issues.push('horizontal document overflow');
      }
      if (document.documentElement.scrollHeight > window.innerHeight + 1) {
        issues.push('vertical document overflow');
      }

      const sidebar = document.querySelector('.sidebar');
      const chat = document.querySelector('.chat');
      if (visible(sidebar) && visible(chat)) {
        const sidebarRect = sidebar.getBoundingClientRect();
        const chatRect = chat.getBoundingClientRect();
        if (Math.abs(sidebarRect.right - chatRect.left) > 1) {
          issues.push('sidebar and chat are misaligned');
        }
      }

      const settings = document.getElementById('settings');
      if (visible(settings) && visible(sidebar)) {
        const sidebarRect = sidebar.getBoundingClientRect();
        const settingsRect = settings.getBoundingClientRect();
        if (Math.abs(sidebarRect.right - settingsRect.left) > 1) {
          issues.push('sidebar and settings are misaligned');
        }
      }

      insideViewport('sidebar', sidebar);
      insideViewport('chat', chat);
      insideViewport('composer', document.querySelector('.composer-shell'));
      insideViewport('send button', document.getElementById('send'));
      insideViewport('attention card', document.querySelector('.attention-card'));
      insideViewport('settings', settings);
      insideViewport('accounts popover', document.getElementById('accounts-popover'));
      return issues;
    })()
  `);
  return Array.isArray(result)
    ? result.filter((issue): issue is string => typeof issue === 'string')
    : ['layout assertion returned an invalid result'];
}

app.on('window-all-closed', () => {
  // Menubar app stays resident even with no windows.
});

app.on('before-quit', () => {
  backend?.stop();
});
