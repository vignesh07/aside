import * as fs from 'node:fs';
import * as path from 'node:path';
import { CODEX_DIR, TIMING } from '../config/defaults.js';
import { extractProjectNameFromCwd } from '../utils/project-name.js';
import { scanJsonlPrefix } from './jsonl-prefix-reader.js';
import type { TrackedSession } from '../types/session.js';

interface DiscoveredCodexSession {
  session: TrackedSession;
  jsonlPath: string;
}

export function scanCodexSessions(): DiscoveredCodexSession[] {
  const results: DiscoveredCodexSession[] = [];
  const sessionsDir = path.join(CODEX_DIR, 'sessions');

  if (!fs.existsSync(sessionsDir)) return results;

  // Scan today's and yesterday's date directories
  const now = new Date();
  const dateDirs = [dateDir(now), dateDir(new Date(now.getTime() - 86400_000))];

  for (const dateDir of dateDirs) {
    const fullDir = path.join(sessionsDir, dateDir);
    if (!fs.existsSync(fullDir)) continue;

    let files: string[];
    try {
      files = fs.readdirSync(fullDir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }

    for (const file of files) {
      const jsonlPath = path.join(fullDir, file);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(jsonlPath);
      } catch {
        continue;
      }

      const mtime = stat.mtimeMs;
      const age = Date.now() - mtime;

      if (age > TIMING.idleThresholdMs) continue;

      const metadata = readCodexSessionMeta(jsonlPath);
      const sessionId = metadata.id || file.replace('.jsonl', '');

      const status =
        age < TIMING.activeThresholdMs ? 'active' as const :
        age < TIMING.idleThresholdMs ? 'idle' as const :
        'ended' as const;

      results.push({
        jsonlPath,
        session: {
          id: sessionId,
          source: 'codex',
          projectName: metadata.projectName || 'unknown',
          projectDir: metadata.cwd || fullDir,
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
  }

  return results;
}

function dateDir(d: Date): string {
  const y = d.getFullYear().toString();
  const m = (d.getMonth() + 1).toString().padStart(2, '0');
  const day = d.getDate().toString().padStart(2, '0');
  return path.join(y, m, day);
}

interface CodexSessionMeta {
  id?: string;
  cwd?: string;
  gitBranch?: string;
  projectName?: string;
  model?: string;
  cliVersion?: string;
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

      if (meta.id && meta.cwd && meta.model && meta.gitBranch) return true;
    } catch {
      // Skip malformed lines
    }
    return false;
  }, { maxBytes: 512 * 1024, maxLines: 400 });

  return meta;
}
