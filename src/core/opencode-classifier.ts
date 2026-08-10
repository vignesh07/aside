import { TRUNCATE } from '../config/defaults.js';
import type { SessionEvent } from '../types/events.js';

/**
 * Classify one Aside-owned OpenCode cache record.
 *
 * OpenCode's live transcript is stored in SQLite rather than JSONL. The
 * scanner projects only the fields Aside needs into a private, append-friendly
 * cache so the existing tail/search pipeline can remain vendor agnostic. Raw
 * OpenCode database rows are never accepted here.
 */
export function classifyOpenCodeLine(raw: string): SessionEvent | null {
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }

  if (record['schema'] !== 'aside.opencode.v1') return null;
  const ts = validTimestamp(record['timestamp']);

  switch (record['type']) {
    case 'session':
      return {
        kind: 'session_started',
        project: clean(String(record['cwd'] ?? ''), TRUNCATE.prose),
        branch: 'unknown',
        model: modelName(record),
        ts,
      };

    case 'text': {
      const text = clean(String(record['text'] ?? ''), TRUNCATE.prose);
      if (!text) return null;
      if (record['role'] === 'user') {
        return { kind: 'user_prompt', summary: text, ts };
      }
      if (record['role'] === 'assistant') {
        return { kind: 'assistant_text', preview: text, ts };
      }
      return null;
    }

    case 'tool':
      return classifyTool(record, ts);

    case 'turn': {
      const status = record['status'];
      if (status === 'completed') {
        return {
          kind: 'turn_complete',
          durationMs: finiteNumber(record['durationMs']) ?? 0,
          ts,
        };
      }
      if (status === 'interrupted') {
        return {
          kind: 'turn_interrupted',
          reason:
            clean(String(record['error'] ?? ''), TRUNCATE.prose) ||
            'OpenCode turn was interrupted',
          ts,
        };
      }
      if (status === 'failed') {
        return {
          kind: 'turn_failed',
          error:
            clean(String(record['error'] ?? ''), TRUNCATE.prose) ||
            'OpenCode turn failed',
          ts,
        };
      }
      return null;
    }

    default:
      return null;
  }
}

function classifyTool(
  record: Record<string, unknown>,
  ts: string,
): SessionEvent | null {
  const tool = clean(String(record['tool'] ?? 'tool'), TRUNCATE.target) || 'tool';
  const state = record['state'];
  const input = recordValue(record['input']);
  const target = toolTarget(input);

  if (state === 'pending' || state === 'running') {
    if (isInputRequestTool(tool)) {
      return {
        kind: 'needs_input',
        reason:
          inputRequest(input) ||
          'OpenCode is waiting for your response.',
        ts,
      };
    }
    return { kind: 'tool_call', tool, target, ts };
  }

  if (state === 'completed') {
    return {
      kind: 'tool_result_ok',
      tool,
      summary:
        clean(String(record['title'] ?? ''), TRUNCATE.command) ||
        'Tool completed',
      ts,
    };
  }

  if (state === 'error') {
    return {
      kind: 'tool_result_error',
      tool,
      error:
        clean(String(record['error'] ?? ''), TRUNCATE.prose) ||
        'Tool execution failed',
      ts,
    };
  }

  if (state === 'rejected') {
    return { kind: 'tool_rejected', tool, ts };
  }

  return null;
}

function modelName(record: Record<string, unknown>): string {
  const provider = String(record['providerID'] ?? '').trim();
  const model = String(record['modelID'] ?? '').trim();
  if (provider && model) return `${provider}/${model}`;
  return model;
}

function toolTarget(input: Record<string, unknown>): string {
  const candidate =
    input['command'] ??
    input['filePath'] ??
    input['file_path'] ??
    input['path'] ??
    input['pattern'] ??
    input['query'] ??
    input['url'] ??
    input['description'] ??
    '';
  if (Array.isArray(candidate)) {
    return clean(candidate.map(String).join(' '), TRUNCATE.target);
  }
  return clean(String(candidate), TRUNCATE.target);
}

function inputRequest(input: Record<string, unknown>): string {
  const questions = input['questions'];
  if (Array.isArray(questions)) {
    const first = recordValue(questions[0]);
    const question = first['question'] ?? first['prompt'] ?? first['header'];
    if (typeof question === 'string') {
      return clean(question, TRUNCATE.prose);
    }
  }
  const direct = input['question'] ?? input['prompt'];
  return typeof direct === 'string' ? clean(direct, TRUNCATE.prose) : '';
}

function isInputRequestTool(tool: string): boolean {
  return [
    'question',
    'ask_user_question',
    'askuserquestion',
    'request_user_input',
  ].includes(tool.toLocaleLowerCase());
}

function recordValue(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function validTimestamp(value: unknown): string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
    ? value
    : new Date().toISOString();
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function clean(value: string, max: number): string {
  const normalized = value
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, ' ')
    .replace(/[\r\n\t]/g, ' ')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 3))}...`;
}
