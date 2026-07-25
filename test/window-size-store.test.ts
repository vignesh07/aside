import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_WINDOW_SIZE } from '../menubar/src/window-layout.js';
import { FileWindowSizeStore } from '../menubar/src/window-size-store.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempStore(): FileWindowSizeStore {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aside-window-store-'));
  tempDirs.push(root);
  return new FileWindowSizeStore(path.join(root, 'private', 'window.json'));
}

describe('FileWindowSizeStore', () => {
  it('round-trips only width and height with private permissions', () => {
    const store = tempStore();
    store.save({ width: 1024, height: 768 });

    expect(store.load()).toEqual({ width: 1024, height: 768 });
    expect(fs.statSync(path.dirname(store.location)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(store.location).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(store.location, 'utf8'))).toEqual({
      version: 1,
      width: 1024,
      height: 768,
    });
    expect(fs.readdirSync(path.dirname(store.location))).toEqual(['window.json']);
  });

  it.each([
    '{not json',
    JSON.stringify({ version: 2, width: 900, height: 700 }),
    JSON.stringify({ version: 1, width: 599, height: 700 }),
    JSON.stringify({ version: 1, width: 900, height: '700' }),
  ])('falls back safely for invalid state', (contents) => {
    const store = tempStore();
    fs.mkdirSync(path.dirname(store.location), { recursive: true });
    fs.writeFileSync(store.location, contents);

    expect(store.load()).toEqual(DEFAULT_WINDOW_SIZE);
  });

  it('falls back for missing, oversized, and symlinked state', () => {
    const store = tempStore();
    expect(store.load()).toEqual(DEFAULT_WINDOW_SIZE);

    fs.mkdirSync(path.dirname(store.location), { recursive: true });
    fs.writeFileSync(store.location, 'x'.repeat(5000));
    expect(store.load()).toEqual(DEFAULT_WINDOW_SIZE);

    fs.unlinkSync(store.location);
    const target = path.join(path.dirname(store.location), 'target.json');
    fs.writeFileSync(
      target,
      JSON.stringify({ version: 1, width: 900, height: 700 }),
    );
    fs.symlinkSync(target, store.location);
    expect(store.load()).toEqual(DEFAULT_WINDOW_SIZE);
  });

  it('does not overwrite a valid preference with invalid dimensions', () => {
    const store = tempStore();
    store.save({ width: 900, height: 700 });
    store.save({ width: 20, height: 20 });

    expect(store.load()).toEqual({ width: 900, height: 700 });
  });
});
