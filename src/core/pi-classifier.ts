import type { SessionEvent } from '../types/events.js';

/**
 * Classify a raw Pi Coding Agent JSONL line into a domain SessionEvent.
 */
export function classifyPiLine(raw: string): SessionEvent | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const ts = (parsed['timestamp'] as string) || new Date().toISOString();
  const type = parsed['type'] as string;

  if (type === 'session') {
    const project = typeof parsed['cwd'] === 'string' ? parsed['cwd'] : '';
    return { kind: 'session_started', project, branch: 'unknown', model: '', ts };
  }

  if (type !== 'message') {
    return null;
  }

  const message = parsed['message'];
  if (!message || typeof message !== 'object') return null;

  const msg = message as Record<string, unknown>;
  const role = msg['role'] as string;

  if (role === 'user') {
    const text = extractTextBlock(msg['content']);
    if (!text) return null;
    return { kind: 'user_prompt', summary: truncate(text, 100), ts };
  }

  if (role === 'assistant') {
    const content = msg['content'];
    if (!Array.isArray(content)) return null;

    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const item = block as Record<string, unknown>;
      if (item['type'] === 'toolCall') {
        const tool = (item['name'] as string) || 'tool';
        const target = extractToolTarget(item['arguments']);
        return { kind: 'tool_call', tool, target, ts };
      }
    }

    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const item = block as Record<string, unknown>;
      if (item['type'] === 'text' && typeof item['text'] === 'string') {
        return { kind: 'assistant_text', preview: truncate(item['text'], 100), ts };
      }
    }

    return null;
  }

  if (role === 'toolResult') {
    const toolName = (msg['toolName'] as string) || 'tool';
    const text = extractTextBlock(msg['content']) || 'Tool completed';
    const isError = msg['isError'] === true;

    if (isError) {
      return {
        kind: 'tool_result_error',
        tool: toolName,
        error: truncate(text, 100),
        ts,
      };
    }

    return {
      kind: 'tool_result_ok',
      tool: toolName,
      summary: truncate(text, 80),
      ts,
    };
  }

  if (role === 'bashExecution') {
    const command = truncate(String(msg['command'] || ''), 80);
    const rawExitCode = msg['exitCode'];
    const cancelled = msg['cancelled'] === true;
    const exitCode = typeof rawExitCode === 'number' && Number.isFinite(rawExitCode)
      ? rawExitCode
      : (cancelled ? 130 : 0);

    return { kind: 'bash_complete', command, exitCode, ts };
  }

  return null;
}

function extractTextBlock(content: unknown): string {
  if (!Array.isArray(content)) return '';

  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const item = block as Record<string, unknown>;
    if (item['type'] === 'text' && typeof item['text'] === 'string') {
      return sanitizeForTui(item['text']);
    }
  }

  return '';
}

function extractToolTarget(rawArguments: unknown): string {
  if (!rawArguments || typeof rawArguments !== 'object') return '';

  const args = rawArguments as Record<string, unknown>;
  const target =
    args['command'] ??
    args['path'] ??
    args['file_path'] ??
    args['pattern'] ??
    args['query'] ??
    args['url'] ??
    '';

  if (typeof target === 'string') {
    return truncate(target, 60);
  }

  if (Array.isArray(target)) {
    return truncate(target.map((v) => String(v)).join(' '), 60);
  }

  return truncate(String(target), 60);
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
