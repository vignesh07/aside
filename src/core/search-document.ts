import { redactSensitiveText } from './redact-sensitive.js';
import type { SessionSource } from '../types/session.js';

export type SearchDocumentKind = 'user' | 'assistant' | 'tool' | 'error';

export interface SearchDocument {
  kind: SearchDocumentKind;
  body: string;
  timestamp: string;
}

export const MAX_SEARCH_DOCUMENT_CHARS = 16 * 1024;

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;
const ANSI_ESCAPE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const CONTEXT_BLOCK =
  /<(?:environment_context|recommended_plugins|permissions instructions|app-context|apps_instructions|plugins_instructions|skills_instructions|collaboration_mode)\b[^>]*>[\s\S]*?<\/(?:environment_context|recommended_plugins|permissions instructions|app-context|apps_instructions|plugins_instructions|skills_instructions|collaboration_mode)>/gi;

/**
 * Extract the durable, high-signal text worth searching from one vendor JSONL
 * record. Successful tool output is deliberately excluded: source dumps and
 * build logs are enormous and make remembered human/agent language harder to
 * find. Tool targets and failures still remain searchable.
 */
export function extractSearchDocuments(
  raw: string,
  source: SessionSource,
): SearchDocument[] {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return [];
  }

  const timestamp =
    typeof parsed['timestamp'] === 'string' ? parsed['timestamp'] : '';
  const candidates =
    source === 'codex'
      ? extractCodex(parsed)
      : source === 'claude'
        ? extractClaude(parsed)
        : extractPi(parsed);

  return candidates.flatMap(([kind, value]): SearchDocument[] => {
    const body = normalizeSearchText(value);
    return body ? [{ kind, body, timestamp }] : [];
  });
}

export function normalizeSearchText(value: unknown): string {
  if (typeof value !== 'string') return '';
  const normalized = value
    .replace(CONTEXT_BLOCK, ' ')
    .replace(ANSI_ESCAPE, ' ')
    .replace(CONTROL_CHARS, ' ')
    .replace(/\r\n?/g, '\n')
    .trim();
  if (!normalized) return '';
  return redactSensitiveText(normalized).slice(0, MAX_SEARCH_DOCUMENT_CHARS);
}

function extractCodex(
  parsed: Record<string, unknown>,
): Array<[SearchDocumentKind, unknown]> {
  const type = parsed['type'];
  const payload = record(parsed['payload']);
  if (!payload) return [];

  if (
    type === 'event_msg' &&
    payload['type'] === 'user_message' &&
    typeof payload['message'] === 'string'
  ) {
    return [['user', payload['message']]];
  }

  if (type !== 'response_item') return [];
  const itemType = payload['type'];
  const role = payload['role'];

  if (itemType === 'message') {
    const content = arrayOfRecords(payload['content']);
    if (role === 'assistant') {
      return textBlocks(content, new Set(['output_text'])).map((text) => [
        'assistant',
        text,
      ]);
    }
    if (role === 'user') {
      return textBlocks(content, new Set(['input_text']))
        .filter((text) => !text.includes('<environment_context>'))
        .map((text) => ['user', text]);
    }
  }

  if (itemType === 'function_call') {
    return [[
      'tool',
      `${stringValue(payload['name'])} ${stringValue(payload['arguments'])}`,
    ]];
  }

  if (itemType === 'function_call_output') {
    const error = codexErrorOutput(payload['output']);
    return error ? [['error', error]] : [];
  }

  return [];
}

function extractClaude(
  parsed: Record<string, unknown>,
): Array<[SearchDocumentKind, unknown]> {
  const type = parsed['type'];
  const message = record(parsed['message']);
  if (!message) return [];
  const content = message['content'];

  if (type === 'user') {
    if (typeof content === 'string') return [['user', content]];
    const out: Array<[SearchDocumentKind, unknown]> = [];
    for (const block of arrayOfRecords(content)) {
      if (block['type'] === 'text') out.push(['user', block['text']]);
      if (block['type'] === 'tool_result' && block['is_error'] === true) {
        out.push(['error', stringifyContent(block['content'])]);
      }
    }
    return out;
  }

  if (type !== 'assistant') return [];
  const out: Array<[SearchDocumentKind, unknown]> = [];
  for (const block of arrayOfRecords(content)) {
    if (block['type'] === 'text') out.push(['assistant', block['text']]);
    if (block['type'] === 'tool_use') {
      out.push([
        'tool',
        `${stringValue(block['name'])} ${safeJson(block['input'])}`,
      ]);
    }
  }
  return out;
}

function extractPi(
  parsed: Record<string, unknown>,
): Array<[SearchDocumentKind, unknown]> {
  if (parsed['type'] !== 'message') return [];
  const message = record(parsed['message']);
  if (!message) return [];
  const role = message['role'];
  const content = arrayOfRecords(message['content']);

  if (role === 'user') {
    return textBlocks(content, new Set(['text'])).map((text) => ['user', text]);
  }
  if (role === 'assistant') {
    const out: Array<[SearchDocumentKind, unknown]> = [];
    for (const block of content) {
      if (block['type'] === 'text') out.push(['assistant', block['text']]);
      if (block['type'] === 'toolCall') {
        out.push([
          'tool',
          `${stringValue(block['name'])} ${safeJson(block['arguments'])}`,
        ]);
      }
    }
    return out;
  }
  if (role === 'toolResult' && message['isError'] === true) {
    return textBlocks(content, new Set(['text'])).map((text) => ['error', text]);
  }
  return [];
}

function codexErrorOutput(value: unknown): string {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      return /\b(?:error|exception|traceback|failed|permission denied)\b/i.test(
        value,
      )
        ? value
        : '';
    }
  }
  const output = record(parsed);
  if (!output) return '';
  const metadata = record(output['metadata']);
  const rawExit = metadata?.['exit_code'];
  const exitCode =
    typeof rawExit === 'number'
      ? rawExit
      : typeof rawExit === 'string'
        ? Number.parseInt(rawExit, 10)
        : 0;
  const failed =
    output['is_error'] === true ||
    (typeof output['error'] === 'string' && output['error'].trim().length > 0) ||
    (Number.isFinite(exitCode) && exitCode !== 0);
  if (!failed) return '';
  if (typeof output['output'] === 'string') return output['output'];
  if (typeof output['error'] === 'string') return output['error'];
  return safeJson(output);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function arrayOfRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === 'object' && !Array.isArray(item),
      )
    : [];
}

function textBlocks(
  content: Record<string, unknown>[],
  types: Set<string>,
): string[] {
  return content.flatMap((block): string[] =>
    types.has(String(block['type'])) && typeof block['text'] === 'string'
      ? [block['text']]
      : [],
  );
}

function stringifyContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .flatMap((item) => {
        const block = record(item);
        return block && typeof block['text'] === 'string' ? [block['text']] : [];
      })
      .join('\n');
  }
  return safeJson(value);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? '');
  } catch {
    return '';
  }
}
