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
import { extractUsageFromLine } from '../menubar/src/usage-extractor.js';
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

    const claudeRecord = (contentType: string, outputTokens: number) => JSON.stringify({
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
          cache_creation_input_tokens: 30,
          cache_creation: {
            ephemeral_5m_input_tokens: 10,
            ephemeral_1h_input_tokens: 20,
          },
          output_tokens: outputTokens,
        },
      },
    });
    fs.writeFileSync(
      claude.jsonlPath,
      `${claudeRecord('thinking', 2)}\n${claudeRecord('text', 114)}\n`,
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
      totalTokens: 1_554,
      requests: 3,
      activeDays: 2,
      unpricedTokens: 0,
    });
    expect(snapshot.totals.estimatedCostUsd).toBeCloseTo(0.014375, 8);
    expect(snapshot.totals.estimatedSavingsUsd).toBeCloseTo(0.0000802, 8);
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
    expect(anthropic.totals).toMatchObject({
      totalTokens: 294,
      requests: 1,
      cacheWrite5mInputTokens: 10,
      cacheWrite1hInputTokens: 20,
      outputTokens: 114,
    });
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

  it('rebases usage when a transcript is rewritten and removes it when deleted', async () => {
    const { root, reader, writer } = tempIndex();
    const session = thread(root, 'pi', 'replaceable-usage');
    const record = (id: string, input: number, output: number) =>
      JSON.stringify({
        type: 'message',
        id,
        timestamp: '2026-07-31T18:00:00Z',
        message: {
          role: 'assistant',
          provider: 'anthropic',
          model: 'claude-opus-4-6',
          usage: { input, output, cacheRead: 0, cacheWrite: 0 },
        },
      });

    fs.writeFileSync(session.jsonlPath, `${record('same-request', 50, 10)}\n`);
    await writer.syncSessions([session], () => {});
    expect(
      reader.usage(query, Date.parse('2026-07-31T20:00:00Z')).totals,
    ).toMatchObject({ totalTokens: 60, requests: 1 });

    fs.writeFileSync(session.jsonlPath, `${record('same-request', 7, 3)}\n`);
    session.lastEventMs += 1;
    await writer.syncSessions([session], () => {});
    expect(
      reader.usage(query, Date.parse('2026-07-31T20:00:00Z')).totals,
    ).toMatchObject({ totalTokens: 10, requests: 1 });

    await writer.syncSessions([], () => {});
    expect(
      reader.usage(query, Date.parse('2026-07-31T20:00:00Z')).totals,
    ).toMatchObject({ totalTokens: 0, requests: 0 });
    writer.close();
    reader.close();
  });

  it('rebases a shared sample after every owner rewrites lower', async () => {
    const { root, reader, writer } = tempIndex();
    const first = thread(root, 'pi', 'shared-usage-first');
    const second = thread(root, 'pi', 'shared-usage-second');
    const record = (input: number, output: number) =>
      JSON.stringify({
        type: 'message',
        id: 'shared-request',
        timestamp: '2026-07-31T18:00:00Z',
        message: {
          role: 'assistant',
          provider: 'anthropic',
          model: 'claude-opus-4-6',
          usage: { input, output, cacheRead: 0, cacheWrite: 0 },
        },
      });
    const usage = () =>
      reader.usage(query, Date.parse('2026-07-31T20:00:00Z')).totals;

    fs.writeFileSync(first.jsonlPath, `${record(50, 10)}\n`);
    fs.writeFileSync(second.jsonlPath, `${record(50, 10)}\n`);
    await writer.syncSessions([first, second], () => {});
    expect(usage()).toMatchObject({ totalTokens: 60, requests: 1 });

    fs.writeFileSync(first.jsonlPath, `${record(7, 3)}\n`);
    first.lastEventMs += 1;
    await writer.syncSessions([first, second], () => {});
    expect(usage()).toMatchObject({ totalTokens: 60, requests: 1 });

    fs.writeFileSync(second.jsonlPath, `${record(7, 3)}\n`);
    second.lastEventMs += 1;
    await writer.syncSessions([first, second], () => {});
    expect(usage()).toMatchObject({ totalTokens: 10, requests: 1 });

    await writer.syncSessions([second], () => {});
    expect(usage()).toMatchObject({ totalTokens: 10, requests: 1 });

    await writer.syncSessions([], () => {});
    expect(usage()).toMatchObject({ totalTokens: 0, requests: 0 });
    writer.close();
    reader.close();
  });

  it('extracts normalized OpenCode usage without indexing prompt content', () => {
    const extracted = extractUsageFromLine(
      JSON.stringify({
        schema: 'aside.opencode.v1',
        id: 'usage-open-code-1',
        type: 'usage',
        timestamp: '2026-08-09T12:00:00Z',
        providerID: 'anthropic',
        modelID: 'claude-sonnet-4-6',
        tokens: {
          input: 120,
          output: 30,
          reasoning: 4,
          cacheRead: 40,
          cacheWrite: 10,
        },
      }),
      'opencode',
      '',
      '',
      120,
      'opencode:test',
    );

    expect(extracted).toMatchObject({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      sample: {
        inputTokens: 120,
        outputTokens: 30,
        reasoningOutputTokens: 4,
        cachedInputTokens: 40,
        cacheWrite5mInputTokens: 10,
      },
    });
  });

  it('deduplicates forked Codex counters while any transcript still owns them', async () => {
    const { root, reader, writer } = tempIndex();
    const original = thread(root, 'codex', 'codex-original');
    const fork = thread(root, 'codex', 'codex-fork');
    const tokenRecord = (timestamp: string) => JSON.stringify({
      timestamp,
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 0,
            cache_write_input_tokens: 0,
            output_tokens: 10,
            reasoning_output_tokens: 2,
            total_tokens: 110,
          },
          last_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 0,
            cache_write_input_tokens: 0,
            output_tokens: 10,
            reasoning_output_tokens: 2,
            total_tokens: 110,
          },
        },
      },
    });
    fs.writeFileSync(
      original.jsonlPath,
      `${JSON.stringify({
        timestamp: '2026-07-29T12:00:00Z',
        type: 'turn_context',
        payload: { model: 'gpt-5.6-sol' },
      })}\n${tokenRecord('2026-07-30T12:00:00Z')}\n`,
    );
    fs.writeFileSync(
      fork.jsonlPath,
      `${tokenRecord('2026-07-31T12:00:00Z')}\n`,
    );

    await writer.syncSessions([fork, original], () => {});
    const snapshot = reader.usage(
      query,
      Date.parse('2026-07-31T20:00:00Z'),
    );
    expect(snapshot.totals).toMatchObject({ totalTokens: 110, requests: 1 });
    expect(snapshot.breakdown).toEqual([
      expect.objectContaining({ model: 'gpt-5.6-sol', totalTokens: 110 }),
    ]);

    await writer.syncSessions([original], () => {});
    expect(
      reader.usage(query, Date.parse('2026-07-31T20:00:00Z')).totals,
    ).toMatchObject({ totalTokens: 110, requests: 1 });

    await writer.syncSessions([], () => {});
    expect(
      reader.usage(query, Date.parse('2026-07-31T20:00:00Z')).totals,
    ).toMatchObject({ totalTokens: 0, requests: 0 });
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
        cacheWrite5mInputTokens: 0,
        cacheWrite1hInputTokens: 0,
        outputTokens: 100,
        reasoningOutputTokens: 0,
        totalTokens: 1_100,
        requests: 1,
      },
    );
    expect(estimate).toEqual({ costUsd: 0, savingsUsd: 0, priced: false });
  });

  it('uses the published GPT-5.6 Terra and Luna token rates', () => {
    const oneMillionEach = {
      inputTokens: 1_000_000,
      cachedInputTokens: 1_000_000,
      cacheWrite5mInputTokens: 1_000_000,
      cacheWrite1hInputTokens: 0,
      outputTokens: 1_000_000,
      reasoningOutputTokens: 0,
      totalTokens: 4_000_000,
      requests: 1,
    };

    const terra = estimateUsage(
      'openai',
      'gpt-5.6-terra',
      false,
      oneMillionEach,
    );
    expect(terra.priced).toBe(true);
    expect(terra.costUsd).toBeCloseTo(16.7, 8);

    const luna = estimateUsage(
      'openai',
      'gpt-5.6-luna',
      false,
      oneMillionEach,
    );
    expect(luna.priced).toBe(true);
    expect(luna.costUsd).toBeCloseTo(1.67, 8);

    const local = estimateUsage('ollama', 'qwen3-coder:30b', true, {
      ...oneMillionEach,
      cachedInputTokens: 0,
      cacheWrite5mInputTokens: 0,
      totalTokens: 2_000_000,
    });
    expect(local).toMatchObject({ costUsd: 0, priced: true });
    expect(local.savingsUsd).toBeCloseTo(1.4, 8);
  });

  it('rejects malformed and implausible transcript counters without storing raw IDs', () => {
    for (const raw of ['null', '[]', '42', '"text"']) {
      expect(
        extractUsageFromLine(raw, 'claude', '', '', 1, 'claude:test'),
      ).toEqual({ model: '', provider: '' });
    }

    const oversized = extractUsageFromLine(
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-07-31T18:00:00Z',
        message: {
          id: 'x'.repeat(100_000),
          role: 'assistant',
          model: 'claude-fable-5',
          usage: { input_tokens: 1e30, output_tokens: 1e30 },
        },
      }),
      'claude',
      '',
      '',
      1,
      'claude:test',
    );
    expect(oversized.sample).toBeUndefined();

    const boundedId = extractUsageFromLine(
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-07-31T18:00:00Z',
        message: {
          id: 'private-id-'.repeat(10_000),
          role: 'assistant',
          model: 'claude-fable-5',
          usage: { input_tokens: 1, output_tokens: 2 },
        },
      }),
      'claude',
      '',
      '',
      2,
      'claude:test',
    );
    expect(boundedId.sample?.sampleKey).toMatch(/^[a-f0-9]{64}$/u);
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
    ).toEqual({ user_version: 5 });
    check.close();
  });

  it('rebuilds pre-release v2 counters without discarding searchable rows', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aside-usage-v2-'));
    roots.push(root);
    const location = path.join(root, 'search.sqlite');
    const initialized = new ThreadSearchReader(location);
    initialized.close();

    const prerelease = new DatabaseSync(location);
    prerelease.exec(`
      INSERT INTO search_transcripts(
        thread_key, session_id, source, jsonl_path, project_name, project_path,
        title, git_branch, last_event_ms, indexed_offset,
        usage_indexed_offset, usage_model, usage_provider
      ) VALUES (
        'codex:v2', 'v2', 'codex', '/tmp/v2.jsonl', 'project', '/tmp',
        'Preserved v2 work', 'main', 1, 99, 99, 'gpt-5.6-sol', 'openai'
      );
      INSERT INTO search_documents(
        thread_key, origin, kind, timestamp, title, project,
        user_text, assistant_text, tool_text, error_text
      ) VALUES (
        'codex:v2', 'metadata', 'metadata', '', 'Preserved v2 work',
        'project', '', '', '', ''
      );
      DROP TABLE token_usage_samples;
      CREATE TABLE token_usage_samples(
        thread_key TEXT NOT NULL,
        sample_key TEXT NOT NULL,
        timestamp_ms INTEGER NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        local INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        cached_input_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(thread_key, sample_key)
      ) WITHOUT ROWID;
      PRAGMA user_version = 2;
    `);
    prerelease.close();

    const migrated = new ThreadSearchReader(location);
    expect(migrated.search('preserved')).toHaveLength(1);
    migrated.close();

    const check = new DatabaseSync(location);
    expect(
      check
        .prepare(
          `SELECT indexed_offset, usage_indexed_offset, usage_model,
                  usage_provider
           FROM search_transcripts WHERE thread_key = 'codex:v2'`,
        )
        .get(),
    ).toEqual({
      indexed_offset: 99,
      usage_indexed_offset: 0,
      usage_model: '',
      usage_provider: '',
    });
    const usageColumns = check
      .prepare('PRAGMA table_info(token_usage_samples)')
      .all() as unknown as Array<{ name: string }>;
    expect(usageColumns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        'cache_write_5m_input_tokens',
        'cache_write_1h_input_tokens',
      ]),
    );
    expect(usageColumns.map((column) => column.name)).not.toContain(
      'thread_key',
    );
    const ownerColumns = check
      .prepare('PRAGMA table_info(token_usage_sample_owners)')
      .all() as unknown as Array<{ name: string }>;
    expect(ownerColumns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        'thread_key',
        'sample_key',
        'timestamp_ms',
        'provider',
        'model',
        'input_tokens',
        'output_tokens',
      ]),
    );
    expect(check.prepare('PRAGMA user_version').get()).toEqual({
      user_version: 5,
    });
    check.close();
  });

  it('rebuilds v3 counters that have no transcript ownership', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aside-usage-v3-'));
    roots.push(root);
    const location = path.join(root, 'search.sqlite');
    const initialized = new ThreadSearchReader(location);
    initialized.close();

    const legacy = new DatabaseSync(location);
    legacy.exec(`
      DROP TABLE token_usage_sample_owners;
      INSERT INTO search_transcripts(
        thread_key, session_id, source, jsonl_path, project_name, project_path,
        title, git_branch, last_event_ms, indexed_offset,
        usage_indexed_offset, usage_model, usage_provider
      ) VALUES (
        'codex:v3', 'v3', 'codex', '/tmp/v3.jsonl', 'project', '/tmp',
        'Preserved v3 work', 'main', 1, 99, 99, 'gpt-5.6-sol', 'openai'
      );
      INSERT INTO search_documents(
        thread_key, origin, kind, timestamp, title, project,
        user_text, assistant_text, tool_text, error_text
      ) VALUES (
        'codex:v3', 'metadata', 'metadata', '', 'Preserved v3 work',
        'project', '', '', '', ''
      );
      INSERT INTO token_usage_samples(
        sample_key, timestamp_ms, provider, model, local, input_tokens,
        cached_input_tokens, cache_write_5m_input_tokens,
        cache_write_1h_input_tokens, output_tokens, reasoning_output_tokens
      ) VALUES (
        'unowned-v3', 1785520800000, 'openai', 'gpt-5.6-sol', 0, 100,
        0, 0, 0, 10, 0
      );
      PRAGMA user_version = 3;
    `);
    legacy.close();

    const migrated = new ThreadSearchReader(location);
    expect(migrated.search('preserved')).toHaveLength(1);
    migrated.close();

    const check = new DatabaseSync(location);
    expect(
      check
        .prepare(
          `SELECT indexed_offset, usage_indexed_offset, usage_model,
                  usage_provider
           FROM search_transcripts WHERE thread_key = 'codex:v3'`,
        )
        .get(),
    ).toEqual({
      indexed_offset: 99,
      usage_indexed_offset: 0,
      usage_model: '',
      usage_provider: '',
    });
    expect(
      check.prepare('SELECT COUNT(*) AS count FROM token_usage_samples').get(),
    ).toEqual({ count: 0 });
    expect(
      check.prepare('PRAGMA user_version').get(),
    ).toEqual({ user_version: 5 });
    check.close();
  });

  it('rebuilds v4 key-only ownership so stale shared maxima cannot survive', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aside-usage-v4-'));
    roots.push(root);
    const location = path.join(root, 'search.sqlite');
    const initialized = new ThreadSearchReader(location);
    initialized.close();

    const legacy = new DatabaseSync(location);
    legacy.exec(`
      DROP TABLE token_usage_sample_owners;
      CREATE TABLE token_usage_sample_owners(
        thread_key TEXT NOT NULL
          REFERENCES search_transcripts(thread_key) ON DELETE CASCADE,
        sample_key TEXT NOT NULL
          REFERENCES token_usage_samples(sample_key) ON DELETE CASCADE,
        PRIMARY KEY(thread_key, sample_key)
      ) WITHOUT ROWID;
      INSERT INTO search_transcripts(
        thread_key, session_id, source, jsonl_path, project_name, project_path,
        title, git_branch, last_event_ms, indexed_offset,
        usage_indexed_offset, usage_model, usage_provider
      ) VALUES (
        'codex:v4', 'v4', 'codex', '/tmp/v4.jsonl', 'project', '/tmp',
        'Preserved v4 work', 'main', 1, 99, 99, 'gpt-5.6-sol', 'openai'
      );
      INSERT INTO search_documents(
        thread_key, origin, kind, timestamp, title, project,
        user_text, assistant_text, tool_text, error_text
      ) VALUES (
        'codex:v4', 'metadata', 'metadata', '', 'Preserved v4 work',
        'project', '', '', '', ''
      );
      INSERT INTO token_usage_samples(
        sample_key, timestamp_ms, provider, model, local, input_tokens,
        cached_input_tokens, cache_write_5m_input_tokens,
        cache_write_1h_input_tokens, output_tokens, reasoning_output_tokens
      ) VALUES (
        'stale-v4', 1785520800000, 'openai', 'gpt-5.6-sol', 0, 100,
        0, 0, 0, 10, 0
      );
      INSERT INTO token_usage_sample_owners(thread_key, sample_key)
      VALUES ('codex:v4', 'stale-v4');
      PRAGMA user_version = 4;
    `);
    legacy.close();

    const migrated = new ThreadSearchReader(location);
    expect(migrated.search('preserved')).toHaveLength(1);
    migrated.close();

    const check = new DatabaseSync(location);
    expect(
      check
        .prepare(
          `SELECT indexed_offset, usage_indexed_offset, usage_model,
                  usage_provider
           FROM search_transcripts WHERE thread_key = 'codex:v4'`,
        )
        .get(),
    ).toEqual({
      indexed_offset: 99,
      usage_indexed_offset: 0,
      usage_model: '',
      usage_provider: '',
    });
    expect(
      check.prepare('SELECT COUNT(*) AS count FROM token_usage_samples').get(),
    ).toEqual({ count: 0 });
    const ownerColumns = check
      .prepare('PRAGMA table_info(token_usage_sample_owners)')
      .all() as unknown as Array<{ name: string }>;
    expect(ownerColumns.map((column) => column.name)).toContain('input_tokens');
    expect(check.prepare('PRAGMA user_version').get()).toEqual({
      user_version: 5,
    });
    check.close();
  });
});
