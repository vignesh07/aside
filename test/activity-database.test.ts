import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { ActivityDatabase } from '../menubar/src/activity-database.js';
import type { ActivityEventRecord } from '../src/types/activity.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function database(): ActivityDatabase {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aside-activity-db-'));
  tempDirs.push(root);
  return new ActivityDatabase(path.join(root, 'private', 'activity.sqlite'));
}

function event(overrides: Partial<ActivityEventRecord> = {}): ActivityEventRecord {
  return {
    seq: 1,
    eventId: 'event-1',
    threadKey: 'codex:session-1',
    source: 'codex',
    sessionId: 'session-1',
    projectName: 'aside',
    projectPath: '/work/aside',
    title: 'Ship attention inbox',
    occurredAtMs: 1_700_000_000_000,
    observedAtMs: 1_700_000_000_100,
    kind: 'turn_completed',
    lifecycle: 'terminal',
    severity: 'info',
    summary: 'Latest turn ended',
    evidenceHash: 'a'.repeat(64),
    seeded: false,
    ...overrides,
  };
}

describe('ActivityDatabase', () => {
  it('round-trips evidence and durable read cursors privately', () => {
    const db = database();
    db.append([event()]);
    db.saveCursors([{
      threadKey: 'codex:session-1',
      baselineAtMs: 100,
      viewedThroughSeq: 1,
      resolvedThroughSeq: 0,
    }]);

    expect(db.load()).toEqual({
      events: [event()],
      cursors: [{
        threadKey: 'codex:session-1',
        baselineAtMs: 100,
        viewedThroughSeq: 1,
        resolvedThroughSeq: 0,
      }],
    });
    expect(fs.statSync(path.dirname(db.location)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(db.location).mode & 0o777).toBe(0o600);
    db.close();
  });

  it('deduplicates replayed evidence and prunes without deleting cursors', () => {
    const db = database();
    db.append([
      event(),
      event(),
      event({
        seq: 2,
        eventId: 'event-2',
        occurredAtMs: 1_800_000_000_000,
      }),
    ]);
    db.saveCursors([{
      threadKey: 'codex:session-1',
      baselineAtMs: 100,
      viewedThroughSeq: 0,
      resolvedThroughSeq: 0,
    }]);

    db.prune(1_750_000_000_000, 20_000);

    expect(db.load().events.map((item) => item.eventId)).toEqual(['event-2']);
    expect(db.load().cursors).toHaveLength(1);
    db.close();
  });

  it('restores v1 click-resolved tasks as viewed but unresolved', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aside-activity-v1-'));
    tempDirs.push(root);
    const location = path.join(root, 'activity.sqlite');
    const legacy = new DatabaseSync(location);
    legacy.exec(`
      CREATE TABLE activity_threads (
        thread_key TEXT PRIMARY KEY,
        baseline_at_ms INTEGER NOT NULL,
        viewed_through_seq INTEGER NOT NULL,
        resolved_through_seq INTEGER NOT NULL
      );
      INSERT INTO activity_threads VALUES ('codex:legacy', 100, 42, 42);
      PRAGMA user_version = 1;
    `);
    legacy.close();

    const migrated = new ActivityDatabase(location);
    migrated.close();
    const check = new DatabaseSync(location);
    expect(check.prepare('PRAGMA user_version').get()?.['user_version']).toBe(2);
    expect(
      check
        .prepare(
          'SELECT viewed_through_seq, resolved_through_seq FROM activity_threads',
        )
        .get(),
    ).toEqual({
      viewed_through_seq: 42,
      resolved_through_seq: 0,
    });
    check.close();
  });
});
