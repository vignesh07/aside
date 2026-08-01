import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  FileProviderConsentStore,
  ProviderConsentStoreError,
} from '../menubar/src/provider-auth-store.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempStore(): FileProviderConsentStore {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aside-provider-store-'));
  tempDirs.push(root);
  const directory = path.join(root, 'private');
  fs.mkdirSync(directory, { mode: 0o700 });
  return new FileProviderConsentStore(path.join(directory, 'providers.json'));
}

function writeConsent(
  store: FileProviderConsentStore,
  value: unknown,
): string {
  const raw = `${JSON.stringify(value, null, 2)}\n`;
  fs.writeFileSync(store.location, raw, { mode: 0o600 });
  fs.chmodSync(store.location, 0o600);
  return raw;
}

function readConsent(store: FileProviderConsentStore): unknown {
  return JSON.parse(fs.readFileSync(store.location, 'utf8'));
}

describe('provider consent store version compatibility', () => {
  it('loads the public v1 shape without silently granting Today access', () => {
    const store = tempStore();
    writeConsent(store, {
      version: 1,
      enabled: {
        'codex-cli': true,
        'claude-cli': true,
        ollama: false,
      },
    });

    expect(store.load()).toEqual({
      enabled: new Set(['codex-cli', 'claude-cli']),
      todayRecaps: new Set(),
    });
  });

  it('loads the prerelease v2 shape and preserves both consent scopes', () => {
    const store = tempStore();
    writeConsent(store, {
      version: 2,
      enabled: {
        'codex-cli': true,
        'claude-cli': true,
        ollama: false,
      },
      todayRecaps: {
        'codex-cli': true,
        'claude-cli': false,
        ollama: false,
      },
    });

    expect(store.load()).toEqual({
      enabled: new Set(['codex-cli', 'claude-cli']),
      todayRecaps: new Set(['codex-cli']),
    });
  });

  it('safely rewrites known v2 state as rollback-compatible v1', () => {
    const store = tempStore();
    writeConsent(store, {
      version: 2,
      enabled: {
        'codex-cli': true,
        'claude-cli': true,
        ollama: false,
      },
      todayRecaps: {
        'codex-cli': true,
        'claude-cli': false,
        ollama: false,
      },
    });

    store.setTodayRecapsEnabled('claude-cli', true);

    expect(readConsent(store)).toEqual({
      version: 1,
      enabled: {
        'codex-cli': true,
        'claude-cli': true,
        ollama: false,
      },
      todayRecaps: {
        'codex-cli': true,
        'claude-cli': true,
        ollama: false,
      },
    });
    expect(store.load()).toEqual({
      enabled: new Set(['codex-cli', 'claude-cli']),
      todayRecaps: new Set(['codex-cli', 'claude-cli']),
    });
    expect(fs.statSync(store.location).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(store.location))).toEqual([
      'providers.json',
    ]);
  });

  it.each([
    {
      name: 'malformed v1 enabled state',
      value: {
        version: 1,
        enabled: { 'codex-cli': 'yes' },
      },
    },
    {
      name: 'malformed v2 Today state',
      value: {
        version: 2,
        enabled: { 'codex-cli': true },
        todayRecaps: { 'codex-cli': 'yes' },
      },
    },
    {
      name: 'unknown future version',
      value: {
        version: 3,
        enabled: { 'codex-cli': true },
        todayRecaps: { 'codex-cli': true },
      },
    },
  ])('fails closed on $name and refuses to rewrite it', ({ value }) => {
    const store = tempStore();
    const original = writeConsent(store, value);

    expect(() => store.load()).toThrowError(
      expect.objectContaining<Partial<ProviderConsentStoreError>>({
        code: 'corrupt',
      }),
    );
    expect(() => store.setEnabled('claude-cli', true)).toThrowError(
      expect.objectContaining<Partial<ProviderConsentStoreError>>({
        code: 'corrupt',
      }),
    );
    expect(fs.readFileSync(store.location, 'utf8')).toBe(original);
    expect(fs.readdirSync(path.dirname(store.location))).toEqual([
      'providers.json',
    ]);
  });
});
