import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  PROVIDER_AUTH_IDS,
  type ProviderAuthId,
} from './provider-auth-types.js';

// Keep the v1 envelope rollback-compatible with the current public build.
// Older Aside versions ignore the optional `todayRecaps` field; if they later
// rewrite this file, the narrower permission is safely forgotten.
const STORE_VERSION = 1;
const MAX_STORE_BYTES = 64 * 1024;

interface StoredConsent {
  version: number;
  enabled: Partial<Record<ProviderAuthId, boolean>>;
  todayRecaps: Partial<Record<ProviderAuthId, boolean>>;
}

export interface ProviderConsentSnapshot {
  readonly enabled: ReadonlySet<ProviderAuthId>;
  readonly todayRecaps: ReadonlySet<ProviderAuthId>;
}

export interface ProviderConsentStore {
  load(): ProviderConsentSnapshot;
  setEnabled(provider: ProviderAuthId, enabled: boolean): void;
  setTodayRecapsEnabled(provider: ProviderAuthId, enabled: boolean): void;
}

export type ProviderConsentStoreErrorCode =
  | 'corrupt'
  | 'insecure_permissions'
  | 'unavailable';

/**
 * Storage failures intentionally carry no raw filesystem or JSON details. The
 * caller can fail closed without accidentally returning local paths or corrupt
 * file contents across IPC.
 */
export class ProviderConsentStoreError extends Error {
  readonly name = 'ProviderConsentStoreError';

  constructor(readonly code: ProviderConsentStoreErrorCode) {
    super('Provider consent storage is unavailable.');
  }
}

/**
 * The only durable auth state Aside owns.
 *
 * Vendor tokens remain in the vendor client's own store. This file contains
 * booleans saying which clients the user explicitly allowed Aside to delegate
 * to, and nothing else.
 */
export class FileProviderConsentStore implements ProviderConsentStore {
  readonly location: string;

  constructor(location = path.join(os.homedir(), '.aside', 'providers.json')) {
    this.location = location;
  }

  load(): ProviderConsentSnapshot {
    const dir = path.dirname(this.location);
    this.assertPrivateDirectoryIfPresent(dir);

    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(this.location);
    } catch (error) {
      if (isFsCode(error, 'ENOENT')) {
        return { enabled: new Set(), todayRecaps: new Set() };
      }
      throw new ProviderConsentStoreError('unavailable');
    }

    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new ProviderConsentStoreError('unavailable');
    }
    if (!isOwnedByCurrentUser(stat) || hasGroupOrWorldPermissions(stat.mode)) {
      throw new ProviderConsentStoreError('insecure_permissions');
    }
    if (stat.size > MAX_STORE_BYTES) {
      throw new ProviderConsentStoreError('corrupt');
    }

    let raw: string;
    try {
      raw = fs.readFileSync(this.location, 'utf8');
    } catch {
      throw new ProviderConsentStoreError('unavailable');
    }

    const parsed = parseStoredConsent(raw);
    return {
      enabled: new Set(
        PROVIDER_AUTH_IDS.filter((provider) => parsed.enabled[provider] === true),
      ),
      todayRecaps: new Set(
        PROVIDER_AUTH_IDS.filter(
          (provider) =>
            parsed.enabled[provider] === true &&
            parsed.todayRecaps[provider] === true,
        ),
      ),
    };
  }

  setEnabled(provider: ProviderAuthId, enabled: boolean): void {
    // Load before writing. An insecure or corrupt existing file must never be
    // silently treated as valid state or overwritten as if nothing happened.
    const current = this.load();
    const next = new Set(current.enabled);
    const todayRecaps = new Set(current.todayRecaps);
    if (enabled) next.add(provider);
    else {
      next.delete(provider);
      todayRecaps.delete(provider);
    }

    this.save(next, todayRecaps);
  }

  setTodayRecapsEnabled(provider: ProviderAuthId, enabled: boolean): void {
    const current = this.load();
    if (enabled && !current.enabled.has(provider)) {
      throw new ProviderConsentStoreError('unavailable');
    }
    const todayRecaps = new Set(current.todayRecaps);
    if (enabled) todayRecaps.add(provider);
    else todayRecaps.delete(provider);
    this.save(new Set(current.enabled), todayRecaps);
  }

  private save(
    enabled: ReadonlySet<ProviderAuthId>,
    todayRecaps: ReadonlySet<ProviderAuthId>,
  ): void {
    const dir = path.dirname(this.location);
    this.ensurePrivateDirectory(dir);

    const state: StoredConsent = {
      version: STORE_VERSION,
      enabled: Object.fromEntries(
        PROVIDER_AUTH_IDS.map((id) => [id, enabled.has(id)]),
      ) as Record<ProviderAuthId, boolean>,
      todayRecaps: Object.fromEntries(
        PROVIDER_AUTH_IDS.map((id) => [id, todayRecaps.has(id)]),
      ) as Record<ProviderAuthId, boolean>,
    };

    const temp = path.join(
      dir,
      `.${path.basename(this.location)}.${process.pid}.${Date.now()}.${randomSuffix()}.tmp`,
    );
    let fd: number | null = null;
    try {
      fd = fs.openSync(temp, 'wx', 0o600);
      fs.writeFileSync(fd, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;

      // rename(2) is atomic within one directory. The manifest-shaped state is
      // therefore always either the old complete file or the new complete file.
      fs.renameSync(temp, this.location);
      fs.chmodSync(this.location, 0o600);
      fsyncDirectory(dir);
    } catch {
      throw new ProviderConsentStoreError('unavailable');
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          // Preserve the primary storage error.
        }
      }
      try {
        fs.unlinkSync(temp);
      } catch {
        // Successful rename removes the temporary name; failed writes clean up
        // best-effort without masking the original error.
      }
    }
  }

  private assertPrivateDirectoryIfPresent(dir: string): void {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(dir);
    } catch (error) {
      if (isFsCode(error, 'ENOENT')) return;
      throw new ProviderConsentStoreError('unavailable');
    }

    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new ProviderConsentStoreError('unavailable');
    }
    if (!isOwnedByCurrentUser(stat) || hasGroupOrWorldPermissions(stat.mode)) {
      throw new ProviderConsentStoreError('insecure_permissions');
    }
  }

  private ensurePrivateDirectory(dir: string): void {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const stat = fs.lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !isOwnedByCurrentUser(stat)) {
        throw new ProviderConsentStoreError('unavailable');
      }
      fs.chmodSync(dir, 0o700);
    } catch (error) {
      if (error instanceof ProviderConsentStoreError) throw error;
      throw new ProviderConsentStoreError('unavailable');
    }
  }
}

function parseStoredConsent(raw: string): StoredConsent {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ProviderConsentStoreError('corrupt');
  }

  if (
    !isPlainObject(value) ||
    value['version'] !== STORE_VERSION
  ) {
    throw new ProviderConsentStoreError('corrupt');
  }
  const enabled = value['enabled'];
  if (!isPlainObject(enabled)) {
    throw new ProviderConsentStoreError('corrupt');
  }
  for (const provider of PROVIDER_AUTH_IDS) {
    const setting = enabled[provider];
    if (setting !== undefined && typeof setting !== 'boolean') {
      throw new ProviderConsentStoreError('corrupt');
    }
  }
  const todayRecaps = value['todayRecaps'] ?? {};
  if (!isPlainObject(todayRecaps)) {
    throw new ProviderConsentStoreError('corrupt');
  }
  for (const provider of PROVIDER_AUTH_IDS) {
    const setting = todayRecaps[provider];
    if (setting !== undefined && typeof setting !== 'boolean') {
      throw new ProviderConsentStoreError('corrupt');
    }
  }

  return {
    version: STORE_VERSION,
    enabled: enabled as StoredConsent['enabled'],
    todayRecaps: todayRecaps as StoredConsent['todayRecaps'],
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function hasGroupOrWorldPermissions(mode: number): boolean {
  return (mode & 0o077) !== 0;
}

function isOwnedByCurrentUser(stat: fs.Stats): boolean {
  return typeof process.getuid !== 'function' || stat.uid === process.getuid();
}

function isFsCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code;
}

function randomSuffix(): string {
  return Math.random().toString(16).slice(2);
}

function fsyncDirectory(dir: string): void {
  let fd: number | null = null;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch {
    // The file has already been atomically installed. Directory fsync is a
    // durability hardening step and is not supported on every filesystem.
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Nothing actionable remains after the rename.
      }
    }
  }
}
