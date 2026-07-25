import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { redactSensitiveText } from '../redact-sensitive.js';
import { captureGitSnapshot } from './git-snapshot.js';
import {
  HANDOFF_SCHEMA_VERSION,
  type CreateHandoffInput,
  type GitSnapshot,
  type HandoffBundle,
  type HandoffRedactionReport,
  type HandoffTranscriptEntry,
} from './types.js';

const DEFAULT_TRANSCRIPT_ENTRIES = 24;
const MAX_TRANSCRIPT_ENTRIES = 100;
const DEFAULT_ENTRY_CHARACTERS = 2_000;
const MAX_ENTRY_CHARACTERS = 8_000;
const MAX_LIST_ITEMS = 100;
const MAX_SOURCE_ID_CHARACTERS = 2_000;
const DEFAULT_CAPSULE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const HANDOFF_CAPSULE_FILENAME =
  /^handoff-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i;

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(maximum, Math.floor(value!)));
}

function sanitizeText(
  value: string | undefined,
  maxCharacters: number,
  report: HandoffRedactionReport,
): string {
  const input = value?.trim() ?? '';
  const redacted = redactSensitiveText(input);
  if (redacted !== input) report.fieldsChanged += 1;
  if (redacted.length <= maxCharacters) return redacted;
  report.truncatedEntries += 1;
  return `${redacted.slice(0, maxCharacters)}\n[TRUNCATED]`;
}

/**
 * Keep launch validation aligned with the exact source-ID representation that
 * is safe to serialize into a handoff.
 */
export function sanitizeHandoffSourceId(value: string): string {
  const report: HandoffRedactionReport = {
    fieldsChanged: 0,
    truncatedEntries: 0,
    omittedTranscriptEntries: 0,
  };
  return sanitizeText(value, MAX_SOURCE_ID_CHARACTERS, report);
}

function sanitizeEntries(
  entries: readonly HandoffTranscriptEntry[] | undefined,
  maxEntries: number,
  maxCharacters: number,
  report: HandoffRedactionReport,
): HandoffTranscriptEntry[] {
  const source = entries ?? [];
  const selected = source.slice(-maxEntries);
  report.omittedTranscriptEntries += Math.max(0, source.length - selected.length);
  return selected
    .map((entry) => {
      const timestamp = entry.timestamp
        ? sanitizeText(entry.timestamp, 500, report)
        : '';
      return {
        role: entry.role,
        text: sanitizeText(entry.text, maxCharacters, report),
        ...(timestamp ? { timestamp } : {}),
      };
    })
    .filter((entry) => entry.text.length > 0);
}

function sanitizeList(
  values: readonly string[] | undefined,
  maxCharacters: number,
  report: HandoffRedactionReport,
): string[] {
  return (values ?? [])
    .slice(0, MAX_LIST_ITEMS)
    .map((value) => sanitizeText(value.replaceAll('\0', ''), maxCharacters, report))
    .filter(Boolean);
}

function sanitizeGitSnapshot(
  snapshot: GitSnapshot,
  report: HandoffRedactionReport,
): GitSnapshot {
  return {
    available: snapshot.available,
    ...(snapshot.repositoryRoot
      ? { repositoryRoot: sanitizeText(snapshot.repositoryRoot, 2_000, report) }
      : {}),
    ...(snapshot.branch
      ? { branch: sanitizeText(snapshot.branch, 500, report) }
      : {}),
    ...(snapshot.head
      ? { head: sanitizeText(snapshot.head, 500, report) }
      : {}),
    dirty: snapshot.dirty,
    stagedCount: snapshot.stagedCount,
    unstagedCount: snapshot.unstagedCount,
    untrackedCount: snapshot.untrackedCount,
    changedFiles: snapshot.changedFiles
      .map((file) => sanitizeText(file.replaceAll('\0', ''), 2_000, report))
      .filter(Boolean),
    ...(snapshot.error
      ? { error: sanitizeText(snapshot.error, 2_000, report) }
      : {}),
  };
}

function deriveObjective(entries: readonly HandoffTranscriptEntry[]): string {
  return [...entries].reverse().find((entry) => entry.role === 'user')?.text
    ?? 'Continue the source agent session.';
}

function deriveCurrentState(entries: readonly HandoffTranscriptEntry[]): string {
  return [...entries].reverse().find((entry) => entry.role === 'assistant')?.text
    ?? 'Review the handoff and verify the workspace before continuing.';
}

/**
 * Build a bounded, sanitized handoff. Provider-private state, hidden prompts,
 * credentials, and full unbounded transcripts are deliberately excluded.
 */
export async function createHandoffBundle(input: CreateHandoffInput): Promise<HandoffBundle> {
  const report: HandoffRedactionReport = {
    fieldsChanged: 0,
    truncatedEntries: 0,
    omittedTranscriptEntries: 0,
  };
  const maxEntries = boundedInteger(
    input.maxTranscriptEntries,
    DEFAULT_TRANSCRIPT_ENTRIES,
    MAX_TRANSCRIPT_ENTRIES,
  );
  const maxCharacters = boundedInteger(
    input.maxEntryCharacters,
    DEFAULT_ENTRY_CHARACTERS,
    MAX_ENTRY_CHARACTERS,
  );
  const recentTranscript = sanitizeEntries(
    input.recentTranscript,
    maxEntries,
    maxCharacters,
    report,
  );
  const asideSideChat = sanitizeEntries(
    input.asideSideChat,
    maxEntries,
    maxCharacters,
    report,
  );
  const git = sanitizeGitSnapshot(
    await captureGitSnapshot(input.workspace.cwd),
    report,
  );

  return {
    schema: 'aside.agent-handoff',
    schemaVersion: HANDOFF_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    source: {
      provider: input.source.provider,
      sessionId: sanitizeText(
        input.source.sessionId,
        MAX_SOURCE_ID_CHARACTERS,
        report,
      ),
      ...(input.source.surface ? { surface: input.source.surface } : {}),
      ...(input.source.title
        ? { title: sanitizeText(input.source.title, 500, report) }
        : {}),
      ...(input.source.parentSessionId
        ? {
            parentSessionId: sanitizeText(
              input.source.parentSessionId,
              MAX_SOURCE_ID_CHARACTERS,
              report,
            ),
          }
        : {}),
      ...(input.source.isInternal !== undefined
        ? { isInternal: input.source.isInternal }
        : {}),
      ...(input.source.isSubagent !== undefined
        ? { isSubagent: input.source.isSubagent }
        : {}),
    },
    workspace: {
      cwd: path.resolve(input.workspace.cwd),
      ...(input.workspace.projectName
        ? { projectName: sanitizeText(input.workspace.projectName, 500, report) }
        : {}),
      ...(input.workspace.recordedBranch
        ? { recordedBranch: sanitizeText(input.workspace.recordedBranch, 500, report) }
        : {}),
      ...(input.workspace.recordedModel
        ? { recordedModel: sanitizeText(input.workspace.recordedModel, 500, report) }
        : {}),
      ...(input.workspace.recordedVersion
        ? { recordedVersion: sanitizeText(input.workspace.recordedVersion, 500, report) }
        : {}),
      git,
    },
    objective: sanitizeText(
      input.objective ?? deriveObjective(recentTranscript),
      maxCharacters,
      report,
    ),
    currentState: sanitizeText(
      input.currentState ?? deriveCurrentState(recentTranscript),
      maxCharacters,
      report,
    ),
    recentTranscript,
    relevantFiles: sanitizeList(input.relevantFiles, 2_000, report),
    nextActions: sanitizeList(input.nextActions, maxCharacters, report),
    ...(asideSideChat.length > 0 ? { asideSideChat } : {}),
    provenance: {
      generatedBy: 'Aside',
      sourceUnchanged: true,
      transcriptIsExcerpt: true,
      hiddenProviderStateIncluded: false,
    },
    redaction: report,
  };
}

export interface CapsuleOptions {
  rootDir?: string;
  maxAgeMs?: number;
}

export interface HandoffCapsule {
  path: string;
  expiresAt: string;
}

async function cleanupExpiredCapsules(rootDir: string, maxAgeMs: number): Promise<number> {
  const cutoff = Date.now() - maxAgeMs;
  const names = await readdir(rootDir).catch(() => []);
  const removed = await Promise.all(
    names
      .filter((name) => HANDOFF_CAPSULE_FILENAME.test(name))
      .map(async (name) => {
        const candidate = path.join(rootDir, name);
        const metadata = await lstat(candidate).catch(() => undefined);
        if (
          !metadata?.isFile()
          || metadata.isSymbolicLink()
          || metadata.mtimeMs >= cutoff
        ) return false;
        return unlink(candidate).then(() => true, () => false);
      }),
  );
  return removed.filter(Boolean).length;
}

/**
 * Remove expired private handoff capsules without creating the handoff root.
 *
 * The root must be a real directory. A missing root is a clean no-op, while a
 * symlink or non-directory is rejected so cleanup cannot be redirected.
 */
export async function cleanupExpiredHandoffCapsules(
  options: CapsuleOptions = {},
): Promise<number> {
  const maxAgeMs = Math.max(60_000, options.maxAgeMs ?? DEFAULT_CAPSULE_MAX_AGE_MS);
  const rootDir = path.resolve(options.rootDir ?? path.join(os.homedir(), '.aside', 'handoffs'));
  let rootMetadata;
  try {
    rootMetadata = await lstat(rootDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error('Aside handoff directory must be a real directory, not a symbolic link.');
  }
  return cleanupExpiredCapsules(rootDir, maxAgeMs);
}

/**
 * Persist a capsule only after the caller has decided a cross-provider launch
 * needs one. Permissions are repaired even when a previous Aside version
 * created the directory with a permissive umask.
 */
export async function writeHandoffCapsule(
  bundle: HandoffBundle,
  options: CapsuleOptions = {},
): Promise<HandoffCapsule> {
  const maxAgeMs = Math.max(60_000, options.maxAgeMs ?? DEFAULT_CAPSULE_MAX_AGE_MS);
  const rootDir = path.resolve(options.rootDir ?? path.join(os.homedir(), '.aside', 'handoffs'));
  await mkdir(rootDir, { recursive: true, mode: 0o700 });
  const rootMetadata = await lstat(rootDir);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error('Aside handoff directory must be a real directory, not a symbolic link.');
  }
  await chmod(rootDir, 0o700);
  await cleanupExpiredCapsules(rootDir, maxAgeMs);

  const capsulePath = path.join(rootDir, `handoff-${randomUUID()}.json`);
  await writeFile(capsulePath, `${JSON.stringify(bundle, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  await chmod(capsulePath, 0o600);
  return {
    path: capsulePath,
    expiresAt: new Date(Date.now() + maxAgeMs).toISOString(),
  };
}
