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
      /**
       * Missing only while reading a pre-provider-qualified
       * `session:<sessionId>` thread from an older Aside install.
       */
      source?: SessionSource;
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

/**
 * Durable session-side-chat identity.
 *
 * Vendor session ids are not globally unique. Keep the provider in the key so
 * a Claude and Codex thread with the same id never share a side conversation.
 */
export function sessionThreadId(
  source: SessionSource,
  sessionId: string,
): string {
  return `session:${source}:${sessionId}`;
}

/** The unqualified shape written by Aside versions before provider namespacing. */
export function legacySessionThreadId(sessionId: string): string {
  return `session:${sessionId}`;
}

export function scopeFromThreadId(threadId: string): ChatThreadScope {
  if (threadId === FLEET_THREAD_ID) return { kind: 'fleet' };
  if (threadId.startsWith('session:') && threadId.length > 'session:'.length) {
    const rest = threadId.slice('session:'.length);
    const sourceSeparator = rest.indexOf(':');
    if (sourceSeparator > 0 && sourceSeparator < rest.length - 1) {
      return {
        kind: 'session',
        source: rest.slice(0, sourceSeparator) as SessionSource,
        sessionId: rest.slice(sourceSeparator + 1),
      };
    }
    // Legacy thread ids are intentionally still readable. SideChatService
    // assigns the source once the scanner can identify the owning session.
    return { kind: 'session', sessionId: rest };
  }
  return { kind: 'fleet' };
}
