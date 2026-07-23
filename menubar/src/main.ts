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
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { MenubarBackend, type MenubarState } from './backend.js';
import { importShellEnv, isMissingShellEnv } from './shell-env.js';
import { DEFAULT_PROVIDER, DEFAULT_MODEL } from '../../dist/config/defaults.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const WINDOW_WIDTH = 760;
const WINDOW_HEIGHT = 620;

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
let lastNeedsUser = new Set<string>();
let attentionInitialized = false;

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
  window.loadURL('aside://app/index.html');
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('aside://app/')) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  if (!DEV_SHOW) window.on('blur', () => window.hide());
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
}

function showWindow(openSettings = false): void {
  if (!win || !tray) return;
  positionWindow(win, tray);
  win.show();
  win.focus();
  win.webContents.send('aside:update', backend?.getState());
  if (openSettings) win.webContents.send('aside:show-settings');
}

function handleBackendUpdate(state: MenubarState): void {
  if (win && !win.isDestroyed()) win.webContents.send('aside:update', state);
  if (tray) {
    tray.setToolTip(
      state.needsUserCount > 0
        ? `aside — ${state.needsUserCount} session${state.needsUserCount === 1 ? '' : 's'} need you`
        : 'aside — your agent threads, one side chat away',
    );
  }

  const next = new Set(state.sessions.filter((session) => session.needsUser).map((session) => session.id));
  if (attentionInitialized && Notification.isSupported()) {
    for (const session of state.sessions) {
      if (!session.needsUser || lastNeedsUser.has(session.id)) continue;
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
  // Menubar-only app: no dock icon.
  app.dock?.hide();

  // A GUI launch inherits launchd's environment, not the user's shell. Two
  // things break as a result, and both look like the app is simply broken:
  //   - PATH lacks ~/.local/bin etc, so the `claude` CLI the default provider
  //     spawns can't be found at all;
  //   - a key exported from .zshrc is invisible, so key-based providers fail.
  // Both work perfectly when launched from a terminal, which is exactly how
  // this gets missed. Recover them from the login shell; skipped when launched
  // from a shell, so startup isn't taxed for nothing.
  if (isMissingShellEnv()) {
    const { imported, error } = importShellEnv();
    if (imported.length > 0) console.log(`  • imported from login shell: ${imported.join(', ')}`);
    else if (error) console.warn(`  • shell env import failed: ${error}`);
  }

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
  );
  backend.start();

  ipcMain.handle('aside:get-state', () => backend?.getState());
  ipcMain.handle('aside:select-thread', (_e, threadId: unknown) => {
    if (typeof threadId === 'string' && threadId.length <= 500) {
      backend?.selectThread(threadId);
    }
  });
  ipcMain.handle('aside:ask', (_e, question: unknown) => {
    if (typeof question === 'string' && question.length <= 20_000) {
      return backend?.ask(question);
    }
  });
  ipcMain.handle('aside:set-model', (_e, provider: string, model: string) =>
    typeof provider === 'string' &&
    typeof model === 'string' &&
    provider.length <= 100 &&
    model.length <= 300
      ? backend?.setModel(provider, model)
      : undefined,
  );
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
  tray.setToolTip('aside — your agent threads, one side chat away');
  tray.on('click', toggleWindow);
  tray.on('right-click', () => {
    const menu = Menu.buildFromTemplate([
      { label: 'Open aside', click: () => showWindow() },
      { label: 'Privacy & diagnostics…', click: () => showWindow(true) },
      { type: 'separator' },
      { label: 'Quit aside', role: 'quit' },
    ]);
    tray?.popUpContextMenu(menu);
  });

  if (DEV_SHOW || CAPTURE_PATH) {
    win.setPosition(DEV_SHOW_POSITION.x, DEV_SHOW_POSITION.y, false);
    win.show();
    win.webContents.once('did-finish-load', () => {
      win?.webContents.send('aside:update', backend?.getState());
    });
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
