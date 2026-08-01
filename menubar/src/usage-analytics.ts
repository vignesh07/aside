import {
  LOCAL_BENCHMARK_LABEL,
  USAGE_PRICING_AS_OF,
  estimateUsage,
} from './usage-pricing.js';
import type {
  UsageAnalyticsQuery,
  UsageAnalyticsSnapshot,
  UsageDay,
  UsageModelBreakdown,
  UsageModelOption,
  UsageProviderOption,
  UsageTokenCounts,
  UsageTotals,
} from './usage-types.js';

export interface UsageAggregateRow {
  day: string;
  provider: string;
  model: string;
  local: number;
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  requests: number;
}

export function buildUsageSnapshot(
  rows: UsageAggregateRow[],
  query: UsageAnalyticsQuery,
  nowMs = Date.now(),
): UsageAnalyticsSnapshot {
  const rangeDays = query.rangeDays === 90 ? 90 : 365;
  const today = startOfLocalDay(new Date(nowMs));
  const start = new Date(today);
  start.setDate(start.getDate() - rangeDays + 1);
  const startDate = localDay(start);
  const endDate = localDay(today);
  const providerFilter = new Set(query.providers);
  const modelFilter = new Set(
    query.models.map(({ provider, model }) => modelIdentity(provider, model)),
  );

  const providerOptions = optionsByProvider(rows);
  const modelOptions = optionsByModel(rows);
  const filtered = rows.filter((row) =>
    (providerFilter.size === 0 || providerFilter.has(row.provider)) &&
    (modelFilter.size === 0 || modelFilter.has(modelIdentity(row.provider, row.model))),
  );

  const days = dayRange(start, rangeDays);
  const dayMap = new Map(days.map((date) => [date, emptyDay(date)]));
  const modelMap = new Map<string, UsageModelBreakdown>();
  const totals = emptyTotals();

  for (const row of filtered) {
    const day = dayMap.get(row.day);
    if (!day) continue;
    const counts = countsFromRow(row);
    const local = row.local === 1;
    const estimate = estimateUsage(row.provider, row.model, local, counts);
    addCounts(day, counts);
    day.estimatedCostUsd += estimate.costUsd;
    day.estimatedSavingsUsd += estimate.savingsUsd;
    if (estimate.priced) day.pricedTokens += counts.totalTokens;
    else day.unpricedTokens += counts.totalTokens;

    addCounts(totals, counts);
    totals.estimatedCostUsd += estimate.costUsd;
    totals.estimatedSavingsUsd += estimate.savingsUsd;
    if (estimate.priced) totals.pricedTokens += counts.totalTokens;
    else totals.unpricedTokens += counts.totalTokens;

    const key = modelIdentity(row.provider, row.model);
    const breakdown = modelMap.get(key) ?? {
      provider: row.provider,
      model: row.model,
      label: row.model,
      totalTokens: 0,
      local,
      share: 0,
      estimatedCostUsd: 0,
      estimatedSavingsUsd: 0,
      priced: true,
    };
    breakdown.totalTokens += counts.totalTokens;
    breakdown.estimatedCostUsd += estimate.costUsd;
    breakdown.estimatedSavingsUsd += estimate.savingsUsd;
    breakdown.priced &&= estimate.priced;
    modelMap.set(key, breakdown);
  }

  const populatedDays = [...dayMap.values()];
  totals.activeDays = populatedDays.filter((day) => day.totalTokens > 0).length;
  for (const day of populatedDays) {
    day.activeDays = day.totalTokens > 0 ? 1 : 0;
  }
  const breakdown = [...modelMap.values()]
    .map((item) => ({
      ...item,
      share: totals.totalTokens > 0 ? item.totalTokens / totals.totalTokens : 0,
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens || a.model.localeCompare(b.model));
  const peakDay = populatedDays.reduce<UsageDay | null>(
    (peak, day) => day.totalTokens > (peak?.totalTokens ?? 0) ? day : peak,
    null,
  );
  const { currentStreak, longestStreak } = streaks(populatedDays, endDate);

  return {
    rangeDays,
    startDate,
    endDate,
    pricingAsOf: USAGE_PRICING_AS_OF,
    localBenchmark: LOCAL_BENCHMARK_LABEL,
    totals,
    days: populatedDays,
    providers: providerOptions,
    models: modelOptions,
    breakdown,
    currentStreak,
    longestStreak,
    peakDay,
  };
}

export function emptyUsageSnapshot(
  query: UsageAnalyticsQuery,
  nowMs = Date.now(),
): UsageAnalyticsSnapshot {
  return buildUsageSnapshot([], query, nowMs);
}

function optionsByProvider(rows: UsageAggregateRow[]): UsageProviderOption[] {
  const providers = new Map<string, UsageProviderOption>();
  for (const row of rows) {
    const value = providers.get(row.provider) ?? {
      id: row.provider,
      label: providerLabel(row.provider),
      totalTokens: 0,
      local: row.local === 1,
    };
    value.totalTokens += rowTotal(row);
    value.local ||= row.local === 1;
    providers.set(row.provider, value);
  }
  return [...providers.values()].sort(
    (a, b) => b.totalTokens - a.totalTokens || a.label.localeCompare(b.label),
  );
}

function optionsByModel(rows: UsageAggregateRow[]): UsageModelOption[] {
  const models = new Map<string, UsageModelOption>();
  for (const row of rows) {
    const key = modelIdentity(row.provider, row.model);
    const value = models.get(key) ?? {
      provider: row.provider,
      model: row.model,
      label: row.model,
      totalTokens: 0,
      local: row.local === 1,
    };
    value.totalTokens += rowTotal(row);
    value.local ||= row.local === 1;
    models.set(key, value);
  }
  return [...models.values()].sort(
    (a, b) => b.totalTokens - a.totalTokens || a.model.localeCompare(b.model),
  );
}

function countsFromRow(row: UsageAggregateRow): UsageTokenCounts {
  return {
    inputTokens: safeCount(row.input_tokens),
    cachedInputTokens: safeCount(row.cached_input_tokens),
    cacheWriteInputTokens: safeCount(row.cache_write_input_tokens),
    outputTokens: safeCount(row.output_tokens),
    reasoningOutputTokens: safeCount(row.reasoning_output_tokens),
    totalTokens: rowTotal(row),
    requests: safeCount(row.requests),
  };
}

function rowTotal(row: UsageAggregateRow): number {
  return safeCount(row.input_tokens) +
    safeCount(row.cached_input_tokens) +
    safeCount(row.cache_write_input_tokens) +
    safeCount(row.output_tokens);
}

function emptyCounts(): UsageTokenCounts {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    requests: 0,
  };
}

function emptyTotals(): UsageTotals {
  return {
    ...emptyCounts(),
    estimatedCostUsd: 0,
    estimatedSavingsUsd: 0,
    pricedTokens: 0,
    unpricedTokens: 0,
    activeDays: 0,
  };
}

function emptyDay(date: string): UsageDay {
  return { date, ...emptyTotals() };
}

function addCounts(target: UsageTokenCounts, source: UsageTokenCounts): void {
  target.inputTokens += source.inputTokens;
  target.cachedInputTokens += source.cachedInputTokens;
  target.cacheWriteInputTokens += source.cacheWriteInputTokens;
  target.outputTokens += source.outputTokens;
  target.reasoningOutputTokens += source.reasoningOutputTokens;
  target.totalTokens += source.totalTokens;
  target.requests += source.requests;
}

function safeCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function providerLabel(provider: string): string {
  const labels: Record<string, string> = {
    anthropic: 'Anthropic',
    google: 'Google',
    lmstudio: 'LM Studio',
    ollama: 'Ollama',
    openai: 'OpenAI',
  };
  return labels[provider] ?? provider
    .split(/[-_.]/u)
    .filter(Boolean)
    .map((part) => part[0]!.toLocaleUpperCase() + part.slice(1))
    .join(' ');
}

function modelIdentity(provider: string, model: string): string {
  return `${provider}\u0000${model}`;
}

function startOfLocalDay(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function localDay(value: Date): string {
  const year = String(value.getFullYear()).padStart(4, '0');
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function dayRange(start: Date, count: number): string[] {
  const result: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const day = new Date(start);
    day.setDate(day.getDate() + index);
    result.push(localDay(day));
  }
  return result;
}

function streaks(
  days: UsageDay[],
  endDate: string,
): { currentStreak: number; longestStreak: number } {
  let longestStreak = 0;
  let running = 0;
  for (const day of days) {
    if (day.totalTokens > 0) {
      running += 1;
      longestStreak = Math.max(longestStreak, running);
    } else {
      running = 0;
    }
  }

  let index = days.findIndex((day) => day.date === endDate);
  if (index < 0) return { currentStreak: 0, longestStreak };
  if (days[index]?.totalTokens === 0) index -= 1;
  if (index < 0 || days.at(-1)!.date !== endDate) {
    return { currentStreak: 0, longestStreak };
  }
  let currentStreak = 0;
  while (index >= 0 && days[index]!.totalTokens > 0) {
    currentStreak += 1;
    index -= 1;
  }
  return { currentStreak, longestStreak };
}
