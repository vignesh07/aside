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
    scope: { kind: 'session', sessionId: 'abc' },
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
      scope: { kind: 'session', sessionId: 'def' },
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
});
