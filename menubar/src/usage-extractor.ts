import { createHash } from 'node:crypto';
import type { SessionSource } from '../../dist/types/session.js';
import type { StoredUsageSample } from './usage-types.js';

const MAX_TOKENS_PER_COUNTER = 10_000_000_000;

export interface UsageExtractionResult {
  model: string;
  provider: string;
  sample?: StoredUsageSample;
}

/**
 * Extract billing counters only. Prompt, response, tool, and path content never
 * enters the usage tables.
 */
export function extractUsageFromLine(
  raw: string,
  source: SessionSource,
  currentModel: string,
  currentProvider: string,
  lineEndOffset: number,
  sampleNamespace: string,
): UsageExtractionResult {
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = record(JSON.parse(raw));
  } catch {
    return { model: currentModel, provider: currentProvider };
  }
  if (!parsed) return { model: currentModel, provider: currentProvider };

  if (source === 'codex') {
    return extractCodex(
      parsed,
      currentModel,
      currentProvider,
      lineEndOffset,
      sampleNamespace,
    );
  }
  if (source === 'claude') {
    return extractClaude(parsed, currentModel, currentProvider, lineEndOffset, sampleNamespace);
  }
  return extractPi(parsed, currentModel, currentProvider, lineEndOffset, sampleNamespace);
}

function extractCodex(
  parsed: Record<string, unknown>,
  currentModel: string,
  currentProvider: string,
  lineEndOffset: number,
  sampleNamespace: string,
): UsageExtractionResult {
  const payload = record(parsed['payload']);
  if (parsed['type'] === 'session_meta') {
    const recordedProvider = stringValue(payload?.['model_provider']);
    return {
      model: currentModel,
      provider: recordedProvider
        ? normalizeProvider(recordedProvider)
        : currentProvider,
    };
  }
  if (parsed['type'] === 'turn_context') {
    return {
      model: cleanModel(payload?.['model']) || currentModel,
      provider: currentProvider,
    };
  }
  if (
    parsed['type'] !== 'event_msg' ||
    payload?.['type'] !== 'token_count'
  ) {
    return { model: currentModel, provider: currentProvider };
  }

  const info = record(payload['info']);
  const usage = record(info?.['last_token_usage']);
  const cumulative = record(info?.['total_token_usage']);
  if (!usage || !cumulative) {
    return { model: currentModel, provider: currentProvider };
  }

  const rawInput = tokens(usage['input_tokens']);
  const cached = tokens(usage['cached_input_tokens']);
  const cacheWrite = tokens(usage['cache_write_input_tokens']);
  const output = tokens(usage['output_tokens']);
  const model = cleanModel(currentModel) || 'unknown';
  const provider = currentProvider
    ? normalizeProvider(currentProvider)
    : 'openai';
  const identity = [
    'codex',
    tokens(cumulative['input_tokens']),
    tokens(cumulative['cached_input_tokens']),
    tokens(cumulative['cache_write_input_tokens']),
    tokens(cumulative['output_tokens']),
    tokens(cumulative['reasoning_output_tokens']),
    tokens(cumulative['total_tokens']),
  ];
  const hasCumulativeCounters = identity.slice(1).some((value) => value !== 0);
  const sample = usageSample({
    sampleKey: stableSampleKey(
      hasCumulativeCounters
        ? identity
        : ['codex', sampleNamespace, lineEndOffset],
    ),
    timestamp: parsed['timestamp'],
    provider,
    model,
    local: isLocalProvider(provider),
    // Codex input includes cached input; normalize every source to disjoint
    // counters so displayed totals and pricing never double-count the cache.
    inputTokens: Math.max(0, rawInput - cached - cacheWrite),
    cachedInputTokens: cached,
    cacheWrite5mInputTokens: cacheWrite,
    cacheWrite1hInputTokens: 0,
    outputTokens: output,
    reasoningOutputTokens: tokens(usage['reasoning_output_tokens']),
  });
  return { model, provider, ...(sample ? { sample } : {}) };
}

function extractClaude(
  parsed: Record<string, unknown>,
  currentModel: string,
  currentProvider: string,
  lineEndOffset: number,
  sampleNamespace: string,
): UsageExtractionResult {
  if (parsed['type'] !== 'assistant') {
    return { model: currentModel, provider: currentProvider };
  }
  const message = record(parsed['message']);
  const usage = record(message?.['usage']);
  const model = cleanModel(message?.['model']) || currentModel || 'unknown';
  if (!usage || model === '<synthetic>') {
    return { model, provider: 'anthropic' };
  }

  const id = stringValue(message?.['id']) ||
    stringValue(parsed['requestId']) ||
    stringValue(parsed['uuid']);
  const cacheCreation = record(usage['cache_creation']);
  const totalCacheWrite = tokens(usage['cache_creation_input_tokens']);
  const cacheWrite5m = tokens(cacheCreation?.['ephemeral_5m_input_tokens']);
  const cacheWrite1h = tokens(cacheCreation?.['ephemeral_1h_input_tokens']);
  const unclassifiedCacheWrite = Math.max(
    0,
    totalCacheWrite - cacheWrite5m - cacheWrite1h,
  );
  const sample = usageSample({
    sampleKey: stableSampleKey(
      id
        ? ['claude', id]
        : ['claude', sampleNamespace, lineEndOffset],
    ),
    timestamp: parsed['timestamp'],
    provider: 'anthropic',
    model,
    local: false,
    inputTokens: tokens(usage['input_tokens']),
    cachedInputTokens: tokens(usage['cache_read_input_tokens']),
    cacheWrite5mInputTokens: cacheWrite5m + unclassifiedCacheWrite,
    cacheWrite1hInputTokens: cacheWrite1h,
    outputTokens: tokens(usage['output_tokens']),
    reasoningOutputTokens: 0,
  });
  return { model, provider: 'anthropic', ...(sample ? { sample } : {}) };
}

function extractPi(
  parsed: Record<string, unknown>,
  currentModel: string,
  currentProvider: string,
  lineEndOffset: number,
  sampleNamespace: string,
): UsageExtractionResult {
  if (parsed['type'] === 'model_change') {
    const changedProvider = stringValue(parsed['provider']);
    return {
      model: cleanModel(parsed['modelId']) || currentModel,
      provider: changedProvider ? normalizeProvider(changedProvider) : currentProvider,
    };
  }
  if (parsed['type'] !== 'message') {
    return { model: currentModel, provider: currentProvider };
  }
  const message = record(parsed['message']);
  if (message?.['role'] !== 'assistant') {
    return { model: currentModel, provider: currentProvider };
  }
  const usage = record(message['usage']);
  const model = cleanModel(message['model']) || currentModel || 'unknown';
  if (!usage) return { model, provider: currentProvider };

  const recordedProvider = stringValue(message['provider']);
  const provider = recordedProvider
    ? normalizeProvider(recordedProvider)
    : currentProvider || 'unknown';
  const id = stringValue(parsed['id']) ||
    stringValue(message['id']);
  const sample = usageSample({
    sampleKey: stableSampleKey(
      id ? ['pi', id] : ['pi', sampleNamespace, lineEndOffset],
    ),
    timestamp: parsed['timestamp'] ?? message['timestamp'],
    provider,
    model,
    local: isLocalProvider(provider),
    inputTokens: tokens(usage['input']),
    cachedInputTokens: tokens(usage['cacheRead']),
    cacheWrite5mInputTokens: tokens(usage['cacheWrite']),
    cacheWrite1hInputTokens: 0,
    outputTokens: tokens(usage['output']),
    reasoningOutputTokens: 0,
  });
  return { model, provider, ...(sample ? { sample } : {}) };
}

function usageSample(
  value: Omit<StoredUsageSample, 'timestampMs'> & { timestamp: unknown },
): StoredUsageSample | undefined {
  const timestampMs = timestamp(value.timestamp);
  const total =
    value.inputTokens +
    value.cachedInputTokens +
    value.cacheWrite5mInputTokens +
    value.cacheWrite1hInputTokens +
    value.outputTokens;
  if (timestampMs === null || total <= 0) return undefined;
  const { timestamp: _timestamp, ...sample } = value;
  return { ...sample, timestampMs };
}

function timestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 10_000_000_000 ? Math.round(value) : Math.round(value * 1000);
  }
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function tokens(value: unknown): number {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= MAX_TOKENS_PER_COUNTER
    ? Math.floor(value)
    : 0;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 1_024) : '';
}

function cleanModel(value: unknown): string {
  return stringValue(value).slice(0, 240);
}

export function normalizeProvider(value: string): string {
  const normalized = value
    .trim()
    .slice(0, 80)
    .toLocaleLowerCase()
    .replaceAll('_', '-');
  if (
    normalized === 'openai-codex' ||
    normalized === 'codex' ||
    normalized.startsWith('openai')
  ) {
    return 'openai';
  }
  if (normalized === 'claude' || normalized.startsWith('anthropic')) {
    return 'anthropic';
  }
  if (normalized.startsWith('google') || normalized.startsWith('gemini')) {
    return 'google';
  }
  if (normalized === 'lm-studio') return 'lmstudio';
  return normalized || 'unknown';
}

function stableSampleKey(parts: Array<string | number>): string {
  return createHash('sha256')
    .update(parts.join('\u0000'))
    .digest('hex');
}

export function isLocalProvider(provider: string): boolean {
  return [
    'ollama',
    'lmstudio',
    'llama.cpp',
    'llama-cpp',
    'local',
  ].includes(provider);
}
