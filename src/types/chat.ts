import type { SessionSource } from './session.js';

/** A single turn in the side chat (not the watched session). */
export interface ChatTurn {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  /** Set on an assistant turn that failed, so the UI can surface the error. */
  error?: boolean;
}

/** The permanent cross-session thread. */
export const FLEET_THREAD_ID = 'fleet';

/** A side-chat thread is either the whole fleet or one concrete agent session. */
export type ChatThreadScope =
  | { kind: 'fleet' }
  | {
      kind: 'session';
      /** Null only while conservatively migrating a pre-source thread id. */
      source: SessionSource | null;
      sessionId: string;
    };

export interface ChatThread {
  id: string;
  scope: ChatThreadScope;
  provider: string;
  model: string;
  turns: ChatTurn[];
  thinking: boolean;
  updatedAt: Date;
}

export function sessionThreadId(
  source: SessionSource,
  sessionId: string,
): string {
  return `session:${source}:${encodeURIComponent(sessionId)}`;
}

export function scopeFromThreadId(threadId: string): ChatThreadScope {
  if (threadId === FLEET_THREAD_ID) return { kind: 'fleet' };
  const prefix = 'session:';
  if (!threadId.startsWith(prefix) || threadId.length <= prefix.length) {
    return { kind: 'fleet' };
  }
  const remainder = threadId.slice(prefix.length);
  const separator = remainder.indexOf(':');
  if (separator > 0) {
    const source = remainder.slice(0, separator);
    if (isSessionSource(source)) {
      try {
        const sessionId = decodeURIComponent(remainder.slice(separator + 1));
        if (
          sessionId &&
          sessionThreadId(source, sessionId) === threadId
        ) {
          return { kind: 'session', source, sessionId };
        }
      } catch {
        return { kind: 'fleet' };
      }
    }
  }
  // Public builds before OpenCode used `session:<vendor id>`. The source
  // cannot be guessed here; SideChatService migrates it only after a scan finds
  // exactly one matching source.
  return { kind: 'session', source: null, sessionId: remainder };
}

export function legacySessionThreadId(sessionId: string): string {
  return `session:${sessionId}`;
}

function isSessionSource(value: string): value is SessionSource {
  return (
    value === 'claude' ||
    value === 'codex' ||
    value === 'pi' ||
    value === 'opencode'
  );
}
