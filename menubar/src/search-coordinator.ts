import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import {
  ThreadSearchReader,
  readySearchStatus,
} from './search-database.js';
import type {
  IndexableSideChat,
  IndexableThread,
  SearchIndexStatus,
  ThreadSearchResult,
  ThreadSearchService,
} from './search-types.js';

type WorkerResponse = { type: 'status'; status: SearchIndexStatus };

export class ThreadSearchCoordinator implements ThreadSearchService {
  private readonly reader: ThreadSearchReader;
  private readonly worker: Worker;
  private readonly listeners = new Set<() => void>();
  private status: SearchIndexStatus = {
    ...readySearchStatus(),
    phase: 'starting',
  };
  private sessionSignature = '\u0000';
  private sideChatSignature = '\u0000';
  private lastSessions: IndexableThread[] = [];
  private lastSideChats: IndexableSideChat[] = [];
  private disposed = false;

  constructor(
    databasePath = path.join(os.homedir(), '.aside', 'search.sqlite'),
  ) {
    this.reader = new ThreadSearchReader(databasePath);
    try {
      this.worker = new Worker(new URL('./search-worker.js', import.meta.url), {
        workerData: { databasePath },
        // `--input-type` is valid only for stdin/eval entrypoints and cannot be
        // inherited by a file-backed worker (notably in developer harnesses).
        execArgv: process.execArgv.filter(
          (argument) => !argument.startsWith('--input-type'),
        ),
      });
    } catch (error) {
      this.reader.close();
      throw error;
    }
    this.worker.on('message', (message: WorkerResponse) => {
      if (message.type !== 'status') return;
      this.status = message.status;
      this.emitStatus();
    });
    this.worker.on('error', (error) => {
      this.status = {
        ...this.status,
        phase: 'error',
        message: error.message,
      };
      this.emitStatus();
    });
    this.worker.on('exit', (code) => {
      if (this.disposed || code === 0) return;
      this.status = {
        ...this.status,
        phase: 'error',
        message: `Search index worker stopped with code ${code}.`,
      };
      this.emitStatus();
    });
  }

  syncSessions(sessions: IndexableThread[]): void {
    if (this.disposed) return;
    this.lastSessions = sessions;
    const signature = sessions
      .map(
        (session) =>
          `${session.source}\u0000${session.sessionId}\u0000${session.jsonlPath}\u0000${session.lastEventMs}`,
      )
      .join('\u0001');
    if (signature === this.sessionSignature) return;
    this.sessionSignature = signature;
    this.worker.postMessage({ type: 'sync-sessions', sessions });
  }

  syncSideChats(chats: IndexableSideChat[]): void {
    if (this.disposed) return;
    this.lastSideChats = chats;
    const signature = chats
      .map(
        (chat) =>
          `${chat.sessionId}\u0000${chat.updatedAt}\u0000${chat.turns.length}`,
      )
      .join('\u0001');
    if (signature === this.sideChatSignature) return;
    this.sideChatSignature = signature;
    this.worker.postMessage({ type: 'sync-side-chats', chats });
  }

  async search(query: string, limit = 40): Promise<ThreadSearchResult[]> {
    if (this.disposed) return [];
    return this.reader.search(query, limit);
  }

  rebuild(): void {
    if (this.disposed) return;
    const sessions = this.lastSessions;
    const sideChats = this.lastSideChats;
    this.sessionSignature = '\u0000';
    this.sideChatSignature = '\u0000';
    this.worker.postMessage({ type: 'rebuild' });
    this.syncSessions(sessions);
    this.syncSideChats(sideChats);
  }

  getStatus(): SearchIndexStatus {
    return this.status;
  }

  onStatus(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.clear();
    this.worker.postMessage({ type: 'dispose' });
    void this.worker.terminate();
    this.reader.close();
  }

  private emitStatus(): void {
    for (const listener of this.listeners) listener();
  }
}

class UnavailableThreadSearchService implements ThreadSearchService {
  private readonly status: SearchIndexStatus;

  constructor(error: unknown) {
    this.status = {
      ...readySearchStatus(),
      phase: 'error',
      message: error instanceof Error ? error.message : String(error),
    };
  }

  syncSessions(): void {}
  syncSideChats(): void {}
  search(): Promise<ThreadSearchResult[]> {
    return Promise.resolve([]);
  }
  rebuild(): void {}
  getStatus(): SearchIndexStatus {
    return this.status;
  }
  onStatus(): () => void {
    return () => {};
  }
  dispose(): void {}
}

type SearchServiceFactory = (databasePath: string) => ThreadSearchService;

/**
 * Content search is an optional, rebuildable layer. A damaged or unwritable
 * index must never prevent the menu-bar app from opening.
 */
export function createThreadSearchService(
  databasePath = path.join(os.homedir(), '.aside', 'search.sqlite'),
  factory: SearchServiceFactory = (location) =>
    new ThreadSearchCoordinator(location),
): ThreadSearchService {
  try {
    return factory(databasePath);
  } catch (firstError) {
    quarantineSearchDatabase(databasePath);
    try {
      return factory(databasePath);
    } catch (retryError) {
      return new UnavailableThreadSearchService(
        retryError instanceof Error ? retryError : firstError,
      );
    }
  }
}

function quarantineSearchDatabase(databasePath: string): void {
  const suffix = `.unreadable-${Date.now()}`;
  for (const filePath of [
    databasePath,
    `${databasePath}-wal`,
    `${databasePath}-shm`,
  ]) {
    try {
      if (fs.existsSync(filePath)) fs.renameSync(filePath, `${filePath}${suffix}`);
    } catch {
      // A permissions failure is handled by the metadata-only fallback.
    }
  }
}
