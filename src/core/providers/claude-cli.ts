import { ClaudeSession } from './claude-session.js';
import type { CompletionRequest, Provider } from './types.js';

export { OBSERVER_CWD, OBSERVER_PROJECT_MARKER } from './claude-session.js';

/** One warm Claude process per durable side-chat thread. */
const sessions = new Map<string, ClaudeSession>();

function sessionFor(id: string): ClaudeSession {
  const existing = sessions.get(id);
  if (existing) return existing;
  const created = new ClaudeSession();
  sessions.set(id, created);
  return created;
}

/**
 * Ask the user's own Claude Code CLI, over its existing login.
 *
 * This is the no-API-key path, and it works by *delegation*, not by borrowing
 * credentials. aside never reads a token: it runs the vendor's own client, which
 * owns authentication and refresh, exactly as if the user had typed the command.
 * (The same shape CodexBar uses for Codex.)
 *
 * Lifting OAuth tokens out of ~/.claude or the Keychain would mean presenting
 * aside to Anthropic as Claude Code. That's client impersonation, and the account
 * at risk would be the user's own — so aside doesn't, and doesn't need to.
 */
export const claudeCli: Provider = {
  id: 'claude-cli',
  label: 'Claude Code (your login, no API key)',
  apiKeyEnv: [],
  requiresApiKey: false,
  models: [
    { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', recommended: true },
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
    { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
  ],

  complete({
    model,
    systemPrompt,
    context,
    history,
    question,
    conversationId,
  }: CompletionRequest) {
    // A warm process already lived through the history. ClaudeSession only
    // injects the durable copy when it has to start a new process.
    return sessionFor(conversationId ?? 'fleet').ask(
      model,
      systemPrompt,
      context,
      question,
      history,
    );
  },
};

/** Stop one background side thread, or every one when omitted. */
export function disposeClaudeSession(conversationId?: string): void {
  if (conversationId) {
    sessions.get(conversationId)?.dispose();
    sessions.delete(conversationId);
    return;
  }
  for (const session of sessions.values()) session.dispose();
  sessions.clear();
}

/** True while any side conversation has a warm process waiting. */
export function isClaudeSessionRunning(): boolean {
  return [...sessions.values()].some((session) => session.isRunning);
}
