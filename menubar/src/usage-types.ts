export interface UsageAnalyticsQuery {
  rangeDays: 90 | 365;
  providers: string[];
  models: Array<{ provider: string; model: string }>;
}

export interface UsageTokenCounts {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWrite5mInputTokens: number;
  cacheWrite1hInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  requests: number;
}

export interface UsageTotals extends UsageTokenCounts {
  estimatedCostUsd: number;
  estimatedSavingsUsd: number;
  pricedTokens: number;
  unpricedTokens: number;
  activeDays: number;
}

export interface UsageDay extends UsageTotals {
  date: string;
}

export interface UsageProviderOption {
  id: string;
  label: string;
  totalTokens: number;
  local: boolean;
}

export interface UsageModelOption {
  provider: string;
  model: string;
  label: string;
  totalTokens: number;
  local: boolean;
}

export interface UsageModelBreakdown extends UsageModelOption {
  share: number;
  estimatedCostUsd: number;
  estimatedSavingsUsd: number;
  priced: boolean;
}

export interface UsageAnalyticsSnapshot {
  rangeDays: 90 | 365;
  startDate: string;
  endDate: string;
  pricingAsOf: string;
  localBenchmark: string;
  totals: UsageTotals;
  days: UsageDay[];
  providers: UsageProviderOption[];
  models: UsageModelOption[];
  breakdown: UsageModelBreakdown[];
  currentStreak: number;
  longestStreak: number;
  peakDay: UsageDay | null;
}

export interface StoredUsageSample {
  sampleKey: string;
  timestampMs: number;
  provider: string;
  model: string;
  local: boolean;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWrite5mInputTokens: number;
  cacheWrite1hInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}
