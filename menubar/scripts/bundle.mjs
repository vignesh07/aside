// Bundle the menubar app for packaging.
//
// The menubar imports the shared core from ../../dist — deliberately, so there's
// one implementation behind both frontends. But that path points *outside* this
// package, and electron-builder only packages files under the app directory. So
// rather than vendoring copies or wiring up a workspace symlink (which asar
// handles badly), esbuild inlines the core into the app bundle. The core is a
// few small modules with no runtime deps of its own, so this is cheap.
//
// Electron is provided by the runtime and is never bundled.

import * as esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

const shared = {
  bundle: true,
  format: 'esm',
  target: 'node20',
  logLevel: 'info',
  // ESM output keeps import.meta.url working, which main.ts uses to locate
  // index.html, preload.cjs and the tray asset relative to itself.
  outExtension: { '.js': '.js' },
};

// Main process. Paths inside resolve relative to the output file, and build/
// sits at the same depth as dist/, so ../assets and ../index.html still land.
await esbuild.build({
  ...shared,
  entryPoints: [path.join(root, 'src', 'main.ts')],
  outfile: path.join(root, 'build', 'main.js'),
  platform: 'node',
  // electron-updater is CommonJS and dynamically requires Electron. Keep it as
  // a packaged runtime dependency rather than wrapping those requires in this
  // ESM bundle.
  external: ['electron', 'electron-updater'],
});

// Renderer. Runs in the browser context and touches only the window.aside
// bridge, so it has no node externals.
await esbuild.build({
  ...shared,
  entryPoints: [path.join(root, 'src', 'renderer.ts')],
  outfile: path.join(root, 'build', 'renderer.js'),
  platform: 'browser',
});

console.log('bundled -> build/main.js, build/renderer.js');
