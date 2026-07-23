import * as fs from 'node:fs';
import * as path from 'node:path';
import { CLAUDE_DIR, TIMING } from '../config/defaults.js';
import { extractProjectName, extractProjectNameFromCwd } from '../utils/project-name.js';
import { cleanThreadTitle } from '../utils/thread-title.js';
import { scanJsonlPrefix } from './jsonl-prefix-reader.js';
import type { TrackedSession, ClaudeContextState } from '../types/session.js';

interface DiscoveredClaudeSession {
  session: TrackedSession;
  jsonlPath: string;
}

interface ClaudeScannerOptions {
  claudeDir?: string;
  nowMs?: number;
}

const metadataCache = new Map<
  string,
  { mtimeMs: number; size: number; metadata: SessionMetadata }
>();

export function scanClaudeSessions(options: ClaudeScannerOptions = {}): DiscoveredClaudeSession[] {
  const results: DiscoveredClaudeSession[] = [];
  const claudeDir = options.claudeDir ?? CLAUDE_DIR;
  const nowMs = options.nowMs ?? Date.now();

  // Context-state files enrich Claude sessions but are not the discovery source.
  const contextStates = readContextStates(claudeDir);

  // Every transcript is discoverable. Modification time only determines its
  // activity label; it never determines whether the thread exists.
  const projectsDir = path.join(claudeDir, 'projects');
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
      const age = Math.max(0, nowMs - mtime);

      // Look up context state for this session
      const contextState = contextStates.find((cs) =>
        sessionId.startsWith(cs.session_id)
      );

      const metadata = cachedMetadata(jsonlPath, jsonlStat);

      const status =
        age < TIMING.activeThresholdMs ? 'active' as const :
        age < TIMING.idleThresholdMs ? 'idle' as const :
        'history' as const;

      results.push({
        jsonlPath,
        session: {
          id: sessionId,
          source: 'claude',
          projectName: metadata.cwd
            ? extractProjectNameFromCwd(metadata.cwd)
            : extractProjectName(projDir),
          title: metadata.title,
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

function readContextStates(claudeDir: string): ClaudeContextState[] {
  const states: ClaudeContextState[] = [];

  let files: string[];
  try {
    files = fs.readdirSync(claudeDir).filter((f) => f.startsWith('context_state_'));
  } catch {
    return states;
  }

  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(claudeDir, file), 'utf-8');
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
  title?: string;
  firstPrompt?: string;
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
      if (parsed.type === 'ai-title' && parsed.aiTitle) {
        meta.title = cleanThreadTitle(parsed.aiTitle);
      }
      if (parsed.type === 'user' && !meta.firstPrompt) {
        const content = parsed.message?.content;
        if (typeof content === 'string') meta.firstPrompt = cleanThreadTitle(content);
        else if (Array.isArray(content)) {
          const text = content.find(
            (part: Record<string, unknown>) => part['type'] === 'text',
          );
          meta.firstPrompt = cleanThreadTitle(text?.['text']);
        }
      }

      // If we have everything, stop reading
      if (meta.cwd && meta.gitBranch && meta.slug && meta.model && meta.version && meta.title) {
        return true;
      }
    } catch {
      // Skip malformed lines
    }
    return false;
  }, { maxBytes: 512 * 1024, maxLines: 300 });

  if (!meta.title) meta.title = meta.firstPrompt;
  return meta;
}

function cachedMetadata(jsonlPath: string, stat: fs.Stats): SessionMetadata {
  const cached = metadataCache.get(jsonlPath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.metadata;
  }
  const metadata = readSessionMetadata(jsonlPath);
  metadataCache.set(jsonlPath, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    metadata,
  });
  return metadata;
}
