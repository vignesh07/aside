// Turns a WorldSnapshot into the text the observer model reads.
//
// The hard problem here is budget. A bird's-eye view means every session is in
// scope, but "every session x 150 events" neither fits in a prompt nor produces
// good answers — burying the one relevant session in ten irrelevant ones makes
// the model worse, not better. So the rendering is two-tier:
//
//   roster  — every session, one line, always. Cheap, and it's what answers
//             "what's running?" and "has anything stalled?".
//   detail  — recent transcript, only for sessions worth spending tokens on,
//             ranked by focus and liveness under a fixed character budget.
//
// Anything dropped from the detail tier is still in the roster, and the omission
// is stated in the prompt rather than left implicit.

import { formatEvent } from './transcript-format.js';
import type { SessionEvent } from '../types/events.js';
import type { ChatTurn } from '../types/chat.js';
import type { SessionSnapshot, WorldSnapshot } from '../types/world.js';

/** Total characters of session transcript allowed in one prompt. */
export const TRANSCRIPT_BUDGET_CHARS = 24_000;

/**
 * Least transcript worth rendering for a session. Below this you get a couple of
 * orphaned events — noise that reads like context but isn't. Better to leave the
 * session in the roster only and say it was omitted.
 */
export const MIN_DETAIL_CHARS = 400;

/** Ranking weights for the detail tier. Focus outranks liveness; liveness outranks history. */
const WEIGHTS = { focus: 6, active: 3, idle: 1.5, ended: 0.5 } as const;

function weightFor(session: SessionSnapshot, focusId: string | null): number {
  if (session.id === focusId) return WEIGHTS.focus;
  if (session.status === 'active') return WEIGHTS.active;
  if (session.status === 'idle') return WEIGHTS.idle;
  return WEIGHTS.ended;
}

export interface BudgetAllocation {
  /** Chars granted per session id. Sessions absent from this map get roster-only. */
  perSession: Map<string, number>;
  /** Ids that had transcript but lost their detail slot to the budget. */
  omitted: string[];
}

/**
 * Split `totalChars` across sessions by weight, dropping the weakest candidates
 * until every survivor clears {@link MIN_DETAIL_CHARS}.
 *
 * Proportional-with-a-floor: a pure proportional split starves low-weight
 * sessions into useless slivers once there are many of them, so instead of
 * handing out slivers we drop the lowest-weight session and re-split among the
 * rest. Terminates because each pass removes exactly one candidate.
 */
export function allocateTranscriptBudget(
  sessions: SessionSnapshot[],
  focusId: string | null,
  totalChars: number = TRANSCRIPT_BUDGET_CHARS,
): BudgetAllocation {
  const candidates = sessions.filter((s) => s.transcript.length > 0);
  const perSession = new Map<string, number>();
  if (candidates.length === 0 || totalChars < MIN_DETAIL_CHARS) {
    return { perSession, omitted: candidates.map((s) => s.id) };
  }

  let pool = candidates.map((s) => ({ id: s.id, weight: weightFor(s, focusId) }));
  for (;;) {
    const totalWeight = pool.reduce((sum, p) => sum + p.weight, 0);
    const shares = pool.map((p) => ({ ...p, share: Math.floor((totalChars * p.weight) / totalWeight) }));
    const starved = shares.some((s) => s.share < MIN_DETAIL_CHARS);
    if (!starved) {
      for (const s of shares) perSession.set(s.id, s.share);
      break;
    }
    if (pool.length === 1) {
      // A single candidate always gets the whole budget rather than nothing.
      perSession.set(pool[0]!.id, totalChars);
      break;
    }
    // Drop the weakest candidate and re-split. Ties break on the later session,
    // so earlier (higher-ranked by the scanner) sessions survive.
    let weakest = 0;
    for (let i = 1; i < pool.length; i += 1) {
      if (pool[i]!.weight <= pool[weakest]!.weight) weakest = i;
    }
    pool = pool.filter((_, i) => i !== weakest);
  }

  const omitted = candidates.filter((s) => !perSession.has(s.id)).map((s) => s.id);
  return { perSession, omitted };
}

/** Take whole events from the end of a transcript until `budget` chars are spent. */
export function tailWithinBudget(transcript: SessionEvent[], budget: number): string[] {
  const lines: string[] = [];
  let spent = 0;
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    const line = formatEvent(transcript[i]!);
    if (!line) continue;
    if (spent + line.length > budget && lines.length > 0) break;
    lines.unshift(line);
    spent += line.length + 1;
  }
  return lines;
}

/** Human duration for roster lines: "4s", "12m", "3h", "2d". */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * One line per session: identity, liveness, and how long it's been quiet.
 *
 * This is the tier that makes idleness answerable — "idle 14m" is a fact the
 * model cannot derive from a transcript, because silence writes nothing.
 */
export function renderRoster(world: WorldSnapshot): string {
  if (world.sessions.length === 0) {
    return 'No agent sessions are running. Nothing to observe right now.';
  }
  const lines = world.sessions.map((s) => {
    const focus = s.id === world.focusId ? ' <- user is focused here' : '';
    const branch = s.gitBranch ? ` (${s.gitBranch})` : '';
    const quiet = `quiet for ${formatDuration(s.idleForMs)}`;
    const activity = s.currentActivity ? ` | last seen: ${s.currentActivity}` : '';
    const ctx = s.contextUsedPercent > 0 ? ` | context ${s.contextUsedPercent}% (${s.contextStatus})` : '';
    return `- [${s.id}] ${s.source} · ${s.projectName}${branch} | ${s.status.toUpperCase()}, ${quiet}${ctx}${activity}${focus}`;
  });
  return `=== Agent sessions aside can see (${world.sessions.length}) ===\n${lines.join('\n')}`;
}

/** Budgeted per-session transcript blocks, deepest for focus and live sessions. */
export function renderDetail(
  world: WorldSnapshot,
  totalChars: number = TRANSCRIPT_BUDGET_CHARS,
): string {
  const { perSession, omitted } = allocateTranscriptBudget(world.sessions, world.focusId, totalChars);
  const blocks: string[] = [];

  for (const session of world.sessions) {
    const budget = perSession.get(session.id);
    if (!budget) continue;
    const lines = tailWithinBudget(session.transcript, budget);
    if (lines.length === 0) continue;
    const branch = session.gitBranch ? ` (${session.gitBranch})` : '';
    blocks.push(
      `--- [${session.id}] ${session.projectName}${branch} — most recent activity, oldest first ---\n${lines.join('\n')}`,
    );
  }

  if (blocks.length === 0) return '';

  let out = `=== Recent activity ===\n${blocks.join('\n\n')}`;
  if (omitted.length > 0) {
    // Stated explicitly: silence here would read as "these sessions did nothing".
    out += `\n\n(Transcript detail for ${omitted.length} other session(s) was omitted to fit the context budget. They are listed in the roster above; ask about one directly to focus it.)`;
  }
  return out;
}

/** The full observer view: what time it is, what's running, and what's happening. */
export function renderWorld(world: WorldSnapshot, totalChars: number = TRANSCRIPT_BUDGET_CHARS): string {
  return [
    `Current time: ${world.now.toISOString()}`,
    renderRoster(world),
    renderDetail(world, totalChars),
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Character budget for prior chat turns folded into the prompt.
 *
 * This chat is long-lived — the user opens it, asks, closes, and comes back
 * tomorrow. Unbounded, every prior answer (~1.5k tokens each) would ride along
 * on every subsequent question: cost rising with the age of the conversation
 * until it eventually blows the context entirely.
 */
export const HISTORY_BUDGET_CHARS = 8_000;

/**
 * Render prior side-chat turns as context so the conversation stays coherent.
 *
 * Keeps the most recent turns within budget. Older ones are dropped — and the
 * drop is *stated*, because a model told nothing about what it forgot will
 * happily contradict something it said an hour ago with full confidence.
 */
export function renderHistory(
  history: ChatTurn[],
  budgetChars: number = HISTORY_BUDGET_CHARS,
): string {
  if (history.length === 0) return '';

  const kept: string[] = [];
  let spent = 0;
  let dropped = 0;

  for (let i = history.length - 1; i >= 0; i -= 1) {
    const turn = history[i]!;
    const line = `${turn.role === 'user' ? 'User asked' : 'You answered'}: ${turn.content}`;
    if (spent + line.length > budgetChars && kept.length > 0) {
      dropped = i + 1;
      break;
    }
    kept.unshift(line);
    spent += line.length + 1;
  }

  const header =
    dropped > 0
      ? `=== Earlier in this side chat (${dropped} older turn(s) omitted for length) ===`
      : '=== Earlier in this side chat (for continuity) ===';
  return `${header}\n${kept.join('\n')}`;
}
