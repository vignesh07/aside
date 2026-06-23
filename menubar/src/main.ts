// Electron menubar shell. Thin: it owns the tray + dropdown window and bridges
// IPC to MenubarBackend, which does the real work via the shared core.

import { app, Tray, BrowserWindow, ipcMain, nativeImage, screen } from 'electron';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { MenubarBackend, type MenubarState } from './backend.js';
import { DEFAULT_PROVIDER, DEFAULT_MODEL, DEFAULT_AUTH_FILE } from '../../dist/config/defaults.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const WINDOW_WIDTH = 400;
const WINDOW_HEIGHT = 560;

let tray: Tray | null = null;
let win: BrowserWindow | null = null;
let backend: MenubarBackend | null = null;

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
  window.on('blur', () => window.hide());
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

  // Empty image + title renders as a text label in the macOS menubar.
  tray = new Tray(nativeImage.createEmpty());
  tray.setTitle('aside');
  tray.setToolTip('aside — side chat for your agent session');
  tray.on('click', toggleWindow);
});

app.on('window-all-closed', () => {
  // Menubar app stays resident even with no windows.
});

app.on('before-quit', () => {
  backend?.stop();
});
