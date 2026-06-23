import * as fs from 'node:fs';
import * as path from 'node:path';
import { CLAUDE_DIR, TIMING } from '../config/defaults.js';
import { extractProjectName } from '../utils/project-name.js';
import { scanJsonlPrefix } from './jsonl-prefix-reader.js';
import type { TrackedSession, ClaudeContextState } from '../types/session.js';

interface DiscoveredClaudeSession {
  session: TrackedSession;
  jsonlPath: string;
}

export function scanClaudeSessions(): DiscoveredClaudeSession[] {
  const results: DiscoveredClaudeSession[] = [];

  // 1. Read context_state files to find sessions with recent activity
  const contextStates = readContextStates();

  // 2. Also scan for recently modified JSONL files directly
  //    (catches sessions without context_state files)
  const projectsDir = path.join(CLAUDE_DIR, 'projects');
  if (!fs.existsSync(projectsDir)) return results;

  const projectDirs = fs.readdirSync(projectsDir);

  for (const projDir of projectDirs) {
    const fullProjDir = path.join(projectsDir, projDir);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(fullProjDir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    let jsonlFiles: string[];
    try {
      jsonlFiles = fs.readdirSync(fullProjDir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }

    for (const jsonlFile of jsonlFiles) {
      const jsonlPath = path.join(fullProjDir, jsonlFile);
      const sessionId = jsonlFile.replace('.jsonl', '');

      let jsonlStat: fs.Stats;
      try {
        jsonlStat = fs.statSync(jsonlPath);
      } catch {
        continue;
      }

      const mtime = jsonlStat.mtimeMs;
      const age = Date.now() - mtime;

      // Only include sessions modified recently
      if (age > TIMING.idleThresholdMs) continue;

      // Look up context state for this session
      const contextState = contextStates.find((cs) =>
        sessionId.startsWith(cs.session_id)
      );

      const metadata = readSessionMetadata(jsonlPath);

      const status =
        age < TIMING.activeThresholdMs ? 'active' as const :
        age < TIMING.idleThresholdMs ? 'idle' as const :
        'ended' as const;

      results.push({
        jsonlPath,
        session: {
          id: sessionId,
          source: 'claude',
          projectName: extractProjectName(projDir),
          projectDir: fullProjDir,
          jsonlPath,
          cwd: metadata.cwd || fullProjDir,
          gitBranch: metadata.gitBranch || 'unknown',
          slug: metadata.slug || sessionId.slice(0, 8),
          model: metadata.model || 'unknown',
          version: metadata.version || '',
          usedPercent: contextState?.used_percent ?? 0,
          contextStatus: contextState?.status ?? 'safe',
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

function readContextStates(): ClaudeContextState[] {
  const states: ClaudeContextState[] = [];

  let files: string[];
  try {
    files = fs.readdirSync(CLAUDE_DIR).filter((f) => f.startsWith('context_state_'));
  } catch {
    return states;
  }

  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(CLAUDE_DIR, file), 'utf-8');
      const parsed = JSON.parse(raw) as ClaudeContextState;
      states.push(parsed);
    } catch {
      // Skip malformed state files
    }
  }

  return states;
}

interface SessionMetadata {
  cwd?: string;
  gitBranch?: string;
  slug?: string;
  model?: string;
  version?: string;
}

function readSessionMetadata(jsonlPath: string): SessionMetadata {
  const meta: SessionMetadata = {};

  scanJsonlPrefix(jsonlPath, (line) => {
    try {
      const parsed = JSON.parse(line);
      if (parsed.cwd && !meta.cwd) meta.cwd = parsed.cwd;
      if (parsed.gitBranch && !meta.gitBranch) meta.gitBranch = parsed.gitBranch;
      if (parsed.slug && !meta.slug) meta.slug = parsed.slug;
      if (parsed.version && !meta.version) meta.version = parsed.version;
      if (parsed.message?.model && !meta.model) meta.model = parsed.message.model;

      // If we have everything, stop reading
      if (meta.cwd && meta.gitBranch && meta.slug && meta.model && meta.version) {
        return true;
      }
    } catch {
      // Skip malformed lines
    }
    return false;
  }, { maxBytes: 512 * 1024, maxLines: 300 });

  return meta;
}
