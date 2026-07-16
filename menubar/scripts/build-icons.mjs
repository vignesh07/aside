// Render the SVG icon sources to the raster assets macOS actually wants.
//
// There's no image toolchain here (no sharp, no rsvg, no ImageMagick) and `sips`
// can't rasterise SVG. But Electron is already a dependency and Chromium renders
// SVG perfectly — so we load each source in a transparent window at an exact
// pixel size and photograph it with capturePage(). `iconutil` (built into macOS)
// then folds the PNG set into a single .icns.
//
//   npm run icons
//
// Outputs:
//   assets/trayTemplate.png      16x16  menubar, @1x
//   assets/trayTemplate@2x.png   32x32  menubar, retina
//   assets/icon.png             1024px  electron-builder source / Linux
//   assets/icon.icns                    the .app icon

import { app, BrowserWindow } from 'electron';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const assets = path.join(here, '..', 'assets');

/** Strip XML comments — they're for humans, and data URLs are tidier without. */
function loadSvg(name) {
  return fs.readFileSync(path.join(assets, name), 'utf-8').replace(/<!--[\s\S]*?-->/g, '').trim();
}

/**
 * Rasterise an SVG at exactly size x size, preserving transparency.
 *
 * The window is sized in CSS pixels, so a retina host would silently render at
 * 2x. useContentSize + a forced zoom factor of 1 pins the output to the size we
 * asked for rather than the display's.
 */
/**
 * One reusable offscreen window for every render.
 *
 * Creating a fresh offscreen BrowserWindow per size fails: the first renders,
 * every subsequent one dies with ERR_FAILED on load. Reusing a single window and
 * resizing it sidesteps that entirely — and is faster.
 */
function createRenderWindow() {
  return new BrowserWindow({
    width: 16,
    height: 16,
    useContentSize: true,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true, zoomFactor: 1 },
  });
}

async function render(win, svg, size, scratchDir) {
  const html = `<!doctype html>
    <html><head><meta charset="utf-8"><style>
      html, body { margin: 0; padding: 0; background: transparent; }
      svg { display: block; width: ${size}px; height: ${size}px; }
    </style></head>
    <body>${svg}</body></html>`;

  const page = path.join(scratchDir, `render-${size}-${Math.abs(hash(svg))}.html`);
  fs.writeFileSync(page, html);

  // Size the window before loading so the SVG lays out at its final size.
  win.setContentSize(size, size);
  await win.loadFile(page);
  const image = await win.webContents.capturePage();

  const resized =
    image.getSize().width === size ? image : image.resize({ width: size, height: size });
  return resized.toPNG();
}

/** Cheap, stable id so concurrent sizes of different art don't collide on disk. */
function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

async function main() {
  const tray = loadSvg('tray-template.svg');
  const icon = loadSvg('app-icon.svg');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aside-icon-'));
  const win = createRenderWindow();

  // Tray. The "Template" suffix is load-bearing: Electron/macOS only apply
  // automatic light/dark inversion to images named *Template.png.
  fs.writeFileSync(path.join(assets, 'trayTemplate.png'), await render(win, tray, 16, scratch));
  fs.writeFileSync(path.join(assets, 'trayTemplate@2x.png'), await render(win, tray, 32, scratch));
  console.log('wrote trayTemplate.png (16) + trayTemplate@2x.png (32)');

  // App icon: full-size PNG for electron-builder, plus an iconset for iconutil.
  fs.writeFileSync(path.join(assets, 'icon.png'), await render(win, icon, 1024, scratch));
  console.log('wrote icon.png (1024)');

  // iconutil demands these exact names; anything else is silently ignored.
  const iconset = path.join(scratch, 'icon.iconset');
  fs.mkdirSync(iconset, { recursive: true });
  const variants = [
    [16, 'icon_16x16.png'],
    [32, 'icon_16x16@2x.png'],
    [32, 'icon_32x32.png'],
    [64, 'icon_32x32@2x.png'],
    [128, 'icon_128x128.png'],
    [256, 'icon_128x128@2x.png'],
    [256, 'icon_256x256.png'],
    [512, 'icon_256x256@2x.png'],
    [512, 'icon_512x512.png'],
    [1024, 'icon_512x512@2x.png'],
  ];
  for (const [size, name] of variants) {
    fs.writeFileSync(path.join(iconset, name), await render(win, icon, size, scratch));
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(assets, 'icon.icns')]);
  win.destroy();
  fs.rmSync(scratch, { recursive: true, force: true });
  console.log('wrote icon.icns');
}

app.whenReady().then(async () => {
  try {
    await main();
    app.exit(0);
  } catch (err) {
    console.error('icon build failed:', err);
    app.exit(1);
  }
});
