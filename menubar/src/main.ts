// Electron menubar shell. Thin: it owns the tray + dropdown window and bridges
// IPC to MenubarBackend, which does the real work via the shared core.

import { app, Tray, BrowserWindow, ipcMain, nativeImage, screen } from 'electron';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { MenubarBackend, type MenubarState } from './backend.js';
import { DEFAULT_PROVIDER, DEFAULT_MODEL, DEFAULT_AUTH_FILE } from '../../dist/config/defaults.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const WINDOW_WIDTH = 400;
const WINDOW_HEIGHT = 560;

/**
 * Dev flag: pin the dropdown open at a fixed position instead of hanging it off
 * the tray and hiding it on blur. A tray dropdown is otherwise impossible to
 * inspect or screenshot — it vanishes the moment anything else takes focus.
 *
 *   npx electron dist/main.js --show
 */
const DEV_SHOW = process.argv.includes('--show');
const DEV_SHOW_POSITION = { x: 80, y: 80 };

function flagValue(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : (process.argv[i + 1] ?? null);
}

/**
 * Dev flags for inspecting the dropdown without a human at the machine.
 *
 *   --capture <png>   render, screenshot the window, quit
 *   --ask "<q>"       ask a real question first, so the shot shows an answer
 *
 * capturePage() photographs our own web contents, which — unlike the system
 * `screencapture` — needs no screen-recording permission.
 */
const CAPTURE_PATH = flagValue('--capture');
const CAPTURE_ASK = flagValue('--ask');

let tray: Tray | null = null;
let win: BrowserWindow | null = null;
let backend: MenubarBackend | null = null;

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
    webPreferences: {
      preload: path.join(here, '..', 'preload.cjs'),
      contextIsolation: true,
      sandbox: false,
    },
  });
  // index.html lives at the menubar package root (one level above dist/).
  window.loadFile(path.join(here, '..', 'index.html'));
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

app.whenReady().then(() => {
  // Menubar-only app: no dock icon.
  app.dock?.hide();

  win = createWindow();

  backend = new MenubarBackend(
    { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL, authFile: DEFAULT_AUTH_FILE },
    (state: MenubarState) => {
      if (win && !win.isDestroyed()) win.webContents.send('aside:update', state);
    },
  );
  backend.start();

  ipcMain.handle('aside:get-state', () => backend?.getState());
  ipcMain.handle('aside:select', (_e, id: string) => backend?.selectSession(id));
  ipcMain.handle('aside:ask', (_e, question: string) => backend?.ask(question));
  ipcMain.handle('aside:set-model', (_e, provider: string, model: string) =>
    backend?.setModel(provider, model),
  );

  const icon = trayImage();
  tray = new Tray(icon);
  // Without an icon there'd be nothing to click, so label it instead.
  if (icon.isEmpty()) tray.setTitle('aside');
  tray.setToolTip("aside — read-only bird's-eye chat for your agents");
  tray.on('click', toggleWindow);

  if (DEV_SHOW || CAPTURE_PATH) {
    win.setPosition(DEV_SHOW_POSITION.x, DEV_SHOW_POSITION.y, false);
    win.show();
    win.webContents.once('did-finish-load', () => {
      win?.webContents.send('aside:update', backend?.getState());
    });
  }

  if (CAPTURE_PATH) void captureAndQuit(win, CAPTURE_PATH, CAPTURE_ASK);
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Render, optionally ask a real question, screenshot the window, and quit. */
async function captureAndQuit(window: BrowserWindow, target: string, question: string | null) {
  try {
    await new Promise<void>((resolve) => {
      if (!window.webContents.isLoading()) return resolve();
      window.webContents.once('did-finish-load', () => resolve());
    });
    // Let the first session scan land and paint.
    await sleep(1500);

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
