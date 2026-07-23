import * as fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { TIMING } from '../config/defaults.js';

export interface TailEvent {
  sessionId: string;
  line: string;
  isSeed: boolean;
}

/**
 * Tails JSONL files for active sessions, emitting new lines as they appear.
 * Uses fs.watch with stat-polling fallback.
 */
export class SessionTailer extends EventEmitter {
  private watchers = new Map<string, { watcher: fs.FSWatcher; offset: number; pollTimer?: NodeJS.Timeout }>();

  /**
   * Start tailing a session JSONL file.
   * Reads the last N lines on startup, then watches for new appends.
   */
  startTailing(sessionId: string, jsonlPath: string): void {
    if (this.watchers.has(sessionId)) return;

    let offset: number;
    try {
      const stat = fs.statSync(jsonlPath);
      for (const line of readJsonlTailLines(jsonlPath, TIMING.seedLines)) {
        this.emit('line', { sessionId, line, isSeed: true } satisfies TailEvent);
      }
      // Set offset to end of file for tailing
      offset = stat.size;
    } catch {
      offset = 0;
    }

    // Watch for changes
    let watcher: fs.FSWatcher;
    try {
      watcher = fs.watch(jsonlPath, () => {
        this.readNewLines(sessionId, jsonlPath);
      });
    } catch {
      // fs.watch might fail - use polling only
      watcher = null as unknown as fs.FSWatcher;
    }

    // Polling fallback
    const pollTimer = setInterval(() => {
      this.readNewLines(sessionId, jsonlPath);
    }, TIMING.tailPollMs);

    this.watchers.set(sessionId, { watcher, offset, pollTimer });
  }

  stopTailing(sessionId: string): void {
    const entry = this.watchers.get(sessionId);
    if (!entry) return;

    try { entry.watcher?.close(); } catch { /* ignore */ }
    if (entry.pollTimer) clearInterval(entry.pollTimer);
    this.watchers.delete(sessionId);
  }

  stopAll(): void {
    for (const id of this.watchers.keys()) {
      this.stopTailing(id);
    }
  }

  get tailedSessionIds(): string[] {
    return [...this.watchers.keys()];
  }

  private readNewLines(sessionId: string, jsonlPath: string): void {
    const entry = this.watchers.get(sessionId);
    if (!entry) return;

    let stat: fs.Stats;
    try {
      stat = fs.statSync(jsonlPath);
    } catch {
      return;
    }

    if (stat.size <= entry.offset) return;

    const bytesToRead = stat.size - entry.offset;
    if (bytesToRead <= 0) return;

    try {
      const fd = fs.openSync(jsonlPath, 'r');
      const buf = Buffer.alloc(bytesToRead);
      fs.readSync(fd, buf, 0, bytesToRead, entry.offset);
      fs.closeSync(fd);

      entry.offset = stat.size;

      const text = buf.toString('utf-8');
      const lines = text.split('\n').filter(Boolean);

      for (const line of lines) {
        this.emit('line', { sessionId, line, isSeed: false } satisfies TailEvent);
      }
    } catch {
      // File read error - skip this round
    }
  }
}

/**
 * Read complete JSONL records from the end of a transcript without loading the
 * entire file. Exported so selecting a historical thread can hydrate context
 * without permanently watching hundreds of old files.
 */
export function readJsonlTailLines(
  jsonlPath: string,
  maxLines: number,
  maxBytes = 512 * 1024,
): string[] {
  let fd: number | undefined;
  try {
    const stat = fs.statSync(jsonlPath);
    const bytes = Math.min(stat.size, maxBytes);
    if (bytes <= 0 || maxLines <= 0) return [];
    const offset = stat.size - bytes;
    fd = fs.openSync(jsonlPath, 'r');
    const buf = Buffer.alloc(bytes);
    fs.readSync(fd, buf, 0, bytes, offset);
    const text = buf.toString('utf-8');
    const firstComplete = offset > 0
      ? (() => {
          const newline = text.indexOf('\n');
          return newline === -1 ? text.length : newline + 1;
        })()
      : 0;
    return text
      .slice(firstComplete)
      .split('\n')
      .filter(Boolean)
      .slice(-maxLines);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}
