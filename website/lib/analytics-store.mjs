const VALID_ARTIFACTS = new Set(["mac-arm64", "mac-intel"]);
const DATABASE_CACHE_KEY = Symbol.for("aside.download-analytics.databases");
const DAY_MS = 24 * 60 * 60 * 1000;

function runtimeEnvironment() {
  return typeof process === "undefined" ? {} : process.env;
}

function databaseCache() {
  if (!globalThis[DATABASE_CACHE_KEY]) {
    globalThis[DATABASE_CACHE_KEY] = new Map();
  }

  return globalThis[DATABASE_CACHE_KEY];
}

function normalizeDatabasePath(path) {
  const trimmed = path?.trim();
  return trimmed ? trimmed : null;
}

export function configuredAnalyticsDatabasePath(env = runtimeEnvironment()) {
  const explicitPath = normalizeDatabasePath(env.ASIDE_ANALYTICS_DB_PATH);
  if (explicitPath) {
    return explicitPath;
  }

  const mountPath = normalizeDatabasePath(env.RAILWAY_VOLUME_MOUNT_PATH);
  if (!mountPath) {
    return null;
  }

  return `${mountPath.replace(/\/+$/, "")}/aside-analytics.sqlite`;
}

async function openDatabase(databasePath) {
  const cache = databaseCache();
  const cached = cache.get(databasePath);
  if (cached) {
    return cached;
  }

  // Keep the Node-only driver out of the Cloudflare/Sites bundle. The public
  // download route remains a normal redirect when no Railway volume is present.
  const sqliteModuleId = "node:sqlite";
  const { DatabaseSync } = await import(
    /* webpackIgnore: true */ /* @vite-ignore */ sqliteModuleId
  );
  const database = new DatabaseSync(databasePath);

  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 250;

    CREATE TABLE IF NOT EXISTS download_events (
      id INTEGER PRIMARY KEY,
      downloaded_at_ms INTEGER NOT NULL,
      artifact TEXT NOT NULL
        CHECK (artifact IN ('mac-arm64', 'mac-intel'))
    );

    CREATE INDEX IF NOT EXISTS download_events_downloaded_at
      ON download_events (downloaded_at_ms);
  `);

  cache.set(databasePath, database);
  return database;
}

function assertArtifact(artifact) {
  if (!VALID_ARTIFACTS.has(artifact)) {
    throw new TypeError(`Unsupported download artifact: ${artifact}`);
  }
}

function periodCounts() {
  return {
    total: 0,
    macArm64: 0,
    macIntel: 0,
  };
}

function addArtifactCount(period, artifact, value) {
  const count = Number(value ?? 0);
  period.total += count;

  if (artifact === "mac-arm64") {
    period.macArm64 += count;
  } else if (artifact === "mac-intel") {
    period.macIntel += count;
  }
}

export async function recordDownload(
  artifact,
  {
    atMs = Date.now(),
    databasePath = configuredAnalyticsDatabasePath(),
  } = {},
) {
  assertArtifact(artifact);

  if (!databasePath) {
    return false;
  }

  const database = await openDatabase(databasePath);
  database
    .prepare(
      "INSERT INTO download_events (downloaded_at_ms, artifact) VALUES (?, ?)",
    )
    .run(Math.trunc(atMs), artifact);
  return true;
}

export async function readDownloadAnalytics({
  asOfMs = Date.now(),
  databasePath = configuredAnalyticsDatabasePath(),
} = {}) {
  if (!databasePath) {
    const error = new Error("Download analytics storage is not configured.");
    error.code = "ANALYTICS_STORAGE_UNAVAILABLE";
    throw error;
  }

  const database = await openDatabase(databasePath);
  const sevenDayStart = Math.trunc(asOfMs - 7 * DAY_MS);
  const thirtyDayStart = Math.trunc(asOfMs - 30 * DAY_MS);
  const rows = database
    .prepare(
      `
        SELECT
          artifact,
          COUNT(*) AS all_time,
          SUM(downloaded_at_ms >= ?) AS days_30,
          SUM(downloaded_at_ms >= ?) AS days_7
        FROM download_events
        GROUP BY artifact
      `,
    )
    .all(thirtyDayStart, sevenDayStart);
  const firstRow = database
    .prepare("SELECT MIN(downloaded_at_ms) AS first_at FROM download_events")
    .get();

  const periods = {
    days7: periodCounts(),
    days30: periodCounts(),
    allTime: periodCounts(),
  };

  for (const row of rows) {
    addArtifactCount(periods.days7, row.artifact, row.days_7);
    addArtifactCount(periods.days30, row.artifact, row.days_30);
    addArtifactCount(periods.allTime, row.artifact, row.all_time);
  }

  return {
    asOf: new Date(asOfMs).toISOString(),
    trackingStartedAt:
      firstRow?.first_at == null
        ? null
        : new Date(Number(firstRow.first_at)).toISOString(),
    periods,
  };
}

export function closeAnalyticsDatabases() {
  const cache = databaseCache();

  for (const database of cache.values()) {
    database.close();
  }

  cache.clear();
}
