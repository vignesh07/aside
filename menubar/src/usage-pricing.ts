import type { UsageTokenCounts } from './usage-types.js';

export const USAGE_PRICING_AS_OF = '2026-07-31';
export const LOCAL_BENCHMARK_LABEL =
  'GPT-5.6 Luna public API rate ($1 input / $6 output per 1M)';

interface ModelPrice {
  provider: string;
  matches: RegExp;
  input: number;
  cachedInput: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  output: number;
}

// USD per million tokens. Sources checked 2026-07-31:
// https://developers.openai.com/api/docs/models/compare
// https://platform.claude.com/docs/en/about-claude/pricing
// https://ai.google.dev/gemini-api/docs/pricing
const PRICES: ModelPrice[] = [
  price('openai', /^gpt-5\.6-terra(?:-|$)/, 2.5, 0.25, 3.125, 15),
  price('openai', /^gpt-5\.6-luna(?:-|$)/, 1, 0.1, 1.25, 6),
  price('openai', /^gpt-5\.6(?:-sol)?(?:-|$)/, 5, 0.5, 6.25, 30),
  price('openai', /^gpt-5\.5(?!-pro)(?:-|$)/, 5, 0.5, 6.25, 30),
  price('openai', /^gpt-5\.5-pro(?:-|$)/, 30, 30, 30, 180),
  price('openai', /^gpt-5\.4-mini(?:-|$)/, 0.75, 0.075, 0.75, 4.5),
  price('openai', /^gpt-5\.4-nano(?:-|$)/, 0.2, 0.02, 0.2, 1.25),
  price('openai', /^gpt-5\.4(?:-|$)/, 2.5, 0.25, 2.5, 15),
  price('openai', /^gpt-5\.2(?:-|$)/, 1.75, 0.175, 1.75, 14),
  price('openai', /^gpt-5(?:\.1)?(?:-codex(?:-max)?)?(?:-|$)/, 1.25, 0.125, 1.25, 10),

  price('anthropic', /^claude-(?:fable|mythos)-5(?:-|$)/, 10, 1, 12.5, 50, 20),
  price('anthropic', /^claude-opus-(?:5|4-[5-8])(?:-|$)/, 5, 0.5, 6.25, 25, 10),
  price('anthropic', /^claude-opus-4(?:-1)?(?:-|$)/, 15, 1.5, 18.75, 75, 30),
  // Sonnet 5 introductory pricing through 2026-08-31.
  price('anthropic', /^claude-sonnet-5(?:-|$)/, 2, 0.2, 2.5, 10, 4),
  price('anthropic', /^claude-sonnet-4(?:-[5-6])?(?:-|$)/, 3, 0.3, 3.75, 15, 6),
  price('anthropic', /^claude-haiku-4-5(?:-|$)/, 1, 0.1, 1.25, 5, 2),
  price('anthropic', /^claude-(?:3-5-haiku|haiku-3-5)(?:-|$)/, 0.8, 0.08, 1, 4, 1.6),

  price('google', /^gemini-3\.5-flash(?:-|$)/, 1.5, 0.15, 1.5, 9),
  price('google', /^gemini-3\.1-pro(?:-|$)/, 2, 0.2, 2, 12),
  price('google', /^gemini-3\.1-flash-lite(?:-|$)/, 0.25, 0.025, 0.25, 1.5),
];

const LOCAL_BENCHMARK: ModelPrice =
  price('local', /.*/, 1, 0.1, 1.25, 6);

export interface UsageEstimate {
  costUsd: number;
  savingsUsd: number;
  priced: boolean;
}

export function estimateUsage(
  provider: string,
  model: string,
  local: boolean,
  counts: UsageTokenCounts,
): UsageEstimate {
  if (local) {
    return {
      costUsd: 0,
      savingsUsd: estimateWithPrice(LOCAL_BENCHMARK, counts),
      priced: true,
    };
  }
  const normalizedModel = model.toLocaleLowerCase();
  const found = PRICES.find(
    (candidate) =>
      candidate.provider === provider && candidate.matches.test(normalizedModel),
  );
  if (!found) return { costUsd: 0, savingsUsd: 0, priced: false };
  return {
    costUsd: estimateWithPrice(found, counts),
    savingsUsd: 0,
    priced: true,
  };
}

function estimateWithPrice(
  modelPrice: ModelPrice,
  counts: UsageTokenCounts,
): number {
  return (
    counts.inputTokens * modelPrice.input +
    counts.cachedInputTokens * modelPrice.cachedInput +
    counts.cacheWrite5mInputTokens * modelPrice.cacheWrite5m +
    counts.cacheWrite1hInputTokens * modelPrice.cacheWrite1h +
    counts.outputTokens * modelPrice.output
  ) / 1_000_000;
}

function price(
  provider: string,
  matches: RegExp,
  input: number,
  cachedInput: number,
  cacheWrite5m: number,
  output: number,
  cacheWrite1h = cacheWrite5m,
): ModelPrice {
  return {
    provider,
    matches,
    input,
    cachedInput,
    cacheWrite5m,
    cacheWrite1h,
    output,
  };
}
