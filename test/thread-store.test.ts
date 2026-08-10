import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileThreadStore } from '../src/core/thread-store.js';
import type { ChatThread } from '../src/types/chat.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempStore(): FileThreadStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aside-store-'));
  tempDirs.push(dir);
  return new FileThreadStore(path.join(dir, 'private', 'threads.json'));
}

function thread(): ChatThread {
  return {
    id: 'session:abc',
    scope: { kind: 'session', source: null, sessionId: 'abc' },
    provider: 'ollama',
    model: 'llama3.2',
    turns: [
      {
        id: 't1-1',
        role: 'user',
        content: 'remember me',
        timestamp: new Date('2026-07-23T12:00:00.000Z'),
      },
    ],
    thinking: true,
    updatedAt: new Date('2026-07-23T12:00:01.000Z'),
  };
}

describe('FileThreadStore', () => {
  it('round-trips durable history and resets transient thinking state', () => {
    const store = tempStore();
    store.save([thread()]);
    const restored = store.load();
    expect(restored).toHaveLength(1);
    expect(restored[0]!.turns[0]!.timestamp).toEqual(new Date('2026-07-23T12:00:00.000Z'));
    expect(restored[0]!.provider).toBe('ollama');
    expect(restored[0]!.thinking).toBe(false);
  });

  it('creates user-only storage permissions', () => {
    const store = tempStore();
    store.save([thread()]);
    expect(fs.statSync(path.dirname(store.location)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(store.location).mode & 0o777).toBe(0o600);
  });

  it('fails closed to an empty state for corrupt data', () => {
    const store = tempStore();
    fs.mkdirSync(path.dirname(store.location), { recursive: true });
    fs.writeFileSync(store.location, '{not json');
    expect(store.load()).toEqual([]);
  });

  it('merges stale writers so two frontends cannot erase each other', () => {
    const store = tempStore();
    const first = thread();
    store.save([first]);

    const second: ChatThread = {
      ...thread(),
      id: 'session:def',
      scope: { kind: 'session', source: null, sessionId: 'def' },
      turns: [{ ...thread().turns[0]!, id: 't2-2', content: 'from the menubar' }],
      updatedAt: new Date('2026-07-23T12:00:02.000Z'),
    };
    // Simulates a process whose in-memory state did not contain session:abc.
    new FileThreadStore(store.location).save([second]);

    expect(store.load().map((saved) => saved.id).sort()).toEqual([
      'session:abc',
      'session:def',
    ]);
  });

  it('atomically merges and removes a migrated legacy thread id', () => {
    const store = tempStore();
    const legacy = thread();
    store.save([legacy]);
    const canonicalId = 'session:opencode:abc';
    const canonical: ChatThread = {
      ...legacy,
      id: canonicalId,
      scope: { kind: 'session', source: 'opencode', sessionId: 'abc' },
      turns: [{
        ...legacy.turns[0]!,
        id: 'canonical-turn',
        content: 'new canonical history',
      }],
      updatedAt: new Date('2026-07-23T12:00:02.000Z'),
    };

    new FileThreadStore(store.location).save([canonical], {
      migrations: new Map([['session:abc', canonicalId]]),
    });

    const restored = store.load();
    expect(restored.map((saved) => saved.id)).toEqual([canonicalId]);
    expect(restored[0]?.scope).toEqual({
      kind: 'session',
      source: 'opencode',
      sessionId: 'abc',
    });
    expect(restored[0]?.turns.map((turn) => turn.content)).toEqual([
      'remember me',
      'new canonical history',
    ]);
  });
});
