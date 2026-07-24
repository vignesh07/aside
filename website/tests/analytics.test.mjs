import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  closeAnalyticsDatabases,
  configuredAnalyticsDatabasePath,
  readDownloadAnalytics,
  recordDownload,
} from "../lib/analytics-store.mjs";
import {
  constantTimeEqualText,
  createAdminSessionToken,
  isAdminSessionTokenValid,
} from "../lib/admin-auth-core.mjs";

const testDirectory = await mkdtemp(join(tmpdir(), "aside-analytics-test-"));

after(async () => {
  closeAnalyticsDatabases();
  await rm(testDirectory, { recursive: true, force: true });
});

test("uses an explicit database path or the Railway volume mount", () => {
  assert.equal(
    configuredAnalyticsDatabasePath({
      ASIDE_ANALYTICS_DB_PATH: "/tmp/explicit.sqlite",
      RAILWAY_VOLUME_MOUNT_PATH: "/data",
    }),
    "/tmp/explicit.sqlite",
  );
  assert.equal(
    configuredAnalyticsDatabasePath({
      RAILWAY_VOLUME_MOUNT_PATH: "/data/",
    }),
    "/data/aside-analytics.sqlite",
  );
  assert.equal(configuredAnalyticsDatabasePath({}), null);
});

test("aggregates rolling 7-day, 30-day, and all-time download starts", async () => {
  const databasePath = join(testDirectory, "aggregation.sqlite");
  const asOfMs = Date.UTC(2026, 6, 24, 12, 0, 0);
  const dayMs = 24 * 60 * 60 * 1000;

  await recordDownload("mac-arm64", { databasePath, atMs: asOfMs });
  await recordDownload("mac-intel", {
    databasePath,
    atMs: asOfMs - 7 * dayMs,
  });
  await recordDownload("mac-arm64", {
    databasePath,
    atMs: asOfMs - 7 * dayMs - 1,
  });
  await recordDownload("mac-intel", {
    databasePath,
    atMs: asOfMs - 30 * dayMs,
  });
  await recordDownload("mac-arm64", {
    databasePath,
    atMs: asOfMs - 30 * dayMs - 1,
  });

  const analytics = await readDownloadAnalytics({ databasePath, asOfMs });

  assert.deepEqual(analytics.periods.days7, {
    total: 2,
    macArm64: 1,
    macIntel: 1,
  });
  assert.deepEqual(analytics.periods.days30, {
    total: 4,
    macArm64: 2,
    macIntel: 2,
  });
  assert.deepEqual(analytics.periods.allTime, {
    total: 5,
    macArm64: 3,
    macIntel: 2,
  });
  assert.equal(
    analytics.trackingStartedAt,
    new Date(asOfMs - 30 * dayMs - 1).toISOString(),
  );
});

test("download recording is disabled without durable storage", async () => {
  assert.equal(
    await recordDownload("mac-arm64", { databasePath: null }),
    false,
  );
  await assert.rejects(
    readDownloadAnalytics({ databasePath: null }),
    /storage is not configured/i,
  );
  await assert.rejects(
    recordDownload("windows", {
      databasePath: join(testDirectory, "invalid.sqlite"),
    }),
    /Unsupported download artifact/,
  );
});

test("admin session tokens validate without exposing the admin key", async () => {
  const key = "correct horse battery staple";
  const nowMs = Date.UTC(2026, 6, 24, 12, 0, 0);
  const expiresAtMs = nowMs + 12 * 60 * 60 * 1000;
  const token = await createAdminSessionToken(key, expiresAtMs);

  assert.equal(token.includes(key), false);
  assert.equal(
    await isAdminSessionTokenValid(token, key, { nowMs }),
    true,
  );
  assert.equal(
    await isAdminSessionTokenValid(token, "wrong key", { nowMs }),
    false,
  );
  assert.equal(
    await isAdminSessionTokenValid(token, key, { nowMs: expiresAtMs }),
    false,
  );
  assert.equal(await constantTimeEqualText(key, key), true);
  assert.equal(await constantTimeEqualText(key, "wrong key"), false);
});
