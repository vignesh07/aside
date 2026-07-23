import * as fs from 'node:fs';
import * as path from 'node:path';
import { CODEX_DIR, TIMING } from '../config/defaults.js';
import { extractProjectNameFromCwd } from '../utils/project-name.js';
import { cleanThreadTitle } from '../utils/thread-title.js';
import { scanJsonlPrefix } from './jsonl-prefix-reader.js';
import type { TrackedSession } from '../types/session.js';

interface DiscoveredCodexSession {
  session: TrackedSession;
  jsonlPath: string;
}

interface CodexScannerOptions {
  sessionsDir?: string;
  nowMs?: number;
}

const metadataCache = new Map<
  string,
  { mtimeMs: number; size: number; metadata: CodexSessionMeta }
>();

export function scanCodexSessions(options: CodexScannerOptions = {}): DiscoveredCodexSession[] {
  const results: DiscoveredCodexSession[] = [];
  const sessionsDir = options.sessionsDir ?? path.join(CODEX_DIR, 'sessions');
  const nowMs = options.nowMs ?? Date.now();

  if (!fs.existsSync(sessionsDir)) return results;

  for (const jsonlPath of listJsonlFiles(sessionsDir)) {
    const file = path.basename(jsonlPath);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(jsonlPath);
    } catch {
      continue;
    }

    const mtime = stat.mtimeMs;
    const age = Math.max(0, nowMs - mtime);

    const metadata = cachedMetadata(jsonlPath, stat);
    // Forked/resumed Codex rollouts can retain the ancestor session_meta.id.
    // The rollout filename is the identity Codex gives this concrete thread;
    // using the copied metadata id collapses many distinct histories into one
    // sidebar row and one side chat.
    const sessionId =
      sessionIdFromRolloutFile(file) ||
      metadata.id ||
      file.replace('.jsonl', '');

    const status =
      age < TIMING.activeThresholdMs ? 'active' as const :
      age < TIMING.idleThresholdMs ? 'idle' as const :
      'history' as const;

    results.push({
      jsonlPath,
      session: {
        id: sessionId,
          source: 'codex',
          projectName: metadata.projectName || 'unknown',
          title: metadata.title,
        projectDir: metadata.cwd || path.dirname(jsonlPath),
        jsonlPath,
        cwd: metadata.cwd || '',
        gitBranch: metadata.gitBranch || 'unknown',
        slug: sessionId.slice(0, 8),
        model: metadata.model || 'unknown',
        version: metadata.cliVersion || '',
        usedPercent: 0,
        contextStatus: 'safe',
        status,
        lastEventTime: new Date(mtime),
        eventCount: 0,
        currentActivity: '',
      },
    });
  }

  return results;
}

function sessionIdFromRolloutFile(fileName: string): string {
  return fileName.match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i,
  )?.[1] ?? '';
}

function listJsonlFiles(root: string): string[] {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) pending.push(fullPath);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(fullPath);
    }
  }
  return files;
}

interface CodexSessionMeta {
  id?: string;
  cwd?: string;
  gitBranch?: string;
  projectName?: string;
  model?: string;
  cliVersion?: string;
  title?: string;
}

function readCodexSessionMeta(jsonlPath: string): CodexSessionMeta {
  const meta: CodexSessionMeta = {};

  scanJsonlPrefix(jsonlPath, (line) => {
    try {
      const parsed = JSON.parse(line);

      if (parsed.type === 'session_meta' && parsed.payload) {
        const p = parsed.payload;
        meta.id = p.id;
        meta.cwd = p.cwd;
        meta.cliVersion = p.cli_version;
        if (p.git?.branch) meta.gitBranch = p.git.branch;
        if (p.cwd) meta.projectName = extractProjectNameFromCwd(p.cwd);
      }

      if (parsed.type === 'turn_context' && parsed.payload?.model && !meta.model) {
        meta.model = parsed.payload.model;
      }

      if (
        parsed.type === 'event_msg' &&
        parsed.payload?.type === 'user_message' &&
        !meta.title
      ) {
        meta.title = cleanThreadTitle(parsed.payload.message);
      }

      if (meta.id && meta.cwd && meta.model && meta.gitBranch && meta.title) return true;
    } catch {
      // Skip malformed lines
    }
    return false;
  }, { maxBytes: 512 * 1024, maxLines: 400 });

  return meta;
}

function cachedMetadata(jsonlPath: string, stat: fs.Stats): CodexSessionMeta {
  const cached = metadataCache.get(jsonlPath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.metadata;
  }
  const metadata = readCodexSessionMeta(jsonlPath);
  metadataCache.set(jsonlPath, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    metadata,
  });
  return metadata;
}
