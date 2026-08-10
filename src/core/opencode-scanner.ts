import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { TIMING } from '../config/defaults.js';
import { extractProjectNameFromCwd } from '../utils/project-name.js';
import { cleanThreadTitle } from '../utils/thread-title.js';
import type { TrackedSession } from '../types/session.js';

const CACHE_SCHEMA = 'aside.opencode.v1';
const MANIFEST_VERSION = 2;
const MODERN_CATALOG_MARKER_VERSION = 1;
const MODERN_CATALOG_MARKER_FILE = '.modern-catalog.json';
// The scanner runs in a dedicated worker every five seconds. A contended vendor
// DB still fails soft so a stuck read cannot starve refreshes or shutdown.
const SQLITE_TIMEOUT_MS = 100;
const SQLITE_MAX_BUFFER = 32 * 1024 * 1024;
const MESSAGE_BATCH_SIZE = 32;
const DEFERRED_MESSAGE_BATCH_SIZE = 8;
const MAX_SYNCHRONOUS_TRANSCRIPT_ROWS = 512;
const DEFERRED_TRANSCRIPT_PAGE_ROWS = 256;
const MAX_MANIFEST_SOURCE_STATES = 20_000;
const MAX_TEXT_CHARS = 64 * 1024;
const MAX_TOOL_INPUT_CHARS = 64 * 1024;
const MAX_ERROR_CHARS = 64 * 1024;
const MAX_TOOL_FIELD_CHARS = 4 * 1024;
const MAX_SHORT_FIELD_CHARS = 1_024;
const MAX_PATH_CHARS = 4 * 1024;
const MAX_JSON_FILE_BYTES = 16 * 1024 * 1024;
const MAX_VENDOR_ID_CHARS = 256;
const CACHE_TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const PROCESS_TEMP_NONCE = randomUUID();
const CACHE_TEMP_PATTERN =
  /^\..+\.(\d+)\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.cache\.tmp$/i;
const PID_PROJECTION_TEMP_PATTERN =
  /^\..+\.jsonl\.(\d+)\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.projection\.tmp$/i;
const LEGACY_PROJECTION_TEMP_PATTERN =
  /^\..+\.jsonl\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.projection\.tmp$/i;
const LEGACY_WRITE_TEMP_PATTERN =
  /^\..+\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.tmp$/i;
const OPEN_NOFOLLOW =
  (fs.constants as unknown as Record<string, number>)['O_NOFOLLOW'] ?? 0;
const OPEN_CLOEXEC =
  (fs.constants as unknown as Record<string, number>)['O_CLOEXEC'] ?? 0;
const OPEN_DIRECTORY =
  (fs.constants as unknown as Record<string, number>)['O_DIRECTORY'] ?? 0;

export interface DiscoveredOpenCodeSession {
  session: TrackedSession;
  jsonlPath: string;
}

export interface OpenCodeScannerOptions {
  databasePath?: string;
  legacyStorageDir?: string;
  cacheDir?: string;
  nowMs?: number;
  includeInternal?: boolean;
  /** Environment used only to resolve OpenCode's default data directory. */
  env?: NodeJS.ProcessEnv;
  /** Explicit test/legacy-runtime seam; normal builds use node:sqlite read-only. */
  sqliteBinary?: string;
}

interface OpenCodeSessionMeta {
  id: string;
  parentId?: string;
  cwd: string;
  title: string;
  version: string;
  providerId: string;
  modelId: string;
  createdMs: number;
  updatedMs: number;
  messageCount: number;
  partCount: number;
  /**
   * Per-session revision derived from session, message, and part rows. The
   * OpenCode database normally runs in WAL mode, so the main database mtime is
   * not a reliable change detector while the writer remains open.
   */
  sourceRevision: string;
}

interface TranscriptRow {
  sessionId: string;
  messageId: string;
  messageCreatedMs: number;
  messageUpdatedMs: number;
  messageCompletedMs: number;
  role: string;
  providerId: string;
  modelId: string;
  finish: string;
  errorName: string;
  errorMessage: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  partId: string;
  partCreatedMs: number;
  partUpdatedMs: number;
  partType: string;
  text: string;
  synthetic: boolean;
  ignored: boolean;
  tool: string;
  toolState: string;
  toolInput: Record<string, unknown>;
  toolTitle: string;
  toolError: string;
  toolStartMs: number;
  toolEndMs: number;
  subtaskPrompt: string;
  subtaskDescription: string;
  subtaskAgent: string;
}

interface NormalizedRecord extends Record<string, unknown> {
  schema: typeof CACHE_SCHEMA;
  id: string;
  sourceId: string;
  timestamp: string;
  type: string;
  sessionId: string;
}

interface NormalizedSource {
  sourceId: string;
  hash: string;
  record: NormalizedRecord;
  text?: string;
}

interface CachedSourceState {
  hash: string;
  textHash?: string;
  textLength?: number;
}

interface CacheManifest {
  version: typeof MANIFEST_VERSION;
  sessionId: string;
  sourceRevision: string;
  databaseMtimeMs: number;
  firstPrompt: string;
  providerId: string;
  modelId: string;
  eventCount: number;
  sources: Record<string, CachedSourceState>;
  sourceStateComplete?: boolean;
}

interface MaterializedMetadata {
  firstPrompt: string;
  providerId: string;
  modelId: string;
  eventCount: number;
}

interface MaterializationResult {
  metadata: Map<string, MaterializedMetadata>;
  excludedSessionIds: Set<string>;
}

interface ReadonlySqlite {
  all(sql: string, params?: readonly string[]): Record<string, unknown>[];
  exactContentRevisions: boolean;
  /** Pins all following statements to one read snapshot when supported. */
  beginSnapshot(): boolean;
  close(): void;
}

interface TranscriptCursor {
  messageCreatedMs: number;
  messageId: string;
  partCreatedMs: number;
  partId: string;
}

interface DeferredSessionProjection {
  meta: OpenCodeSessionMeta;
  cursor: TranscriptCursor | null;
  pendingMessageRows: TranscriptRow[];
  tempPath: string;
  firstPrompt: string;
  providerId: string;
  modelId: string;
  eventCount: number;
  sources: Record<string, CachedSourceState>;
  sourceStateCount: number;
  sourceStateComplete: boolean;
  reader: ReadonlySqlite;
  schema: OpenCodeSchema;
}

interface DeferredProjectionJob {
  key: string;
  databasePath: string;
  sqliteBinary?: string;
  namespace: string;
  databaseMtimeMs: number;
  metas: Map<string, OpenCodeSessionMeta>;
  current: DeferredSessionProjection | null;
  immediate: NodeJS.Immediate | null;
}

const deferredProjectionJobs = new Map<string, DeferredProjectionJob>();
const sqliteCatalogCache = new Map<
  string,
  { sourceGeneration: string; metas: OpenCodeSessionMeta[] }
>();
/** Once modern storage is recognized, transient absence must not revive legacy rows. */
const recognizedModernDatabases = new Set<string>();

/**
 * Discover current SQLite-backed OpenCode threads, falling back to the legacy
 * JSON store only when no usable SQLite catalog exists.
 *
 * The OpenCode database is opened read-only with query_only enabled. Aside
 * never invokes OpenCode migrations and never writes into OpenCode's data
 * directory. The JSONL files returned to the rest of Aside live under
 * ~/.aside/opencode-cache with 0700/0600 permissions.
 */
export function scanOpenCodeSessions(
  options: OpenCodeScannerOptions = {},
): DiscoveredOpenCodeSession[] {
  return scanOpenCodeSessionsWithStatus(options).sessions;
}

export interface OpenCodeScanStatus {
  sessions: DiscoveredOpenCodeSession[];
  /** False means retain the previous roster and retry; absence is not deletion. */
  authoritative: boolean;
}

/** Cancel private background projections before a worker shuts down. */
export function disposeOpenCodeScanner(): void {
  for (const job of deferredProjectionJobs.values()) {
    if (job.immediate) clearImmediate(job.immediate);
    if (job.current) disposeDeferredProjection(job.current);
  }
  deferredProjectionJobs.clear();
  sqliteCatalogCache.clear();
  recognizedModernDatabases.clear();
}

export function scanOpenCodeSessionsWithStatus(
  options: OpenCodeScannerOptions = {},
): OpenCodeScanStatus {
  const nowMs = options.nowMs ?? Date.now();
  const dataDir = resolveOpenCodeDataDir(options.env);
  const databasePath =
    options.databasePath ?? path.join(dataDir, 'opencode.db');
  const legacyStorageDir =
    options.legacyStorageDir ?? path.join(dataDir, 'storage');
  const cacheRoot =
    options.cacheDir ?? path.join(os.homedir(), '.aside', 'opencode-cache');

  const sqlite = scanSqlite(databasePath, cacheRoot, nowMs, options.sqliteBinary);
  // A present modern database exclusively owns the catalog. Locked/malformed
  // reads and private-cache failures are non-authoritative, and a database
  // recognized earlier in this process remains so through transient absence.
  // None of those states may resurrect pre-SQLite transcript content.
  if (sqlite !== null) {
    return {
      sessions: filterInternal(sqlite.sessions, options.includeInternal ?? false),
      authoritative: sqlite.authoritative,
    };
  }

  const legacy = scanLegacy(legacyStorageDir, cacheRoot, nowMs);
  return {
    sessions: filterInternal(legacy.sessions, options.includeInternal ?? false),
    authoritative: legacy.authoritative,
  };
}

/** Resolve the same XDG-aware data root OpenCode uses for sessions and auth. */
export function resolveOpenCodeDataDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const home = env['HOME'] || env['USERPROFILE'] || os.homedir();
  const configured = env['XDG_DATA_HOME'];
  const base = configured && path.isAbsolute(configured)
    ? configured
    : process.platform === 'win32'
      ? env['LOCALAPPDATA'] || path.join(home, 'AppData', 'Local')
      : path.join(home, '.local', 'share');
  return path.join(base, 'opencode');
}

function scanSqlite(
  databasePath: string,
  cacheRoot: string,
  nowMs: number,
  sqliteBinary?: string,
): OpenCodeScanStatus | null {
  const catalogKey = path.resolve(databasePath);
  if (!isRegularFile(databasePath)) {
    const durableRecognition = modernCatalogRecognitionStatus(
      cacheRoot,
      databasePath,
    );
    return (
      recognizedModernDatabases.has(catalogKey) ||
      durableRecognition !== 'absent'
    )
      ? { sessions: [], authoritative: false }
      : null;
  }

  let reader: ReadonlySqlite | null = null;
  try {
    reader = openReadonlySqlite(databasePath, sqliteBinary);
    if (!reader) return { sessions: [], authoritative: false };
    // Pin catalog metadata and any immediate bounded projections to the same
    // SQLite view. The writer may continue appending in WAL mode while Aside
    // reads, but a projection can never mix rows from different revisions.
    reader.beginSnapshot();
    const schemas = inspectSchema(reader);
    if (!schemas) return { sessions: [], authoritative: false };

    const databaseMtimeMs = safeStat(databasePath)?.mtimeMs ?? 0;
    const catalogGeneration = databaseSourceGeneration(databasePath);
    const cachedCatalog = sqliteCatalogCache.get(catalogKey);
    let metas: OpenCodeSessionMeta[] | null;
    if (cachedCatalog?.sourceGeneration === catalogGeneration) {
      metas = cachedCatalog.metas;
    } else {
      metas = readSessionRows(
        reader,
        schemas,
        databaseMtimeMs,
        reader.exactContentRevisions ? '' : catalogGeneration,
      );
      if (metas !== null) {
        sqliteCatalogCache.set(catalogKey, {
          sourceGeneration: catalogGeneration,
          metas,
        });
      }
    }
    if (metas === null) return { sessions: [], authoritative: false };
    recognizedModernDatabases.add(catalogKey);

    ensurePrivateDirectory(cacheRoot);
    const namespace = cacheNamespace(cacheRoot, 'sqlite', databasePath);
    ensurePrivateDirectory(namespace);
    if (
      modernCatalogRecognitionStatus(cacheRoot, databasePath) !== 'recognized'
    ) {
      writeModernCatalogMarker(namespace, databasePath);
    }
    const materialized = materializeSqlite(
      reader,
      schemas,
      metas,
      namespace,
      databaseMtimeMs,
      databasePath,
      sqliteBinary,
      nowMs,
    );

    const sessions = metas.flatMap((meta): DiscoveredOpenCodeSession[] => {
      if (materialized.excludedSessionIds.has(meta.id)) return [];
      const cache = cachePaths(namespace, meta.id);
      const currentManifest = readManifest(cache.manifestPath, meta.id);
      const enrichment = materialized.metadata.get(meta.id) ?? (
        currentManifest?.sourceRevision === meta.sourceRevision
          ? materializedMetadata(currentManifest)
          : undefined
      );
      return [discoveredSession(
        meta,
        cache.snapshotPath,
        nowMs,
        enrichment,
      )];
    });
    return { sessions, authoritative: true };
  } catch {
    return { sessions: [], authoritative: false };
  } finally {
    try { reader?.close(); } catch { /* best-effort read-only close */ }
  }
}

function scanLegacy(
  storageDir: string,
  cacheRoot: string,
  nowMs: number,
): OpenCodeScanStatus {
  const sessionRoot = path.join(storageDir, 'session');
  const sourceStatus = legacySourceStatus(storageDir, sessionRoot);
  if (sourceStatus === 'missing') {
    return { sessions: [], authoritative: true };
  }
  if (sourceStatus === 'unavailable') {
    return { sessions: [], authoritative: false };
  }
  const namespace = cacheNamespace(cacheRoot, 'legacy', storageDir);
  try {
    ensurePrivateDirectory(cacheRoot);
    ensurePrivateDirectory(namespace);
    pruneStaleCacheTemps(namespace, nowMs);
  } catch {
    return { sessions: [], authoritative: false };
  }
  const results: DiscoveredOpenCodeSession[] = [];

  try {
    for (const sessionFile of listJsonFilesTwoLevelsStrict(sessionRoot)) {
      const sessionRead = readJsonRecordWithSignature(sessionFile);
      const raw = sessionRead?.record;
      if (!raw || !sessionRead) return { sessions: results, authoritative: false };
      const id = truncateCodePoints(stringValue(raw['id']), MAX_VENDOR_ID_CHARS + 1);
      if (!isVendorId(id, 'ses')) continue;
      const time = recordValue(raw['time']);
      const model = recordValue(raw['model']);
      const parentId = truncateCodePoints(
        stringValue(raw['parentID'] ?? raw['parent_id']),
        MAX_VENDOR_ID_CHARS + 1,
      );
      const stat = safeStat(sessionFile);
      const meta: OpenCodeSessionMeta = {
        id,
        parentId: isVendorId(parentId, 'ses') ? parentId : undefined,
        cwd: truncateCodePoints(
          stringValue(raw['directory'] ?? raw['cwd']),
          MAX_PATH_CHARS,
        ),
        title: cleanThreadTitle(
          truncateCodePoints(stringValue(raw['title']), MAX_TEXT_CHARS),
        ),
        version: truncateCodePoints(stringValue(raw['version']), MAX_SHORT_FIELD_CHARS),
        providerId: truncateCodePoints(
          stringValue(model['providerID'] ?? model['providerId']),
          MAX_SHORT_FIELD_CHARS,
        ),
        modelId: truncateCodePoints(
          stringValue(model['modelID'] ?? model['id']),
          MAX_SHORT_FIELD_CHARS,
        ),
        createdMs: numericTime(time['created']) || stat?.birthtimeMs || stat?.mtimeMs || 0,
        updatedMs: numericTime(time['updated']) || stat?.mtimeMs || 0,
        messageCount: 0,
        partCount: 0,
        sourceRevision: '',
      };
      const cache = cachePaths(namespace, id);
      const legacy = readLegacyTranscript(
        storageDir,
        meta,
        sessionRead.signature,
      );
      if (legacy) {
        const prior = readManifest(cache.manifestPath, id);
        if (
          !prior ||
          prior.sourceRevision !== String(legacy.revision) ||
          !isPrivateRegularFile(cache.snapshotPath)
        ) {
          writeCanonicalSnapshot(cache.snapshotPath, meta, legacy.sources);
          writeManifest(cache.manifestPath, {
            version: MANIFEST_VERSION,
            sessionId: id,
            sourceRevision: String(legacy.revision),
            databaseMtimeMs: 0,
            firstPrompt: legacy.metadata.firstPrompt,
            providerId: legacy.metadata.providerId,
            modelId: legacy.metadata.modelId,
            eventCount: legacy.metadata.eventCount,
            sources: sourceState(legacy.sources),
            sourceStateComplete: true,
          });
        }
        results.push(
          discoveredSession(meta, cache.snapshotPath, nowMs, legacy.metadata),
        );
        continue;
      }

      ensureHeaderSnapshot(cache.snapshotPath, meta);
      results.push(
        discoveredSession(
          meta,
          cache.snapshotPath,
          nowMs,
          metadataFromManifest(cache.manifestPath),
        ),
      );
    }
  } catch {
    return { sessions: results, authoritative: false };
  }
  return { sessions: results, authoritative: true };
}

function filterInternal(
  sessions: DiscoveredOpenCodeSession[],
  includeInternal: boolean,
): DiscoveredOpenCodeSession[] {
  return includeInternal
    ? sessions
    : sessions.filter(({ session }) => !session.isInternal);
}

function discoveredSession(
  meta: OpenCodeSessionMeta,
  snapshotPath: string,
  nowMs: number,
  enrichment?: MaterializedMetadata,
): DiscoveredOpenCodeSession {
  const updatedMs = meta.updatedMs || meta.createdMs || nowMs;
  const age = Math.max(0, nowMs - updatedMs);
  const status =
    age < TIMING.activeThresholdMs
      ? 'active' as const
      : age < TIMING.idleThresholdMs
        ? 'idle' as const
        : 'history' as const;
  const cwd = meta.cwd || path.dirname(snapshotPath);
  const providerId = enrichment?.providerId || meta.providerId;
  const modelId = enrichment?.modelId || meta.modelId;
  const model = providerId && modelId
    ? `${providerId}/${modelId}`
    : modelId || 'unknown';
  const title =
    preferredTitle(meta.title, enrichment?.firstPrompt) || undefined;

  return {
    jsonlPath: snapshotPath,
    session: {
      id: meta.id,
      source: 'opencode',
      isInternal: Boolean(meta.parentId),
      parentSessionId: meta.parentId,
      projectName: cwd ? extractProjectNameFromCwd(cwd) : 'unknown',
      title,
      projectDir: cwd,
      jsonlPath: snapshotPath,
      cwd,
      gitBranch: 'unknown',
      slug: meta.id.slice(0, 8),
      model,
      version: meta.version,
      usedPercent: 0,
      contextStatus: 'safe',
      status,
      lastEventTime: new Date(updatedMs),
      eventCount: enrichment?.eventCount ?? 0,
      currentActivity: '',
    },
  };
}

function preferredTitle(saved: string, firstPrompt?: string): string {
  const generic = /^new session(?:\s+-|$)/i.test(saved);
  return cleanThreadTitle(generic ? firstPrompt || saved : saved || firstPrompt);
}

interface OpenCodeSchema {
  session: Set<string>;
  message: Set<string>;
  part: Set<string>;
}

function inspectSchema(reader: ReadonlySqlite): OpenCodeSchema | null {
  const session = tableColumns(reader, 'session');
  const message = tableColumns(reader, 'message');
  const part = tableColumns(reader, 'part');
  if (!session.has('id') || !session.has('directory')) return null;
  if (
    !message.has('id') ||
    !message.has('session_id') ||
    !message.has('data')
  ) {
    return null;
  }
  if (
    !part.has('id') ||
    !part.has('message_id') ||
    !part.has('session_id') ||
    !part.has('data')
  ) {
    return null;
  }
  return { session, message, part };
}

function tableColumns(reader: ReadonlySqlite, table: 'session' | 'message' | 'part'): Set<string> {
  try {
    return new Set(
      reader
        .all(`PRAGMA table_info(${table})`)
        .map((row) => stringValue(row['name']))
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

function readSessionRows(
  reader: ReadonlySqlite,
  schema: OpenCodeSchema,
  fallbackUpdatedMs: number,
  sourceGeneration: string,
  sessionIds: string[] = [],
): OpenCodeSessionMeta[] | null {
  const columns = schema.session;
  const value = (name: string, fallback: string): string =>
    columns.has(name) ? `s.${name}` : fallback;
  const revisionTime = (table: 'message' | 'part', alias: string): string => {
    const tableColumns = schema[table];
    if (tableColumns.has('time_updated')) return `${alias}.time_updated`;
    if (tableColumns.has('time_created')) return `${alias}.time_created`;
    return '0';
  };
  const messageRevisionTime = revisionTime('message', 'm');
  const partRevisionTime = revisionTime('part', 'p');
  const sessionModel = value('model', "''");
  const validSessionModel = `json_valid(${sessionModel})`;
  const sessionModelValue = (primary: string, fallback: string): string =>
    `CASE WHEN ${validSessionModel} THEN COALESCE(` +
    `json_extract(${sessionModel}, '${primary}'), ` +
    `json_extract(${sessionModel}, '${fallback}'), '') ELSE '' END`;
  const placeholders = sessionIds.map(() => '?').join(', ');
  const messageFilter = sessionIds.length > 0
    ? `WHERE m.session_id IN (${placeholders})`
    : '';
  const partFilter = sessionIds.length > 0
    ? `WHERE p.session_id IN (${placeholders})`
    : '';
  const sessionFilter = sessionIds.length > 0
    ? `WHERE s.id IN (${placeholders})`
    : '';
  const messageContentRevision = reader.exactContentRevisions
    ? `COALESCE(aside_content_hash(m.id, m.data, ${messageRevisionTime}), '')`
    : "''";
  const partContentRevision = reader.exactContentRevisions
    ? `COALESCE(aside_content_hash(p.id, p.data, ${partRevisionTime}), '')`
    : "''";
  const sql = `
    WITH message_revision AS (
      SELECT
        m.session_id AS session_id,
        COUNT(*) AS message_count,
        COALESCE(MAX(${messageRevisionTime}), 0) AS message_updated,
        CAST(COALESCE(SUM(CAST(${messageRevisionTime} AS REAL)), 0) AS TEXT) AS message_time_sum,
        ${messageContentRevision} AS message_content_revision
      FROM message m
      ${messageFilter}
      GROUP BY m.session_id
    ),
    part_revision AS (
      SELECT
        p.session_id AS session_id,
        COUNT(*) AS part_count,
        COALESCE(MAX(${partRevisionTime}), 0) AS part_updated,
        CAST(COALESCE(SUM(CAST(${partRevisionTime} AS REAL)), 0) AS TEXT) AS part_time_sum,
        ${partContentRevision} AS part_content_revision
      FROM part p
      ${partFilter}
      GROUP BY p.session_id
    )
    SELECT
      substr(s.id, 1, ${MAX_VENDOR_ID_CHARS + 1}) AS id,
      substr(${value('parent_id', "''")}, 1, ${MAX_VENDOR_ID_CHARS + 1}) AS parent_id,
      substr(s.directory, 1, ${MAX_PATH_CHARS}) AS directory,
      substr(${value('title', "''")}, 1, ${MAX_TEXT_CHARS}) AS title,
      substr(${value('version', "''")}, 1, ${MAX_SHORT_FIELD_CHARS}) AS version,
      substr(${sessionModelValue('$.providerID', '$.providerId')}, 1, ${MAX_SHORT_FIELD_CHARS}) AS provider_id,
      substr(${sessionModelValue('$.id', '$.modelID')}, 1, ${MAX_SHORT_FIELD_CHARS}) AS model_id,
      ${value('time_created', '0')} AS time_created,
      ${value('time_updated', value('time_created', '0'))} AS time_updated,
      COALESCE(mr.message_count, 0) AS message_count,
      COALESCE(mr.message_updated, 0) AS message_updated,
      COALESCE(mr.message_time_sum, '0') AS message_time_sum,
      COALESCE(mr.message_content_revision, '') AS message_content_revision,
      COALESCE(pr.part_count, 0) AS part_count,
      COALESCE(pr.part_updated, 0) AS part_updated,
      COALESCE(pr.part_time_sum, '0') AS part_time_sum,
      COALESCE(pr.part_content_revision, '') AS part_content_revision
    FROM session s
    LEFT JOIN message_revision mr ON mr.session_id = s.id
    LEFT JOIN part_revision pr ON pr.session_id = s.id
    ${sessionFilter}
    ORDER BY time_updated DESC, s.id
  `;
  try {
    const params = sessionIds.length > 0
      ? [...sessionIds, ...sessionIds, ...sessionIds]
      : [];
    return reader.all(sql, params).flatMap((row): OpenCodeSessionMeta[] => {
      const id = stringValue(row['id']);
      if (!isVendorId(id, 'ses')) return [];
      const parentId = stringValue(row['parent_id']);
      const sessionUpdatedMs = numericTime(row['time_updated']);
      const messageUpdatedMs = numericTime(row['message_updated']);
      const partUpdatedMs = numericTime(row['part_updated']);
      const messageCount = counter(row['message_count']);
      const partCount = counter(row['part_count']);
      return [{
        id,
        parentId: isVendorId(parentId, 'ses') ? parentId : undefined,
        cwd: truncateCodePoints(stringValue(row['directory']), MAX_PATH_CHARS),
        title: cleanThreadTitle(
          truncateCodePoints(stringValue(row['title']), MAX_TEXT_CHARS),
        ),
        version: truncateCodePoints(stringValue(row['version']), MAX_SHORT_FIELD_CHARS),
        providerId: truncateCodePoints(
          stringValue(row['provider_id']),
          MAX_SHORT_FIELD_CHARS,
        ),
        modelId: truncateCodePoints(
          stringValue(row['model_id']),
          MAX_SHORT_FIELD_CHARS,
        ),
        createdMs: numericTime(row['time_created']),
        updatedMs:
          Math.max(sessionUpdatedMs, messageUpdatedMs, partUpdatedMs) ||
          numericTime(row['time_created']) ||
          fallbackUpdatedMs,
        messageCount,
        partCount,
        sourceRevision: hash({
          id,
          parentId: isVendorId(parentId, 'ses') ? parentId : '',
          directory: stringValue(row['directory']),
          title: stringValue(row['title']),
          version: stringValue(row['version']),
          providerId: stringValue(row['provider_id']),
          modelId: stringValue(row['model_id']),
          sessionUpdatedMs,
          messageCount,
          messageUpdatedMs,
          messageTimeSum: stringValue(row['message_time_sum']),
          messageContentRevision: stringValue(row['message_content_revision']),
          partCount,
          partUpdatedMs,
          partTimeSum: stringValue(row['part_time_sum']),
          partContentRevision: stringValue(row['part_content_revision']),
          sourceGeneration,
        }),
      }];
    });
  } catch {
    return null;
  }
}

function materializeSqlite(
  reader: ReadonlySqlite,
  schema: OpenCodeSchema,
  metas: OpenCodeSessionMeta[],
  namespace: string,
  databaseMtimeMs: number,
  databasePath: string,
  sqliteBinary: string | undefined,
  nowMs: number,
): MaterializationResult {
  ensurePrivateDirectory(namespace);
  pruneStaleCacheTemps(namespace, nowMs);
  const output = new Map<string, MaterializedMetadata>();
  const excludedSessionIds = new Set<string>();
  const pending: OpenCodeSessionMeta[] = [];
  const mustMaterializeNow = new Set<string>();
  const staleProjectionIds = new Set<string>();

  for (const meta of metas) {
    const cache = cachePaths(namespace, meta.id);
    const manifest = readManifest(cache.manifestPath, meta.id);
    const snapshotExists = isPrivateRegularFile(cache.snapshotPath);
    const revisionMatches = manifest?.sourceRevision === meta.sourceRevision;
    if (manifest && snapshotExists && revisionMatches) {
      output.set(meta.id, materializedMetadata(manifest));
    }
    if (
      !manifest ||
      !snapshotExists ||
      !revisionMatches
    ) {
      pending.push(meta);
      if (snapshotExists && !revisionMatches) staleProjectionIds.add(meta.id);
      const estimatedRows = meta.messageCount + meta.partCount;
      if (estimatedRows <= MAX_SYNCHRONOUS_TRANSCRIPT_ROWS && (
        nowMs - meta.updatedMs < TIMING.idleThresholdMs ||
        staleProjectionIds.has(meta.id)
      )) {
        // Existing projections can contain now-deleted private content, so a
        // small rewrite is correctness-critical and stays on the fast path.
        mustMaterializeNow.add(meta.id);
      }
    }
  }

  const immediate = pending.filter((meta) => mustMaterializeNow.has(meta.id));
  const deferred = pending.filter((meta) => !mustMaterializeNow.has(meta.id));
  const deferredIds = new Set(deferred.map((meta) => meta.id));

  // Never keep a changed projection: the revision may represent deletion or
  // redaction. Active large sessions get a bounded projection from this scan's
  // pinned SQLite snapshot so chat/search remain useful while the complete
  // projection is rebuilt in bounded worker turns.
  for (const meta of deferred) {
    const cache = cachePaths(namespace, meta.id);
    const shouldPublishRecent =
      staleProjectionIds.has(meta.id) ||
      nowMs - meta.updatedMs < TIMING.idleThresholdMs;
    if (shouldPublishRecent) {
      try {
        const metadata = materializeBoundedTail(
          reader,
          schema,
          meta,
          cache,
        );
        output.set(meta.id, metadata);
      } catch {
        if (staleProjectionIds.has(meta.id)) {
          if (!invalidateProjection(cache, meta)) excludedSessionIds.add(meta.id);
        } else {
          ensureHeaderSnapshot(cache.snapshotPath, meta, 'building');
        }
      }
    }
  }

  for (let offset = 0; offset < immediate.length; offset += MESSAGE_BATCH_SIZE) {
    const batch = immediate.slice(offset, offset + MESSAGE_BATCH_SIZE);
    const failed = materializeBatch(
      reader,
      schema,
      batch,
      namespace,
      databaseMtimeMs,
      output,
    );
    for (const meta of batch) {
      if (!failed.has(meta.id)) continue;
      if (!invalidateProjection(cachePaths(namespace, meta.id), meta)) {
        excludedSessionIds.add(meta.id);
      }
    }
  }

  scheduleDeferredProjection({
    databasePath,
    sqliteBinary,
    namespace,
    databaseMtimeMs,
    metas: deferred,
  });

  for (const meta of metas) {
    const cache = cachePaths(namespace, meta.id);
    // Live metadata and transcript context stay immediately usable. Historical
    // cache creation is intentionally left to the bounded projection queue.
    if (!deferredIds.has(meta.id) && !excludedSessionIds.has(meta.id)) {
      ensureHeaderSnapshot(cache.snapshotPath, meta);
    }
  }
  pruneMissingCaches(namespace, new Set(metas.map((meta) => meta.id)));
  return { metadata: output, excludedSessionIds };
}

function scheduleDeferredProjection(input: {
  databasePath: string;
  sqliteBinary?: string;
  namespace: string;
  databaseMtimeMs: number;
  metas: OpenCodeSessionMeta[];
}): void {
  const key = `${path.resolve(input.databasePath)}\0${path.resolve(input.namespace)}`;
  const existing = deferredProjectionJobs.get(key);
  if (input.metas.length === 0) {
    if (existing?.immediate) clearImmediate(existing.immediate);
    if (existing?.current) disposeDeferredProjection(existing.current);
    deferredProjectionJobs.delete(key);
    return;
  }
  if (existing) {
    existing.sqliteBinary = input.sqliteBinary;
    existing.databaseMtimeMs = input.databaseMtimeMs;
    // The latest catalog is authoritative: replacing instead of merging also
    // cancels sessions deleted while an older projection job was queued.
    const latest = new Map(input.metas.map((meta) => [meta.id, meta]));
    if (existing.current) {
      const currentMeta = latest.get(existing.current.meta.id);
      if (currentMeta?.sourceRevision === existing.current.meta.sourceRevision) {
        latest.delete(existing.current.meta.id);
      } else {
        disposeDeferredProjection(existing.current);
        existing.current = null;
      }
    }
    existing.metas = latest;
    if (!existing.immediate) queueDeferredProjection(existing);
    return;
  }
  const job: DeferredProjectionJob = {
    key,
    databasePath: input.databasePath,
    sqliteBinary: input.sqliteBinary,
    namespace: input.namespace,
    databaseMtimeMs: input.databaseMtimeMs,
    metas: new Map(input.metas.map((meta) => [meta.id, meta])),
    current: null,
    immediate: null,
  };
  deferredProjectionJobs.set(key, job);
  queueDeferredProjection(job);
}

function queueDeferredProjection(job: DeferredProjectionJob): void {
  job.immediate = setImmediate(() => runDeferredProjection(job));
  job.immediate.unref?.();
}

function runDeferredProjection(job: DeferredProjectionJob): void {
  if (deferredProjectionJobs.get(job.key) !== job) return;
  job.immediate = null;
  if ((job.metas.size === 0 && !job.current) || !isRegularFile(job.databasePath)) {
    if (job.current) disposeDeferredProjection(job.current);
    deferredProjectionJobs.delete(job.key);
    return;
  }

  let reader: ReadonlySqlite | null = null;
  try {
    let schema: OpenCodeSchema | null;
    if (job.current) {
      reader = job.current.reader;
      schema = job.current.schema;
    } else {
      reader = openReadonlySqlite(job.databasePath, job.sqliteBinary);
      if (!reader) throw new Error('OpenCode database is unavailable');
      const stableSnapshot = reader.beginSnapshot();
      schema = inspectSchema(reader);
      if (!schema) throw new Error('OpenCode database schema is unavailable');

      const metas = [...job.metas.values()];
      const small: OpenCodeSessionMeta[] = [];
      let estimatedRows = 0;
      for (const meta of metas) {
        const work = Math.max(1, meta.messageCount + meta.partCount);
        if (
          small.length >= DEFERRED_MESSAGE_BATCH_SIZE ||
          estimatedRows + work > DEFERRED_TRANSCRIPT_PAGE_ROWS
        ) break;
        small.push(meta);
        estimatedRows += work;
      }
      if (small.length > 0) {
        for (const meta of small) job.metas.delete(meta.id);
        materializeBatch(
          reader,
          schema,
          small,
          job.namespace,
          job.databaseMtimeMs,
          new Map(),
        );
      } else {
        const meta = metas[0]!;
        job.metas.delete(meta.id);
        if (stableSnapshot) {
          job.current = startDeferredProjection(
            job.namespace,
            meta,
            reader,
            schema,
          );
        } else {
          // The explicit sqlite3 CLI seam cannot hold a transaction across
          // event-loop turns. One SELECT is still a stable SQLite snapshot, so
          // materialize the session in one worker-only statement instead of
          // ever publishing a mixed multi-connection projection.
          materializeBatch(
            reader,
            schema,
            [meta],
            job.namespace,
            job.databaseMtimeMs,
            new Map(),
          );
        }
      }
    }
    if (job.current) {
      projectDeferredPage(job, reader, schema);
    }
  } catch {
    // A later scanner pass retries from the latest source revision.
    if (job.current) disposeDeferredProjection(job.current);
    deferredProjectionJobs.delete(job.key);
    return;
  } finally {
    // A paged projection owns its pinned reader until it publishes or is
    // cancelled. Every other reader is local to this scheduler turn.
    if (!job.current || job.current.reader !== reader) {
      try { reader?.close(); } catch { /* best-effort read-only close */ }
    }
  }

  if (job.metas.size > 0 || job.current) queueDeferredProjection(job);
  else deferredProjectionJobs.delete(job.key);
}

function startDeferredProjection(
  namespace: string,
  meta: OpenCodeSessionMeta,
  reader: ReadonlySqlite,
  schema: OpenCodeSchema,
): DeferredSessionProjection {
  ensurePrivateDirectory(namespace);
  const cache = cachePaths(namespace, meta.id);
  const tempPath = path.join(
    namespace,
    cacheTempName(path.basename(cache.snapshotPath)),
  );
  fs.writeFileSync(tempPath, `${JSON.stringify(sessionRecord(meta))}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  fs.chmodSync(tempPath, 0o600);
  return {
    meta,
    cursor: null,
    pendingMessageRows: [],
    tempPath,
    firstPrompt: '',
    providerId: meta.providerId,
    modelId: meta.modelId,
    eventCount: 0,
    sources: {},
    sourceStateCount: 0,
    sourceStateComplete: true,
    reader,
    schema,
  };
}

function projectDeferredPage(
  job: DeferredProjectionJob,
  reader: ReadonlySqlite,
  schema: OpenCodeSchema,
): void {
  const projection = job.current;
  if (!projection) return;
  const rows = readTranscriptRows(
    reader,
    schema,
    [projection.meta.id],
    { cursor: projection.cursor, limit: DEFERRED_TRANSCRIPT_PAGE_ROWS },
  );
  for (const group of groupRowsByMessage(rows)) {
    const first = group[0]!;
    const pending = projection.pendingMessageRows[0];
    if (pending && pending.messageId !== first.messageId) {
      appendDeferredSources(
        projection,
        terminalSources(projection.meta, pending),
      );
      projection.pendingMessageRows = [];
    }
    if (projection.pendingMessageRows.length === 0) {
      projection.pendingMessageRows = [first];
      if (first.providerId) projection.providerId = first.providerId;
      if (first.modelId) projection.modelId = first.modelId;
    }
    appendDeferredSources(
      projection,
      partSources(projection.meta, group),
    );
  }
  if (rows.length > 0) projection.cursor = transcriptCursor(rows.at(-1)!);
  if (rows.length >= DEFERRED_TRANSCRIPT_PAGE_ROWS) return;

  const pending = projection.pendingMessageRows[0];
  if (pending) {
    appendDeferredSources(projection, terminalSources(projection.meta, pending));
    projection.pendingMessageRows = [];
  }

  const sourceGeneration = reader.exactContentRevisions
    ? ''
    : databaseSourceGeneration(job.databasePath);
  const latest = readSessionRows(
    reader,
    schema,
    job.databaseMtimeMs,
    sourceGeneration,
    [projection.meta.id],
  )?.[0];
  if (!latest || latest.sourceRevision !== projection.meta.sourceRevision) {
    disposeDeferredProjection(projection);
    job.current = null;
    if (latest) job.metas.set(latest.id, latest);
    return;
  }

  // The pinned reader proves the pages form one coherent snapshot. A second
  // read proves that snapshot is still current before it becomes observable;
  // otherwise a deletion that landed during the rebuild could reappear until
  // the next five-second scan.
  const current = readCurrentSessionMeta(job, projection.meta.id);
  if (!current || current.sourceRevision !== projection.meta.sourceRevision) {
    disposeDeferredProjection(projection);
    job.current = null;
    if (current) job.metas.set(current.id, current);
    return;
  }

  finishDeferredProjection(job.namespace, job.databaseMtimeMs, projection);
  job.current = null;
}

function readCurrentSessionMeta(
  job: DeferredProjectionJob,
  sessionId: string,
): OpenCodeSessionMeta | null {
  let reader: ReadonlySqlite | null = null;
  try {
    reader = openReadonlySqlite(job.databasePath, job.sqliteBinary);
    if (!reader) return null;
    reader.beginSnapshot();
    const schema = inspectSchema(reader);
    if (!schema) return null;
    const databaseMtimeMs = safeStat(job.databasePath)?.mtimeMs ?? 0;
    const sourceGeneration = reader.exactContentRevisions
      ? ''
      : databaseSourceGeneration(job.databasePath);
    return readSessionRows(
      reader,
      schema,
      databaseMtimeMs,
      sourceGeneration,
      [sessionId],
    )?.[0] ?? null;
  } catch {
    return null;
  } finally {
    try { reader?.close(); } catch { /* best-effort read-only close */ }
  }
}

function appendDeferredSources(
  projection: DeferredSessionProjection,
  sources: NormalizedSource[],
): void {
  if (sources.length === 0) return;
  appendPrivateJsonl(
    projection.tempPath,
    sources.map((source) => source.record),
  );
  for (const source of sources) {
    projection.eventCount += 1;
    if (projection.sourceStateComplete) {
      if (projection.sourceStateCount >= MAX_MANIFEST_SOURCE_STATES) {
        projection.sources = {};
        projection.sourceStateCount = 0;
        projection.sourceStateComplete = false;
      } else {
        projection.sources[source.sourceId] = cachedSourceState(source);
        projection.sourceStateCount += 1;
      }
    }
    if (!projection.firstPrompt && source.record['role'] === 'user' && source.text) {
      projection.firstPrompt = cleanThreadTitle(source.text);
    }
  }
}

function partSources(meta: OpenCodeSessionMeta, rows: TranscriptRow[]): NormalizedSource[] {
  return normalizeTranscript(meta, rows).sources.filter(
    (source) =>
      !source.sourceId.endsWith(':usage') &&
      !source.sourceId.endsWith(':turn'),
  );
}

function terminalSources(
  meta: OpenCodeSessionMeta,
  message: TranscriptRow,
): NormalizedSource[] {
  return normalizeTranscript(meta, [{ ...message, partId: '', partType: '' }]).sources.filter(
    (source) => source.sourceId.endsWith(':usage') || source.sourceId.endsWith(':turn'),
  );
}

function transcriptCursor(row: TranscriptRow): TranscriptCursor {
  return {
    messageCreatedMs: row.messageCreatedMs,
    messageId: row.messageId,
    partCreatedMs: row.partCreatedMs,
    partId: row.partId,
  };
}

function finishDeferredProjection(
  namespace: string,
  databaseMtimeMs: number,
  projection: DeferredSessionProjection,
): void {
  const cache = cachePaths(namespace, projection.meta.id);
  fs.renameSync(projection.tempPath, cache.snapshotPath);
  writeManifest(cache.manifestPath, {
    version: MANIFEST_VERSION,
    sessionId: projection.meta.id,
    sourceRevision: projection.meta.sourceRevision,
    databaseMtimeMs,
    firstPrompt: projection.firstPrompt,
    providerId: projection.providerId,
    modelId: projection.modelId,
    eventCount: projection.eventCount,
    sources: projection.sources,
    sourceStateComplete: projection.sourceStateComplete,
  });
}

function disposeDeferredProjection(projection: DeferredSessionProjection): void {
  try { fs.unlinkSync(projection.tempPath); } catch { /* absent or completed */ }
  try { projection.reader.close(); } catch { /* already closed */ }
}

function materializeBatch(
  reader: ReadonlySqlite,
  schema: OpenCodeSchema,
  metas: OpenCodeSessionMeta[],
  namespace: string,
  databaseMtimeMs: number,
  output: Map<string, MaterializedMetadata>,
): Set<string> {
  const failed = new Set<string>();
  if (metas.length === 0) return failed;
  let rows: TranscriptRow[];
  try {
    rows = readTranscriptRows(reader, schema, metas.map((meta) => meta.id));
  } catch {
    if (metas.length === 1) return new Set([metas[0]!.id]);
    const midpoint = Math.ceil(metas.length / 2);
    for (const id of materializeBatch(
      reader,
      schema,
      metas.slice(0, midpoint),
      namespace,
      databaseMtimeMs,
      output,
    )) failed.add(id);
    for (const id of materializeBatch(
      reader,
      schema,
      metas.slice(midpoint),
      namespace,
      databaseMtimeMs,
      output,
    )) failed.add(id);
    return failed;
  }

  const rowsBySession = new Map<string, TranscriptRow[]>();
  for (const row of rows) {
    const list = rowsBySession.get(row.sessionId);
    if (list) list.push(row);
    else rowsBySession.set(row.sessionId, [row]);
  }

  for (const meta of metas) {
    try {
      const normalized = normalizeTranscript(meta, rowsBySession.get(meta.id) ?? []);
      const cache = cachePaths(namespace, meta.id);
      // Canonical replacement is intentionally atomic. An append followed by a
      // separate manifest write can duplicate a delta after SIGKILL between
      // those two operations.
      writeCanonicalSnapshot(cache.snapshotPath, meta, normalized.sources);
      const manifest: CacheManifest = {
        version: MANIFEST_VERSION,
        sessionId: meta.id,
        sourceRevision: meta.sourceRevision,
        databaseMtimeMs,
        firstPrompt: normalized.metadata.firstPrompt,
        providerId: normalized.metadata.providerId,
        modelId: normalized.metadata.modelId,
        eventCount: normalized.metadata.eventCount,
        sources: sourceState(normalized.sources),
        sourceStateComplete: true,
      };
      writeManifest(cache.manifestPath, manifest);
      output.set(meta.id, normalized.metadata);
    } catch {
      // One malformed/oversized session cannot hide the rest of the catalog.
      failed.add(meta.id);
    }
  }
  return failed;
}

function readTranscriptRows(
  reader: ReadonlySqlite,
  schema: OpenCodeSchema,
  sessionIds: string[],
  page?: {
    cursor: TranscriptCursor | null;
    limit: number;
    direction?: 'forward' | 'tail';
  },
): TranscriptRow[] {
  if (sessionIds.length === 0) return [];
  const messageUpdated = schema.message.has('time_updated')
    ? 'm.time_updated'
    : schema.message.has('time_created')
      ? 'm.time_created'
      : '0';
  const messageCreated = schema.message.has('time_created') ? 'm.time_created' : '0';
  const partUpdated = schema.part.has('time_updated')
    ? 'p.time_updated'
    : schema.part.has('time_created')
      ? 'p.time_created'
      : '0';
  const partCreated = schema.part.has('time_created') ? 'p.time_created' : '0';
  const validMessage = 'json_valid(m.data)';
  const validPart = "p.data IS NOT NULL AND json_valid(p.data)";
  const messageJson = (pathValue: string, fallback = "''"): string =>
    `CASE WHEN ${validMessage} THEN COALESCE(json_extract(m.data, '${pathValue}'), ${fallback}) ELSE ${fallback} END`;
  const partJson = (pathValue: string, fallback = "''"): string =>
    `CASE WHEN ${validPart} THEN COALESCE(json_extract(p.data, '${pathValue}'), ${fallback}) ELSE ${fallback} END`;
  const placeholders = sessionIds.map(() => '?').join(', ');
  const cursorFilter = page?.cursor
    ? `AND (
         ${messageCreated}, m.id, ${partCreated}, COALESCE(p.id, '')
       ) > (CAST(? AS INTEGER), ?, CAST(? AS INTEGER), ?)`
    : '';
  const limit = page ? `LIMIT ${Math.max(1, Math.floor(page.limit))}` : '';
  const descending = page?.direction === 'tail';
  const order = descending ? 'DESC' : 'ASC';
  const sql = `
    SELECT
      m.session_id AS session_id,
      m.id AS message_id,
      ${messageCreated} AS message_created,
      ${messageUpdated} AS message_updated,
      ${messageJson('$.time.completed', '0')} AS message_completed,
      substr(${messageJson('$.role')}, 1, ${MAX_SHORT_FIELD_CHARS}) AS role,
      substr(${messageJson('$.providerID', messageJson('$.model.providerID'))}, 1, ${MAX_SHORT_FIELD_CHARS}) AS provider_id,
      substr(${messageJson('$.modelID', messageJson('$.model.modelID'))}, 1, ${MAX_SHORT_FIELD_CHARS}) AS model_id,
      substr(${messageJson('$.finish')}, 1, ${MAX_SHORT_FIELD_CHARS}) AS finish,
      substr(${messageJson('$.error.name')}, 1, ${MAX_SHORT_FIELD_CHARS}) AS error_name,
      substr(${messageJson('$.error.data.message', messageJson('$.error.message'))}, 1, ${MAX_ERROR_CHARS}) AS error_message,
      ${messageJson('$.tokens.input', '0')} AS input_tokens,
      ${messageJson('$.tokens.output', '0')} AS output_tokens,
      ${messageJson('$.tokens.reasoning', '0')} AS reasoning_tokens,
      ${messageJson('$.tokens.cache.read', '0')} AS cache_read_tokens,
      ${messageJson('$.tokens.cache.write', '0')} AS cache_write_tokens,
      COALESCE(p.id, '') AS part_id,
      ${partCreated} AS part_created,
      ${partUpdated} AS part_updated,
      substr(${partJson('$.type')}, 1, ${MAX_SHORT_FIELD_CHARS}) AS part_type,
      substr(${partJson('$.text')}, 1, ${MAX_TEXT_CHARS}) AS text,
      ${partJson('$.synthetic', '0')} AS synthetic,
      ${partJson('$.ignored', '0')} AS ignored,
      substr(${partJson('$.tool')}, 1, ${MAX_SHORT_FIELD_CHARS}) AS tool,
      substr(${partJson('$.state.status')}, 1, ${MAX_SHORT_FIELD_CHARS}) AS tool_state,
      substr(${partJson('$.state.input.command')}, 1, ${MAX_TOOL_FIELD_CHARS}) AS tool_command,
      substr(${partJson('$.state.input.filePath')}, 1, ${MAX_TOOL_FIELD_CHARS}) AS tool_file_path,
      substr(${partJson('$.state.input.file_path')}, 1, ${MAX_TOOL_FIELD_CHARS}) AS tool_file_path_snake,
      substr(${partJson('$.state.input.path')}, 1, ${MAX_TOOL_FIELD_CHARS}) AS tool_path,
      substr(${partJson('$.state.input.pattern')}, 1, ${MAX_TOOL_FIELD_CHARS}) AS tool_pattern,
      substr(${partJson('$.state.input.query')}, 1, ${MAX_TOOL_FIELD_CHARS}) AS tool_query,
      substr(${partJson('$.state.input.url')}, 1, ${MAX_TOOL_FIELD_CHARS}) AS tool_url,
      substr(${partJson('$.state.input.description')}, 1, ${MAX_TOOL_FIELD_CHARS}) AS tool_description,
      substr(${partJson('$.state.input.question')}, 1, ${MAX_TOOL_FIELD_CHARS}) AS tool_question,
      substr(${partJson('$.state.input.prompt')}, 1, ${MAX_TOOL_FIELD_CHARS}) AS tool_prompt,
      substr(${partJson('$.state.input.questions[0].question')}, 1, ${MAX_TOOL_FIELD_CHARS}) AS tool_first_question,
      substr(${partJson('$.state.input.questions[0].prompt')}, 1, ${MAX_TOOL_FIELD_CHARS}) AS tool_first_prompt,
      substr(${partJson('$.state.input.questions[0].header')}, 1, ${MAX_TOOL_FIELD_CHARS}) AS tool_first_header,
      substr(${partJson('$.state.title')}, 1, ${MAX_SHORT_FIELD_CHARS}) AS tool_title,
      substr(${partJson('$.state.error')}, 1, ${MAX_ERROR_CHARS}) AS tool_error,
      ${partJson('$.state.time.start', '0')} AS tool_start,
      ${partJson('$.state.time.end', '0')} AS tool_end,
      substr(${partJson('$.prompt')}, 1, ${MAX_TEXT_CHARS}) AS subtask_prompt,
      substr(${partJson('$.description')}, 1, 4096) AS subtask_description,
      substr(${partJson('$.agent')}, 1, 1024) AS subtask_agent
    FROM message m
    LEFT JOIN part p ON p.message_id = m.id AND p.session_id = m.session_id
    WHERE m.session_id IN (${placeholders})
    ${cursorFilter}
    ORDER BY m.session_id ${order}, ${messageCreated} ${order}, m.id ${order}, ${partCreated} ${order}, p.id ${order}
    ${limit}
  `;

  const params = page?.cursor
    ? [
        ...sessionIds,
        String(page.cursor.messageCreatedMs),
        page.cursor.messageId,
        String(page.cursor.partCreatedMs),
        page.cursor.partId,
      ]
    : sessionIds;
  const rows = reader.all(sql, params).flatMap((row): TranscriptRow[] => {
      const sessionId = stringValue(row['session_id']);
      const messageId = stringValue(row['message_id']);
      const partId = stringValue(row['part_id']);
      if (
        !isVendorId(sessionId, 'ses') ||
        !isVendorId(messageId, 'msg') ||
        (partId && !isVendorId(partId, 'prt'))
      ) return [];
    return [{
      sessionId,
      messageId,
      messageCreatedMs: numericTime(row['message_created']),
      messageUpdatedMs: numericTime(row['message_updated']),
      messageCompletedMs: numericTime(row['message_completed']),
      role: stringValue(row['role']),
      providerId: stringValue(row['provider_id']),
      modelId: stringValue(row['model_id']),
      finish: stringValue(row['finish']),
      errorName: stringValue(row['error_name']),
      errorMessage: stringValue(row['error_message']),
      inputTokens: counter(row['input_tokens']),
      outputTokens: counter(row['output_tokens']),
      reasoningTokens: counter(row['reasoning_tokens']),
      cacheReadTokens: counter(row['cache_read_tokens']),
      cacheWriteTokens: counter(row['cache_write_tokens']),
      partId,
      partCreatedMs: numericTime(row['part_created']),
      partUpdatedMs: numericTime(row['part_updated']),
      partType: stringValue(row['part_type']),
      text: stringValue(row['text']),
      synthetic: booleanValue(row['synthetic']),
      ignored: booleanValue(row['ignored']),
      tool: stringValue(row['tool']),
      toolState: stringValue(row['tool_state']),
      toolInput: projectToolInput({
        command: row['tool_command'],
        filePath: row['tool_file_path'],
        file_path: row['tool_file_path_snake'],
        path: row['tool_path'],
        pattern: row['tool_pattern'],
        query: row['tool_query'],
        url: row['tool_url'],
        description: row['tool_description'],
        question: row['tool_question'],
        prompt: row['tool_prompt'],
        questions: [{
          question: row['tool_first_question'],
          prompt: row['tool_first_prompt'],
          header: row['tool_first_header'],
        }],
      }),
      toolTitle: stringValue(row['tool_title']),
      toolError: stringValue(row['tool_error']),
      toolStartMs: numericTime(row['tool_start']),
      toolEndMs: numericTime(row['tool_end']),
      subtaskPrompt: stringValue(row['subtask_prompt']),
      subtaskDescription: stringValue(row['subtask_description']),
      subtaskAgent: stringValue(row['subtask_agent']),
    }];
  });
  return descending ? rows.reverse() : rows;
}

function normalizeTranscript(
  meta: OpenCodeSessionMeta,
  rows: TranscriptRow[],
): { sources: NormalizedSource[]; metadata: MaterializedMetadata } {
  const sources: NormalizedSource[] = [];
  let firstPrompt = '';
  let providerId = meta.providerId;
  let modelId = meta.modelId;
  const messages = groupRowsByMessage(rows);

  for (const messageRows of messages) {
    const message = messageRows[0]!;
    if (message.providerId) providerId = message.providerId;
    if (message.modelId) modelId = message.modelId;

    for (const row of messageRows) {
      if (!row.partId) continue;
      const timestamp = toIso(
        row.partType === 'tool'
          ? row.toolEndMs || row.toolStartMs || row.partUpdatedMs || row.messageCreatedMs
          : row.partCreatedMs || row.messageCreatedMs,
      );
      if (row.partType === 'text' && !row.ignored && row.text) {
        if (row.role === 'user' && !firstPrompt && !row.synthetic) {
          firstPrompt = cleanThreadTitle(row.text);
        }
        const base = {
          schema: CACHE_SCHEMA,
          id: `${row.partId}:text:${hash(row.text).slice(0, 12)}`,
          sourceId: row.partId,
          timestamp,
          type: 'text',
          sessionId: meta.id,
          messageId: row.messageId,
          role: row.role,
          providerID: row.providerId,
          modelID: row.modelId,
          synthetic: row.synthetic,
          update: 'replace',
          text: row.text,
        } satisfies NormalizedRecord;
        sources.push(normalizedSource(row.partId, base, row.text));
        continue;
      }

      if (row.partType === 'tool' && row.tool) {
        const record = {
          schema: CACHE_SCHEMA,
          id: `${row.partId}:tool:${row.toolState || 'pending'}:${hash({
            tool: row.tool,
            state: row.toolState,
            input: row.toolInput,
            title: row.toolTitle,
            error: row.toolError,
          }).slice(0, 12)}`,
          sourceId: row.partId,
          timestamp,
          type: 'tool',
          sessionId: meta.id,
          messageId: row.messageId,
          role: row.role,
          providerID: row.providerId,
          modelID: row.modelId,
          tool: row.tool,
          state: row.toolState || 'pending',
          input: row.toolInput,
          title: row.toolTitle,
          error: row.toolError,
        } satisfies NormalizedRecord;
        sources.push(normalizedSource(row.partId, record));
        continue;
      }

      if (row.partType === 'subtask') {
        const input = {
          prompt: row.subtaskPrompt,
          description: row.subtaskDescription,
          agent: row.subtaskAgent,
        };
        const record = {
          schema: CACHE_SCHEMA,
          id: `${row.partId}:subtask:${hash(input).slice(0, 12)}`,
          sourceId: row.partId,
          timestamp,
          type: 'tool',
          sessionId: meta.id,
          messageId: row.messageId,
          role: row.role,
          providerID: row.providerId,
          modelID: row.modelId,
          tool: 'task',
          state: 'completed',
          input,
          title: row.subtaskDescription || `Delegated to ${row.subtaskAgent}`,
          error: '',
        } satisfies NormalizedRecord;
        sources.push(normalizedSource(row.partId, record));
      }
    }

    if (message.role !== 'assistant') continue;
    const terminal = terminalStatus(message);
    const usage = {
      input: message.inputTokens,
      output: message.outputTokens,
      reasoning: message.reasoningTokens,
      cacheRead: message.cacheReadTokens,
      cacheWrite: message.cacheWriteTokens,
    };
    if (Object.values(usage).some((value) => value > 0)) {
      const sourceId = `${message.messageId}:usage`;
      const record = {
        schema: CACHE_SCHEMA,
        id: sourceId,
        sourceId,
        timestamp: toIso(
          message.messageCompletedMs || message.messageUpdatedMs || message.messageCreatedMs,
        ),
        type: 'usage',
        sessionId: meta.id,
        messageId: message.messageId,
        role: message.role,
        providerID: message.providerId,
        modelID: message.modelId,
        tokens: usage,
      } satisfies NormalizedRecord;
      sources.push(normalizedSource(sourceId, record));
    }
    if (terminal) {
      const sourceId = `${message.messageId}:turn`;
      const record = {
        schema: CACHE_SCHEMA,
        id: `${sourceId}:${terminal.status}`,
        sourceId,
        timestamp: toIso(
          message.messageCompletedMs || message.messageUpdatedMs || message.messageCreatedMs,
        ),
        type: 'turn',
        sessionId: meta.id,
        messageId: message.messageId,
        role: message.role,
        providerID: message.providerId,
        modelID: message.modelId,
        status: terminal.status,
        error: terminal.error,
        durationMs:
          message.messageCompletedMs > message.messageCreatedMs
            ? message.messageCompletedMs - message.messageCreatedMs
            : 0,
      } satisfies NormalizedRecord;
      sources.push(normalizedSource(sourceId, record));
    }
  }

  return {
    sources,
    metadata: {
      firstPrompt,
      providerId,
      modelId,
      eventCount: sources.length,
    },
  };
}

function groupRowsByMessage(rows: TranscriptRow[]): TranscriptRow[][] {
  const groups: TranscriptRow[][] = [];
  let current: TranscriptRow[] = [];
  let currentId = '';
  for (const row of rows) {
    if (row.messageId !== currentId) {
      if (current.length > 0) groups.push(current);
      current = [];
      currentId = row.messageId;
    }
    current.push(row);
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function terminalStatus(
  message: TranscriptRow,
): { status: 'completed' | 'failed' | 'interrupted'; error: string } | null {
  if (message.errorName) {
    const interrupted = /abort|cancel|interrupt/i.test(message.errorName);
    return {
      status: interrupted ? 'interrupted' : 'failed',
      error: message.errorMessage || message.errorName,
    };
  }
  if (!message.messageCompletedMs) return null;
  if (/^tool[-_ ]?calls?$/i.test(message.finish)) return null;
  return { status: 'completed', error: '' };
}

function normalizedSource(
  sourceId: string,
  record: NormalizedRecord,
  text?: string,
): NormalizedSource {
  return { sourceId, record, hash: hash(record), ...(text === undefined ? {} : { text }) };
}

function writeCanonicalSnapshot(
  snapshotPath: string,
  meta: OpenCodeSessionMeta,
  sources: NormalizedSource[],
): void {
  const header = sessionRecord(meta);
  writePrivateJsonl(snapshotPath, [header, ...sources.map((source) => source.record)]);
}

function materializeBoundedTail(
  reader: ReadonlySqlite,
  schema: OpenCodeSchema,
  meta: OpenCodeSessionMeta,
  cache: { snapshotPath: string; manifestPath: string },
): MaterializedMetadata {
  const rows = readTranscriptRows(
    reader,
    schema,
    [meta.id],
    { cursor: null, limit: MAX_SYNCHRONOUS_TRANSCRIPT_ROWS, direction: 'tail' },
  );
  const normalized = normalizeTranscript(meta, rows);
  writePrivateJsonl(cache.snapshotPath, [
    sessionRecord(meta, 'partial'),
    ...normalized.sources.map((source) => source.record),
  ]);
  // A partial snapshot must never masquerade as the completed revision after a
  // crash. The worker publishes a matching manifest only after the full stable
  // projection has been atomically installed.
  try { fs.unlinkSync(cache.manifestPath); } catch { /* absent */ }
  return normalized.metadata;
}

function ensureHeaderSnapshot(
  snapshotPath: string,
  meta: OpenCodeSessionMeta,
  projectionState?: 'building' | 'partial',
): void {
  if (isPrivateRegularFile(snapshotPath)) return;
  try {
    writePrivateJsonl(snapshotPath, [sessionRecord(meta, projectionState)]);
  } catch {
    // Metadata discovery remains useful even if the private cache is unwritable.
  }
}

function invalidateProjection(
  cache: { snapshotPath: string; manifestPath: string },
  meta: OpenCodeSessionMeta,
): boolean {
  try {
    // Atomic replacement removes stale text before the old manifest is
    // discarded. A later scan sees a safe header and retries projection.
    writePrivateJsonl(cache.snapshotPath, [sessionRecord(meta, 'building')]);
    try { fs.unlinkSync(cache.manifestPath); } catch { /* absent or unsafe */ }
    return true;
  } catch {
    // Fail closed: unlinking the exact cache pair cannot follow a symlink and
    // is safer than leaving a prior private transcript addressable.
    try { fs.unlinkSync(cache.snapshotPath); } catch { /* absent */ }
    try { fs.unlinkSync(cache.manifestPath); } catch { /* absent */ }
    return false;
  }
}

function sessionRecord(
  meta: OpenCodeSessionMeta,
  projectionState?: 'building' | 'partial',
): NormalizedRecord {
  return {
    schema: CACHE_SCHEMA,
    id: `${meta.id}:session`,
    sourceId: `${meta.id}:session`,
    timestamp: toIso(meta.createdMs || meta.updatedMs),
    type: 'session',
    sessionId: meta.id,
    cwd: meta.cwd,
    ...(projectionState ? { projectionState } : {}),
    title: meta.title,
    version: meta.version,
    parentSessionId: meta.parentId ?? '',
    providerID: meta.providerId,
    modelID: meta.modelId,
  };
}

function sourceState(sources: NormalizedSource[]): Record<string, CachedSourceState> {
  return Object.fromEntries(
    sources.map((source) => [
      source.sourceId,
      cachedSourceState(source),
    ]),
  );
}

function cachedSourceState(source: NormalizedSource): CachedSourceState {
  return {
    hash: source.hash,
    ...(source.text === undefined
      ? {}
      : {
          textHash: hash(source.text),
          textLength: source.text.length,
        }),
  };
}

function materializedMetadata(manifest: CacheManifest): MaterializedMetadata {
  return {
    firstPrompt: manifest.firstPrompt,
    providerId: manifest.providerId,
    modelId: manifest.modelId,
    eventCount: manifest.eventCount,
  };
}

function metadataFromManifest(manifestPath: string): MaterializedMetadata | undefined {
  const raw = readJsonRecord(manifestPath, true);
  if (!raw) return undefined;
  return {
    firstPrompt: stringValue(raw['firstPrompt']),
    providerId: stringValue(raw['providerId']),
    modelId: stringValue(raw['modelId']),
    eventCount: counter(raw['eventCount']),
  };
}

function readManifest(manifestPath: string, sessionId: string): CacheManifest | null {
  const raw = readJsonRecord(manifestPath, true);
  if (
    !raw ||
    raw['version'] !== MANIFEST_VERSION ||
    raw['sessionId'] !== sessionId
  ) {
    return null;
  }
  const rawSources = recordValue(raw['sources']);
  const sources: Record<string, CachedSourceState> = {};
  for (const [id, value] of Object.entries(rawSources)) {
    const item = recordValue(value);
    const sourceHash = stringValue(item['hash']);
    if (!sourceHash) continue;
    const textHash = stringValue(item['textHash']);
    const textLength = counter(item['textLength']);
    sources[id] = {
      hash: sourceHash,
      ...(textHash ? { textHash, textLength } : {}),
    };
  }
  return {
    version: MANIFEST_VERSION,
    sessionId,
    sourceRevision: stringValue(raw['sourceRevision']),
    databaseMtimeMs: finiteNumber(raw['databaseMtimeMs']),
    firstPrompt: stringValue(raw['firstPrompt']),
    providerId: stringValue(raw['providerId']),
    modelId: stringValue(raw['modelId']),
    eventCount: counter(raw['eventCount']),
    sources,
    sourceStateComplete: raw['sourceStateComplete'] !== false,
  };
}

function writeManifest(manifestPath: string, manifest: CacheManifest): void {
  writePrivateFile(manifestPath, `${JSON.stringify(manifest)}\n`);
}

function cacheNamespace(root: string, kind: string, sourcePath: string): string {
  return path.join(root, `${kind}-${hash(path.resolve(sourcePath)).slice(0, 16)}`);
}

function writeModernCatalogMarker(
  namespace: string,
  databasePath: string,
): void {
  writePrivateFile(
    path.join(namespace, MODERN_CATALOG_MARKER_FILE),
    `${JSON.stringify({
      version: MODERN_CATALOG_MARKER_VERSION,
      databaseHash: hash(path.resolve(databasePath)),
    })}\n`,
  );
}

/**
 * A durable marker prevents a restart during transient database absence from
 * reviving legacy transcripts. An existing but unreadable/incomplete modern
 * namespace is also non-authoritative: it may be the result of a failed marker
 * write and is never evidence that legacy storage became canonical again.
 */
function modernCatalogRecognitionStatus(
  cacheRoot: string,
  databasePath: string,
): 'recognized' | 'absent' | 'unavailable' {
  const rootStatus = existingPrivateDirectoryStatus(cacheRoot);
  if (rootStatus !== 'safe') {
    return rootStatus === 'missing' ? 'absent' : 'unavailable';
  }
  const namespace = cacheNamespace(cacheRoot, 'sqlite', databasePath);
  const namespaceStatus = existingPrivateDirectoryStatus(namespace);
  if (namespaceStatus === 'missing') return 'absent';
  if (namespaceStatus === 'unavailable') return 'unavailable';

  const markerPath = path.join(namespace, MODERN_CATALOG_MARKER_FILE);
  const marker = readJsonRecord(markerPath, true);
  if (!marker) return 'unavailable';
  return (
    marker['version'] === MODERN_CATALOG_MARKER_VERSION &&
    marker['databaseHash'] === hash(path.resolve(databasePath))
  )
    ? 'recognized'
    : 'unavailable';
}

function cachePaths(
  namespace: string,
  sessionId: string,
): { snapshotPath: string; manifestPath: string } {
  const readable = sessionId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 48) || 'session';
  const file = `${readable}-${hash(sessionId).slice(0, 12)}`;
  return {
    snapshotPath: path.join(namespace, `${file}.jsonl`),
    manifestPath: path.join(namespace, `${file}.state.json`),
  };
}

/** Remove only cache pairs whose valid manifest names a now-absent session. */
function pruneMissingCaches(namespace: string, visibleSessionIds: Set<string>): void {
  for (const entry of readDirectory(namespace)) {
    if (!entry.isFile() || !entry.name.endsWith('.state.json')) continue;
    const manifestPath = path.join(namespace, entry.name);
    const raw = readJsonRecord(manifestPath, true);
    const sessionId = stringValue(raw?.['sessionId']);
    if (!sessionId || visibleSessionIds.has(sessionId)) continue;
    const cache = cachePaths(namespace, sessionId);
    // A forged/mismatched manifest cannot select an arbitrary target.
    if (cache.manifestPath !== manifestPath) continue;
    try { fs.unlinkSync(cache.snapshotPath); } catch { /* already absent */ }
    try { fs.unlinkSync(cache.manifestPath); } catch { /* already absent */ }
  }
}

/** Remove abandoned private staging files without racing a live scanner. */
function pruneStaleCacheTemps(namespace: string, nowMs: number): void {
  const active = new Set<string>();
  for (const job of deferredProjectionJobs.values()) {
    if (job.current && path.dirname(job.current.tempPath) === namespace) {
      active.add(path.resolve(job.current.tempPath));
    }
  }

  for (const entry of readDirectory(namespace)) {
    if (!entry.isFile()) continue;
    const currentMatch = CACHE_TEMP_PATTERN.exec(entry.name);
    const pidProjectionMatch = PID_PROJECTION_TEMP_PATTERN.exec(entry.name);
    const legacyMatch = LEGACY_PROJECTION_TEMP_PATTERN.exec(entry.name) ??
      LEGACY_WRITE_TEMP_PATTERN.exec(entry.name);
    if (!currentMatch && !pidProjectionMatch && !legacyMatch) continue;
    const candidate = path.join(namespace, entry.name);
    if (active.has(path.resolve(candidate)) || !isPrivateRegularFile(candidate)) {
      continue;
    }

    const stat = safeLstat(candidate);
    if (!stat) continue;
    const ageMs = Math.max(0, nowMs - stat.mtimeMs);
    const pidMatch = currentMatch ?? pidProjectionMatch;
    if (pidMatch) {
      const ownerPid = Number(pidMatch[1]);
      if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) continue;
      const currentOwner = Boolean(
        currentMatch &&
        ownerPid === process.pid &&
        currentMatch[2] === PROCESS_TEMP_NONCE,
      );
      if (currentOwner) continue;
      // Twenty-four hours is an explicit abort bound for a staging operation.
      // It also prevents PID reuse from retaining a private transcript forever.
      if (ageMs < CACHE_TEMP_MAX_AGE_MS && isLiveProcess(ownerPid)) continue;
    } else {
      if (ageMs < CACHE_TEMP_MAX_AGE_MS) continue;
    }
    try { fs.unlinkSync(candidate); } catch { /* retry on a later scan */ }
  }
}

function isLiveProcess(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function writePrivateJsonl(filePath: string, records: NormalizedRecord[]): void {
  writePrivateFile(
    filePath,
    records.length > 0
      ? `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
      : '',
  );
}

function appendPrivateJsonl(filePath: string, records: NormalizedRecord[]): void {
  if (records.length === 0) return;
  ensurePrivateDirectory(path.dirname(filePath));
  let fd: number | undefined;
  try {
    fd = fs.openSync(
      filePath,
      fs.constants.O_WRONLY | fs.constants.O_APPEND | OPEN_NOFOLLOW | OPEN_CLOEXEC,
    );
    assertPrivateRegularFile(fd, filePath);
    fs.fchmodSync(fd, 0o600);
    fs.writeSync(
      fd,
      `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
      undefined,
      'utf8',
    );
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function writePrivateFile(filePath: string, content: string): void {
  const directory = path.dirname(filePath);
  ensurePrivateDirectory(directory);
  const tempPath = path.join(directory, cacheTempName(path.basename(filePath)));
  try {
    fs.writeFileSync(tempPath, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.chmodSync(tempPath, 0o600);
    fs.renameSync(tempPath, filePath);
  } finally {
    try { fs.unlinkSync(tempPath); } catch { /* renamed or already absent */ }
  }
}

function cacheTempName(baseName: string): string {
  return `.${baseName}.${process.pid}.${PROCESS_TEMP_NONCE}.${randomUUID()}.cache.tmp`;
}

function ensurePrivateDirectory(directory: string): void {
  const resolved = path.resolve(directory);
  const anchor = trustedPathAnchor(resolved);
  const relative = path.relative(anchor, resolved);
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Unsafe cache directory: ${directory}`);
  }

  let current = anchor;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let stat = safeLstat(current);
    if (!stat) {
      try {
        fs.mkdirSync(current, { mode: 0o700 });
      } catch (error) {
        // A racing creator is acceptable only if it produced the directory we
        // would have accepted before creation.
        if (!safeLstat(current)) throw error;
      }
      stat = safeLstat(current);
    }
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Unsafe cache directory: ${current}`);
    }
  }

  let fd: number | undefined;
  try {
    fd = fs.openSync(
      resolved,
      fs.constants.O_RDONLY | OPEN_DIRECTORY | OPEN_NOFOLLOW | OPEN_CLOEXEC,
    );
    const stat = fs.fstatSync(fd);
    if (!stat.isDirectory()) throw new Error(`Unsafe cache directory: ${directory}`);
    assertOwnedByCurrentUser(stat, directory);
    fs.fchmodSync(fd, 0o700);
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* best-effort close */ }
    }
  }
}

function existingPrivateDirectoryStatus(
  directory: string,
): 'safe' | 'missing' | 'unavailable' {
  const resolved = path.resolve(directory);
  const anchor = trustedPathAnchor(resolved);
  const relative = path.relative(anchor, resolved);
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return 'unavailable';
  }

  let current = anchor;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return 'unavailable';
    } catch (error) {
      return isMissingFileError(error) ? 'missing' : 'unavailable';
    }
  }

  let fd: number | undefined;
  try {
    fd = fs.openSync(
      resolved,
      fs.constants.O_RDONLY | OPEN_DIRECTORY | OPEN_NOFOLLOW | OPEN_CLOEXEC,
    );
    const stat = fs.fstatSync(fd);
    if (!stat.isDirectory() || (stat.mode & 0o077) !== 0) return 'unavailable';
    assertOwnedByCurrentUser(stat, directory);
    return 'safe';
  } catch (error) {
    return isMissingFileError(error) ? 'missing' : 'unavailable';
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* best-effort close */ }
    }
  }
}

function trustedPathAnchor(target: string): string {
  const candidates = [os.homedir(), os.tmpdir(), process.cwd()]
    .map((candidate) => path.resolve(candidate))
    .filter((candidate) => isContainedPath(candidate, target))
    .sort((left, right) => right.length - left.length);
  return candidates[0] ?? path.parse(target).root;
}

function isContainedPath(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/**
 * Commutative aggregate for exact per-session content revisioning. Including
 * each row ID makes duplicate payloads independent; XOR keeps the aggregate
 * bounded regardless of transcript size while retaining SHA-256 collision
 * resistance for inserts, updates, and deletions.
 */
function xorContentHash(
  state: Uint8Array,
  ...values: unknown[]
): Uint8Array {
  const digest = createHash('sha256');
  for (const value of values) {
    const encoded = typeof value === 'string'
      ? value
      : Buffer.isBuffer(value) || value instanceof Uint8Array
        ? Buffer.from(value).toString('base64')
        : String(value ?? '');
    digest.update(String(Buffer.byteLength(encoded)));
    digest.update(':');
    digest.update(encoded);
    digest.update('\0');
  }
  const rowHash = digest.digest();
  for (let index = 0; index < state.length; index += 1) {
    state[index] = state[index]! ^ rowHash[index]!;
  }
  return state;
}

/** Bounded fallback change detector for runtimes without node:sqlite aggregates. */
function databaseSourceGeneration(databasePath: string): string {
  const digest = createHash('sha256');
  for (const filePath of [databasePath, `${databasePath}-wal`]) {
    const stat = safeStat(filePath);
    digest.update(filePath);
    if (!stat?.isFile()) {
      digest.update('\0missing\0');
      continue;
    }
    digest.update(
      `\0${stat.dev}\0${stat.ino}\0${stat.size}\0${stat.mtimeMs}\0${stat.ctimeMs}\0`,
    );
    let fd: number | undefined;
    try {
      fd = fs.openSync(filePath, fs.constants.O_RDONLY | OPEN_NOFOLLOW | OPEN_CLOEXEC);
      const sampleBytes = Math.min(stat.size, 8 * 1024);
      if (sampleBytes > 0) {
        const head = Buffer.alloc(sampleBytes);
        fs.readSync(fd, head, 0, sampleBytes, 0);
        digest.update(head);
        if (stat.size > sampleBytes) {
          const tail = Buffer.alloc(sampleBytes);
          fs.readSync(fd, tail, 0, sampleBytes, stat.size - sampleBytes);
          digest.update(tail);
        }
      }
    } catch {
      digest.update('\0unreadable\0');
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* best-effort close */ }
      }
    }
  }
  return digest.digest('hex');
}

function openReadonlySqlite(
  databasePath: string,
  sqliteBinary?: string,
): ReadonlySqlite | null {
  const native = openNodeSqlite(databasePath);
  if (native) return native;
  // Do not silently fall back to a synchronous sqlite3 subprocess. Besides
  // blocking the caller, that seam has only a database-wide change token, so
  // one active session would invalidate every cached projection. Callers that
  // deliberately support a legacy runtime may opt into an exact binary.
  return sqliteBinary ? openCliSqlite(databasePath, sqliteBinary) : null;
}

function openNodeSqlite(databasePath: string): ReadonlySqlite | null {
  try {
    const require = createRequire(import.meta.url);
    const module = require('node:sqlite') as {
      DatabaseSync: new (
        path: string,
        options?: { readOnly?: boolean; timeout?: number },
      ) => {
        exec(sql: string): void;
        prepare(sql: string): {
          all(...params: string[]): unknown[];
        };
        aggregate?: (
          name: string,
          options: {
            deterministic?: boolean;
            varargs?: boolean;
            start: () => Uint8Array;
            step: (state: Uint8Array, ...values: unknown[]) => Uint8Array;
            result: (state: Uint8Array) => string;
          },
        ) => void;
        close(): void;
      };
    };
    const database = new module.DatabaseSync(databasePath, {
      readOnly: true,
      timeout: SQLITE_TIMEOUT_MS,
    });
    const exactContentRevisions = typeof database.aggregate === 'function';
    if (database.aggregate) {
      database.aggregate('aside_content_hash', {
        deterministic: true,
        varargs: true,
        start: () => new Uint8Array(32),
        step: xorContentHash,
        result: (state) => Buffer.from(state).toString('hex'),
      });
    }
    database.exec(
      `PRAGMA query_only = ON;
       PRAGMA trusted_schema = OFF;
       PRAGMA busy_timeout = ${SQLITE_TIMEOUT_MS};`,
    );
    let snapshotOpen = false;
    return {
      exactContentRevisions,
      beginSnapshot() {
        if (snapshotOpen) return true;
        database.exec('BEGIN');
        snapshotOpen = true;
        return true;
      },
      all(sql, params = []) {
        return database.prepare(sql).all(...params) as Record<string, unknown>[];
      },
      close() {
        if (snapshotOpen) {
          try { database.exec('ROLLBACK'); } catch { /* already ended */ }
          snapshotOpen = false;
        }
        database.close();
      },
    };
  } catch {
    return null;
  }
}

function openCliSqlite(databasePath: string, binary: string): ReadonlySqlite {
  return {
    exactContentRevisions: false,
    beginSnapshot() {
      return false;
    },
    all(sql, params = []) {
      const bound = bindSqlLiterals(sql, params);
      const result = spawnSync(
        binary,
        ['-readonly', '-json', '-batch', '-bail', '--', databasePath],
        {
          encoding: 'utf8',
          input:
            `PRAGMA query_only = ON;\n` +
            `PRAGMA trusted_schema = OFF;\n` +
            `PRAGMA busy_timeout = ${SQLITE_TIMEOUT_MS};\n` +
            `${bound};\n`,
          timeout: SQLITE_TIMEOUT_MS * 4,
          maxBuffer: SQLITE_MAX_BUFFER,
          windowsHide: true,
        },
      );
      if (result.error || result.status !== 0) {
        throw result.error ?? new Error(result.stderr || 'sqlite3 query failed');
      }
      const text = result.stdout.trim();
      if (!text) return [];
      const parsed = JSON.parse(text) as unknown;
      if (!Array.isArray(parsed)) throw new Error('sqlite3 returned non-array JSON');
      return parsed.filter(
        (value): value is Record<string, unknown> =>
          Boolean(value) && typeof value === 'object' && !Array.isArray(value),
      );
    },
    close() {},
  };
}

function bindSqlLiterals(sql: string, params: readonly string[]): string {
  let index = 0;
  const bound = sql.replaceAll('?', () => {
    if (index >= params.length) throw new Error('Missing SQLite parameter');
    const value = params[index++]!;
    return `'${value.replaceAll("'", "''")}'`;
  });
  if (index !== params.length) throw new Error('Unused SQLite parameter');
  return bound;
}

function readLegacyTranscript(
  storageDir: string,
  meta: OpenCodeSessionMeta,
  sessionSignature: string,
): {
  revision: number;
  sources: NormalizedSource[];
  metadata: MaterializedMetadata;
} | null {
  const messageRoot = path.join(storageDir, 'message');
  const messageDir = containedChildPath(messageRoot, meta.id);
  if (!messageDir || !isSafeSourceDirectory(storageDir, messageDir)) return null;
  const messageFiles = listJsonFiles(messageDir);
  const sourceSignatures: string[] = [sessionSignature];
  const rows: TranscriptRow[] = [];

  for (const messageFile of messageFiles) {
    const messageRead = readJsonRecordWithSignature(messageFile);
    if (!messageRead) throw new Error('OpenCode legacy message changed while reading');
    const message = messageRead.record;
    sourceSignatures.push(messageRead.signature);
    const messageId = stringValue(message['id']);
    if (!isVendorId(messageId, 'msg')) continue;
    const messageTime = recordValue(message['time']);
    const messageModel = recordValue(message['model']);
    const error = recordValue(message['error']);
    const errorData = recordValue(error['data']);
    const tokens = recordValue(message['tokens']);
    const cache = recordValue(tokens['cache']);
    const partDir = containedChildPath(path.join(storageDir, 'part'), messageId);
    if (!partDir || !isSafeSourceDirectory(storageDir, partDir)) continue;
    const partFiles = listJsonFiles(partDir);
    if (partFiles.length === 0) {
      rows.push(legacyRow(meta.id, messageId, message, {}, messageTime, messageModel, error, errorData, tokens, cache));
      continue;
    }
    for (const partFile of partFiles) {
      const partRead = readJsonRecordWithSignature(partFile);
      if (!partRead) throw new Error('OpenCode legacy part changed while reading');
      const part = partRead.record;
      const partId = stringValue(part['id']);
      if (!isVendorId(partId, 'prt')) continue;
      sourceSignatures.push(partRead.signature);
      rows.push(legacyRow(meta.id, messageId, message, part, messageTime, messageModel, error, errorData, tokens, cache));
    }
  }

  const normalized = normalizeTranscript(meta, rows);
  return {
    revision: Number.parseInt(hash(sourceSignatures.sort()).slice(0, 13), 16),
    sources: normalized.sources,
    metadata: normalized.metadata,
  };
}

function legacyRow(
  sessionId: string,
  messageId: string,
  message: Record<string, unknown>,
  part: Record<string, unknown>,
  messageTime: Record<string, unknown>,
  messageModel: Record<string, unknown>,
  error: Record<string, unknown>,
  errorData: Record<string, unknown>,
  tokens: Record<string, unknown>,
  cache: Record<string, unknown>,
): TranscriptRow {
  const state = recordValue(part['state']);
  const stateTime = recordValue(state['time']);
  return {
    sessionId,
    messageId,
    messageCreatedMs: numericTime(messageTime['created']),
    messageUpdatedMs: numericTime(messageTime['updated'] ?? messageTime['completed']),
    messageCompletedMs: numericTime(messageTime['completed']),
    role: truncateCodePoints(stringValue(message['role']), MAX_SHORT_FIELD_CHARS),
    providerId: truncateCodePoints(
      stringValue(message['providerID'] ?? messageModel['providerID']),
      MAX_SHORT_FIELD_CHARS,
    ),
    modelId: truncateCodePoints(
      stringValue(message['modelID'] ?? messageModel['modelID']),
      MAX_SHORT_FIELD_CHARS,
    ),
    finish: truncateCodePoints(stringValue(message['finish']), MAX_SHORT_FIELD_CHARS),
    errorName: truncateCodePoints(stringValue(error['name']), MAX_SHORT_FIELD_CHARS),
    errorMessage: truncateCodePoints(
      stringValue(errorData['message'] ?? error['message']),
      MAX_ERROR_CHARS,
    ),
    inputTokens: counter(tokens['input']),
    outputTokens: counter(tokens['output']),
    reasoningTokens: counter(tokens['reasoning']),
    cacheReadTokens: counter(cache['read']),
    cacheWriteTokens: counter(cache['write']),
    partId: stringValue(part['id']),
    partCreatedMs: numericTime(recordValue(part['time'])['start']),
    partUpdatedMs: numericTime(recordValue(part['time'])['end']),
    partType: truncateCodePoints(stringValue(part['type']), MAX_SHORT_FIELD_CHARS),
    text: truncateCodePoints(stringValue(part['text']), MAX_TEXT_CHARS),
    synthetic: booleanValue(part['synthetic']),
    ignored: booleanValue(part['ignored']),
    tool: truncateCodePoints(stringValue(part['tool']), MAX_SHORT_FIELD_CHARS),
    toolState: truncateCodePoints(stringValue(state['status']), MAX_SHORT_FIELD_CHARS),
    toolInput: projectToolInput(state['input']),
    toolTitle: truncateCodePoints(stringValue(state['title']), MAX_SHORT_FIELD_CHARS),
    toolError: truncateCodePoints(stringValue(state['error']), MAX_ERROR_CHARS),
    toolStartMs: numericTime(stateTime['start']),
    toolEndMs: numericTime(stateTime['end']),
    subtaskPrompt: truncateCodePoints(stringValue(part['prompt']), MAX_TEXT_CHARS),
    subtaskDescription: truncateCodePoints(stringValue(part['description']), 4096),
    subtaskAgent: truncateCodePoints(stringValue(part['agent']), MAX_SHORT_FIELD_CHARS),
  };
}

function listJsonFilesTwoLevels(root: string): string[] {
  const files: string[] = [];
  for (const entry of readDirectory(root)) {
    const full = path.join(root, entry.name);
    if (entry.isFile() && entry.name.endsWith('.json')) files.push(full);
    if (!entry.isDirectory()) continue;
    files.push(...listJsonFiles(full));
  }
  return files.sort();
}

/** Enumerate the authoritative legacy roster without collapsing I/O failures to empty. */
function listJsonFilesTwoLevelsStrict(root: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isFile() && entry.name.endsWith('.json')) files.push(full);
    if (!entry.isDirectory()) continue;
    for (const child of fs.readdirSync(full, { withFileTypes: true })) {
      if (child.isFile() && child.name.endsWith('.json')) {
        files.push(path.join(full, child.name));
      }
    }
  }
  return files.sort();
}

function listJsonFiles(root: string): string[] {
  return readDirectory(root)
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => path.join(root, entry.name))
    .sort();
}

function readDirectory(root: string): fs.Dirent[] {
  try {
    return fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
}

function readJsonRecord(
  filePath: string,
  requirePrivateOwnership = false,
): Record<string, unknown> | null {
  return readJsonRecordWithSignature(filePath, requirePrivateOwnership)?.record ?? null;
}

function readJsonRecordWithSignature(
  filePath: string,
  requirePrivateOwnership = false,
): { record: Record<string, unknown>; signature: string } | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | OPEN_NOFOLLOW | OPEN_CLOEXEC,
    );
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size > MAX_JSON_FILE_BYTES) return null;
    if (requirePrivateOwnership) assertPrivateFileStat(before, filePath);
    const content = fs.readFileSync(fd, 'utf8');
    const after = fs.fstatSync(fd);
    if (fileIdentitySignature(before) !== fileIdentitySignature(after)) return null;
    const parsed = JSON.parse(content) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return {
      record: parsed as Record<string, unknown>,
      // Content participates directly, so an atomic replacement after this
      // descriptor read cannot cache old bytes under the replacement's stat.
      signature: hash({
        identity: fileIdentitySignature(after),
        content: hash(content),
      }),
    };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function fileIdentitySignature(stat: fs.Stats): string {
  return `${stat.dev}\0${stat.ino}\0${stat.size}\0${stat.mtimeMs}\0${stat.ctimeMs}`;
}

function containedChildPath(root: string, child: string): string | null {
  const resolvedRoot = path.resolve(root);
  const resolvedChild = path.resolve(resolvedRoot, child);
  const relative = path.relative(resolvedRoot, resolvedChild);
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) return null;
  return resolvedChild;
}

/** Reject source-directory symlinks, including symlinked intermediate roots. */
function isSafeSourceDirectory(storageDir: string, candidate: string): boolean {
  try {
    const storageStat = fs.lstatSync(storageDir);
    const candidateStat = fs.lstatSync(candidate);
    if (
      storageStat.isSymbolicLink() ||
      !storageStat.isDirectory() ||
      candidateStat.isSymbolicLink() ||
      !candidateStat.isDirectory()
    ) {
      return false;
    }
    const realStorage = fs.realpathSync(storageDir);
    const realCandidate = fs.realpathSync(candidate);
    return isContainedPath(realStorage, realCandidate);
  } catch {
    return false;
  }
}

function legacySourceStatus(
  storageDir: string,
  sessionRoot: string,
): 'missing' | 'safe' | 'unavailable' {
  try {
    const storageStat = fs.lstatSync(storageDir);
    if (!storageStat.isDirectory() || storageStat.isSymbolicLink()) {
      return 'unavailable';
    }
  } catch (error) {
    return isMissingFileError(error) ? 'missing' : 'unavailable';
  }

  try {
    fs.lstatSync(sessionRoot);
  } catch (error) {
    return isMissingFileError(error) ? 'missing' : 'unavailable';
  }
  return isSafeSourceDirectory(storageDir, sessionRoot)
    ? 'safe'
    : 'unavailable';
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function isVendorId(value: string, prefix: 'ses' | 'msg' | 'prt'): boolean {
  if (!value || value.length > MAX_VENDOR_ID_CHARS) return false;
  return new RegExp(`^${prefix}_[A-Za-z0-9][A-Za-z0-9_-]*$`).test(value);
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string' || !value) return {};
  try {
    return recordValue(JSON.parse(value) as unknown);
  } catch {
    return {};
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/**
 * Keep only tool-input fields consumed by the classifier. Limits are Unicode
 * code points in both SQLite (`substr`) and legacy JSON.
 */
function projectToolInput(value: unknown): Record<string, unknown> {
  const input = recordValue(value);
  const projected: Record<string, unknown> = {};
  for (const key of [
    'command',
    'filePath',
    'file_path',
    'path',
    'pattern',
    'query',
    'url',
    'description',
    'question',
    'prompt',
  ]) {
    const bounded = boundedToolValue(input[key]);
    if (bounded !== undefined && bounded !== '') projected[key] = bounded;
  }
  const questions = input['questions'];
  if (Array.isArray(questions)) {
    const first = recordValue(questions[0]);
    const question: Record<string, unknown> = {};
    for (const key of ['question', 'prompt', 'header']) {
      const bounded = boundedToolValue(first[key]);
      if (bounded !== undefined && bounded !== '') question[key] = bounded;
    }
    if (Object.keys(question).length > 0) projected['questions'] = [question];
  }
  // The fixed field set and per-field bounds keep this valid projection under
  // the aggregate cap. Fail closed if a future field breaks that invariant.
  return stableJson(projected).length <= MAX_TOOL_INPUT_CHARS ? projected : {};
}

function boundedToolValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return truncateCodePoints(value, MAX_TOOL_FIELD_CHARS);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value.slice(0, 32).map((item) =>
      truncateCodePoints(String(item), MAX_TOOL_FIELD_CHARS)
    );
  }
  return undefined;
}

function truncateCodePoints(value: string, max: number): string {
  if (value.length <= max && !/[\uD800-\uDFFF]/.test(value)) return value;
  return Array.from(value).slice(0, max).join('');
}

function numericTime(value: unknown): number {
  const number = finiteNumber(value);
  if (number <= 0) return 0;
  return number < 10_000_000_000 ? number * 1000 : number;
}

function finiteNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function counter(value: unknown): number {
  return Math.max(0, Math.floor(finiteNumber(value)));
}

function booleanValue(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function toIso(value: number): string {
  const timestamp = value > 0 && Number.isFinite(value) ? value : 0;
  try {
    return new Date(timestamp).toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

function hash(value: unknown): string {
  const encoded = typeof value === 'string' ? value : stableJson(value);
  return createHash('sha256').update(encoded).digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(record[key])}`
    ).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function safeStat(filePath: string): fs.Stats | null {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function safeLstat(filePath: string): fs.Stats | null {
  try {
    return fs.lstatSync(filePath);
  } catch {
    return null;
  }
}

function assertOwnedByCurrentUser(stat: fs.Stats, filePath: string): void {
  const getuid = process.getuid;
  if (typeof getuid === 'function' && stat.uid !== getuid()) {
    throw new Error(`Cache path is not owned by the current user: ${filePath}`);
  }
}

function assertPrivateRegularFile(fd: number, filePath: string): void {
  const stat = fs.fstatSync(fd);
  assertPrivateFileStat(stat, filePath);
}

function assertPrivateFileStat(stat: fs.Stats, filePath: string): void {
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
    throw new Error(`Unsafe cache file: ${filePath}`);
  }
  assertOwnedByCurrentUser(stat, filePath);
}

function isPrivateRegularFile(filePath: string): boolean {
  const stat = safeLstat(filePath);
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) return false;
  try {
    assertPrivateFileStat(stat, filePath);
    return true;
  } catch {
    return false;
  }
}

function isRegularFile(filePath: string): boolean {
  return safeStat(filePath)?.isFile() ?? false;
}

function isDirectory(filePath: string): boolean {
  return safeStat(filePath)?.isDirectory() ?? false;
}
