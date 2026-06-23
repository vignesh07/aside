import type { SessionEvent } from '../types/events.js';
import type { ChatTurn } from '../types/chat.js';
import { resolveOAuthApiKeyForProvider } from './oauth-auth-store.js';

/**
 * The side chat is a *read-only observer*. It can see everything the watched
 * agent session is doing, but it has no tools and cannot act on the session,
 * the filesystem, or anything else. Its only job is to answer the user's
 * questions about what the main agent is up to — so the user can ask "by the
 * way, why did it pick X?" without derailing the main thread.
 */
const SYSTEM_PROMPT = `You are "aside" — a read-only observer attached to a running AI coding-agent session.

You can see a live transcript of what the main agent (Claude Code, Codex, etc.) is doing: the user's prompts, the agent's responses, the tools it runs, files it edits, and command output. The user is chatting with YOU on the side, so they can ask questions WITHOUT interrupting or steering the main agent.

Your job:
- Answer questions about what the main session is doing, why, and what it might do next.
- Explain decisions, summarize progress, flag risks or mistakes you notice.
- Be concise and direct. This is a side panel in a terminal, not an essay.

Hard constraints:
- You are READ-ONLY. You have no tools and cannot edit files, run commands, or send anything into the main session. Never claim to have done so.
- If asked to *do* something to the codebase, explain that you only observe — the user should tell the main agent directly.
- If the transcript doesn't contain the answer, say so plainly rather than guessing. Don't invent activity that isn't in the transcript.`;

export interface SideChatEngineConfig {
  provider: string;
  model: string;
  authFile?: string;
}

export interface AskParams {
  /** Human-readable name of the watched session (project/branch). */
  projectName: string;
  /** Recent activity in the watched session, oldest-first. */
  transcript: SessionEvent[];
  /** Prior side-chat turns for continuity (excludes the new question). */
  history: ChatTurn[];
  /** The new question the user is asking. */
  question: string;
}

/**
 * Answers questions about a watched session. Reuses pi-ai for multi-provider
 * routing and the shared OAuth key resolution, mirroring talkatui's engine —
 * the only real differences are the prompt and that this is request/response
 * instead of auto-generated commentary.
 */
export class SideChatEngine {
  private config: SideChatEngineConfig;
  private piAi: typeof import('@mariozechner/pi-ai') | null = null;

  constructor(config: SideChatEngineConfig) {
    this.config = config;
  }

  setModel(provider: string, model: string): void {
    this.config = { ...this.config, provider, model };
    // Force re-import so a freshly selected provider is picked up.
    this.piAi = null;
  }

  async ask({ projectName, transcript, history, question }: AskParams): Promise<string> {
    const piAi = await this.loadPiAi();
    const providers = piAi.getProviders();
    if (!providers.includes(this.config.provider as never)) {
      throw new Error(`Unknown provider: ${this.config.provider}`);
    }
    const provider = this.config.provider as (typeof providers)[number];
    const model = piAi.getModels(provider).find((m) => m.id === this.config.model);
    if (!model) {
      throw new Error(`Unknown model ${this.config.model} for provider ${this.config.provider}`);
    }

    const explicitApiKey = await this.resolveApiKey(piAi, provider);

    // Both the watched transcript and the prior side-chat Q&A are folded into
    // the system prompt, so the single outgoing message is a clean UserMessage.
    // (pi-ai's AssistantMessage carries provider metadata we can't fabricate,
    // so we don't try to replay history as real assistant turns.) The prompt is
    // rebuilt every ask, so the observer always sees the latest activity.
    const systemPrompt = [
      SYSTEM_PROMPT,
      renderTranscript(projectName, transcript),
      renderHistory(history),
    ]
      .filter(Boolean)
      .join('\n\n');

    const response = await piAi.completeSimple(
      model,
      {
        systemPrompt,
        messages: [{ role: 'user' as const, content: question, timestamp: Date.now() }],
      },
      explicitApiKey ? { apiKey: explicitApiKey } : undefined,
    );

    let text = '';
    for (const block of response.content) {
      if ('text' in block && block.text) {
        text += block.text;
      }
    }
    text = text.trim();
    return text || '(no response)';
  }

  private async resolveApiKey(
    piAi: typeof import('@mariozechner/pi-ai'),
    provider: string,
  ): Promise<string | null> {
    const envApiKey = piAi.getEnvApiKey(provider);
    if (envApiKey) {
      // pi-ai resolves env credentials itself; nothing to inject.
      return null;
    }
    return resolveOAuthApiKeyForProvider(provider, this.config.authFile, piAi.getOAuthApiKey);
  }

  private async loadPiAi() {
    if (!this.piAi) {
      this.piAi = await import('@mariozechner/pi-ai');
    }
    return this.piAi;
  }
}

/** Render the watched session's recent activity as a plain-text block. */
function renderTranscript(projectName: string, transcript: SessionEvent[]): string {
  const lines = transcript.map(formatEvent).filter(Boolean);
  if (lines.length === 0) {
    return `You are watching session "${projectName}". No activity has been observed yet.`;
  }
  return `=== Live transcript of session "${projectName}" (oldest first) ===\n${lines.join('\n')}`;
}

/** Render prior side-chat turns as context so the conversation stays coherent. */
function renderHistory(history: ChatTurn[]): string {
  if (history.length === 0) return '';
  const lines = history.map((turn) => `${turn.role === 'user' ? 'User asked' : 'You answered'}: ${turn.content}`);
  return `=== Earlier in this side chat (for continuity) ===\n${lines.join('\n')}`;
}

function formatEvent(event: SessionEvent): string {
  switch (event.kind) {
    case 'session_started':
      return `[session started] project=${event.project} branch=${event.branch} model=${event.model}`;
    case 'user_prompt':
      return `[user] ${event.summary}`;
    case 'assistant_text':
      return `[agent] ${event.preview}`;
    case 'tool_call':
      return `[tool] ${event.tool} → ${event.target}`;
    case 'tool_result_ok':
      return `[tool ok] ${event.tool}: ${event.summary}`;
    case 'tool_result_error':
      return `[tool ERROR] ${event.tool}: ${event.error}`;
    case 'tool_rejected':
      return `[tool rejected by user] ${event.tool}`;
    case 'bash_running':
      return `[bash running ${event.elapsedSeconds}s] ${event.command}`;
    case 'bash_complete':
      return `[bash done exit=${event.exitCode}] ${event.command}`;
    case 'file_written':
      return `[wrote file] ${event.path}`;
    case 'file_edited':
      return `[edited file] ${event.path}`;
    case 'turn_complete':
      return `[turn complete in ${(event.durationMs / 1000).toFixed(1)}s]`;
    case 'context_health':
      return `[context ${event.usedPercent}% used (${event.status})]`;
    case 'unknown':
      return '';
    default:
      return '';
  }
}

export { SYSTEM_PROMPT, renderTranscript, renderHistory, formatEvent };
