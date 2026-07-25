import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  legacySessionThreadId,
  scopeFromThreadId,
} from '../types/chat.js';
import type { ChatThread, ChatTurn } from '../types/chat.js';

const STORE_VERSION = 1;
const MAX_TURNS_PER_THREAD = 200;

interface StoredTurn extends Omit<ChatTurn, 'timestamp'> {
  timestamp: string;
}

interface StoredThread extends Omit<ChatThread, 'turns' | 'thinking' | 'updatedAt'> {
  turns: StoredTurn[];
  updatedAt: string;
}

interface StoredState {
  version: number;
  threads: StoredThread[];
}

export interface ThreadStore {
  load(): ChatThread[];
  save(threads: ChatThread[]): void;
  readonly location?: string;
}

/**
 * Durable local side-chat history.
 *
 * This is aside's own state, never an agent transcript or project file. The
 * directory and file are private to the current user because side chats may
 * contain sensitive project context even after provider-bound text is redacted.
 */
export class FileThreadStore implements ThreadStore {
  readonly location: string;

  constructor(location = path.join(os.homedir(), '.aside', 'threads.json')) {
    this.location = location;
  }

  load(): ChatThread[] {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.location, 'utf-8')) as Partial<StoredState>;
      if (parsed.version !== STORE_VERSION || !Array.isArray(parsed.threads)) return [];
      return parsed.threads.flatMap((thread): ChatThread[] => {
        if (
          !thread ||
          typeof thread.id !== 'string' ||
          typeof thread.provider !== 'string' ||
          typeof thread.model !== 'string' ||
          !thread.scope ||
          !Array.isArray(thread.turns)
        ) {
          return [];
        }
        const turns = thread.turns.flatMap((turn): ChatTurn[] => {
          if (
            !turn ||
            typeof turn.id !== 'string' ||
            (turn.role !== 'user' && turn.role !== 'assistant') ||
            typeof turn.content !== 'string'
          ) {
            return [];
          }
          const timestamp = new Date(turn.timestamp);
          if (Number.isNaN(timestamp.getTime())) return [];
          return [{ ...turn, timestamp }];
        });
        const updatedAt = new Date(thread.updatedAt);
        return [{
          id: thread.id,
          scope: thread.scope,
          provider: thread.provider,
          model: thread.model,
          turns,
          thinking: false,
          updatedAt: Number.isNaN(updatedAt.getTime()) ? new Date(0) : updatedAt,
        }];
      });
    } catch {
      return [];
    }
  }

  save(threads: ChatThread[]): void {
    let lockFd: number | null = null;
    let lockPath = '';
    try {
      const dir = path.dirname(this.location);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.chmodSync(dir, 0o700);
      lockPath = `${this.location}.lock`;
      lockFd = acquireLock(lockPath);
      if (lockFd === null) return;

      // Both frontends may be open. Merge under the lock so a TUI write cannot
      // erase a newer menubar thread (or vice versa).
      const merged = mergeThreads(this.load(), threads);
      const state: StoredState = {
        version: STORE_VERSION,
        threads: merged.map(serializeThread),
      };
      const temp = `${this.location}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
      fs.renameSync(temp, this.location);
    } catch {
      // Persistence must never make the live observer unusable.
    } finally {
      if (lockFd !== null) {
        try {
          fs.closeSync(lockFd);
          fs.unlinkSync(lockPath);
        } catch {
          // A stale lock ages out on the next save.
        }
      }
    }
  }
}

function serializeThread(thread: ChatThread): StoredThread {
  return {
    id: thread.id,
    scope: thread.scope,
    provider: thread.provider,
    model: thread.model,
    turns: thread.turns.slice(-MAX_TURNS_PER_THREAD).map((turn) => ({
      ...turn,
      timestamp: turn.timestamp.toISOString(),
    })),
    updatedAt: thread.updatedAt.toISOString(),
  };
}

function mergeThreads(existing: ChatThread[], incoming: ChatThread[]): ChatThread[] {
  const merged = new Map(existing.map((thread) => [thread.id, thread]));
  for (const incomingThread of incoming) {
    let next = incomingThread;
    const scope = scopeFromThreadId(next.id);
    if (scope.kind === 'session' && scope.source) {
      const legacyId = legacySessionThreadId(scope.sessionId);
      const legacy = merged.get(legacyId);
      if (legacy) {
        next = mergeThreadPair(legacy, next);
        merged.delete(legacyId);
      }
    } else if (scope.kind === 'session') {
      // A stale frontend may try to write an unqualified thread after another
      // frontend migrated it. Merge it into the sole matching canonical thread
      // instead of resurrecting the legacy id. If multiple providers share the
      // id, retaining it is safer than guessing.
      const canonical = [...merged.values()].filter((thread) => {
        const candidate = scopeFromThreadId(thread.id);
        return (
          candidate.kind === 'session' &&
          candidate.source &&
          candidate.sessionId === scope.sessionId
        );
      });
      if (canonical.length === 1) {
        const target = canonical[0]!;
        next = mergeThreadPair(target, {
          ...next,
          id: target.id,
          scope: target.scope,
        });
      }
    }

    const current = merged.get(next.id);
    if (!current) {
      merged.set(next.id, next);
      continue;
    }
    merged.set(next.id, mergeThreadPair(current, next));
  }
  return [...merged.values()];
}

function mergeThreadPair(
  current: ChatThread,
  next: ChatThread,
): ChatThread {
  const newer = next.updatedAt >= current.updatedAt ? next : current;
  const turns = new Map(current.turns.map((turn) => [turn.id, turn]));
  for (const turn of next.turns) turns.set(turn.id, turn);
  return {
    ...newer,
    id: next.id,
    scope: next.scope,
    turns: [...turns.values()]
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
      .slice(-MAX_TURNS_PER_THREAD),
    thinking: false,
  };
}

function acquireLock(lockPath: string): number | null {
  const waitArray = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return fs.openSync(lockPath, 'wx', 0o600);
    } catch {
      try {
        const ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (ageMs > 30_000) fs.unlinkSync(lockPath);
      } catch {
        // Another process may have released it between open and stat.
      }
      Atomics.wait(waitArray, 0, 0, 5);
    }
  }
  return null;
}
