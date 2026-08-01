import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ThreadSearchReader,
  ThreadSearchWriter,
} from '../menubar/src/search-database.js';
import type { IndexableThread } from '../menubar/src/search-types.js';
import { estimateUsage } from '../menubar/src/usage-pricing.js';

const roots: string[] = [];

function tempIndex() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aside-usage-index-'));
  roots.push(root);
  const location = path.join(root, 'search.sqlite');
  const reader = new ThreadSearchReader(location);
  const writer = new ThreadSearchWriter(location);
  return { root, reader, writer };
}

function thread(
  root: string,
  source: IndexableThread['source'],
  id: string,
): IndexableThread {
  return {
    sessionId: id,
    source,
    jsonlPath: path.join(root, `${id}.jsonl`),
    projectName: 'usage-project',
    projectPath: '/work/usage-project',
    title: 'Usage test',
    gitBranch: 'main',
    lastEventMs: Date.parse('2026-07-31T18:00:00Z'),
  };
}

const query = {
  rangeDays: 90 as const,
  providers: [],
  models: [],
};

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('local token usage analytics', () => {
  it('deduplicates streamed records and aggregates providers, models, cost, and savings', async () => {
    const { root, reader, writer } = tempIndex();
    const codex = thread(root, 'codex', 'codex-usage');
    const claude = thread(root, 'claude', 'claude-usage');
    const pi = thread(root, 'pi', 'pi-usage');
    const codexUsage = JSON.stringify({
      timestamp: '2026-07-30T18:00:00Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 1_000,
            cached_input_tokens: 200,
            cache_write_input_tokens: 0,
            output_tokens: 100,
            reasoning_output_tokens: 20,
            total_tokens: 1_100,
          },
          last_token_usage: {
            input_tokens: 1_000,
            cached_input_tokens: 200,
            cache_write_input_tokens: 0,
            output_tokens: 100,
            reasoning_output_tokens: 20,
            total_tokens: 1_100,
          },
        },
      },
    });
    fs.writeFileSync(
      codex.jsonlPath,
      [
        JSON.stringify({
          timestamp: '2026-07-30T17:59:00Z',
          type: 'turn_context',
          payload: { model: 'gpt-5.6-sol' },
        }),
        codexUsage,
        // Repeated cumulative counters must not inflate usage.
        codexUsage,
      ].join('\n') + '\n',
    );

    const claudeRecord = (contentType: string) => JSON.stringify({
      type: 'assistant',
      timestamp: '2026-07-31T17:00:00Z',
      requestId: 'request-1',
      uuid: `fragment-${contentType}`,
      message: {
        id: 'message-1',
        role: 'assistant',
        model: 'claude-fable-5',
        content: [{ type: contentType }],
        usage: {
          input_tokens: 100,
          cache_read_input_tokens: 50,
          cache_creation_input_tokens: 20,
          output_tokens: 30,
        },
      },
    });
    fs.writeFileSync(
      claude.jsonlPath,
      `${claudeRecord('thinking')}\n${claudeRecord('text')}\n`,
    );

    fs.writeFileSync(
      pi.jsonlPath,
      `${JSON.stringify({
        type: 'message',
        id: 'local-message',
        timestamp: '2026-07-31T18:00:00Z',
        message: {
          role: 'assistant',
          provider: 'ollama',
          model: 'qwen3-coder:30b',
          usage: {
            input: 100,
            output: 50,
            cacheRead: 10,
            cacheWrite: 0,
            totalTokens: 160,
          },
        },
      })}\n`,
    );

    await writer.syncSessions([codex, claude, pi], () => {});
    const snapshot = reader.usage(
      query,
      Date.parse('2026-07-31T20:00:00Z'),
    );

    expect(snapshot.totals).toMatchObject({
      totalTokens: 1_460,
      requests: 3,
      activeDays: 2,
      unpricedTokens: 0,
    });
    expect(snapshot.totals.estimatedCostUsd).toBeCloseTo(0.0099, 8);
    expect(snapshot.totals.estimatedSavingsUsd).toBeCloseTo(0.000401, 8);
    expect(snapshot.currentStreak).toBe(2);
    expect(snapshot.longestStreak).toBe(2);
    expect(snapshot.providers.map((provider) => provider.id)).toEqual([
      'openai',
      'anthropic',
      'ollama',
    ]);
    expect(snapshot.models.map((model) => model.model)).toContain('qwen3-coder:30b');

    const anthropic = reader.usage(
      { ...query, providers: ['anthropic'] },
      Date.parse('2026-07-31T20:00:00Z'),
    );
    expect(anthropic.totals.totalTokens).toBe(200);
    expect(anthropic.breakdown).toHaveLength(1);
    expect(anthropic.breakdown[0]).toMatchObject({
      provider: 'anthropic',
      model: 'claude-fable-5',
    });

    writer.close();
    reader.close();
  });

  it('picks up appended usage once and preserves it across unchanged syncs', async () => {
    const { root, reader, writer } = tempIndex();
    const session = thread(root, 'pi', 'incremental-usage');
    fs.writeFileSync(session.jsonlPath, '');
    await writer.syncSessions([session], () => {});

    const record = JSON.stringify({
      type: 'message',
      id: 'one-request',
      timestamp: '2026-07-31T18:00:00Z',
      message: {
        role: 'assistant',
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        usage: { input: 50, output: 10, cacheRead: 0, cacheWrite: 0 },
      },
    });
    fs.appendFileSync(session.jsonlPath, `${record}\n`);
    session.lastEventMs += 1;
    await writer.syncSessions([session], () => {});
    await writer.syncSessions([session], () => {});

    const snapshot = reader.usage(
      query,
      Date.parse('2026-07-31T20:00:00Z'),
    );
    expect(snapshot.totals.totalTokens).toBe(60);
    expect(snapshot.totals.requests).toBe(1);
    writer.close();
    reader.close();
  });

  it('leaves unknown cloud models unpriced instead of inventing a rate', () => {
    const estimate = estimateUsage(
      'unknown-cloud',
      'mystery-1',
      false,
      {
        inputTokens: 1_000,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 100,
        reasoningOutputTokens: 0,
        totalTokens: 1_100,
        requests: 1,
      },
    );
    expect(estimate).toEqual({ costUsd: 0, savingsUsd: 0, priced: false });
  });

  it('migrates the existing search schema without discarding indexed threads', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aside-usage-migration-'));
    roots.push(root);
    const location = path.join(root, 'search.sqlite');
    const legacy = new DatabaseSync(location);
    legacy.exec(`
      CREATE TABLE search_transcripts(
        thread_key TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        source TEXT NOT NULL,
        jsonl_path TEXT NOT NULL,
        project_name TEXT NOT NULL,
        project_path TEXT NOT NULL,
        title TEXT NOT NULL,
        git_branch TEXT NOT NULL,
        last_event_ms INTEGER NOT NULL,
        file_dev INTEGER NOT NULL DEFAULT 0,
        file_ino INTEGER NOT NULL DEFAULT 0,
        file_size INTEGER NOT NULL DEFAULT 0,
        file_mtime_ms REAL NOT NULL DEFAULT 0,
        prefix_bytes INTEGER NOT NULL DEFAULT 0,
        prefix_hash TEXT NOT NULL DEFAULT '',
        indexed_offset INTEGER NOT NULL DEFAULT 0,
        metadata_signature TEXT NOT NULL DEFAULT '',
        sidechat_signature TEXT NOT NULL DEFAULT '',
        last_fingerprint TEXT NOT NULL DEFAULT ''
      );
      INSERT INTO search_transcripts(
        thread_key, session_id, source, jsonl_path, project_name, project_path,
        title, git_branch, last_event_ms
      ) VALUES (
        'codex:preserved', 'preserved', 'codex', '/tmp/preserved.jsonl',
        'project', '/tmp', 'Preserved', 'main', 1
      );
      PRAGMA user_version = 1;
    `);
    legacy.close();

    const migrated = new ThreadSearchReader(location);
    migrated.close();
    const check = new DatabaseSync(location);
    const columns = check
      .prepare('PRAGMA table_info(search_transcripts)')
      .all() as unknown as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        'usage_indexed_offset',
        'usage_model',
        'usage_provider',
      ]),
    );
    expect(
      check.prepare('SELECT session_id FROM search_transcripts').get(),
    ).toEqual({ session_id: 'preserved' });
    expect(
      check.prepare('PRAGMA user_version').get(),
    ).toEqual({ user_version: 2 });
    check.close();
  });
});
