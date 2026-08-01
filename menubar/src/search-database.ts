import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import {
  extractSearchDocuments,
  normalizeSearchText,
  type SearchDocumentKind,
} from '../../dist/core/search-document.js';
import {
  buildUsageSnapshot,
  type UsageAggregateRow,
} from './usage-analytics.js';
import { extractUsageFromLine } from './usage-extractor.js';
import type {
  StoredUsageSample,
  UsageAnalyticsQuery,
  UsageAnalyticsSnapshot,
} from './usage-types.js';
import type {
  IndexableSideChat,
  IndexableThread,
  SearchIndexStatus,
  SearchMatchKind,
  SearchSnippetPart,
  ThreadSearchResult,
} from './search-types.js';

const SCHEMA_VERSION = 3;
const USAGE_RETENTION_DAYS = 370;
const USAGE_RETENTION_MS = USAGE_RETENTION_DAYS * 24 * 60 * 60 * 1_000;
const READ_CHUNK_BYTES = 1024 * 1024;
const COMMIT_AFTER_BYTES = 4 * 1024 * 1024;
const MAX_JSONL_LINE_BYTES = 32 * 1024 * 1024;
const MAX_QUERY_TOKENS = 10;
const DEFAULT_RESULT_LIMIT = 40;
const MAX_RESULT_LIMIT = 100;
const SNIPPET_START = '\u0001';
const SNIPPET_END = '\u0002';

interface TranscriptRow {
  thread_key: string;
  jsonl_path: string;
  file_dev: number;
  file_ino: number;
  file_size: number;
  file_mtime_ms: number;
  prefix_bytes: number;
  prefix_hash: string;
  indexed_offset: number;
  usage_indexed_offset: number;
  usage_model: string;
  usage_provider: string;
  metadata_signature: string;
  sidechat_signature: string;
  last_fingerprint: string;
  last_event_ms: number;
}

interface RankedThreadRow {
  thread_key: string;
  session_id: string;
  source: IndexableThread['source'];
  best_rank: number;
}

interface SnippetRow {
  thread_key: string;
  kind: SearchMatchKind;
  snippet: string;
  score: number;
}

export interface SearchWriterProgress {
  indexedThreads: number;
  totalThreads: number;
  indexedBytes: number;
  totalBytes: number;
}

/**
 * Read connection used by the Electron main process. It never traverses source
 * transcripts; queries touch only the local FTS index.
 */
export class ThreadSearchReader {
  private readonly db: DatabaseSync;

  constructor(readonly location: string) {
    ensurePrivateParent(location);
    this.db = new DatabaseSync(location);
    try {
      initializeSchema(this.db);
      secureDatabaseFile(location);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  search(input: string, requestedLimit = DEFAULT_RESULT_LIMIT): ThreadSearchResult[] {
    const ftsQuery = buildFtsQuery(input);
    if (!ftsQuery) return [];
    const limit = Math.max(1, Math.min(MAX_RESULT_LIMIT, requestedLimit));

    const ranked = this.db
      .prepare(
        `SELECT
           t.thread_key,
           t.session_id,
           t.source,
           MIN(search_documents_fts.rank) AS best_rank
         FROM search_documents_fts
         JOIN search_documents d ON d.id = search_documents_fts.rowid
         JOIN search_transcripts t ON t.thread_key = d.thread_key
         WHERE search_documents_fts MATCH ?
         GROUP BY t.thread_key, t.session_id, t.source
         ORDER BY best_rank ASC, t.last_event_ms DESC
         LIMIT ?`,
      )
      .all(ftsQuery, limit) as unknown as RankedThreadRow[];
    if (ranked.length === 0) return [];

    const placeholders = ranked.map(() => '?').join(', ');
    const snippetRows = this.db
      .prepare(
        `SELECT
           d.thread_key,
           d.kind,
           snippet(
             search_documents_fts,
             -1,
             '${SNIPPET_START}',
             '${SNIPPET_END}',
             ' … ',
             24
           ) AS snippet,
           search_documents_fts.rank AS score
         FROM search_documents_fts
         JOIN search_documents d ON d.id = search_documents_fts.rowid
         WHERE search_documents_fts MATCH ?
           AND d.thread_key IN (${placeholders})
         ORDER BY score ASC
         LIMIT ?`,
      )
      .all(
        ftsQuery,
        ...ranked.map((row) => row.thread_key),
        Math.max(200, ranked.length * 12),
      ) as unknown as SnippetRow[];

    const bestSnippet = new Map<string, SnippetRow>();
    for (const row of snippetRows) {
      if (!bestSnippet.has(row.thread_key)) bestSnippet.set(row.thread_key, row);
    }

    return ranked.map((row) => {
      const match = bestSnippet.get(row.thread_key);
      return {
        sessionId: row.session_id,
        source: row.source,
        kind: match?.kind ?? 'metadata',
        snippet: parseSnippet(match?.snippet ?? ''),
        score: row.best_rank,
      };
    });
  }

  usage(
    query: UsageAnalyticsQuery,
    nowMs = Date.now(),
  ): UsageAnalyticsSnapshot {
    const { startMs, endMs } = usageRangeBounds(query.rangeDays, nowMs);
    const rows = this.db
      .prepare(
        `SELECT
           date(timestamp_ms / 1000, 'unixepoch', 'localtime') AS day,
           provider,
           model,
           local,
           SUM(input_tokens) AS input_tokens,
           SUM(cached_input_tokens) AS cached_input_tokens,
           SUM(cache_write_5m_input_tokens) AS cache_write_5m_input_tokens,
           SUM(cache_write_1h_input_tokens) AS cache_write_1h_input_tokens,
           SUM(output_tokens) AS output_tokens,
           SUM(reasoning_output_tokens) AS reasoning_output_tokens,
           COUNT(*) AS requests
         FROM token_usage_samples
         WHERE timestamp_ms >= ? AND timestamp_ms < ?
         GROUP BY day, provider, model, local
         ORDER BY day ASC`,
      )
      .all(startMs, endMs) as unknown as UsageAggregateRow[];
    return buildUsageSnapshot(rows, query, nowMs);
  }

  close(): void {
    this.db.close();
  }
}

/**
 * The background writer. Transactions are committed every few megabytes, so a
 * reader on the WAL database sees useful newest-first results during the first
 * build rather than waiting for the complete corpus.
 */
export class ThreadSearchWriter {
  private readonly db: DatabaseSync;
  private readonly insertDocument: StatementSync;
  private readonly insertUsageSample: StatementSync;
  private changedDocuments = 0;

  constructor(readonly location: string) {
    ensurePrivateParent(location);
    this.db = new DatabaseSync(location);
    try {
      initializeSchema(this.db);
      secureDatabaseFile(location);
    } catch (error) {
      this.db.close();
      throw error;
    }
    this.insertDocument = this.db.prepare(
      `INSERT INTO search_documents(
         thread_key,
         origin,
         kind,
         timestamp,
         title,
         project,
         user_text,
         assistant_text,
         tool_text,
         error_text
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.insertUsageSample = this.db.prepare(
      `INSERT INTO token_usage_samples(
         sample_key,
         timestamp_ms,
         provider,
         model,
         local,
         input_tokens,
         cached_input_tokens,
         cache_write_5m_input_tokens,
         cache_write_1h_input_tokens,
         output_tokens,
         reasoning_output_tokens
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(sample_key) DO UPDATE SET
         provider = CASE
           WHEN excluded.timestamp_ms < timestamp_ms
             AND excluded.provider <> 'unknown'
             THEN excluded.provider
           WHEN provider = 'unknown' AND excluded.provider <> 'unknown'
             THEN excluded.provider
           ELSE provider
         END,
         model = CASE
           WHEN excluded.timestamp_ms < timestamp_ms
             AND excluded.model <> 'unknown'
             THEN excluded.model
           WHEN model = 'unknown' AND excluded.model <> 'unknown'
             THEN excluded.model
           ELSE model
         END,
         timestamp_ms = MIN(timestamp_ms, excluded.timestamp_ms),
         local = MAX(local, excluded.local),
         input_tokens = MAX(input_tokens, excluded.input_tokens),
         cached_input_tokens = MAX(
           cached_input_tokens,
           excluded.cached_input_tokens
         ),
         cache_write_5m_input_tokens = MAX(
           cache_write_5m_input_tokens,
           excluded.cache_write_5m_input_tokens
         ),
         cache_write_1h_input_tokens = MAX(
           cache_write_1h_input_tokens,
           excluded.cache_write_1h_input_tokens
         ),
         output_tokens = MAX(output_tokens, excluded.output_tokens),
         reasoning_output_tokens = MAX(
           reasoning_output_tokens,
           excluded.reasoning_output_tokens
         )`,
    );
  }

  async syncSessions(
    sessions: IndexableThread[],
    onProgress: (progress: SearchWriterProgress) => void,
  ): Promise<void> {
    const discovered = sessions.flatMap((session) => {
      try {
        return [{ session, stat: fs.statSync(session.jsonlPath) }];
      } catch {
        return [];
      }
    });
    discovered.sort(
      (a, b) => b.session.lastEventMs - a.session.lastEventMs,
    );
    const visibleKeys = new Set(
      discovered.map(({ session }) => threadKey(session)),
    );
    this.pruneMissing(visibleKeys);

    const totalBytes = discovered.reduce((sum, item) => sum + item.stat.size, 0);
    let indexedBytes = discovered.reduce((sum, { session, stat }) => {
      const existing = this.transcript(threadKey(session));
      return sum + Math.min(processedOffset(existing), stat.size);
    }, 0);
    let indexedThreads = 0;
    onProgress({
      indexedThreads,
      totalThreads: discovered.length,
      indexedBytes,
      totalBytes,
    });

    for (const { session, stat } of discovered) {
      const before = Math.min(
        processedOffset(this.transcript(threadKey(session))),
        stat.size,
      );
      await this.indexSession(session, stat, (offset) => {
        const nextIndexed = indexedBytes + Math.max(0, offset - before);
        onProgress({
          indexedThreads,
          totalThreads: discovered.length,
          indexedBytes: Math.min(totalBytes, nextIndexed),
          totalBytes,
        });
      });
      const after = Math.min(
        processedOffset(this.transcript(threadKey(session))),
        stat.size,
      );
      indexedBytes += Math.max(0, after - before);
      indexedThreads += 1;
      onProgress({
        indexedThreads,
        totalThreads: discovered.length,
        indexedBytes: Math.min(totalBytes, indexedBytes),
        totalBytes,
      });
      await yieldToWorkerLoop();
    }
    this.pruneExpiredUsageSamples();
  }

  syncSideChats(chats: IndexableSideChat[]): void {
    const seenSessionIds = new Set(chats.map((chat) => chat.sessionId));
    const transcriptRows = this.db
      .prepare(
        `SELECT thread_key, session_id, sidechat_signature
         FROM search_transcripts`,
      )
      .all() as unknown as Array<{
      thread_key: string;
      session_id: string;
      sidechat_signature: string;
    }>;

    this.db.exec('BEGIN');
    try {
      for (const chat of chats) {
        const matching = transcriptRows.filter(
          (row) => row.session_id === chat.sessionId,
        );
        const signature = sideChatSignature(chat);
        for (const row of matching) {
          if (row.sidechat_signature === signature) continue;
          this.db
            .prepare(
              `DELETE FROM search_documents
               WHERE thread_key = ? AND origin = 'sidechat'`,
            )
            .run(row.thread_key);
          for (const turn of chat.turns) {
            const body = normalizeSearchText(turn.content);
            if (!body) continue;
            this.addDocument(
              row.thread_key,
              'sidechat',
              turn.role === 'user' ? 'side_user' : 'side_assistant',
              turn.timestamp,
              body,
            );
          }
          this.db
            .prepare(
              `UPDATE search_transcripts
               SET sidechat_signature = ?
               WHERE thread_key = ?`,
            )
            .run(signature, row.thread_key);
        }
      }

      for (const row of transcriptRows) {
        if (
          seenSessionIds.has(row.session_id) ||
          row.sidechat_signature.length === 0
        ) {
          continue;
        }
        this.db
          .prepare(
            `DELETE FROM search_documents
             WHERE thread_key = ? AND origin = 'sidechat'`,
          )
          .run(row.thread_key);
        this.db
          .prepare(
            `UPDATE search_transcripts
             SET sidechat_signature = ''
             WHERE thread_key = ?`,
          )
          .run(row.thread_key);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  optimizeIfUseful(onBefore?: () => void): boolean {
    if (this.changedDocuments < 5_000) return false;
    onBefore?.();
    this.db.exec(`INSERT INTO search_documents_fts(search_documents_fts)
                  VALUES('optimize')`);
    this.changedDocuments = 0;
    return true;
  }

  clear(): void {
    this.db.exec('BEGIN');
    try {
      this.db.exec('DELETE FROM search_transcripts');
      this.db.exec('DELETE FROM token_usage_samples');
      this.db.exec('COMMIT');
      this.changedDocuments = 0;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  private async indexSession(
    session: IndexableThread,
    stat: fs.Stats,
    onOffset: (offset: number) => void,
  ): Promise<void> {
    const key = threadKey(session);
    let existing = this.transcript(key);
    if (
      existing !== null &&
      existing.jsonl_path === session.jsonlPath &&
      existing.file_dev === stat.dev &&
      existing.file_ino === stat.ino &&
      existing.file_size === stat.size &&
      existing.file_mtime_ms === stat.mtimeMs &&
      existing.last_event_ms === session.lastEventMs &&
      existing.metadata_signature === metadataSignature(session) &&
      existing.indexed_offset >= stat.size &&
      existing.usage_indexed_offset >= stat.size
    ) {
      return;
    }
    const identityChanged =
      existing !== null &&
      ((existing.file_dev !== 0 && existing.file_dev !== stat.dev) ||
        (existing.file_ino !== 0 && existing.file_ino !== stat.ino));
    const prefixChanged =
      existing !== null &&
      existing.prefix_bytes > 0 &&
      existing.prefix_hash !==
        filePrefixHash(session.jsonlPath, existing.prefix_bytes);
    const rewrittenAtSameSize =
      existing !== null &&
      existing.indexed_offset === stat.size &&
      existing.usage_indexed_offset === stat.size &&
      existing.file_size === stat.size &&
      existing.file_mtime_ms !== stat.mtimeMs;
    const mustReset =
      existing !== null &&
      (existing.jsonl_path !== session.jsonlPath ||
        stat.size < existing.indexed_offset ||
        stat.size < existing.usage_indexed_offset ||
        identityChanged ||
        prefixChanged ||
        rewrittenAtSameSize);

    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO search_transcripts(
             thread_key,
             session_id,
             source,
             jsonl_path,
             project_name,
             project_path,
             title,
             git_branch,
             last_event_ms,
             file_dev,
             file_ino,
             file_size,
             file_mtime_ms,
             prefix_bytes,
             prefix_hash
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          key,
          session.sessionId,
          session.source,
          session.jsonlPath,
          session.projectName,
          session.projectPath,
          session.title,
          session.gitBranch,
          session.lastEventMs,
          stat.dev,
          stat.ino,
          stat.size,
          stat.mtimeMs,
          Math.min(stat.size, 4096),
          filePrefixHash(session.jsonlPath, Math.min(stat.size, 4096)),
        );
      existing = this.transcript(key);
    } else if (mustReset) {
      this.db.exec('BEGIN');
      try {
        this.db
          .prepare(
            `DELETE FROM search_documents
             WHERE thread_key = ? AND origin = 'transcript'`,
          )
          .run(key);
        this.db
          .prepare(
            `UPDATE search_transcripts
             SET indexed_offset = 0,
                 usage_indexed_offset = 0,
                 usage_model = '',
                 usage_provider = '',
                 last_fingerprint = '',
                 file_dev = ?,
                 file_ino = ?,
                 file_size = ?,
                 file_mtime_ms = ?,
                 prefix_bytes = ?,
                 prefix_hash = ?,
                 jsonl_path = ?
             WHERE thread_key = ?`,
          )
          .run(
            stat.dev,
            stat.ino,
            stat.size,
            stat.mtimeMs,
            Math.min(stat.size, 4096),
            filePrefixHash(session.jsonlPath, Math.min(stat.size, 4096)),
            session.jsonlPath,
            key,
          );
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
      existing = this.transcript(key);
    }
    if (!existing) return;

    this.updateMetadata(session, existing);
    const startOffset = processedOffset(existing);
    if (
      existing.indexed_offset >= stat.size &&
      existing.usage_indexed_offset >= stat.size
    ) {
      this.updateFileState(
        key,
        existing.indexed_offset,
        existing.usage_indexed_offset,
        existing.last_fingerprint,
        existing.usage_model,
        existing.usage_provider,
        stat,
      );
      return;
    }

    let searchOffset = existing.indexed_offset;
    let usageOffset = existing.usage_indexed_offset;
    let lastFingerprint = existing.last_fingerprint;
    let usageModel = existing.usage_model;
    let usageProvider = existing.usage_provider;
    let transactionOpen = false;
    const begin = () => {
      if (!transactionOpen) {
        this.db.exec('BEGIN');
        transactionOpen = true;
      }
    };
    const commit = () => {
      if (!transactionOpen) return;
      this.updateFileState(
        key,
        searchOffset,
        usageOffset,
        lastFingerprint,
        usageModel,
        usageProvider,
        stat,
      );
      this.db.exec('COMMIT');
      transactionOpen = false;
      onOffset(Math.min(searchOffset, usageOffset));
    };

    try {
      begin();
      let commitBase = startOffset;
      for await (const line of readCompleteJsonlLines(
        session.jsonlPath,
        startOffset,
        stat.size,
      )) {
        if (line.endOffset > searchOffset) {
          for (const document of extractSearchDocuments(line.raw, session.source)) {
            const fingerprint = searchFingerprint(document.kind, document.body);
            if (fingerprint === lastFingerprint) continue;
            this.addDocument(
              key,
              'transcript',
              document.kind,
              document.timestamp,
              document.body,
            );
            lastFingerprint = fingerprint;
          }
          searchOffset = line.endOffset;
        }
        if (line.endOffset > usageOffset) {
          const extracted = extractUsageFromLine(
            line.raw,
            session.source,
            usageModel,
            usageProvider,
            line.endOffset,
            key,
          );
          usageModel = extracted.model;
          usageProvider = extracted.provider;
          if (extracted.sample) this.addUsageSample(extracted.sample);
          usageOffset = line.endOffset;
        }
        const processed = Math.min(searchOffset, usageOffset);
        if (processed - commitBase >= COMMIT_AFTER_BYTES) {
          commit();
          commitBase = processed;
          await yieldToWorkerLoop();
          begin();
        }
      }
      commit();
    } catch (error) {
      if (transactionOpen) this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private updateMetadata(
    session: IndexableThread,
    existing: TranscriptRow,
  ): void {
    const signature = metadataSignature(session);
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          `UPDATE search_transcripts
           SET session_id = ?,
               source = ?,
               jsonl_path = ?,
               project_name = ?,
               project_path = ?,
               title = ?,
               git_branch = ?,
               last_event_ms = ?
           WHERE thread_key = ?`,
        )
        .run(
          session.sessionId,
          session.source,
          session.jsonlPath,
          session.projectName,
          session.projectPath,
          session.title,
          session.gitBranch,
          session.lastEventMs,
          existing.thread_key,
        );
      if (signature !== existing.metadata_signature) {
        const metadata = searchableMetadata(session);
        this.db
          .prepare(
            `DELETE FROM search_documents
             WHERE thread_key = ? AND origin = 'metadata'`,
          )
          .run(existing.thread_key);
        this.insertDocument.run(
          existing.thread_key,
          'metadata',
          'metadata',
          '',
          metadata.title,
          metadata.project,
          '',
          '',
          '',
          '',
        );
        this.changedDocuments += 1;
        this.db
          .prepare(
            `UPDATE search_transcripts
             SET metadata_signature = ?
             WHERE thread_key = ?`,
          )
          .run(signature, existing.thread_key);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private addDocument(
    threadKeyValue: string,
    origin: 'transcript' | 'sidechat',
    kind: SearchMatchKind,
    timestamp: string,
    body: string,
  ): void {
    const columns = textColumns(kind, body);
    this.insertDocument.run(
      threadKeyValue,
      origin,
      kind,
      timestamp,
      '',
      '',
      columns.user,
      columns.assistant,
      columns.tool,
      columns.error,
    );
    this.changedDocuments += 1;
  }

  private addUsageSample(sample: StoredUsageSample): void {
    if (sample.timestampMs < Date.now() - USAGE_RETENTION_MS) return;
    this.insertUsageSample.run(
      sample.sampleKey,
      sample.timestampMs,
      sample.provider,
      sample.model,
      sample.local ? 1 : 0,
      sample.inputTokens,
      sample.cachedInputTokens,
      sample.cacheWrite5mInputTokens,
      sample.cacheWrite1hInputTokens,
      sample.outputTokens,
      sample.reasoningOutputTokens,
    );
  }

  private pruneExpiredUsageSamples(): void {
    this.db
      .prepare('DELETE FROM token_usage_samples WHERE timestamp_ms < ?')
      .run(Date.now() - USAGE_RETENTION_MS);
  }

  private updateFileState(
    key: string,
    searchOffset: number,
    usageOffset: number,
    lastFingerprint: string,
    usageModel: string,
    usageProvider: string,
    stat: fs.Stats,
  ): void {
    this.db
      .prepare(
        `UPDATE search_transcripts
         SET indexed_offset = ?,
             usage_indexed_offset = ?,
             usage_model = ?,
             usage_provider = ?,
             last_fingerprint = ?,
             file_dev = ?,
             file_ino = ?,
             file_size = ?,
             file_mtime_ms = ?
         WHERE thread_key = ?`,
      )
      .run(
        searchOffset,
        usageOffset,
        usageModel,
        usageProvider,
        lastFingerprint,
        stat.dev,
        stat.ino,
        stat.size,
        stat.mtimeMs,
        key,
      );
  }

  private transcript(key: string): TranscriptRow | null {
    return (
      (this.db
        .prepare(
          `SELECT
             thread_key,
             jsonl_path,
             file_dev,
             file_ino,
             file_size,
             file_mtime_ms,
             prefix_bytes,
             prefix_hash,
             indexed_offset,
             usage_indexed_offset,
             usage_model,
             usage_provider,
             metadata_signature,
             sidechat_signature,
             last_fingerprint,
             last_event_ms
           FROM search_transcripts
           WHERE thread_key = ?`,
        )
        .get(key) as unknown as TranscriptRow | undefined) ?? null
    );
  }

  private pruneMissing(visibleKeys: Set<string>): void {
    const existing = this.db
      .prepare('SELECT thread_key FROM search_transcripts')
      .all() as unknown as Array<{ thread_key: string }>;
    const stale = existing.filter((row) => !visibleKeys.has(row.thread_key));
    if (stale.length === 0) return;
    this.db.exec('BEGIN');
    try {
      const remove = this.db.prepare(
        'DELETE FROM search_transcripts WHERE thread_key = ?',
      );
      for (const row of stale) remove.run(row.thread_key);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

export function buildFtsQuery(input: string): string | null {
  const normalized = input.normalize('NFKC').toLocaleLowerCase();
  const tokens =
    normalized.match(/[\p{L}\p{N}]+/gu)?.slice(0, MAX_QUERY_TOKENS) ?? [];
  if (tokens.length === 0) return null;
  if (tokens.length === 1 && tokens[0]!.length < 3) return null;
  const prefixLast = !/\s$/u.test(input) && tokens.at(-1)!.length >= 3;
  return tokens
    .map((token, index) => {
      const quoted = `"${token.replaceAll('"', '""')}"`;
      return prefixLast && index === tokens.length - 1 ? `${quoted}*` : quoted;
    })
    .join(' AND ');
}

function initializeSchema(db: DatabaseSync): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA secure_delete = FAST;
    PRAGMA busy_timeout = 250;
  `);
  const version = Number(
    (db.prepare('PRAGMA user_version').get() as { user_version?: number })
      .user_version ?? 0,
  );
  if (
    version !== 0 &&
    version !== 1 &&
    version !== 2 &&
    version !== SCHEMA_VERSION
  ) {
    db.exec(`
      DROP TRIGGER IF EXISTS search_documents_ai;
      DROP TRIGGER IF EXISTS search_documents_ad;
      DROP TABLE IF EXISTS search_documents_fts;
      DROP TABLE IF EXISTS search_documents;
      DROP TABLE IF EXISTS token_usage_samples;
      DROP TABLE IF EXISTS search_transcripts;
    `);
  }
  if (version === 2) {
    // v2 was only used by pre-release token-insights builds. Its per-thread
    // samples multiplied forked Codex history and cannot be migrated safely;
    // preserve the search index and rebuild just the local counters.
    db.exec(`
      DROP TABLE IF EXISTS token_usage_samples;
      UPDATE search_transcripts
      SET usage_indexed_offset = 0,
          usage_model = '',
          usage_provider = '';
    `);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS search_transcripts(
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
      usage_indexed_offset INTEGER NOT NULL DEFAULT 0,
      usage_model TEXT NOT NULL DEFAULT '',
      usage_provider TEXT NOT NULL DEFAULT '',
      metadata_signature TEXT NOT NULL DEFAULT '',
      sidechat_signature TEXT NOT NULL DEFAULT '',
      last_fingerprint TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS search_documents(
      id INTEGER PRIMARY KEY,
      thread_key TEXT NOT NULL
        REFERENCES search_transcripts(thread_key) ON DELETE CASCADE,
      origin TEXT NOT NULL,
      kind TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      title TEXT NOT NULL,
      project TEXT NOT NULL,
      user_text TEXT NOT NULL,
      assistant_text TEXT NOT NULL,
      tool_text TEXT NOT NULL,
      error_text TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS search_documents_thread
      ON search_documents(thread_key, origin);

    CREATE TABLE IF NOT EXISTS token_usage_samples(
      sample_key TEXT PRIMARY KEY,
      timestamp_ms INTEGER NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      local INTEGER NOT NULL DEFAULT 0 CHECK(local IN (0, 1)),
      input_tokens INTEGER NOT NULL DEFAULT 0,
      cached_input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_5m_input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_1h_input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_output_tokens INTEGER NOT NULL DEFAULT 0
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS token_usage_time
      ON token_usage_samples(timestamp_ms, provider, model);

    CREATE VIRTUAL TABLE IF NOT EXISTS search_documents_fts USING fts5(
      title,
      project,
      user_text,
      assistant_text,
      tool_text,
      error_text,
      content='search_documents',
      content_rowid='id',
      tokenize='unicode61 remove_diacritics 2',
      prefix='2 3 4'
    );

    CREATE TRIGGER IF NOT EXISTS search_documents_ai
    AFTER INSERT ON search_documents BEGIN
      INSERT INTO search_documents_fts(
        rowid,
        title,
        project,
        user_text,
        assistant_text,
        tool_text,
        error_text
      ) VALUES (
        new.id,
        new.title,
        new.project,
        new.user_text,
        new.assistant_text,
        new.tool_text,
        new.error_text
      );
    END;

    CREATE TRIGGER IF NOT EXISTS search_documents_ad
    AFTER DELETE ON search_documents BEGIN
      INSERT INTO search_documents_fts(
        search_documents_fts,
        rowid,
        title,
        project,
        user_text,
        assistant_text,
        tool_text,
        error_text
      ) VALUES (
        'delete',
        old.id,
        old.title,
        old.project,
        old.user_text,
        old.assistant_text,
        old.tool_text,
        old.error_text
      );
    END;

    PRAGMA user_version = ${SCHEMA_VERSION};
  `);
  ensureColumn(
    db,
    'search_transcripts',
    'usage_indexed_offset',
    "INTEGER NOT NULL DEFAULT 0",
  );
  ensureColumn(
    db,
    'search_transcripts',
    'usage_model',
    "TEXT NOT NULL DEFAULT ''",
  );
  ensureColumn(
    db,
    'search_transcripts',
    'usage_provider',
    "TEXT NOT NULL DEFAULT ''",
  );
  db.exec(`
    INSERT INTO search_documents_fts(search_documents_fts, rank)
    VALUES('rank', 'bm25(30.0, 12.0, 6.0, 4.0, 2.0, 5.0)');
  `);
}

function ensureColumn(
  db: DatabaseSync,
  table: string,
  column: string,
  declaration: string,
): void {
  const columns = db
    .prepare(`PRAGMA table_info(${table})`)
    .all() as unknown as Array<{ name: string }>;
  if (columns.some((candidate) => candidate.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
}

function processedOffset(row: TranscriptRow | null | undefined): number {
  return row ? Math.min(row.indexed_offset, row.usage_indexed_offset) : 0;
}

function usageRangeBounds(
  rangeDays: UsageAnalyticsQuery['rangeDays'],
  nowMs: number,
): { startMs: number; endMs: number } {
  const now = new Date(nowMs);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const start = new Date(end);
  start.setDate(start.getDate() - (rangeDays === 90 ? 90 : 365));
  return { startMs: start.getTime(), endMs: end.getTime() };
}

async function* readCompleteJsonlLines(
  filePath: string,
  startOffset: number,
  endOffset: number,
): AsyncGenerator<{ raw: string; endOffset: number }> {
  if (endOffset <= startOffset) return;
  const stream = fs.createReadStream(filePath, {
    start: startOffset,
    end: endOffset - 1,
    highWaterMark: READ_CHUNK_BYTES,
  });
  let chunkOffset = startOffset;
  let pieces: Buffer[] = [];
  let lineBytes = 0;
  let oversized = false;

  for await (const value of stream) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    let segmentStart = 0;
    for (let index = 0; index < chunk.length; index += 1) {
      if (chunk[index] !== 0x0a) continue;
      const segment = chunk.subarray(segmentStart, index);
      if (!oversized && lineBytes + segment.length <= MAX_JSONL_LINE_BYTES) {
        pieces.push(segment);
        lineBytes += segment.length;
      }
      const completeOffset = chunkOffset + index + 1;
      if (!oversized) {
        yield {
          raw: Buffer.concat(pieces, lineBytes).toString('utf8'),
          endOffset: completeOffset,
        };
      } else {
        yield { raw: '', endOffset: completeOffset };
      }
      pieces = [];
      lineBytes = 0;
      oversized = false;
      segmentStart = index + 1;
    }
    const remainder = chunk.subarray(segmentStart);
    if (!oversized && lineBytes + remainder.length <= MAX_JSONL_LINE_BYTES) {
      pieces.push(remainder);
      lineBytes += remainder.length;
    } else {
      pieces = [];
      lineBytes = 0;
      oversized = true;
    }
    chunkOffset += chunk.length;
  }
  // An unterminated final record is intentionally left for the next append.
}

function textColumns(
  kind: SearchMatchKind,
  body: string,
): { user: string; assistant: string; tool: string; error: string } {
  return {
    user: kind === 'user' || kind === 'side_user' ? body : '',
    assistant:
      kind === 'assistant' || kind === 'side_assistant' ? body : '',
    tool: kind === 'tool' ? body : '',
    error: kind === 'error' ? body : '',
  };
}

function parseSnippet(value: string): SearchSnippetPart[] {
  if (!value) return [];
  const parts: SearchSnippetPart[] = [];
  let remaining = value;
  let matching = false;
  while (remaining.length > 0) {
    const marker = matching ? SNIPPET_END : SNIPPET_START;
    const index = remaining.indexOf(marker);
    const text = index === -1 ? remaining : remaining.slice(0, index);
    if (text) parts.push({ text, match: matching });
    if (index === -1) break;
    remaining = remaining.slice(index + marker.length);
    matching = !matching;
  }
  return parts;
}

function threadKey(session: IndexableThread): string {
  return `${session.source}:${session.sessionId}`;
}

function metadataSignature(session: IndexableThread): string {
  const metadata = searchableMetadata(session);
  return searchFingerprint(
    'metadata',
    [
      metadata.title,
      metadata.project,
    ].join('\u0000'),
  );
}

function searchableMetadata(session: IndexableThread): {
  title: string;
  project: string;
} {
  return {
    title: normalizeSearchText(session.title),
    project: normalizeSearchText(
      [
        session.projectName,
        session.projectPath,
        session.gitBranch,
        session.source,
        session.sessionId,
      ].join(' '),
    ),
  };
}

function sideChatSignature(chat: IndexableSideChat): string {
  return searchFingerprint(
    'sidechat',
    `${chat.updatedAt}\u0000${chat.turns.length}\u0000${
      chat.turns.at(-1)?.content ?? ''
    }`,
  );
}

function searchFingerprint(kind: SearchDocumentKind | string, body: string): string {
  return crypto
    .createHash('sha1')
    .update(kind)
    .update('\u0000')
    .update(body)
    .digest('hex');
}

function filePrefixHash(filePath: string, bytes: number): string {
  if (bytes <= 0) return '';
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(bytes);
    const read = fs.readSync(fd, buffer, 0, bytes, 0);
    return crypto
      .createHash('sha1')
      .update(buffer.subarray(0, read))
      .digest('hex');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Best effort: a failed close should not disable search.
      }
    }
  }
}

function ensurePrivateParent(location: string): void {
  const directory = path.dirname(location);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(directory, 0o700);
  } catch {
    // The containing directory still limits access on supported local filesystems.
  }
}

function secureDatabaseFile(location: string): void {
  try {
    fs.chmodSync(location, 0o600);
  } catch {
    // Best effort on filesystems without POSIX permissions.
  }
}

function yieldToWorkerLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export function readySearchStatus(): SearchIndexStatus {
  return {
    phase: 'ready',
    indexedThreads: 0,
    totalThreads: 0,
    indexedBytes: 0,
    totalBytes: 0,
  };
}
