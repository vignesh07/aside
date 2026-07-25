import {
  tryReadJsonlTailLines,
} from '../session-tailer.js';
import {
  extractSearchDocuments,
} from '../search-document.js';
import type { SessionSource } from '../../types/session.js';
import type { HandoffTranscriptEntry } from './types.js';

const DEFAULT_TAIL_LINES = 240;
const DEFAULT_TAIL_BYTES = 512 * 1024;
const DEFAULT_MAX_ENTRIES = 36;
const DEFAULT_MAX_CHARACTERS = 24_000;

export interface HandoffTranscriptOptions {
  tailLines?: number;
  tailBytes?: number;
  maxEntries?: number;
  maxCharacters?: number;
}

function bounded(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(maximum, Math.floor(value!)));
}

/**
 * Project a bounded, provider-neutral excerpt from a vendor transcript.
 *
 * This intentionally reuses Aside's search extraction path, then keeps only
 * human and assistant prose. Tool calls and errors may contain executable
 * prompt-injection text, so they remain searchable in Aside but never enter a
 * handoff projection. Hidden provider records and successful raw tool output
 * are also excluded, environment blocks are stripped, and common credential
 * patterns are redacted. The original JSONL is never changed.
 */
export function readHandoffTranscript(
  source: SessionSource,
  jsonlPath: string,
  options: HandoffTranscriptOptions = {},
): HandoffTranscriptEntry[] {
  const result = tryReadJsonlTailLines(
    jsonlPath,
    bounded(options.tailLines, DEFAULT_TAIL_LINES, 2_000),
    bounded(options.tailBytes, DEFAULT_TAIL_BYTES, 4 * 1024 * 1024),
  );
  if (!result.success) return [];

  const projected: HandoffTranscriptEntry[] = [];
  for (const line of result.lines) {
    for (const document of extractSearchDocuments(line, source)) {
      if (document.kind !== 'user' && document.kind !== 'assistant') continue;
      const entry: HandoffTranscriptEntry = {
        role: document.kind,
        text: document.body,
        ...(document.timestamp ? { timestamp: document.timestamp } : {}),
      };
      const previous = projected.at(-1);
      // Codex can record the same human prompt as both an event and a response
      // item. Keep one copy in the handoff.
      if (
        previous?.role === entry.role &&
        previous.text === entry.text
      ) {
        continue;
      }
      projected.push(entry);
    }
  }

  const maxEntries = bounded(options.maxEntries, DEFAULT_MAX_ENTRIES, 200);
  const maxCharacters = bounded(
    options.maxCharacters,
    DEFAULT_MAX_CHARACTERS,
    128 * 1024,
  );
  const selected: HandoffTranscriptEntry[] = [];
  let spent = 0;
  for (
    let index = projected.length - 1;
    index >= 0 && selected.length < maxEntries;
    index -= 1
  ) {
    const entry = projected[index]!;
    const remaining = maxCharacters - spent;
    if (remaining <= 0) break;
    const text =
      entry.text.length <= remaining
        ? entry.text
        : `${entry.text.slice(0, Math.max(0, remaining - 14))}\n[TRUNCATED]`;
    if (!text.trim()) continue;
    selected.unshift({ ...entry, text });
    spent += text.length;
  }
  return selected;
}
