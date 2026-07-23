import type { SessionEvent } from '../types/events.js';
import { TRUNCATE } from '../config/defaults.js';

/**
 * Classify a raw Claude Code JSONL line into a domain SessionEvent.
 */
export function classifyClaudeLine(raw: string): SessionEvent | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const ts = (parsed['timestamp'] as string) || new Date().toISOString();
  const type = parsed['type'] as string;

  if (type === 'file-history-snapshot') return null;

  if (type === 'user') {
    const message = parsed['message'] as Record<string, unknown> | undefined;
    if (message?.content) {
      const content = message.content;
      let summary: string;
      if (typeof content === 'string') {
        summary = truncate(content, TRUNCATE.prose);
      } else if (Array.isArray(content)) {
        // Tool results from user
        const toolResult = content.find((c: Record<string, unknown>) => c['type'] === 'tool_result');
        if (toolResult) {
          const isError = toolResult['is_error'] === true;
          const toolUseId = toolResult['tool_use_id'] as string || '';
          if (isError) {
            return { kind: 'tool_result_error', tool: toolUseId, error: 'Tool execution failed', ts };
          }
          return { kind: 'tool_result_ok', tool: toolUseId, summary: 'Tool completed', ts };
        }
        const text = content.find((c: Record<string, unknown>) => c['type'] === 'text');
        summary = truncate((text?.['text'] as string) || 'User message', TRUNCATE.prose);
      } else {
        summary = 'User message';
      }
      return { kind: 'user_prompt', summary, ts };
    }
    return null;
  }

  if (type === 'assistant') {
    const message = parsed['message'] as Record<string, unknown> | undefined;
    if (!message?.content) return null;

    const content = message.content as Array<Record<string, unknown>>;
    if (!Array.isArray(content)) {
      return { kind: 'assistant_text', preview: truncate(String(message.content), TRUNCATE.prose), ts };
    }

    // Look for tool_use blocks first (most interesting for commentary)
    for (const block of content) {
      if (block['type'] === 'tool_use') {
        const toolName = (block['name'] as string) || 'unknown';
        const input = block['input'] as Record<string, unknown> | undefined;
        const target = extractToolTarget(toolName, input);
        if (isInputRequestTool(toolName)) {
          return {
            kind: 'needs_input',
            reason: target || 'The agent is waiting for your response.',
            ts,
          };
        }
        return { kind: 'tool_call', tool: toolName, target, ts };
      }
    }

    // Text content
    for (const block of content) {
      if (block['type'] === 'text' && block['text']) {
        return { kind: 'assistant_text', preview: truncate(block['text'] as string, TRUNCATE.prose), ts };
      }
    }

    return null;
  }

  if (type === 'progress') {
    const data = parsed['data'] as Record<string, unknown> | undefined;
    if (!data) return null;

    if (data['type'] === 'bash_progress') {
      const command = (data['command'] as string) || '';
      const elapsed = (data['elapsedTimeSeconds'] as number) || 0;
      return { kind: 'bash_running', command: truncate(command, TRUNCATE.command), elapsedSeconds: elapsed, ts };
    }
    return null;
  }

  if (type === 'system') {
    const subtype = parsed['subtype'] as string;
    if (subtype === 'turn_response') {
      const durationMs = (parsed['durationMs'] as number) || 0;
      return { kind: 'turn_complete', durationMs, ts };
    }
    return null;
  }

  return null;
}

function extractToolTarget(tool: string, input?: Record<string, unknown>): string {
  if (!input) return '';
  switch (tool) {
    case 'Read':
    case 'Write':
      return truncate((input['file_path'] as string) || '', TRUNCATE.target);
    case 'Edit':
      return truncate((input['file_path'] as string) || '', TRUNCATE.target);
    case 'Bash':
      return truncate((input['command'] as string) || '', TRUNCATE.target);
    case 'Glob':
      return truncate((input['pattern'] as string) || '', TRUNCATE.target);
    case 'Grep':
      return truncate((input['pattern'] as string) || '', TRUNCATE.target);
    case 'WebFetch':
      return truncate((input['url'] as string) || '', TRUNCATE.target);
    case 'WebSearch':
      return truncate((input['query'] as string) || '', TRUNCATE.target);
    case 'Task':
      return truncate((input['description'] as string) || '', TRUNCATE.target);
    case 'AskUserQuestion':
    case 'ask_user_question':
    case 'request_user_input': {
      const questions = input['questions'];
      if (Array.isArray(questions)) {
        const first = questions[0] as Record<string, unknown> | undefined;
        return truncate(String(first?.['question'] || first?.['prompt'] || ''), TRUNCATE.prose);
      }
      return truncate(String(input['question'] || input['prompt'] || ''), TRUNCATE.prose);
    }
    default:
      return '';
  }
}

function isInputRequestTool(tool: string): boolean {
  return ['AskUserQuestion', 'ask_user_question', 'request_user_input'].includes(tool);
}

function truncate(s: string, max: number): string {
  const clean = sanitizeForTui(s);
  if (clean.length <= max) return clean;
  return clean.slice(0, max - 3) + '...';
}

function sanitizeForTui(s: string): string {
  return s
    // Strip ANSI escape sequences.
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, ' ')
    // Normalize control chars and unicode to stable ASCII display.
    .replace(/[\r\n\t]/g, ' ')
    .replace(/[^\x20-\x7E]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
