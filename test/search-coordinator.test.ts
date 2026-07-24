import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createThreadSearchService,
} from '../menubar/src/search-coordinator.js';
import {
  ThreadSearchReader,
  readySearchStatus,
} from '../menubar/src/search-database.js';
import type { ThreadSearchService } from '../menubar/src/search-types.js';

const roots: string[] = [];

function fakeService(): ThreadSearchService {
  return {
    syncSessions: () => {},
    syncSideChats: () => {},
    search: async () => [],
    rebuild: () => {},
    getStatus: readySearchStatus,
    onStatus: () => () => {},
    dispose: () => {},
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('content search startup recovery', () => {
  it('quarantines a corrupt disposable index and starts with a clean one', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aside-search-recovery-'));
    roots.push(root);
    const databasePath = path.join(root, 'search.sqlite');
    fs.writeFileSync(databasePath, 'not a sqlite database');
    let attempts = 0;

    const service = createThreadSearchService(databasePath, (location) => {
      attempts += 1;
      const reader = new ThreadSearchReader(location);
      reader.close();
      return fakeService();
    });

    expect(attempts).toBe(2);
    expect(service.getStatus().phase).toBe('ready');
    expect(
      fs.readdirSync(root).some((entry) =>
        entry.startsWith('search.sqlite.unreadable-'),
      ),
    ).toBe(true);
    service.dispose();
  });

  it('falls back to metadata-only search when the index cannot open', async () => {
    const service = createThreadSearchService('/unavailable/search.sqlite', () => {
      throw new Error('index unavailable');
    });

    expect(service.getStatus()).toMatchObject({
      phase: 'error',
      message: 'index unavailable',
    });
    await expect(service.search('anything')).resolves.toEqual([]);
    service.dispose();
  });
});
