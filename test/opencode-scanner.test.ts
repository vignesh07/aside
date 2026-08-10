import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  disposeOpenCodeScanner,
  resolveOpenCodeDataDir,
  scanOpenCodeSessions,
  scanOpenCodeSessionsWithStatus,
} from '../src/core/opencode-scanner.js';
import { scanAllSessions } from '../src/core/session-scanner.js';

const roots: string[] = [];
const NOW = Date.parse('2026-08-09T20:00:00.000Z');

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aside-opencode-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  disposeOpenCodeScanner();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('OpenCode SQLite discovery', () => {
  it('can leave OpenCode discovery to an out-of-process coordinator', () => {
    const result = scanAllSessions(
      { source: 'opencode' },
      { includeOpenCode: false },
    );
    expect(result.sessions).toEqual([]);
    expect(result.jsonlPaths.size).toBe(0);
    expect(result.authoritativeSources.has('opencode')).toBe(false);
  });

  it('uses XDG_DATA_HOME for the default OpenCode database and legacy store', () => {
    const root = tempRoot();
    const xdgData = path.join(root, 'xdg-data');
    const openCodeDir = path.join(xdgData, 'opencode');
    const databasePath = path.join(openCodeDir, 'opencode.db');
    const cacheDir = path.join(root, 'cache');
    fs.mkdirSync(openCodeDir, { recursive: true });
    const db = createDatabase(databasePath);
    insertSession(db, {
      id: 'ses_xdg',
      directory: '/Users/test/xdg-project',
      title: 'XDG session',
      updated: NOW - 1_000,
    });
    db.close();

    const env = {
      HOME: path.join(root, 'home'),
      XDG_DATA_HOME: xdgData,
    };
    expect(resolveOpenCodeDataDir(env)).toBe(openCodeDir);
    expect(scanOpenCodeSessions({ env, cacheDir, nowMs: NOW })).toMatchObject([
      { session: { id: 'ses_xdg', source: 'opencode' } },
    ]);
  });

  it('projects root and child sessions without writing the source database', () => {
    const root = tempRoot();
    const databasePath = path.join(root, 'opencode.db');
    const cacheDir = path.join(root, 'cache');
    const db = createDatabase(databasePath);
    insertSession(db, {
      id: 'ses_root',
      directory: '/Users/test/acme',
      title: 'New session - 2026-08-09',
      updated: NOW - 10_000,
      model: { providerID: 'openai', id: 'gpt-5.4' },
    });
    insertSession(db, {
      id: 'ses_child',
      parentId: 'ses_root',
      directory: '/Users/test/acme',
      title: 'Investigate tests',
      updated: NOW - 20_000,
    });
    insertMessage(db, {
      id: 'msg_user',
      sessionId: 'ses_root',
      created: NOW - 9_000,
      data: {
        role: 'user',
        time: { created: NOW - 9_000 },
        model: { providerID: 'openai', modelID: 'gpt-5.4' },
      },
    });
    insertPart(db, {
      id: 'prt_user',
      messageId: 'msg_user',
      sessionId: 'ses_root',
      created: NOW - 9_000,
      data: { type: 'text', text: 'Fix the launch blocker' },
    });
    insertMessage(db, {
      id: 'msg_assistant',
      sessionId: 'ses_root',
      created: NOW - 8_000,
      data: {
        role: 'assistant',
        time: { created: NOW - 8_000, completed: NOW - 2_000 },
        providerID: 'openai',
        modelID: 'gpt-5.4',
        finish: 'stop',
        tokens: {
          input: 120,
          output: 30,
          reasoning: 8,
          cache: { read: 12, write: 3 },
        },
      },
    });
    insertPart(db, {
      id: 'prt_answer',
      messageId: 'msg_assistant',
      sessionId: 'ses_root',
      created: NOW - 7_000,
      data: { type: 'text', text: 'The release blocker is fixed.' },
    });
    insertPart(db, {
      id: 'prt_tool',
      messageId: 'msg_assistant',
      sessionId: 'ses_root',
      created: NOW - 6_000,
      data: {
        type: 'tool',
        callID: 'call_1',
        tool: 'bash',
        state: {
          status: 'completed',
          input: { command: 'npm test' },
          title: 'Run tests',
          output: 'DO_NOT_COPY_SUCCESSFUL_TOOL_OUTPUT',
          metadata: {},
          time: { start: NOW - 6_000, end: NOW - 3_000 },
        },
      },
    });
    db.close();

    const before = sourceFingerprint(databasePath);
    const rootsOnly = scanOpenCodeSessions({
      databasePath,
      legacyStorageDir: path.join(root, 'missing-storage'),
      cacheDir,
      nowMs: NOW,
    });
    const after = sourceFingerprint(databasePath);

    expect(rootsOnly).toHaveLength(1);
    expect(rootsOnly[0]!.session).toMatchObject({
      id: 'ses_root',
      source: 'opencode',
      isInternal: false,
      projectName: 'acme',
      title: 'Fix the launch blocker',
      model: 'openai/gpt-5.4',
      status: 'active',
    });
    expect(before).toBe(after);

    const snapshot = fs.readFileSync(rootsOnly[0]!.jsonlPath, 'utf8');
    expect(snapshot).toContain('Fix the launch blocker');
    expect(snapshot).toContain('The release blocker is fixed.');
    expect(snapshot).toContain('npm test');
    expect(snapshot).toContain('"type":"usage"');
    expect(snapshot).toContain('"type":"turn"');
    expect(snapshot).not.toContain('DO_NOT_COPY_SUCCESSFUL_TOOL_OUTPUT');
    expect(fs.statSync(rootsOnly[0]!.jsonlPath).mode & 0o777).toBe(0o600);

    const withChildren = scanOpenCodeSessions({
      databasePath,
      cacheDir,
      nowMs: NOW,
      includeInternal: true,
    });
    expect(withChildren.map(({ session }) => session.id).sort()).toEqual([
      'ses_child',
      'ses_root',
    ]);
    expect(withChildren.find(({ session }) => session.id === 'ses_child')?.session)
      .toMatchObject({ isInternal: true, parentSessionId: 'ses_root' });
  });

  it('reads committed WAL content while the OpenCode writer remains open', () => {
    const root = tempRoot();
    const databasePath = path.join(root, 'opencode.db');
    const db = createDatabase(databasePath);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0');
    insertSession(db, {
      id: 'ses_wal',
      directory: '/Users/test/wal-project',
      title: 'WAL session',
      updated: NOW - 1_000,
    });
    insertMessage(db, {
      id: 'msg_wal',
      sessionId: 'ses_wal',
      created: NOW - 1_000,
      data: { role: 'user', time: { created: NOW - 1_000 } },
    });
    insertPart(db, {
      id: 'prt_wal',
      messageId: 'msg_wal',
      sessionId: 'ses_wal',
      created: NOW - 1_000,
      data: { type: 'text', text: 'Visible before checkpoint' },
    });

    const databaseBefore = sourceFingerprint(databasePath);
    const result = scanOpenCodeSessions({
      databasePath,
      cacheDir: path.join(root, 'cache'),
      nowMs: NOW,
    });
    expect(result).toHaveLength(1);
    expect(fs.readFileSync(result[0]!.jsonlPath, 'utf8'))
      .toContain('Visible before checkpoint');
    expect(sourceFingerprint(databasePath)).toBe(databaseBefore);
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM session').get(),
    ).toMatchObject({ count: 1 });
    db.close();
  });

  it('refreshes historical WAL projections without a session or main-file change', async () => {
    const root = tempRoot();
    const databasePath = path.join(root, 'opencode.db');
    const cacheDir = path.join(root, 'cache');
    const db = createDatabase(databasePath);
    const historicalCreated = NOW - 3 * 24 * 60 * 60_000;
    db.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0');
    insertSession(db, {
      id: 'ses_streaming_wal',
      directory: '/Users/test/streaming-wal',
      title: 'Streaming WAL session',
      updated: historicalCreated,
    });
    insertMessage(db, {
      id: 'msg_streaming_wal',
      sessionId: 'ses_streaming_wal',
      created: historicalCreated,
      data: { role: 'assistant', time: { created: historicalCreated } },
    });
    insertPart(db, {
      id: 'prt_streaming_wal',
      messageId: 'msg_streaming_wal',
      sessionId: 'ses_streaming_wal',
      created: historicalCreated,
      data: { type: 'text', text: 'First' },
    });

    const [initial] = scanOpenCodeSessions({ databasePath, cacheDir, nowMs: NOW });
    await eventually(() => fs.existsSync(initial!.jsonlPath), 3_000);
    const databaseBefore = sourceFingerprint(databasePath);
    const sessionUpdatedBefore = db.prepare(
      'SELECT time_updated FROM session WHERE id = ?',
    ).get('ses_streaming_wal');

    db.prepare('UPDATE part SET data = ?, time_updated = ? WHERE id = ?').run(
      JSON.stringify({ type: 'text', text: 'First response' }),
      NOW - 2 * 24 * 60 * 60_000,
      'prt_streaming_wal',
    );
    expect(sourceFingerprint(databasePath)).toBe(databaseBefore);
    expect(db.prepare('SELECT time_updated FROM session WHERE id = ?').get(
      'ses_streaming_wal',
    )).toEqual(sessionUpdatedBefore);

    scanOpenCodeSessions({ databasePath, cacheDir, nowMs: NOW + 2_000 });
    expect(fs.readFileSync(initial!.jsonlPath, 'utf8')).toContain(' response');

    db.prepare('DELETE FROM part WHERE id = ?').run('prt_streaming_wal');
    expect(sourceFingerprint(databasePath)).toBe(databaseBefore);
    scanOpenCodeSessions({ databasePath, cacheDir, nowMs: NOW + 3_000 });
    expect(fs.readFileSync(initial!.jsonlPath, 'utf8'))
      .not.toContain('First response');
    db.close();
  });

  it('handles unsafe timestamp aggregates and equal-length content edits in bounded pages', async () => {
    const root = tempRoot();
    const databasePath = path.join(root, 'opencode.db');
    const cacheDir = path.join(root, 'cache');
    const db = createDatabase(databasePath);
    const created = NOW - 3 * 24 * 60 * 60_000;
    insertSession(db, {
      id: 'ses_large_revision',
      directory: '/Users/test/large-revision',
      title: 'Large exact revision',
      updated: created,
    });
    insertMessage(db, {
      id: 'msg_large_revision',
      sessionId: 'ses_large_revision',
      created,
      data: { role: 'assistant', time: { created } },
    });
    const insert = db.prepare(
      `INSERT INTO part(
         id, message_id, session_id, time_created, time_updated, data
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    db.exec('BEGIN');
    for (let index = 0; index < 6_100; index += 1) {
      insert.run(
        `prt_large_revision_${String(index).padStart(5, '0')}`,
        'msg_large_revision',
        'ses_large_revision',
        created + index,
        created + index,
        JSON.stringify({
          type: 'text',
          text: index === 123 ? 'OLD_SENTINEL_A' : `large row ${index}`,
        }),
      );
    }
    db.exec('COMMIT');
    const aggregate = db.prepare(
      `SELECT CAST(SUM(time_updated) AS TEXT) AS total
       FROM part WHERE session_id = ?`,
    ).get('ses_large_revision') as { total: string };
    expect(BigInt(aggregate.total)).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
    db.close();

    const [initial] = scanOpenCodeSessions({ databasePath, cacheDir, nowMs: NOW });
    expect(initial).toBeDefined();
    await new Promise<void>((resolve) => setImmediate(resolve));
    // More than one row-bounded scheduler turn is required, so unrelated work
    // gets a chance to run before the canonical snapshot is published.
    expect(fs.existsSync(initial!.jsonlPath)).toBe(false);
    await eventually(
      () => fs.existsSync(initial!.jsonlPath) &&
        fs.readFileSync(initial!.jsonlPath, 'utf8').includes('large row 6099'),
      5_000,
    );
    expect(fs.readFileSync(initial!.jsonlPath, 'utf8')).toContain('OLD_SENTINEL_A');

    const update = new DatabaseSync(databasePath);
    const timestampBefore = update.prepare(
      'SELECT time_updated FROM part WHERE id = ?',
    ).get('prt_large_revision_00123');
    update.prepare('UPDATE part SET data = ? WHERE id = ?').run(
      JSON.stringify({ type: 'text', text: 'NEW_SENTINEL_B' }),
      'prt_large_revision_00123',
    );
    expect(update.prepare(
      'SELECT time_updated FROM part WHERE id = ?',
    ).get('prt_large_revision_00123')).toEqual(timestampBefore);
    update.close();

    scanOpenCodeSessions({ databasePath, cacheDir, nowMs: NOW + 1_000 });
    // The stale large projection is replaced by a safe header before its
    // bounded rebuild begins.
    expect(fs.readFileSync(initial!.jsonlPath, 'utf8'))
      .not.toContain('OLD_SENTINEL_A');
    await eventually(
      () => fs.readFileSync(initial!.jsonlPath, 'utf8').includes('NEW_SENTINEL_B'),
      5_000,
    );
    const rebuilt = fs.readFileSync(initial!.jsonlPath, 'utf8');
    expect(rebuilt).not.toContain('OLD_SENTINEL_A');
    expect(rebuilt).toContain('large row 6099');
  }, 15_000);

  it('keeps recent context visible while an active large session rebuilds', async () => {
    const root = tempRoot();
    const databasePath = path.join(root, 'opencode.db');
    const cacheDir = path.join(root, 'cache');
    const db = createDatabase(databasePath);
    db.exec('PRAGMA journal_mode = WAL');
    insertSession(db, {
      id: 'ses_streaming_large',
      directory: '/Users/test/streaming-large',
      title: 'Streaming large session',
      updated: NOW - 1_000,
    });
    insertMessage(db, {
      id: 'msg_streaming_large',
      sessionId: 'ses_streaming_large',
      created: NOW - 2_000,
      data: { role: 'assistant', time: { created: NOW - 2_000 } },
    });
    const insert = db.prepare(
      `INSERT INTO part(
         id, message_id, session_id, time_created, time_updated, data
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    db.exec('BEGIN');
    for (let index = 0; index < 2_000; index += 1) {
      insert.run(
        `prt_streaming_large_${String(index).padStart(5, '0')}`,
        'msg_streaming_large',
        'ses_streaming_large',
        NOW - 2_000 + index,
        NOW - 2_000 + index,
        JSON.stringify({ type: 'text', text: `streaming row ${index}` }),
      );
    }
    db.exec('COMMIT');

    const [session] = scanOpenCodeSessions({ databasePath, cacheDir, nowMs: NOW });
    const partial = fs.readFileSync(session!.jsonlPath, 'utf8');
    expect(partial).toContain('"projectionState":"partial"');
    expect(partial).toContain('streaming row 1999');
    expect(partial).not.toContain('streaming row 0"');

    // Let the worker pin its first page, then mutate the live WAL. The old
    // multi-page snapshot must never publish over the newer source revision;
    // the coordinator retries from a new stable view instead.
    await new Promise<void>((resolve) => setImmediate(resolve));
    db.prepare('UPDATE part SET data = ? WHERE id = ?').run(
      JSON.stringify({ type: 'text', text: 'LATEST_STREAMING_CONTEXT' }),
      'prt_streaming_large_01999',
    );
    await eventually(
      () => {
        const text = fs.readFileSync(session!.jsonlPath, 'utf8');
        return text.includes('LATEST_STREAMING_CONTEXT') &&
          !text.includes('"projectionState":"partial"');
      },
      5_000,
    );
    db.close();
  }, 10_000);

  it('atomically rewrites monotonic text and leaves an unchanged cache alone', () => {
    const root = tempRoot();
    const databasePath = path.join(root, 'opencode.db');
    const cacheDir = path.join(root, 'cache');
    const db = createDatabase(databasePath);
    insertSession(db, {
      id: 'ses_live',
      directory: '/Users/test/live',
      title: 'Live response',
      updated: NOW - 2_000,
    });
    insertMessage(db, {
      id: 'msg_live',
      sessionId: 'ses_live',
      created: NOW - 2_000,
      data: {
        role: 'assistant',
        time: { created: NOW - 2_000 },
        providerID: 'anthropic',
        modelID: 'claude-sonnet-4-5',
      },
    });
    insertPart(db, {
      id: 'prt_live',
      messageId: 'msg_live',
      sessionId: 'ses_live',
      created: NOW - 2_000,
      data: { type: 'text', text: 'Hello' },
    });
    db.close();

    const first = scanOpenCodeSessions({ databasePath, cacheDir, nowMs: NOW });
    const snapshotPath = first[0]!.jsonlPath;
    const firstStat = fs.statSync(snapshotPath);

    const update = new DatabaseSync(databasePath);
    update.prepare('UPDATE part SET data = ?, time_updated = ? WHERE id = ?').run(
      JSON.stringify({ type: 'text', text: 'Hello world' }),
      NOW + 1_000,
      'prt_live',
    );
    update.prepare('UPDATE session SET time_updated = ? WHERE id = ?').run(
      NOW + 1_000,
      'ses_live',
    );
    update.close();

    scanOpenCodeSessions({ databasePath, cacheDir, nowMs: NOW + 2_000 });
    const secondStat = fs.statSync(snapshotPath);
    const records = jsonl(snapshotPath);
    const text = records.filter((record) => record['type'] === 'text');
    expect(secondStat.ino).not.toBe(firstStat.ino);
    expect(text).toHaveLength(1);
    expect(text[0]).toMatchObject({ update: 'replace', text: 'Hello world' });

    const stableStat = fs.statSync(snapshotPath);
    scanOpenCodeSessions({ databasePath, cacheDir, nowMs: NOW + 3_000 });
    expect(fs.statSync(snapshotPath).size).toBe(stableStat.size);
    expect(fs.statSync(snapshotPath).mtimeMs).toBe(stableStat.mtimeMs);
  });

  it('atomically removes deleted or non-monotonic content from the cache', () => {
    const root = tempRoot();
    const databasePath = path.join(root, 'opencode.db');
    const cacheDir = path.join(root, 'cache');
    const db = createDatabase(databasePath);
    insertSession(db, {
      id: 'ses_delete',
      directory: '/Users/test/delete',
      title: 'Delete old content',
      updated: NOW - 3_000,
    });
    insertMessage(db, {
      id: 'msg_delete',
      sessionId: 'ses_delete',
      created: NOW - 3_000,
      data: { role: 'user', time: { created: NOW - 3_000 } },
    });
    insertPart(db, {
      id: 'prt_delete',
      messageId: 'msg_delete',
      sessionId: 'ses_delete',
      created: NOW - 3_000,
      data: { type: 'text', text: 'private text that is removed' },
    });
    db.close();

    const [initial] = scanOpenCodeSessions({ databasePath, cacheDir, nowMs: NOW });
    const oldInode = fs.statSync(initial!.jsonlPath).ino;
    const update = new DatabaseSync(databasePath);
    update.prepare('DELETE FROM part WHERE id = ?').run('prt_delete');
    update.prepare('UPDATE session SET time_updated = ? WHERE id = ?').run(
      NOW + 1_000,
      'ses_delete',
    );
    update.close();

    scanOpenCodeSessions({ databasePath, cacheDir, nowMs: NOW + 2_000 });
    expect(fs.statSync(initial!.jsonlPath).ino).not.toBe(oldInode);
    expect(fs.readFileSync(initial!.jsonlPath, 'utf8'))
      .not.toContain('private text that is removed');

    const removeSession = new DatabaseSync(databasePath);
    removeSession.prepare('DELETE FROM message WHERE session_id = ?').run('ses_delete');
    removeSession.prepare('DELETE FROM session WHERE id = ?').run('ses_delete');
    removeSession.close();
    expect(scanOpenCodeSessions({
      databasePath,
      legacyStorageDir: path.join(root, 'missing-storage'),
      cacheDir,
      nowMs: NOW + 3_000,
    })).toEqual([]);
    expect(fs.existsSync(initial!.jsonlPath)).toBe(false);
  });

  it('fails closed when a changed projection cannot publish its manifest', () => {
    const root = tempRoot();
    const databasePath = path.join(root, 'opencode.db');
    const cacheDir = path.join(root, 'cache');
    const db = createDatabase(databasePath);
    insertSession(db, {
      id: 'ses_failed_refresh',
      directory: '/Users/test/failed-refresh',
      title: 'Failed refresh',
      updated: NOW,
    });
    insertMessage(db, {
      id: 'msg_failed_refresh',
      sessionId: 'ses_failed_refresh',
      created: NOW,
      data: { role: 'user', time: { created: NOW } },
    });
    insertPart(db, {
      id: 'prt_failed_refresh',
      messageId: 'msg_failed_refresh',
      sessionId: 'ses_failed_refresh',
      created: NOW,
      data: { type: 'text', text: 'OLD_PRIVATE_SENTINEL' },
    });
    db.close();

    const [initial] = scanOpenCodeSessions({ databasePath, cacheDir, nowMs: NOW });
    const namespace = path.dirname(initial!.jsonlPath);
    const manifestPath = fs.readdirSync(namespace)
      .filter((name) => name.endsWith('.state.json'))
      .map((name) => path.join(namespace, name))[0]!;
    const update = new DatabaseSync(databasePath);
    update.prepare('UPDATE part SET data = ?, time_updated = ? WHERE id = ?').run(
      JSON.stringify({ type: 'text', text: 'NEW_PRIVATE_SENTINEL' }),
      NOW + 1_000,
      'prt_failed_refresh',
    );
    update.close();
    fs.unlinkSync(manifestPath);
    fs.mkdirSync(manifestPath);

    const [failed] = scanOpenCodeSessions({
      databasePath,
      cacheDir,
      nowMs: NOW + 2_000,
    });
    expect(failed).toBeDefined();
    const safeProjection = fs.readFileSync(initial!.jsonlPath, 'utf8');
    expect(safeProjection).not.toContain('OLD_PRIVATE_SENTINEL');
    expect(safeProjection).not.toContain('NEW_PRIVATE_SENTINEL');
    expect(jsonl(initial!.jsonlPath)).toHaveLength(1);

    fs.rmdirSync(manifestPath);
    scanOpenCodeSessions({ databasePath, cacheDir, nowMs: NOW + 3_000 });
    expect(fs.readFileSync(initial!.jsonlPath, 'utf8'))
      .toContain('NEW_PRIVATE_SENTINEL');
  });

  it('does not follow cache-root, snapshot, or manifest symlinks', () => {
    const root = tempRoot();
    const databasePath = path.join(root, 'opencode.db');
    const db = createDatabase(databasePath);
    insertSession(db, {
      id: 'ses_symlink',
      directory: '/Users/test/symlink',
      title: 'Symlink safety',
      updated: NOW - 2_000,
    });
    insertMessage(db, {
      id: 'msg_symlink',
      sessionId: 'ses_symlink',
      created: NOW - 2_000,
      data: { role: 'assistant', time: { created: NOW - 2_000 } },
    });
    insertPart(db, {
      id: 'prt_symlink',
      messageId: 'msg_symlink',
      sessionId: 'ses_symlink',
      created: NOW - 2_000,
      data: { type: 'text', text: 'Safe' },
    });
    db.close();

    const victimRoot = path.join(root, 'victim-root');
    fs.mkdirSync(victimRoot);
    const linkedCache = path.join(root, 'linked-cache');
    fs.symlinkSync(victimRoot, linkedCache);
    expect(scanOpenCodeSessionsWithStatus({
      databasePath,
      cacheDir: linkedCache,
      nowMs: NOW,
    })).toEqual({ sessions: [], authoritative: false });
    expect(fs.readdirSync(victimRoot)).toEqual([]);

    const cacheDir = path.join(root, 'cache');
    const [initial] = scanOpenCodeSessions({ databasePath, cacheDir, nowMs: NOW });
    const snapshotPath = initial!.jsonlPath;
    const namespace = path.dirname(snapshotPath);
    const manifestPath = fs.readdirSync(namespace)
      .filter((name) => name.endsWith('.state.json'))
      .map((name) => path.join(namespace, name))[0]!;
    expect(fs.statSync(cacheDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(namespace).mode & 0o777).toBe(0o700);
    expect(fs.statSync(snapshotPath).mode & 0o777).toBe(0o600);
    expect(
      fs.statSync(path.join(namespace, '.modern-catalog.json')).mode & 0o777,
    ).toBe(0o600);

    const snapshotVictim = path.join(root, 'snapshot-victim.txt');
    fs.writeFileSync(snapshotVictim, 'DO NOT APPEND');
    fs.unlinkSync(snapshotPath);
    fs.symlinkSync(snapshotVictim, snapshotPath);
    const update = new DatabaseSync(databasePath);
    update.prepare('UPDATE part SET data = ?, time_updated = ? WHERE id = ?').run(
      JSON.stringify({ type: 'text', text: 'Safe append' }),
      NOW + 1_000,
      'prt_symlink',
    );
    update.close();
    scanOpenCodeSessions({ databasePath, cacheDir, nowMs: NOW + 2_000 });
    expect(fs.readFileSync(snapshotVictim, 'utf8')).toBe('DO NOT APPEND');
    expect(fs.lstatSync(snapshotPath).isSymbolicLink()).toBe(false);

    const manifestVictim = path.join(root, 'manifest-victim.json');
    fs.writeFileSync(manifestVictim, '{"forged":true}\n');
    fs.unlinkSync(manifestPath);
    fs.symlinkSync(manifestVictim, manifestPath);
    scanOpenCodeSessions({ databasePath, cacheDir, nowMs: NOW + 3_000 });
    expect(fs.readFileSync(manifestVictim, 'utf8')).toBe('{"forged":true}\n');
    expect(fs.lstatSync(manifestPath).isSymbolicLink()).toBe(false);
  });

  it('rejects symlinked cache ancestors without falling back to stale legacy data', () => {
    const root = tempRoot();
    const databasePath = path.join(root, 'opencode.db');
    const db = createDatabase(databasePath);
    insertSession(db, {
      id: 'ses_modern_authority',
      directory: '/Users/test/modern',
      title: 'Modern authority',
      updated: NOW,
    });
    db.close();
    const legacyStorageDir = path.join(root, 'storage');
    writeJson(path.join(
      legacyStorageDir,
      'session',
      'stale',
      'ses_stale_legacy.json',
    ), {
      id: 'ses_stale_legacy',
      directory: '/Users/test/stale',
      title: 'LEGACY_STALE_SENTINEL',
      time: { created: NOW, updated: NOW },
    });

    const victim = path.join(root, 'cache-victim');
    fs.mkdirSync(victim);
    const linkedParent = path.join(root, 'linked-cache-parent');
    fs.symlinkSync(victim, linkedParent);
    expect(scanOpenCodeSessions({
      databasePath,
      legacyStorageDir,
      cacheDir: path.join(linkedParent, 'nested-cache'),
      nowMs: NOW,
    })).toEqual([]);
    expect(fs.readdirSync(victim)).toEqual([]);

    const locked = new DatabaseSync(databasePath);
    locked.exec('BEGIN EXCLUSIVE');
    const duringLock = scanOpenCodeSessions({
      databasePath,
      legacyStorageDir,
      cacheDir: path.join(root, 'safe-cache'),
      nowMs: NOW,
    });
    expect(duringLock.find(({ session }) => session.id === 'ses_stale_legacy'))
      .toBeUndefined();
    locked.exec('ROLLBACK');
    locked.close();
  });

  it('does not resurrect legacy storage when a recognized modern database disappears', () => {
    const root = tempRoot();
    const databasePath = path.join(root, 'opencode.db');
    const cacheDir = path.join(root, 'cache');
    const legacyStorageDir = path.join(root, 'storage');
    const db = createDatabase(databasePath);
    insertSession(db, {
      id: 'ses_modern_then_missing',
      directory: '/Users/test/modern',
      title: 'Modern catalog',
      updated: NOW,
    });
    db.close();
    writeJson(path.join(
      legacyStorageDir,
      'session',
      'stale',
      'ses_stale_after_modern.json',
    ), {
      id: 'ses_stale_after_modern',
      directory: '/Users/test/stale',
      title: 'STALE_LEGACY_SHOULD_NOT_RETURN',
      time: { created: NOW, updated: NOW },
    });

    expect(scanOpenCodeSessionsWithStatus({
      databasePath,
      legacyStorageDir,
      cacheDir,
      nowMs: NOW,
    })).toMatchObject({
      authoritative: true,
      sessions: [{ session: { id: 'ses_modern_then_missing' } }],
    });

    fs.unlinkSync(databasePath);
    const missing = scanOpenCodeInFreshProcess({
      databasePath,
      legacyStorageDir,
      cacheDir,
      nowMs: NOW + 1_000,
    });
    expect(missing).toEqual({ sessionIds: [], authoritative: false });
  });

  it('bounds SQLite metadata before returning or projecting it', () => {
    const root = tempRoot();
    const databasePath = path.join(root, 'opencode.db');
    const db = createDatabase(databasePath);
    insertSession(db, {
      id: 'ses_bounded_metadata',
      parentId: `ses_${'p'.repeat(300)}`,
      directory: `${'d'.repeat(5_000)}DIRECTORY_TAIL_SENTINEL`,
      title: `${'t'.repeat(70_000)}TITLE_TAIL_SENTINEL`,
      updated: NOW,
      model: {
        providerID: `${'p'.repeat(2_000)}PROVIDER_TAIL_SENTINEL`,
        id: `${'m'.repeat(2_000)}MODEL_TAIL_SENTINEL`,
        ignored: 'x'.repeat(100_000),
      },
    });
    db.prepare('UPDATE session SET version = ? WHERE id = ?').run(
      `${'v'.repeat(2_000)}VERSION_TAIL_SENTINEL`,
      'ses_bounded_metadata',
    );
    db.close();

    const [result] = scanOpenCodeSessions({
      databasePath,
      cacheDir: path.join(root, 'cache'),
      nowMs: NOW,
      includeInternal: true,
    });
    expect(result).toBeDefined();
    expect(Array.from(result!.session.cwd)).toHaveLength(4_096);
    expect(Array.from(result!.session.version)).toHaveLength(1_024);
    expect(result!.session.parentSessionId).toBeUndefined();
    expect(result!.session.model).not.toContain('PROVIDER_TAIL_SENTINEL');
    expect(result!.session.model).not.toContain('MODEL_TAIL_SENTINEL');
    const header = fs.readFileSync(result!.jsonlPath, 'utf8');
    expect(header).not.toContain('DIRECTORY_TAIL_SENTINEL');
    expect(header).not.toContain('TITLE_TAIL_SENTINEL');
    expect(header).not.toContain('VERSION_TAIL_SENTINEL');
    expect(header.length).toBeLessThan(80_000);
  });

  it('keeps oversized SQLite tool input valid and bounded by projected fields', () => {
    const root = tempRoot();
    const databasePath = path.join(root, 'opencode.db');
    const db = createDatabase(databasePath);
    insertSession(db, {
      id: 'ses_bounded',
      directory: '/Users/test/bounded',
      title: 'Bound input',
      updated: NOW,
    });
    insertMessage(db, {
      id: 'msg_bounded',
      sessionId: 'ses_bounded',
      created: NOW,
      data: { role: 'assistant', time: { created: NOW } },
    });
    insertPart(db, {
      id: 'prt_bounded',
      messageId: 'msg_bounded',
      sessionId: 'ses_bounded',
      created: NOW,
      data: {
        type: 'tool',
        tool: 'bash',
        state: {
          status: 'running',
          input: {
            command: '🧪'.repeat(20_000),
            ignoredSecretBlob: 'do-not-project'.repeat(20_000),
          },
        },
      },
    });
    db.close();

    const [result] = scanOpenCodeSessions({
      databasePath,
      cacheDir: path.join(root, 'cache'),
      nowMs: NOW,
    });
    const tool = jsonl(result!.jsonlPath).find((record) => record['type'] === 'tool')!;
    const input = tool['input'] as Record<string, unknown>;
    expect(Array.from(String(input['command']))).toHaveLength(4_096);
    expect(String(input['command']).endsWith('🧪')).toBe(true);
    expect(input).not.toHaveProperty('ignoredSecretBlob');
    expect(JSON.stringify(input).length).toBeLessThanOrEqual(64 * 1024);
  });

  it('tolerates missing, malformed, and drifting database schemas', () => {
    const root = tempRoot();
    const missing = scanOpenCodeSessions({
      databasePath: path.join(root, 'missing.db'),
      legacyStorageDir: path.join(root, 'missing-storage'),
      cacheDir: path.join(root, 'cache-a'),
    });
    expect(missing).toEqual([]);

    const malformedPath = path.join(root, 'malformed.db');
    fs.writeFileSync(malformedPath, 'not sqlite');
    expect(scanOpenCodeSessions({
      databasePath: malformedPath,
      legacyStorageDir: path.join(root, 'missing-storage'),
      cacheDir: path.join(root, 'cache-b'),
    })).toEqual([]);

    const driftedPath = path.join(root, 'drifted.db');
    const drifted = new DatabaseSync(driftedPath);
    drifted.exec('CREATE TABLE session(id TEXT PRIMARY KEY, directory TEXT)');
    drifted.close();
    expect(scanOpenCodeSessions({
      databasePath: driftedPath,
      legacyStorageDir: path.join(root, 'missing-storage'),
      cacheDir: path.join(root, 'cache-c'),
    })).toEqual([]);

    const lockedPath = path.join(root, 'locked.db');
    const locked = createDatabase(lockedPath);
    insertSession(locked, {
      id: 'ses_locked',
      directory: '/Users/test/locked',
      title: 'Locked session',
      updated: NOW,
    });
    locked.exec('BEGIN EXCLUSIVE');
    expect(() => scanOpenCodeSessions({
      databasePath: lockedPath,
      legacyStorageDir: path.join(root, 'missing-storage'),
      cacheDir: path.join(root, 'cache-d'),
      nowMs: NOW,
    })).not.toThrow();
    locked.exec('ROLLBACK');
    locked.close();
  });

  it('projects every historical transcript across bounded event-loop batches', async () => {
    const root = tempRoot();
    const databasePath = path.join(root, 'opencode.db');
    const cacheDir = path.join(root, 'cache');
    const db = createDatabase(databasePath);
    db.exec('BEGIN');
    for (let index = 0; index < 17; index += 1) {
      const sessionId = `ses_deferred_${index}`;
      const messageId = `msg_deferred_${index}`;
      insertSession(db, {
        id: sessionId,
        directory: '/Users/test/deferred',
        title: `Deferred ${index}`,
        updated: NOW - 86_400_000 - index,
      });
      insertMessage(db, {
        id: messageId,
        sessionId,
        created: NOW - 86_400_000 - index,
        data: { role: 'assistant', time: { created: NOW - 86_400_000 - index } },
      });
      for (let partIndex = 0; partIndex < 20; partIndex += 1) {
        insertPart(db, {
          id: `prt_deferred_${index}_${partIndex}`,
          messageId,
          sessionId,
          created: NOW - 86_400_000 - index + partIndex,
          data: { type: 'text', text: `session ${index} part ${partIndex}` },
        });
      }
    }
    db.exec('COMMIT');
    db.close();

    const sessions = scanOpenCodeSessions({ databasePath, cacheDir, nowMs: NOW });
    expect(sessions).toHaveLength(17);
    expect(sessions.every(({ jsonlPath }) => fs.existsSync(jsonlPath))).toBe(false);
    await eventually(
      () => sessions.every(({ jsonlPath }) => fs.existsSync(jsonlPath)),
      3_000,
    );
    for (const { jsonlPath } of sessions) {
      expect(fs.readFileSync(jsonlPath, 'utf8')).toContain('part 19');
    }
  });

  it('prunes dead projection temps without touching a live worker or recent legacy temp', () => {
    const root = tempRoot();
    const databasePath = path.join(root, 'opencode.db');
    const cacheDir = path.join(root, 'cache');
    const db = createDatabase(databasePath);
    insertSession(db, {
      id: 'ses_temp_cleanup',
      directory: '/Users/test/temp-cleanup',
      title: 'Temp cleanup',
      updated: NOW - 86_400_000,
    });
    db.close();
    scanOpenCodeSessions({ databasePath, cacheDir, nowMs: NOW });

    const namespace = fs.readdirSync(cacheDir)
      .map((entry) => path.join(cacheDir, entry))
      .find((entry) => path.basename(entry).startsWith('sqlite-'))!;
    const dead = path.join(
      namespace,
      '.ses-dead.jsonl.99999999.00000000-0000-4000-8000-000000000001.projection.tmp',
    );
    const live = path.join(
      namespace,
      `.ses-live.jsonl.${process.ppid}.00000000-0000-4000-8000-000000000002.projection.tmp`,
    );
    const recentLegacy = path.join(
      namespace,
      '.ses-recent.jsonl.00000000-0000-4000-8000-000000000003.projection.tmp',
    );
    const oldLegacy = path.join(
      namespace,
      '.ses-old.jsonl.00000000-0000-4000-8000-000000000004.projection.tmp',
    );
    const deadWrite = path.join(
      namespace,
      '.ses-dead.state.json.99999999.00000000-0000-4000-8000-000000000005.00000000-0000-4000-8000-000000000006.cache.tmp',
    );
    const oldLegacyWrite = path.join(
      namespace,
      '.ses-old.state.json.00000000-0000-4000-8000-000000000007.tmp',
    );
    for (const file of [
      dead,
      live,
      recentLegacy,
      oldLegacy,
      deadWrite,
      oldLegacyWrite,
    ]) {
      fs.writeFileSync(file, 'private projected text', { mode: 0o600 });
    }
    const oldSeconds = (NOW - 25 * 60 * 60 * 1_000) / 1_000;
    fs.utimesSync(oldLegacy, oldSeconds, oldSeconds);
    fs.utimesSync(oldLegacyWrite, oldSeconds, oldSeconds);

    scanOpenCodeSessions({ databasePath, cacheDir, nowMs: NOW });
    expect(fs.existsSync(dead)).toBe(false);
    expect(fs.existsSync(oldLegacy)).toBe(false);
    expect(fs.existsSync(deadWrite)).toBe(false);
    expect(fs.existsSync(oldLegacyWrite)).toBe(false);
    expect(fs.existsSync(live)).toBe(true);
    expect(fs.existsSync(recentLegacy)).toBe(true);
  });

  it('keeps a transcript-bearing 1000-session catalog scan bounded', () => {
    const root = tempRoot();
    const databasePath = path.join(root, 'opencode.db');
    const cacheDir = path.join(root, 'cache');
    const db = createDatabase(databasePath);
    const insertBenchmarkMessage = db.prepare(
      `INSERT INTO message(id, session_id, time_created, time_updated, data)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const insertBenchmarkPart = db.prepare(
      `INSERT INTO part(
         id, message_id, session_id, time_created, time_updated, data
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    db.exec('BEGIN');
    for (let index = 0; index < 1_000; index += 1) {
      const sessionId = `ses_scale_${String(index).padStart(4, '0')}`;
      const messageId = `msg_scale_${String(index).padStart(4, '0')}`;
      insertSession(db, {
        id: sessionId,
        directory: `/Users/test/project-${index % 20}`,
        title: `Historical thread ${index}`,
        updated: NOW - 86_400_000 - index,
      });
      insertBenchmarkMessage.run(
        messageId,
        sessionId,
        NOW - 86_400_000 - index,
        NOW - 86_400_000 - index,
        JSON.stringify({ role: 'assistant', time: { created: NOW - 86_400_000 - index } }),
      );
      for (let partIndex = 0; partIndex < 20; partIndex += 1) {
        insertBenchmarkPart.run(
          `prt_scale_${String(index).padStart(4, '0')}_${String(partIndex).padStart(2, '0')}`,
          messageId,
          sessionId,
          NOW - 86_400_000 - index + partIndex,
          NOW - 86_400_000 - index + partIndex,
          JSON.stringify({
            type: 'text',
            text: `Historical transcript ${index}, part ${partIndex}`,
          }),
        );
      }
    }
    db.exec('COMMIT');
    db.close();

    const coldStart = performance.now();
    expect(scanOpenCodeSessions({ databasePath, cacheDir, nowMs: NOW }))
      .toHaveLength(1_000);
    const coldMs = performance.now() - coldStart;
    const warmStart = performance.now();
    expect(scanOpenCodeSessions({ databasePath, cacheDir, nowMs: NOW }))
      .toHaveLength(1_000);
    const warmMs = performance.now() - warmStart;

    if (process.env['ASIDE_OPENCODE_BENCHMARK'] === '1') {
      process.stdout.write(
        `OpenCode 1000-session scan: cold=${coldMs.toFixed(1)}ms warm=${warmMs.toFixed(1)}ms\n`,
      );
    }
    // The catalog is immediate; historical transcript projection continues in
    // small event-loop batches. This catches a regression back to projecting
    // all 20,000 parts synchronously on the UI thread.
    expect(coldMs).toBeLessThan(1_200);
    expect(warmMs).toBeLessThan(3_000);
  }, 20_000);
});

describe('OpenCode legacy JSON discovery', () => {
  it('reads the pre-SQLite session/message/part layout', () => {
    const root = tempRoot();
    const storage = path.join(root, 'storage');
    writeJson(path.join(storage, 'session', 'project-1', 'ses_legacy.json'), {
      id: 'ses_legacy',
      directory: '/Users/test/legacy-project',
      title: 'Legacy work',
      version: '1.0.0',
      time: { created: NOW - 86_400_000, updated: NOW - 86_400_000 },
    });
    writeJson(path.join(storage, 'message', 'ses_legacy', 'msg_legacy.json'), {
      id: 'msg_legacy',
      sessionID: 'ses_legacy',
      role: 'user',
      time: { created: NOW - 86_400_000 },
      model: { providerID: 'google', modelID: 'gemini-2.5-pro' },
    });
    writeJson(path.join(storage, 'part', 'msg_legacy', 'prt_legacy.json'), {
      id: 'prt_legacy',
      sessionID: 'ses_legacy',
      messageID: 'msg_legacy',
      type: 'text',
      text: 'Find this old OpenCode thread',
    });
    writeJson(path.join(storage, 'part', 'msg_legacy', 'prt_legacy_tool.json'), {
      id: 'prt_legacy_tool',
      sessionID: 'ses_legacy',
      messageID: 'msg_legacy',
      type: 'tool',
      tool: 'bash',
      state: {
        status: 'running',
        input: {
          command: '🧪'.repeat(20_000),
          ignoredSecretBlob: 'do-not-project'.repeat(20_000),
        },
      },
    });

    const result = scanOpenCodeSessions({
      databasePath: path.join(root, 'missing.db'),
      legacyStorageDir: storage,
      cacheDir: path.join(root, 'cache'),
      nowMs: NOW,
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.session).toMatchObject({
      id: 'ses_legacy',
      source: 'opencode',
      projectName: 'legacy-project',
      title: 'Legacy work',
      model: 'google/gemini-2.5-pro',
      status: 'history',
    });
    expect(fs.readFileSync(result[0]!.jsonlPath, 'utf8'))
      .toContain('Find this old OpenCode thread');
    const legacyTool = jsonl(result[0]!.jsonlPath)
      .find((record) => record['type'] === 'tool')!;
    const legacyInput = legacyTool['input'] as Record<string, unknown>;
    expect(Array.from(String(legacyInput['command']))).toHaveLength(4_096);
    expect(String(legacyInput['command']).endsWith('🧪')).toBe(true);
    expect(legacyInput).not.toHaveProperty('ignoredSecretBlob');
  });

  it('refreshes equal-size legacy edits even when the source mtime is restored', () => {
    const root = tempRoot();
    const storage = path.join(root, 'storage');
    const partPath = path.join(
      storage,
      'part',
      'msg_legacy_revision',
      'prt_legacy_revision.json',
    );
    writeJson(path.join(storage, 'session', 'project', 'ses_legacy_revision.json'), {
      id: 'ses_legacy_revision',
      directory: '/Users/test/legacy-revision',
      title: 'Legacy revision',
      time: { created: NOW, updated: NOW },
    });
    writeJson(path.join(storage, 'message', 'ses_legacy_revision', 'msg_legacy_revision.json'), {
      id: 'msg_legacy_revision',
      sessionID: 'ses_legacy_revision',
      role: 'assistant',
      time: { created: NOW },
    });
    const part = {
      id: 'prt_legacy_revision',
      sessionID: 'ses_legacy_revision',
      messageID: 'msg_legacy_revision',
      type: 'text',
      text: 'OLD_A',
    };
    writeJson(partPath, part);
    const originalStat = fs.statSync(partPath);
    const options = {
      databasePath: path.join(root, 'missing.db'),
      legacyStorageDir: storage,
      cacheDir: path.join(root, 'cache'),
      nowMs: NOW,
    };

    const [initial] = scanOpenCodeSessions(options);
    expect(fs.readFileSync(initial!.jsonlPath, 'utf8')).toContain('OLD_A');
    writeJson(partPath, { ...part, text: 'NEW_B' });
    fs.utimesSync(
      partPath,
      originalStat.atimeMs / 1_000,
      originalStat.mtimeMs / 1_000,
    );

    const [updated] = scanOpenCodeSessions(options);
    const projection = fs.readFileSync(updated!.jsonlPath, 'utf8');
    expect(projection).toContain('NEW_B');
    expect(projection).not.toContain('OLD_A');
  });

  it('rejects legacy session and message IDs that can escape storage roots', () => {
    const root = tempRoot();
    const storage = path.join(root, 'storage');
    writeJson(path.join(storage, 'session', 'project-1', 'bad-session.json'), {
      id: '../../outside-message',
      directory: '/Users/test/malicious',
      title: 'Bad session',
      time: { created: NOW, updated: NOW },
    });
    writeJson(path.join(root, 'outside-message', 'msg_outside.json'), {
      id: 'msg_outside',
      role: 'user',
      time: { created: NOW },
    });
    writeJson(path.join(root, 'outside-part', 'prt_outside.json'), {
      id: 'prt_outside',
      type: 'text',
      text: 'EXTERNAL_SENTINEL',
    });

    writeJson(path.join(storage, 'session', 'project-1', 'ses_safe.json'), {
      id: 'ses_safe',
      directory: '/Users/test/safe',
      title: 'Safe session',
      time: { created: NOW, updated: NOW },
    });
    writeJson(path.join(storage, 'message', 'ses_safe', 'bad-message.json'), {
      id: '../../../outside-part',
      role: 'user',
      time: { created: NOW },
    });

    const result = scanOpenCodeSessions({
      databasePath: path.join(root, 'missing.db'),
      legacyStorageDir: storage,
      cacheDir: path.join(root, 'cache'),
      nowMs: NOW,
    });
    expect(result.map(({ session }) => session.id)).toEqual(['ses_safe']);
    expect(fs.readFileSync(result[0]!.jsonlPath, 'utf8'))
      .not.toContain('EXTERNAL_SENTINEL');
  });

  it('does not follow legacy source-directory symlinks outside storage', () => {
    const root = tempRoot();
    const storage = path.join(root, 'storage');
    writeJson(path.join(storage, 'session', 'project', 'ses_safe.json'), {
      id: 'ses_safe',
      directory: '/Users/test/safe',
      title: 'Safe legacy session',
      time: { created: NOW, updated: NOW },
    });
    writeJson(path.join(storage, 'message', 'ses_safe', 'msg_safe.json'), {
      id: 'msg_safe',
      role: 'user',
      time: { created: NOW },
    });
    const externalParts = path.join(root, 'external-parts');
    writeJson(path.join(externalParts, 'prt_external.json'), {
      id: 'prt_external',
      type: 'text',
      text: 'EXTERNAL_PART_SENTINEL',
    });
    fs.mkdirSync(path.join(storage, 'part'), { recursive: true });
    fs.symlinkSync(externalParts, path.join(storage, 'part', 'msg_safe'));

    const [result] = scanOpenCodeSessions({
      databasePath: path.join(root, 'missing.db'),
      legacyStorageDir: storage,
      cacheDir: path.join(root, 'cache-a'),
      nowMs: NOW,
    });
    expect(result).toBeDefined();
    expect(fs.readFileSync(result!.jsonlPath, 'utf8'))
      .not.toContain('EXTERNAL_PART_SENTINEL');

    const linkedStorage = path.join(root, 'linked-storage');
    fs.mkdirSync(linkedStorage);
    const externalSessions = path.join(root, 'external-sessions');
    writeJson(path.join(externalSessions, 'project', 'ses_external.json'), {
      id: 'ses_external',
      directory: '/Users/test/external',
      title: 'EXTERNAL_SESSION_SENTINEL',
      time: { created: NOW, updated: NOW },
    });
    fs.symlinkSync(externalSessions, path.join(linkedStorage, 'session'));
    expect(scanOpenCodeSessions({
      databasePath: path.join(root, 'also-missing.db'),
      legacyStorageDir: linkedStorage,
      cacheDir: path.join(root, 'cache-b'),
      nowMs: NOW,
    })).toEqual([]);
  });

  it('treats a legacy cache failure as non-authoritative', () => {
    const root = tempRoot();
    const storage = path.join(root, 'storage');
    writeJson(path.join(storage, 'session', 'project', 'ses_retained.json'), {
      id: 'ses_retained',
      directory: '/Users/test/retained',
      title: 'Retain this session',
      time: { created: NOW, updated: NOW },
    });
    const victim = path.join(root, 'cache-victim');
    fs.mkdirSync(victim);
    const linkedCache = path.join(root, 'linked-cache');
    fs.symlinkSync(victim, linkedCache);

    expect(scanOpenCodeSessionsWithStatus({
      databasePath: path.join(root, 'missing.db'),
      legacyStorageDir: storage,
      cacheDir: linkedCache,
      nowMs: NOW,
    })).toEqual({ sessions: [], authoritative: false });
    expect(fs.readdirSync(victim)).toEqual([]);
  });

  it('bounds legacy metadata with the same contract as SQLite metadata', () => {
    const root = tempRoot();
    const storage = path.join(root, 'storage');
    writeJson(path.join(storage, 'session', 'project', 'ses_legacy_bounded.json'), {
      id: 'ses_legacy_bounded',
      parentID: `ses_${'p'.repeat(300)}`,
      directory: `${'d'.repeat(5_000)}LEGACY_DIRECTORY_TAIL`,
      title: `${'t'.repeat(70_000)}LEGACY_TITLE_TAIL`,
      version: `${'v'.repeat(2_000)}LEGACY_VERSION_TAIL`,
      model: {
        providerID: `${'p'.repeat(2_000)}LEGACY_PROVIDER_TAIL`,
        modelID: `${'m'.repeat(2_000)}LEGACY_MODEL_TAIL`,
      },
      time: { created: NOW, updated: NOW },
    });

    const [result] = scanOpenCodeSessions({
      databasePath: path.join(root, 'missing.db'),
      legacyStorageDir: storage,
      cacheDir: path.join(root, 'cache'),
      nowMs: NOW,
      includeInternal: true,
    });
    expect(result).toBeDefined();
    expect(Array.from(result!.session.cwd)).toHaveLength(4_096);
    expect(Array.from(result!.session.version)).toHaveLength(1_024);
    expect(result!.session.parentSessionId).toBeUndefined();
    expect(result!.session.model).not.toContain('LEGACY_PROVIDER_TAIL');
    expect(result!.session.model).not.toContain('LEGACY_MODEL_TAIL');
    const header = fs.readFileSync(result!.jsonlPath, 'utf8');
    expect(header).not.toContain('LEGACY_DIRECTORY_TAIL');
    expect(header).not.toContain('LEGACY_TITLE_TAIL');
    expect(header).not.toContain('LEGACY_VERSION_TAIL');
  });
});

function scanOpenCodeInFreshProcess(options: {
  databasePath: string;
  legacyStorageDir: string;
  cacheDir: string;
  nowMs: number;
}): { authoritative: boolean; sessionIds: string[] } {
  const scannerUrl = pathToFileURL(
    path.join(process.cwd(), 'dist', 'core', 'opencode-scanner.js'),
  ).href;
  const child = spawnSync(
    process.execPath,
    [
      '--no-warnings',
      '--input-type=module',
      '--eval',
      `
        import { scanOpenCodeSessionsWithStatus } from ${JSON.stringify(scannerUrl)};
        const options = JSON.parse(process.env.ASIDE_OPENCODE_SCAN_OPTIONS ?? '{}');
        const result = scanOpenCodeSessionsWithStatus(options);
        process.stdout.write(JSON.stringify({
          authoritative: result.authoritative,
          sessionIds: result.sessions.map(({ session }) => session.id),
        }));
      `,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ASIDE_OPENCODE_SCAN_OPTIONS: JSON.stringify(options),
      },
      encoding: 'utf8',
    },
  );
  if (child.error) throw child.error;
  if (child.status !== 0) {
    throw new Error(child.stderr || `Fresh scanner exited ${child.status}`);
  }
  return JSON.parse(child.stdout) as {
    authoritative: boolean;
    sessionIds: string[];
  };
}

function createDatabase(databasePath: string): DatabaseSync {
  const db = new DatabaseSync(databasePath);
  db.exec(`
    CREATE TABLE session(
      id TEXT PRIMARY KEY,
      parent_id TEXT,
      directory TEXT NOT NULL,
      title TEXT NOT NULL,
      version TEXT NOT NULL,
      model TEXT,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL
    );
    CREATE TABLE message(
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE part(
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
  `);
  return db;
}

function insertSession(
  db: DatabaseSync,
  input: {
    id: string;
    parentId?: string;
    directory: string;
    title: string;
    updated: number;
    model?: Record<string, unknown>;
  },
): void {
  db.prepare(
    `INSERT INTO session(
       id, parent_id, directory, title, version, model, time_created, time_updated
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.parentId ?? null,
    input.directory,
    input.title,
    '1.2.3',
    input.model ? JSON.stringify(input.model) : null,
    input.updated - 1_000,
    input.updated,
  );
}

function insertMessage(
  db: DatabaseSync,
  input: {
    id: string;
    sessionId: string;
    created: number;
    data: Record<string, unknown>;
  },
): void {
  db.prepare(
    `INSERT INTO message(id, session_id, time_created, time_updated, data)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.sessionId,
    input.created,
    input.created,
    JSON.stringify(input.data),
  );
}

function insertPart(
  db: DatabaseSync,
  input: {
    id: string;
    messageId: string;
    sessionId: string;
    created: number;
    data: Record<string, unknown>;
  },
): void {
  db.prepare(
    `INSERT INTO part(
       id, message_id, session_id, time_created, time_updated, data
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.messageId,
    input.sessionId,
    input.created,
    input.created,
    JSON.stringify(input.data),
  );
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value));
}

function jsonl(filePath: string): Record<string, unknown>[] {
  return fs.readFileSync(filePath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function sourceFingerprint(filePath: string): string {
  const stat = fs.statSync(filePath);
  return createHash('sha256')
    .update(fs.readFileSync(filePath))
    .update(String(stat.size))
    .update(String(stat.mtimeMs))
    .digest('hex');
}

async function eventually(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for deferred projection');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
