import { parentPort, workerData } from 'node:worker_threads';
import {
  ThreadSearchReader,
  ThreadSearchWriter,
} from './search-database.js';
import type {
  IndexableSideChat,
  IndexableThread,
  SearchIndexStatus,
} from './search-types.js';
import type {
  UsageAnalyticsQuery,
  UsageAnalyticsSnapshot,
} from './usage-types.js';

interface WorkerConfig {
  databasePath: string;
}

type WorkerRequest =
  | { type: 'sync-sessions'; sessions: IndexableThread[] }
  | { type: 'sync-side-chats'; chats: IndexableSideChat[] }
  | { type: 'usage'; requestId: number; query: UsageAnalyticsQuery }
  | { type: 'rebuild' }
  | { type: 'dispose' };

type WorkerResponse =
  | { type: 'status'; status: SearchIndexStatus }
  | {
      type: 'usage-result';
      requestId: number;
      snapshot: UsageAnalyticsSnapshot;
    }
  | { type: 'usage-error'; requestId: number; message: string };

if (!parentPort) throw new Error('Search index worker requires a parent port.');
const port = parentPort;

const config = workerData as WorkerConfig;
const writer = new ThreadSearchWriter(config.databasePath);
const reader = new ThreadSearchReader(config.databasePath);
let pendingSessions: IndexableThread[] | null = null;
let pendingSideChats: IndexableSideChat[] | null = null;
let draining = false;
let disposed = false;
let lastProgressPublishMs = 0;
let lastProgress: SearchIndexStatus = {
  phase: 'starting',
  indexedThreads: 0,
  totalThreads: 0,
  indexedBytes: 0,
  totalBytes: 0,
};

function publish(status: SearchIndexStatus): void {
  lastProgress = status;
  port.postMessage({ type: 'status', status } satisfies WorkerResponse);
}

async function drain(): Promise<void> {
  if (draining || disposed) return;
  draining = true;
  try {
    while (!disposed && (pendingSessions !== null || pendingSideChats !== null)) {
      if (pendingSessions !== null) {
        const sessions = pendingSessions;
        pendingSessions = null;
        await writer.syncSessions(sessions, (progress) => {
          const now = Date.now();
          if (
            now - lastProgressPublishMs >= 100 ||
            progress.indexedThreads === progress.totalThreads
          ) {
            lastProgressPublishMs = now;
            publish({ phase: 'indexing', ...progress });
          }
        });
      }
      if (pendingSideChats !== null) {
        const chats = pendingSideChats;
        pendingSideChats = null;
        writer.syncSideChats(chats);
      }
    }
    if (
      !disposed &&
      writer.optimizeIfUseful(() => {
        publish({ ...lastProgress, phase: 'optimizing' });
      })
    ) {
      // The optimizing status is published before the blocking FTS merge.
    }
    if (!disposed) {
      publish({ ...lastProgress, phase: 'ready' });
    }
  } catch (error) {
    publish({
      ...lastProgress,
      phase: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    draining = false;
    if (!disposed && (pendingSessions !== null || pendingSideChats !== null)) {
      void drain();
    }
  }
}

port.on('message', (message: WorkerRequest) => {
  if (message.type === 'sync-sessions') {
    pendingSessions = message.sessions;
    void drain();
    return;
  }
  if (message.type === 'sync-side-chats') {
    pendingSideChats = message.chats;
    void drain();
    return;
  }
  if (message.type === 'usage') {
    try {
      port.postMessage({
        type: 'usage-result',
        requestId: message.requestId,
        snapshot: reader.usage(message.query),
      } satisfies WorkerResponse);
    } catch (error) {
      port.postMessage({
        type: 'usage-error',
        requestId: message.requestId,
        message: error instanceof Error ? error.message : String(error),
      } satisfies WorkerResponse);
    }
    return;
  }
  if (message.type === 'rebuild') {
    writer.clear();
    publish({
      phase: 'starting',
      indexedThreads: 0,
      totalThreads: 0,
      indexedBytes: 0,
      totalBytes: 0,
    });
    return;
  }
  disposed = true;
  reader.close();
  writer.close();
});

publish(lastProgress);
