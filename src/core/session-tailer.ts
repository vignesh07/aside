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
      // Seed: read last chunk of file
      const seedBytes = Math.min(stat.size, 32768); // ~32KB
      offset = stat.size - seedBytes;
      if (seedBytes > 0) {
        const fd = fs.openSync(jsonlPath, 'r');
        const buf = Buffer.alloc(seedBytes);
        fs.readSync(fd, buf, 0, seedBytes, offset);
        fs.closeSync(fd);

        const text = buf.toString('utf-8');
        // Find the first complete line (skip partial first line)
        const firstNewline = offset > 0 ? text.indexOf('\n') + 1 : 0;
        const lines = text.slice(firstNewline).split('\n').filter(Boolean);

        // Emit the last N seed lines
        const seedLines = lines.slice(-TIMING.seedLines);
        for (const line of seedLines) {
          this.emit('line', { sessionId, line, isSeed: true } satisfies TailEvent);
        }
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
