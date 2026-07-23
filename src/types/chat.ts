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
  | { kind: 'session'; sessionId: string };

export interface ChatThread {
  id: string;
  scope: ChatThreadScope;
  provider: string;
  model: string;
  turns: ChatTurn[];
  thinking: boolean;
  updatedAt: Date;
}

export function sessionThreadId(sessionId: string): string {
  return `session:${sessionId}`;
}

export function scopeFromThreadId(threadId: string): ChatThreadScope {
  if (threadId === FLEET_THREAD_ID) return { kind: 'fleet' };
  if (threadId.startsWith('session:') && threadId.length > 'session:'.length) {
    return { kind: 'session', sessionId: threadId.slice('session:'.length) };
  }
  return { kind: 'fleet' };
}
