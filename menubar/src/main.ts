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
import { shouldNotifyForAttention } from './attention-notification.js';
import {
  makeAvailableOnCurrentSpace,
  WindowRecoveryController,
} from './window-recovery.js';
import { DEFAULT_PROVIDER, DEFAULT_MODEL } from '../../dist/config/defaults.js';
import { createThreadSearchService } from './search-coordinator.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const WINDOW_WIDTH = 760;
const WINDOW_HEIGHT = 620;
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

/**
 * Dev flags for inspecting the dropdown without a human at the machine.
 *
 *   --capture <png>   render, screenshot the window, quit
 *   --ask "<q>"       ask a real question first, so the shot shows an answer
 *   --search "<q>"    filter the machine-wide thread list before capture
 *   --older            expand and scroll to the 7d+ section before capture
 *
 * capturePage() photographs our own web contents, which — unlike the system
 * `screencapture` — needs no screen-recording permission.
 */
const CAPTURE_PATH = flagValue('--capture');
const CAPTURE_ASK = flagValue('--ask');
const CAPTURE_THREAD = flagValue('--thread');
const CAPTURE_SEARCH = flagValue('--search');
const CAPTURE_OLDER = process.argv.includes('--older');
const CAPTURE_SETTINGS = process.argv.includes('--settings');

let tray: Tray | null = null;
let win: BrowserWindow | null = null;
let backend: MenubarBackend | null = null;
let providerAuth: ProviderAuthCoordinator | null = null;
let appUpdates: AppUpdateController | null = null;
let lastNeedsUser = new Set<string>();
let attentionInitialized = false;
let authFlowActive = false;
let updateCheckTimer: ReturnType<typeof setTimeout> | null = null;
let updateCheckInterval: ReturnType<typeof setInterval> | null = null;

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

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    show: false,
    frame: false,
    resizable: false,
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
  if (!DEV_SHOW) {
    window.on('blur', () => {
      if (!authFlowActive) window.hide();
    });
  }
  return window;
}

/** Drop the window just under the tray icon. */
function positionWindow(window: BrowserWindow, trayInstance: Tray): void {
  const trayBounds = trayInstance.getBounds();
  const display = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y });
  const x = Math.round(
    Math.min(
      Math.max(trayBounds.x + trayBounds.width / 2 - WINDOW_WIDTH / 2, display.workArea.x + 8),
      display.workArea.x + display.workArea.width - WINDOW_WIDTH - 8,
    ),
  );
  const y = Math.round(trayBounds.y + trayBounds.height + 4);
  window.setPosition(x, y, false);
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
  win.webContents.send('aside:update', backend?.getState());
  void refreshProviderAuth();
}

function showWindow(openSettings = false, refreshAuth = true): boolean {
  if (!win || !tray) return false;
  positionWindow(win, tray);
  win.show();
  win.focus();
  win.webContents.send('aside:update', backend?.getState());
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
    state && state.needsUserCount > 0
      ? `aside — ${state.needsUserCount} session${state.needsUserCount === 1 ? '' : 's'} need you`
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

function handleBackendUpdate(state: MenubarState): void {
  if (win && !win.isDestroyed()) win.webContents.send('aside:update', state);
  updateTrayToolTip(state);

  const next = new Set(
    state.sessions
      .filter((session) => !session.isInternal && session.needsUser)
      .map((session) => session.id),
  );
  if (attentionInitialized && Notification.isSupported()) {
    for (const session of state.sessions) {
      if (session.isInternal) continue;
      // Historical reconstruction powers the sidebar inbox, but must never
      // manufacture a delayed macOS alert for a stale thread after launch.
      if (!shouldNotifyForAttention(session, lastNeedsUser)) continue;
      const notification = new Notification({
        title: `${session.projectName} needs you`,
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
  lastNeedsUser = next;
}

app.whenReady().then(() => {
  if (!ownsSingleInstanceLock) return;

  // Menubar-only app: no dock icon.
  app.dock?.hide();

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

  win = createWindow();

  backend = new MenubarBackend(
    { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL },
    handleBackendUpdate,
    { search: createThreadSearchService() },
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

  ipcMain.handle('aside:get-state', () => backend?.getState());
  ipcMain.handle('aside:select-thread', (_e, threadId: unknown) => {
    if (typeof threadId === 'string' && threadId.length <= 500) {
      backend?.selectThread(threadId);
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
    win.setPosition(DEV_SHOW_POSITION.x, DEV_SHOW_POSITION.y, false);
    win.show();
    win.webContents.once('did-finish-load', () => {
      win?.webContents.send('aside:update', backend?.getState());
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
) {
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

    const image = await window.webContents.capturePage();
    fs.writeFileSync(target, image.toPNG());
    console.log(`captured -> ${target}`);
  } catch (err) {
    console.error('capture failed:', err);
  } finally {
    app.exit(0);
  }
}

app.on('window-all-closed', () => {
  // Menubar app stays resident even with no windows.
});

app.on('before-quit', () => {
  backend?.stop();
});
