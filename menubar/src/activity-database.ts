import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ActivityLedgerStore } from '../../dist/core/activity-ledger.js';
import type {
  ActivityEventRecord,
  ActivityLedgerState,
  ThreadActivityCursor,
} from '../../dist/types/activity.js';

const SCHEMA_VERSION = 1;

interface EventRow {
  seq: number;
  event_id: string;
  thread_key: string;
  source: ActivityEventRecord['source'];
  session_id: string;
  parent_thread_key: string | null;
  root_thread_key: string | null;
  project_name: string;
  project_path: string;
  title: string;
  occurred_at_ms: number;
  observed_at_ms: number;
  kind: ActivityEventRecord['kind'];
  lifecycle: ActivityEventRecord['lifecycle'];
  severity: ActivityEventRecord['severity'];
  summary: string;
  origin_id: string | null;
  evidence_hash: string;
  seeded: number;
}

interface CursorRow {
  thread_key: string;
  baseline_at_ms: number;
  viewed_through_seq: number;
  resolved_through_seq: number;
}

/**
 * Durable attention history. This database is deliberately separate from the
 * rebuildable full-text index because viewed/resolved cursors are user state.
 */
export class ActivityDatabase implements ActivityLedgerStore {
  private readonly db: DatabaseSync;

  constructor(
    readonly location = path.join(os.homedir(), '.aside', 'activity.sqlite'),
  ) {
    ensurePrivateParent(location);
    this.db = new DatabaseSync(location);
    try {
      this.db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA secure_delete = ON;
      `);
      initializeSchema(this.db);
      secureDatabaseFiles(location);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  load(): ActivityLedgerState {
    const events = this.db
      .prepare('SELECT * FROM activity_events ORDER BY seq ASC')
      .all() as unknown as EventRow[];
    const cursors = this.db
      .prepare('SELECT * FROM activity_threads ORDER BY thread_key ASC')
      .all() as unknown as CursorRow[];
    return {
      events: events.map(deserializeEvent),
      cursors: cursors.map((row) => ({
        threadKey: row.thread_key,
        baselineAtMs: row.baseline_at_ms,
        viewedThroughSeq: row.viewed_through_seq,
        resolvedThroughSeq: row.resolved_through_seq,
      })),
    };
  }

  append(events: ActivityEventRecord[]): void {
    if (events.length === 0) return;
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO activity_events (
        seq, event_id, thread_key, source, session_id,
        parent_thread_key, root_thread_key, project_name, project_path, title,
        occurred_at_ms, observed_at_ms, kind, lifecycle, severity, summary,
        origin_id, evidence_hash, seeded
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const event of events) {
        insert.run(
          event.seq,
          event.eventId,
          event.threadKey,
          event.source,
          event.sessionId,
          event.parentThreadKey ?? null,
          event.rootThreadKey ?? null,
          event.projectName,
          event.projectPath,
          event.title,
          event.occurredAtMs,
          event.observedAtMs,
          event.kind,
          event.lifecycle,
          event.severity,
          event.summary,
          event.originId ?? null,
          event.evidenceHash,
          event.seeded ? 1 : 0,
        );
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  saveCursors(cursors: ThreadActivityCursor[]): void {
    if (cursors.length === 0) return;
    const upsert = this.db.prepare(`
      INSERT INTO activity_threads (
        thread_key, baseline_at_ms, viewed_through_seq, resolved_through_seq
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(thread_key) DO UPDATE SET
        baseline_at_ms = excluded.baseline_at_ms,
        viewed_through_seq = MAX(activity_threads.viewed_through_seq, excluded.viewed_through_seq),
        resolved_through_seq = MAX(activity_threads.resolved_through_seq, excluded.resolved_through_seq)
    `);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const cursor of cursors) {
        upsert.run(
          cursor.threadKey,
          cursor.baselineAtMs,
          cursor.viewedThroughSeq,
          cursor.resolvedThroughSeq,
        );
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  prune(cutoffOccurredAtMs: number, keepNewest: number): void {
    this.db
      .prepare('DELETE FROM activity_events WHERE occurred_at_ms < ?')
      .run(cutoffOccurredAtMs);
    this.db
      .prepare(`
        DELETE FROM activity_events
        WHERE seq NOT IN (
          SELECT seq FROM activity_events ORDER BY seq DESC LIMIT ?
        )
      `)
      .run(keepNewest);
  }

  close(): void {
    this.db.close();
  }
}

function initializeSchema(db: DatabaseSync): void {
  const version = Number(db.prepare('PRAGMA user_version').get()?.['user_version'] ?? 0);
  if (version > SCHEMA_VERSION) {
    throw new Error(`Activity database version ${version} is newer than this Aside build.`);
  }
  if (version === 0) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS activity_events (
        seq INTEGER NOT NULL UNIQUE,
        event_id TEXT PRIMARY KEY,
        thread_key TEXT NOT NULL,
        source TEXT NOT NULL,
        session_id TEXT NOT NULL,
        parent_thread_key TEXT,
        root_thread_key TEXT,
        project_name TEXT NOT NULL,
        project_path TEXT NOT NULL,
        title TEXT NOT NULL,
        occurred_at_ms INTEGER NOT NULL,
        observed_at_ms INTEGER NOT NULL,
        kind TEXT NOT NULL,
        lifecycle TEXT NOT NULL,
        severity TEXT NOT NULL,
        summary TEXT NOT NULL,
        origin_id TEXT,
        evidence_hash TEXT NOT NULL,
        seeded INTEGER NOT NULL CHECK (seeded IN (0, 1))
      );
      CREATE INDEX IF NOT EXISTS idx_activity_time
        ON activity_events(occurred_at_ms, thread_key);
      CREATE INDEX IF NOT EXISTS idx_activity_thread_seq
        ON activity_events(thread_key, seq);

      CREATE TABLE IF NOT EXISTS activity_threads (
        thread_key TEXT PRIMARY KEY,
        baseline_at_ms INTEGER NOT NULL,
        viewed_through_seq INTEGER NOT NULL,
        resolved_through_seq INTEGER NOT NULL
      );
      PRAGMA user_version = 1;
    `);
  }
}

function deserializeEvent(row: EventRow): ActivityEventRecord {
  return {
    seq: row.seq,
    eventId: row.event_id,
    threadKey: row.thread_key,
    source: row.source,
    sessionId: row.session_id,
    parentThreadKey: row.parent_thread_key ?? undefined,
    rootThreadKey: row.root_thread_key ?? undefined,
    projectName: row.project_name,
    projectPath: row.project_path,
    title: row.title,
    occurredAtMs: row.occurred_at_ms,
    observedAtMs: row.observed_at_ms,
    kind: row.kind,
    lifecycle: row.lifecycle,
    severity: row.severity,
    summary: row.summary,
    originId: row.origin_id ?? undefined,
    evidenceHash: row.evidence_hash,
    seeded: row.seeded === 1,
  };
}

function ensurePrivateParent(location: string): void {
  const dir = path.dirname(location);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

function secureDatabaseFiles(location: string): void {
  for (const file of [location, `${location}-wal`, `${location}-shm`]) {
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // WAL sidecars are created lazily.
    }
  }
}
