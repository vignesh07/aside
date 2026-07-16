import type { ChatTurn } from '../types/chat.js';
import type { WorldSnapshot } from '../types/world.js';
import { resolveOAuthApiKeyForProvider } from './oauth-auth-store.js';
import { renderWorld, renderHistory, TRANSCRIPT_BUDGET_CHARS } from './world-view.js';

/**
 * The side chat is a *read-only observer* with a bird's-eye view: it sees every
 * agent session aside can discover, not just one. It has no tools and cannot act
 * on any session, the filesystem, or anything else — so the user can ask "why did
 * it pick that path?" or "is anything stuck?" without touching the main threads.
 */
const SYSTEM_PROMPT = `You are "aside" — a read-only observer with a bird's-eye view of the AI coding-agent sessions running on this user's machine.

You are given, for every session you can see: a roster line (project, branch, source, status, how long it has been quiet, context usage, last observed activity), and — for the sessions most worth the detail — a recent transcript of prompts, agent replies, tool calls, file edits, and command output.

The user chats with YOU on the side. They are asking about their agents WITHOUT interrupting or steering them.

Your job:
- Answer questions across all sessions: what each agent is doing right now, why it went the way it did, what it will likely do next.
- Compare and connect sessions when it helps ("both are editing the same file", "this one has been stuck for 20 minutes while that one finished").
- Notice things worth flagging: a session quiet far longer than its work suggests it should be, repeated failing commands, a session burning context, an agent that looks off-track.
- Be concise and direct. This is a side panel, not an essay.

Formatting:
- Answer in plain prose. Both frontends render your reply as literal text, so markdown does not format — "## Heading", "**bold**" and "---" appear verbatim and just look like noise. Use short paragraphs and plain "-" bullets only.
- Lead with the answer. A one-line verdict first, detail after.

Reading the data:
- "Current time" and each session's "quiet for" are computed for you. Use them for anything about idleness or how long something has taken — you cannot infer elapsed time from the transcript alone, because a session that does nothing writes nothing.
- A session being quiet is not automatically a problem. An agent waiting on the user, or finished, is quiet and fine. Say what the quiet most likely means given its last activity, and distinguish "waiting for input" from "stalled mid-task".
- Transcript prose is truncated, so an agent's reasoning may be cut off mid-thought. Don't mistake a truncation for the agent stopping.

Hard constraints:
- You are READ-ONLY. You have no tools and cannot edit files, run commands, or send anything into any session. Never claim to have done so.
- If asked to *do* something, explain that you only observe — the user should tell that agent directly.
- You see agent sessions only. You cannot see builds, containers, other terminals, browser tabs, or anything else on the machine. If asked about something outside the sessions, say plainly that it's outside what you can see.
- If the data doesn't answer the question, say so rather than guessing. Never invent activity that isn't in the transcript. If detail for a session was omitted from your context, say that instead of assuming it was idle.`;

export interface SideChatEngineConfig {
  provider: string;
  model: string;
  authFile?: string;
  /** Character budget for rendered transcripts. Defaults to {@link TRANSCRIPT_BUDGET_CHARS}. */
  transcriptBudget?: number;
}

export interface AskParams {
  /** Everything the observer can see, at one instant. */
  world: WorldSnapshot;
  /** Prior side-chat turns for continuity (excludes the new question). */
  history: ChatTurn[];
  /** The new question the user is asking. */
  question: string;
}

/**
 * Answers questions about every watched session. Reuses pi-ai for multi-provider
 * routing and the shared OAuth key resolution — the prompt is rebuilt on every
 * ask, so the observer always reasons over current state rather than a snapshot
 * taken when the chat opened.
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

  async ask({ world, history, question }: AskParams): Promise<string> {
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

    // Both the observed world and the prior side-chat Q&A are folded into the
    // system prompt, so the single outgoing message is a clean UserMessage.
    // (pi-ai's AssistantMessage carries provider metadata we can't fabricate,
    // so we don't try to replay history as real assistant turns.)
    const systemPrompt = [
      SYSTEM_PROMPT,
      renderWorld(world, this.config.transcriptBudget ?? TRANSCRIPT_BUDGET_CHARS),
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

export { SYSTEM_PROMPT };
