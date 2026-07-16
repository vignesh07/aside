import { ClaudeSession } from './claude-session.js';
import type { CompletionRequest, Provider } from './types.js';

export { OBSERVER_CWD, OBSERVER_PROJECT_MARKER } from './claude-session.js';

/**
 * One session for the process's lifetime.
 *
 * Module-level because the conversation *is* the state: aside has one chat, so
 * it has one session. A fresh session per question would be the per-spawn design
 * this replaced — slow, and amnesiac.
 */
const session = new ClaudeSession();

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

  complete({ model, systemPrompt, context, question }: CompletionRequest) {
    // `history` is deliberately unused: the session already lived through it.
    // Re-sending it would duplicate the conversation inside its own context.
    return session.ask(model, systemPrompt, context, question);
  },
};

/** Stop the background session. Safe to call when none is running. */
export function disposeClaudeSession(): void {
  session.dispose();
}

/** True while a conversation is live (i.e. a warm process is waiting). */
export function isClaudeSessionRunning(): boolean {
  return session.isRunning;
}
