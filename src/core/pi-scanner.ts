import * as fs from 'node:fs';
import * as path from 'node:path';
import { PI_DIR, TIMING } from '../config/defaults.js';
import { extractProjectNameFromCwd } from '../utils/project-name.js';
import { cleanThreadTitle } from '../utils/thread-title.js';
import { scanJsonlPrefix } from './jsonl-prefix-reader.js';
import type { TrackedSession } from '../types/session.js';

interface DiscoveredPiSession {
  session: TrackedSession;
  jsonlPath: string;
}

interface PiSessionMeta {
  id?: string;
  cwd?: string;
  projectName?: string;
  model?: string;
  version?: string;
  title?: string;
}

interface PiScannerOptions {
  sessionsDir?: string;
  nowMs?: number;
}

const metadataCache = new Map<
  string,
  { mtimeMs: number; size: number; metadata: PiSessionMeta }
>();

export function scanPiSessions(options: PiScannerOptions = {}): DiscoveredPiSession[] {
  const results: DiscoveredPiSession[] = [];
  const sessionsDir = options.sessionsDir ?? path.join(PI_DIR, 'agent', 'sessions');
  const nowMs = options.nowMs ?? Date.now();

  if (!fs.existsSync(sessionsDir)) return results;

  let projectDirs: fs.Dirent[];
  try {
    projectDirs = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const projectDirEntry of projectDirs) {
    if (!projectDirEntry.isDirectory()) continue;

    const projectDirName = projectDirEntry.name;
    const projectDirPath = path.join(sessionsDir, projectDirName);

    let files: string[];
    try {
      files = fs.readdirSync(projectDirPath).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }

    for (const file of files) {
      const jsonlPath = path.join(projectDirPath, file);

      let stat: fs.Stats;
      try {
        stat = fs.statSync(jsonlPath);
      } catch {
        continue;
      }

      const mtime = stat.mtimeMs;
      const age = Math.max(0, nowMs - mtime);

      const metadata = cachedMetadata(jsonlPath, stat);
      const sessionId = metadata.id || fallbackSessionId(file);
      const status =
        age < TIMING.activeThresholdMs ? 'active' as const :
        age < TIMING.idleThresholdMs ? 'idle' as const :
        'history' as const;

      const projectName = metadata.projectName || inferProjectNameFromDir(projectDirName);

      results.push({
        jsonlPath,
        session: {
          id: sessionId,
          source: 'pi',
          projectName,
          title: metadata.title,
          projectDir: metadata.cwd || projectDirPath,
          jsonlPath,
          cwd: metadata.cwd || projectDirPath,
          gitBranch: 'unknown',
          slug: sessionId.slice(0, 8),
          model: metadata.model || 'unknown',
          version: metadata.version || '',
          usedPercent: 0,
          contextStatus: 'safe',
          status,
          lastEventTime: new Date(mtime),
          eventCount: 0,
          currentActivity: '',
        },
      });
    }
  }

  return results;
}

function readPiSessionMeta(jsonlPath: string): PiSessionMeta {
  const meta: PiSessionMeta = {};

  scanJsonlPrefix(jsonlPath, (line) => {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const type = parsed['type'];

      if (type === 'session') {
        if (typeof parsed['id'] === 'string' && !meta.id) {
          meta.id = parsed['id'];
        }
        if (typeof parsed['cwd'] === 'string' && !meta.cwd) {
          meta.cwd = parsed['cwd'];
          meta.projectName = extractProjectNameFromCwd(parsed['cwd']);
        }
        if (parsed['version'] !== undefined && !meta.version) {
          meta.version = String(parsed['version']);
        }
      }

      if (type === 'model_change' && typeof parsed['modelId'] === 'string' && !meta.model) {
        meta.model = parsed['modelId'];
      }

      if (type === 'message') {
        const message = parsed['message'];
        if (message && typeof message === 'object') {
          const msg = message as Record<string, unknown>;
          if (typeof msg['model'] === 'string' && !meta.model) {
            meta.model = msg['model'];
          }
          if (msg['role'] === 'user' && !meta.title) {
            const content = msg['content'];
            if (typeof content === 'string') meta.title = cleanThreadTitle(content);
            else if (Array.isArray(content)) {
              const text = content.find(
                (part): part is Record<string, unknown> =>
                  Boolean(part) && typeof part === 'object' &&
                  (part as Record<string, unknown>)['type'] === 'text',
              );
              meta.title = cleanThreadTitle(text?.['text']);
            }
          }
        }
      }

      if (meta.id && meta.cwd && meta.model && meta.version) {
        return true;
      }
    } catch {
      // Skip malformed lines
    }

    return false;
  }, { maxBytes: 512 * 1024, maxLines: 400 });

  return meta;
}

function fallbackSessionId(fileName: string): string {
  const withoutExt = fileName.replace(/\.jsonl$/, '');
  const parts = withoutExt.split('_');
  return parts[parts.length - 1] || withoutExt;
}

function inferProjectNameFromDir(projectDirName: string): string {
  const normalized = projectDirName.replace(/^--/, '').replace(/--$/, '');
  const parts = normalized.split('-').filter(Boolean);
  return parts[parts.length - 1] || projectDirName;
}

function cachedMetadata(jsonlPath: string, stat: fs.Stats): PiSessionMeta {
  const cached = metadataCache.get(jsonlPath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.metadata;
  }
  const metadata = readPiSessionMeta(jsonlPath);
  metadataCache.set(jsonlPath, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    metadata,
  });
  return metadata;
}
