import * as fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { TIMING } from '../config/defaults.js';
import { ACTIVITY_MAX_RECORDS } from './activity-ledger.js';

const MAX_PENDING_RECORD_BYTES = 32 * 1024 * 1024;
export const MAX_CANONICAL_RESET_BYTES = 64 * 1024 * 1024;
export const MAX_CANONICAL_RESET_LINES = ACTIVITY_MAX_RECORDS;
const MAX_APPEND_READ_BYTES = 4 * 1024 * 1024;
const GENERATION_ANCHOR_BYTES = 4 * 1024;

export interface TailEvent {
  sessionId: string;
  line: string;
  isSeed: boolean;
}

/** A bounded, oldest-first replacement projection after truncate/rename. */
export interface TailResetEvent {
  sessionId: string;
  lines: string[];
  /** False when byte/line bounds prevented reading the whole projection. */
  complete: boolean;
}

export interface StartTailingOptions {
  /** Skip the initial tail when the caller already hydrated the same file. */
  seed?: boolean;
}

/**
 * Tails JSONL files for active sessions, emitting new lines as they appear.
 * Uses fs.watch with stat-polling fallback.
 */
export class SessionTailer extends EventEmitter {
  private watchers = new Map<string, {
    watcher: fs.FSWatcher;
    offset: number;
    pending: string;
    dev: number;
    ino: number;
    anchor: Buffer<ArrayBufferLike>;
    pollTimer?: NodeJS.Timeout;
  }>();

  /**
   * Start tailing a session JSONL file.
   * Reads the last N lines on startup, then watches for new appends.
   */
  startTailing(
    sessionId: string,
    jsonlPath: string,
    options: StartTailingOptions = {},
  ): boolean {
    if (this.watchers.has(sessionId)) return true;

    let offset: number;
    let pending = '';
    let dev = 0;
    let ino = 0;
    let anchor: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let sourceReadable = false;
    try {
      const stat = fs.statSync(jsonlPath);
      if (options.seed !== false) {
        const seed = tryReadJsonlTailLines(
          jsonlPath,
          MAX_CANONICAL_RESET_LINES,
          MAX_CANONICAL_RESET_BYTES,
        );
        if (!seed.success) throw new Error('Could not read transcript seed');
        // Startup is a canonical projection, not a stream of new appends.
        // Emitting one reset lets durable activity prune records that were
        // deleted or rewritten while Aside was closed.
        this.emit('reset', {
          sessionId,
          lines: seed.lines,
          complete: seed.complete,
        } satisfies TailResetEvent);
      }
      pending = readTrailingPartialRecord(jsonlPath, stat.size);
      // Set offset to end of file for tailing
      offset = stat.size;
      dev = stat.dev;
      ino = stat.ino;
      anchor = readGenerationAnchor(jsonlPath, stat.size);
      sourceReadable = true;
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

    this.watchers.set(sessionId, {
      watcher,
      offset,
      pending,
      dev,
      ino,
      anchor,
      pollTimer,
    });
    return sourceReadable;
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

    // Aside-owned projections (for example the OpenCode SQLite adapter) are
    // normally append-only, but a source deletion or non-monotonic edit must
    // atomically replace the projection to avoid retaining stale private text.
    // Replacement history is emitted as one seeded reset batch: treating it
    // as live appends would retain deleted state and produce false activity.
    const inodeChanged =
      entry.ino !== 0 &&
      (entry.dev !== stat.dev || entry.ino !== stat.ino);
    const appeared = entry.ino === 0;
    const truncated = stat.size < entry.offset;
    const anchorChanged =
      entry.ino !== 0 &&
      !generationAnchorMatches(jsonlPath, entry.offset, entry.anchor);
    if (inodeChanged || appeared || truncated || anchorChanged) {
      const replacement = tryReadJsonlTailLines(
        jsonlPath,
        MAX_CANONICAL_RESET_LINES,
        MAX_CANONICAL_RESET_BYTES,
      );
      // Keep the previous identity and offset so the polling path retries. An
      // unreadable replacement is not evidence of an intentionally empty file.
      if (!replacement.success) return;
      const nextPending = readTrailingPartialRecord(jsonlPath, stat.size);
      const nextAnchor = readGenerationAnchor(jsonlPath, stat.size);
      try {
        this.emit('reset', {
          sessionId,
          lines: replacement.lines,
          complete: replacement.complete,
        } satisfies TailResetEvent);
      } catch {
        // The consumer did not commit the canonical replacement. Retain the
        // old generation so polling retries instead of accepting divergence.
        return;
      }
      entry.offset = stat.size;
      entry.pending = nextPending;
      entry.dev = stat.dev;
      entry.ino = stat.ino;
      entry.anchor = nextAnchor;
      if (inodeChanged || appeared) {
        try { entry.watcher?.close(); } catch { /* ignore */ }
        try {
          entry.watcher = fs.watch(jsonlPath, () => {
            this.readNewLines(sessionId, jsonlPath);
          });
        } catch {
          entry.watcher = null as unknown as fs.FSWatcher;
        }
      }
      return;
    }
    if (stat.size === entry.offset) return;

    const bytesToRead = Math.min(
      stat.size - entry.offset,
      MAX_APPEND_READ_BYTES,
    );
    if (bytesToRead <= 0) return;

    let fd: number | undefined;
    try {
      fd = fs.openSync(jsonlPath, 'r');
      const buf = Buffer.alloc(bytesToRead);
      const bytesRead = fs.readSync(fd, buf, 0, bytesToRead, entry.offset);
      fs.closeSync(fd);
      fd = undefined;
      if (bytesRead !== bytesToRead) return;

      const text = entry.pending + buf.toString('utf-8');
      const complete = text.endsWith('\n');
      const parts = text.split('\n');
      let nextPending = complete ? '' : (parts.pop() ?? '');
      // A corrupt or hostile unterminated record must not grow forever.
      if (Buffer.byteLength(nextPending, 'utf8') > MAX_PENDING_RECORD_BYTES) {
        nextPending = '';
      }
      const lines = parts.filter(Boolean);

      try {
        for (const line of lines) {
          this.emit('line', { sessionId, line, isSeed: false } satisfies TailEvent);
        }
      } catch {
        return;
      }
      entry.offset += bytesRead;
      entry.pending = nextPending;
      entry.anchor = readGenerationAnchor(jsonlPath, entry.offset);
    } catch {
      // File read error - skip this round
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* ignore */ }
      }
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
  return tryReadJsonlTailLines(jsonlPath, maxLines, maxBytes).lines;
}

/**
 * The status-bearing form lets restart recovery distinguish an empty
 * transcript from a transient read failure. Callers that only need best-effort
 * lines should continue using readJsonlTailLines.
 */
export function tryReadJsonlTailLines(
  jsonlPath: string,
  maxLines: number,
  maxBytes = 512 * 1024,
): { lines: string[]; success: boolean; complete: boolean } {
  let fd: number | undefined;
  try {
    const stat = fs.statSync(jsonlPath);
    const bytes = Math.min(stat.size, maxBytes);
    if (bytes <= 0 || maxLines <= 0) {
      return {
        lines: [],
        success: true,
        complete: stat.size === 0,
      };
    }
    const offset = stat.size - bytes;
    fd = fs.openSync(jsonlPath, 'r');
    const buf = Buffer.alloc(bytes);
    const bytesRead = fs.readSync(fd, buf, 0, bytes, offset);
    // A concurrent rewrite can make the stat/read pair race. Treat a short
    // read as transient instead of accepting a partial projection as truth.
    if (bytesRead !== bytes) {
      return { lines: [], success: false, complete: false };
    }
    const text = buf.toString('utf-8');
    const firstComplete = offset > 0
      ? (() => {
          const newline = text.indexOf('\n');
          return newline === -1 ? text.length : newline + 1;
        })()
      : 0;
    const completeText = text.slice(firstComplete);
    const parts = completeText.split('\n');
    const hasTrailingPartial = !completeText.endsWith('\n');
    if (hasTrailingPartial) parts.pop();
    const lines = parts.filter(Boolean);
    return {
      lines: lines.slice(-maxLines),
      success: true,
      complete:
        offset === 0 &&
        !hasTrailingPartial &&
        lines.length <= maxLines,
    };
  } catch {
    return { lines: [], success: false, complete: false };
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function readTrailingPartialRecord(
  jsonlPath: string,
  size: number,
): string {
  if (size <= 0) return '';
  const bytes = Math.min(size, MAX_PENDING_RECORD_BYTES);
  const offset = size - bytes;
  let fd: number | undefined;
  try {
    fd = fs.openSync(jsonlPath, 'r');
    const buf = Buffer.alloc(bytes);
    fs.readSync(fd, buf, 0, bytes, offset);
    const text = buf.toString('utf8');
    if (text.endsWith('\n')) return '';
    const lastNewline = text.lastIndexOf('\n');
    if (lastNewline !== -1) return text.slice(lastNewline + 1);
    return offset === 0 ? text : '';
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function readGenerationAnchor(jsonlPath: string, size: number): Buffer {
  if (size <= 0) return Buffer.alloc(0);
  const tailBytes = Math.min(size, GENERATION_ANCHOR_BYTES);
  const headBytes = Math.min(size - tailBytes, GENERATION_ANCHOR_BYTES);
  let fd: number | undefined;
  try {
    fd = fs.openSync(jsonlPath, 'r');
    const anchor = Buffer.alloc(headBytes + tailBytes);
    if (headBytes > 0) {
      const read = fs.readSync(fd, anchor, 0, headBytes, 0);
      if (read !== headBytes) return Buffer.alloc(0);
    }
    const tailOffset = size - tailBytes;
    const tailRead = fs.readSync(fd, anchor, headBytes, tailBytes, tailOffset);
    return tailRead === tailBytes ? anchor : Buffer.alloc(0);
  } catch {
    return Buffer.alloc(0);
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function generationAnchorMatches(
  jsonlPath: string,
  size: number,
  expected: Buffer,
): boolean {
  if (expected.length === 0) return size === 0;
  return readGenerationAnchor(jsonlPath, size).equals(expected);
}
