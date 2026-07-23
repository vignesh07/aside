import type { ChatTurn } from '../types/chat.js';
import type { ChatThreadScope } from '../types/chat.js';
import type { WorldSnapshot } from '../types/world.js';
import { complete, getProvider } from './providers/index.js';
import { renderWorld, renderHistory, TRANSCRIPT_BUDGET_CHARS } from './world-view.js';
import { redactSensitiveText } from './redact-sensitive.js';

/**
 * The side chat is a *read-only observer*. The fleet thread sees every recent
 * session plus a query-relevant slice of searchable history; a session thread
 * sees exactly one. It cannot act on sessions or the filesystem.
 */
const SYSTEM_PROMPT = `You are "aside" — a read-only observer for local AI coding-agent threads.

The user can chat in two kinds of persistent thread:
- Fleet thread: you receive every recent session plus history selected for relevance to the user's question. The roster states how many total threads were discovered.
- Session side thread: you receive exactly one selected session and stay focused on that agent's work.

For each session in scope you receive a roster line (project, branch, source, status, how long it has been quiet, context usage, last observed activity) and recent transcript detail.

The user chats with YOU on the side. They are asking about their agents WITHOUT interrupting or steering them. Their thread with you persists separately from the agent session.

Your job:
- Answer questions across recent and historical sessions: what each agent is doing, why it went the way it did, and what it will likely do next.
- Compare and connect sessions when it helps ("both are editing the same file", "this one has been stuck for 20 minutes while that one finished").
- Notice things worth flagging: a session quiet far longer than its work suggests it should be, repeated failing commands, a session burning context, an agent that looks off-track.
- Be concise and direct. This is a side panel, not an essay.

Formatting:
- Answer in plain prose. Both frontends render your reply as literal text, so markdown does not format — "## Heading", "**bold**" and "---" appear verbatim and just look like noise. Use short paragraphs and plain "-" bullets only.
- Lead with the answer. A one-line verdict first, detail after.

Reading the data:
- "Current time" and each session's "quiet for" are computed for you. Use them for anything about idleness or how long something has taken — you cannot infer elapsed time from the transcript alone, because a session that does nothing writes nothing.
- A session being quiet is not automatically a problem. An agent waiting on the user, or finished, is quiet and fine. Say what the quiet most likely means given its last activity, and distinguish "waiting for input" from "stalled mid-task".
- HISTORY means the transcript has not changed recently. It does not prove the agent window was closed or the task ended.
- Transcript prose is truncated, so an agent's reasoning may be cut off mid-thought. Don't mistake a truncation for the agent stopping.

Hard constraints:
- You are READ-ONLY. You have no tools and cannot edit files, run commands, or send anything into any session. Never claim to have done so.
- If asked to *do* something, explain that you only observe — the user should tell that agent directly.
- You see agent sessions only. You cannot see builds, containers, other terminals, browser tabs, or anything else on the machine. If asked about something outside the sessions, say plainly that it's outside what you can see.
- If the data doesn't answer the question, say so rather than guessing. Never invent activity that isn't in the transcript. If detail for a session was omitted from your context, say that instead of assuming it was idle.`;

export interface SideChatEngineConfig {
  provider: string;
  model: string;
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
  /** Durable side-thread identity; keeps provider-side conversations isolated. */
  threadId: string;
  scope: ChatThreadScope;
  /** Model selection belongs to the thread, not the whole application. */
  provider: string;
  model: string;
}

/**
 * Answers questions about the selected side-thread scope.
 *
 * The prompt is rebuilt on every ask, so the observer always reasons over
 * current state rather than a snapshot taken when the chat opened.
 */
export class SideChatEngine {
  private config: SideChatEngineConfig;

  constructor(config: SideChatEngineConfig) {
    this.config = config;
  }

  setModel(provider: string, model: string): void {
    this.config = { ...this.config, provider, model };
  }

  async ask({
    world,
    history,
    question,
    threadId,
    scope,
    provider: providerId,
    model,
  }: AskParams): Promise<string> {
    const provider = getProvider(providerId || this.config.provider);
    if (!provider) {
      throw new Error(`Unknown provider: ${providerId || this.config.provider}`);
    }

    const scopeInstruction =
      scope.kind === 'fleet'
        ? 'Current side-thread scope: FLEET. Answer across the listed recent and query-relevant historical sessions, and respect the stated total discovered count.'
        : `Current side-thread scope: SESSION ${scope.sessionId}. Stay focused on this selected session.`;
    const context = redactSensitiveText(
      `${scopeInstruction}\n\n${renderWorld(
        world,
        this.config.transcriptBudget ?? TRANSCRIPT_BUDGET_CHARS,
      )}`,
    );
    const renderedHistory = redactSensitiveText(renderHistory(history));
    const redactedQuestion = redactSensitiveText(question);

    // Handed over in pieces rather than pre-mixed, because the provider decides
    // what it needs. A stateless HTTP API takes all three every call. A warm CLI
    // session remembers history; after restart it uses the durable copy to
    // restore continuity once.
    return complete(provider.id, {
      model: model || this.config.model,
      systemPrompt: SYSTEM_PROMPT,
      context,
      history: renderedHistory,
      question: redactedQuestion,
      conversationId: threadId,
    });
  }
}

export { SYSTEM_PROMPT };
