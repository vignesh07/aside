import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { GeneratedArtifact } from '../types/generated-artifact.js';

const STORE_VERSION = 1;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ID_LENGTH = 512;
const MAX_EVIDENCE_IDS = 1_000;
const MAX_ARTIFACTS = 500;
const MAX_GENERATED_TEXT_CHARACTERS = 50_000;
const MAX_STORE_BYTES = 8 * 1024 * 1024;

interface StoredArtifactState {
  version: 1;
  artifacts: GeneratedArtifact[];
}

export interface GeneratedArtifactStore {
  load(): GeneratedArtifact[];
  save(artifacts: GeneratedArtifact[]): void;
  readonly location?: string;
}

/**
 * Private durable storage for explicit diary recaps and thread reviews.
 *
 * Writes use a same-directory temporary file followed by rename(2), so readers
 * see either the complete previous snapshot or the complete next snapshot.
 * Invalid or unsupported files fail closed to an empty result.
 */
export class FileGeneratedArtifactStore implements GeneratedArtifactStore {
  readonly location: string;

  constructor(
    location = path.join(os.homedir(), '.aside', 'generated-artifacts.json'),
  ) {
    this.location = location;
  }

  load(): GeneratedArtifact[] {
    try {
      const stats = fs.statSync(this.location);
      if (!stats.isFile() || stats.size > MAX_STORE_BYTES) return [];
      const parsed = JSON.parse(
        fs.readFileSync(this.location, 'utf-8'),
      ) as unknown;
      if (!isStoredState(parsed)) return [];
      return parsed.artifacts.map(cloneArtifact);
    } catch {
      return [];
    }
  }

  save(artifacts: GeneratedArtifact[]): void {
    if (!Array.isArray(artifacts) || !artifacts.every(isGeneratedArtifact)) {
      throw new TypeError('Cannot persist an invalid generated artifact.');
    }

    const directory = path.dirname(this.location);
    const temporaryPath = `${this.location}.${process.pid}.${Date.now()}.tmp`;
    let fileDescriptor: number | null = null;
    try {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      fs.chmodSync(directory, 0o700);

      const recent = [...artifacts]
        .sort(compareArtifacts)
        .slice(-MAX_ARTIFACTS)
        .map(cloneArtifact);
      const { state, serialized } = boundedSnapshot(recent);
      if (Buffer.byteLength(serialized, 'utf-8') > MAX_STORE_BYTES) {
        throw new RangeError('Generated artifact snapshot is too large.');
      }
      fileDescriptor = fs.openSync(temporaryPath, 'wx', 0o600);
      fs.writeFileSync(fileDescriptor, serialized, 'utf-8');
      fs.fsyncSync(fileDescriptor);
      fs.closeSync(fileDescriptor);
      fileDescriptor = null;

      fs.renameSync(temporaryPath, this.location);
      fs.chmodSync(this.location, 0o600);
      syncDirectory(directory);
    } catch (error) {
      if (fileDescriptor !== null) {
        try {
          fs.closeSync(fileDescriptor);
        } catch {
          // Preserve the original persistence error.
        }
      }
      try {
        fs.unlinkSync(temporaryPath);
      } catch {
        // The rename may already have installed the complete snapshot.
      }
      throw error;
    }
  }
}

function isStoredState(value: unknown): value is StoredArtifactState {
  return (
    isPlainObject(value) &&
    value['version'] === STORE_VERSION &&
    Array.isArray(value['artifacts']) &&
    value['artifacts'].length <= MAX_ARTIFACTS &&
    value['artifacts'].every(isGeneratedArtifact)
  );
}

function isGeneratedArtifact(value: unknown): value is GeneratedArtifact {
  if (
    !isPlainObject(value) ||
    !safeString(value['id']) ||
    !validIsoTimestamp(value['createdAt']) ||
    !safeString(value['provider']) ||
    !safeString(value['model']) ||
    !nonnegativeInteger(value['inputHighWaterSeq']) ||
    typeof value['inputHash'] !== 'string' ||
    !HASH_PATTERN.test(value['inputHash']) ||
    !validEvidenceIds(value['evidenceIds']) ||
    typeof value['markdown'] !== 'string' ||
    value['markdown'].length > MAX_GENERATED_TEXT_CHARACTERS
  ) {
    return false;
  }

  if (value['kind'] === 'daily_recap') {
    return (
      typeof value['day'] === 'string' &&
      validCalendarDay(value['day']) &&
      value['threadKey'] === undefined
    );
  }
  if (value['kind'] === 'thread_review') {
    return safeString(value['threadKey']) && value['day'] === undefined;
  }
  return false;
}

function validEvidenceIds(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length > MAX_EVIDENCE_IDS) return false;
  const unique = new Set<string>();
  for (const id of value) {
    if (!safeString(id) || unique.has(id)) return false;
    unique.add(id);
  }
  return true;
}

function safeString(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function validIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const date = new Date(value);
  return (
    Number.isFinite(date.getTime()) &&
    date.toISOString() === value
  );
}

function validCalendarDay(value: string): boolean {
  if (!DAY_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value;
}

function nonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compareArtifacts(
  left: GeneratedArtifact,
  right: GeneratedArtifact,
): number {
  return (
    left.createdAt.localeCompare(right.createdAt) ||
    left.id.localeCompare(right.id)
  );
}

function cloneArtifact(artifact: GeneratedArtifact): GeneratedArtifact {
  return {
    ...artifact,
    evidenceIds: [...artifact.evidenceIds],
  };
}

function serializeState(state: StoredArtifactState): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

function boundedSnapshot(artifacts: GeneratedArtifact[]): {
  state: StoredArtifactState;
  serialized: string;
} {
  let state: StoredArtifactState = {
    version: STORE_VERSION,
    artifacts,
  };
  let serialized = serializeState(state);
  if (Buffer.byteLength(serialized, 'utf-8') <= MAX_STORE_BYTES) {
    return { state, serialized };
  }

  // Find the smallest number of oldest artifacts to discard. Snapshot size is
  // monotonic as that prefix grows, so this takes at most log2(500) complete
  // serializations even for a worst-case store.
  let lower = 1;
  let upper = artifacts.length;
  while (lower < upper) {
    const midpoint = Math.floor((lower + upper) / 2);
    const candidate = serializeState({
      version: STORE_VERSION,
      artifacts: artifacts.slice(midpoint),
    });
    if (Buffer.byteLength(candidate, 'utf-8') <= MAX_STORE_BYTES) {
      upper = midpoint;
    } else {
      lower = midpoint + 1;
    }
  }
  state = {
    version: STORE_VERSION,
    artifacts: artifacts.slice(lower),
  };
  serialized = serializeState(state);
  return { state, serialized };
}

function syncDirectory(directory: string): void {
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(directory, 'r');
    fs.fsyncSync(descriptor);
  } catch {
    // The complete file has already been atomically installed. Some
    // filesystems do not allow directory fsync.
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}
