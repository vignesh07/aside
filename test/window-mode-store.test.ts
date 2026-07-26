import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FileWindowModeStore,
  parseWindowPosition,
} from '../menubar/src/window-mode-store.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempStore(): FileWindowModeStore {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aside-window-mode-'));
  tempDirs.push(root);
  return new FileWindowModeStore(path.join(root, 'private', 'window-mode.json'));
}

describe('FileWindowModeStore', () => {
  it('round-trips Keep Open and its detached position privately', () => {
    const store = tempStore();
    store.save({ keepOpen: true, position: { x: -1200, y: 42 } });

    expect(store.load()).toEqual({
      keepOpen: true,
      position: { x: -1200, y: 42 },
    });
    expect(fs.statSync(path.dirname(store.location)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(store.location).mode & 0o777).toBe(0o600);
  });

  it('keeps a remembered point while returning to transient mode', () => {
    const store = tempStore();
    store.save({ keepOpen: false, position: { x: 900, y: 80 } });

    expect(store.load()).toEqual({
      keepOpen: false,
      position: { x: 900, y: 80 },
    });
  });

  it.each([
    '{not json',
    JSON.stringify({ version: 2, keepOpen: true, position: null }),
    JSON.stringify({ version: 1, keepOpen: 'yes', position: null }),
    JSON.stringify({ version: 1, keepOpen: true, position: { x: 2.5, y: 4 } }),
  ])('fails closed for invalid state', (contents) => {
    const store = tempStore();
    fs.mkdirSync(path.dirname(store.location), { recursive: true });
    fs.writeFileSync(store.location, contents);

    expect(store.load()).toEqual({ keepOpen: false, position: null });
  });
});

describe('parseWindowPosition', () => {
  it('supports negative display coordinates', () => {
    expect(parseWindowPosition({ x: -3440, y: -120 })).toEqual({
      x: -3440,
      y: -120,
    });
  });

  it.each([
    null,
    {},
    { x: '1', y: 2 },
    { x: 1, y: Number.NaN },
    { x: 100_001, y: 0 },
  ])('rejects unsafe positions: %j', (value) => {
    expect(parseWindowPosition(value)).toBeNull();
  });
});
