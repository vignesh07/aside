export type SessionSource = 'claude' | 'codex' | 'pi';

export type SessionStatus = 'active' | 'idle' | 'ended';

export type ContextHealth = 'safe' | 'caution' | 'critical';

export interface TrackedSession {
  id: string;
  source: SessionSource;
  projectName: string;
  projectDir: string;
  jsonlPath: string;
  cwd: string;
  gitBranch: string;
  slug: string;
  model: string;
  version: string;

  usedPercent: number;
  contextStatus: ContextHealth;

  status: SessionStatus;
  lastEventTime: Date;
  eventCount: number;
  currentActivity: string;
}

export interface ClaudeContextState {
  session_id: string;
  free_tokens: number;
  total_used: number;
  usable_tokens: number;
  used_percent: number;
  status: ContextHealth;
  tool_count: number;
  last_checkpoint: number;
  timestamp: number;
}

export interface RawClaudeMessage {
  type: 'user' | 'assistant' | 'progress' | 'system' | 'file-history-snapshot';
  sessionId: string;
  timestamp: string;
  uuid: string;
  parentUuid: string | null;
  cwd: string;
  version: string;
  gitBranch?: string;
  slug?: string;
  message?: {
    role: 'user' | 'assistant';
    model?: string;
    content: unknown;
  };
  data?: {
    type: string;
    command?: string;
    output?: string;
    elapsedTimeSeconds?: number;
  };
  subtype?: string;
  durationMs?: number;
}

export interface RawCodexMessage {
  timestamp: string;
  type: 'session_meta' | 'response_item' | 'event_msg' | 'token_count' | 'turn_context';
  payload: Record<string, unknown>;
}

export interface ScopeFilter {
  projectName?: string;
  sessionIds?: string[];
  source?: SessionSource;
}
