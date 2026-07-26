import type { SessionEvent } from '../types/events.js';
import { TRUNCATE } from '../config/defaults.js';

const callIdToTool = new Map<string, string>();
const callIdOrder: string[] = [];
const MAX_CALL_TRACK = 2048;

/**
 * Classify a raw Codex JSONL line into a domain SessionEvent.
 */
export function classifyCodexLine(raw: string): SessionEvent | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const ts = (parsed['timestamp'] as string) || new Date().toISOString();
  const type = parsed['type'] as string;
  const payload = parsed['payload'] as Record<string, unknown> | undefined;

  if (!payload) return null;

  if (type === 'session_meta') {
    const cwd = (payload['cwd'] as string) || '';
    const git = payload['git'] as Record<string, unknown> | undefined;
    const branch = (git?.['branch'] as string) || 'unknown';
    return { kind: 'session_started', project: cwd, branch, model: '', ts };
  }

  if (type === 'event_msg') {
    const eventType = payload['type'] as string;

    if (eventType === 'user_message') {
      const message = (payload['message'] as string) || 'User message';
      return { kind: 'user_prompt', summary: truncate(message, TRUNCATE.prose), ts };
    }

    if (eventType === 'task_started') {
      return { kind: 'user_prompt', summary: 'Task started', ts };
    }

    if (eventType === 'task_complete') {
      // `last_agent_message` is deliberately not re-emitted: the same text already
      // arrives as an `assistant_text` response_item, so surfacing it here would
      // double it in the transcript.
      return { kind: 'turn_complete', durationMs: 0, ts };
    }

    if (eventType === 'turn_aborted') {
      return {
        kind: 'turn_interrupted',
        reason: String(payload['reason'] || 'Turn was interrupted'),
        ts,
      };
    }

    return null;
  }

  if (type === 'response_item') {
    const role = payload['role'] as string;
    const itemType = payload['type'] as string;

    if (role === 'user' && itemType === 'message') {
      const content = payload['content'] as Array<Record<string, unknown>> | undefined;
      if (content) {
        for (const block of content) {
          if (block['type'] === 'input_text') {
            const text = (block['text'] as string) || '';
            // Skip environment context blocks
            if (text.includes('<environment_context>')) return null;
            return { kind: 'user_prompt', summary: truncate(text, TRUNCATE.prose), ts };
          }
        }
      }
      return null;
    }

    // Function calls (tool use)
    if (itemType === 'function_call') {
      const name = (payload['name'] as string) || 'unknown';
      const args = (payload['arguments'] as string) || '';
      const callId = (payload['call_id'] as string) || '';
      let target = '';
      try {
        const parsedArgs = JSON.parse(args) as Record<string, unknown>;
        if (isInputRequestTool(name)) {
          target = extractInputRequest(parsedArgs);
        }
        const command = parsedArgs['command'];
        const filePath = parsedArgs['file_path'];
        const query = parsedArgs['query'];
        const targetValue = Array.isArray(command)
          ? command.join(' ')
          : (command || filePath || query || args);
        if (!target) target = truncate(String(targetValue), TRUNCATE.target);
      } catch {
        target = truncate(args, TRUNCATE.target);
      }
      if (callId) {
        rememberCallTool(callId, name);
      }
      if (isInputRequestTool(name)) {
        return {
          kind: 'needs_input',
          reason: target || 'The agent is waiting for your response.',
          ts,
        };
      }
      return { kind: 'tool_call', tool: name, target, ts };
    }

    if (itemType === 'function_call_output') {
      const callId = (payload['call_id'] as string) || '';
      const toolName = resolveCallTool(callId);
      const parsedOutput = parseFunctionCallOutput(payload['output']);
      if (parsedOutput.isError) {
        return {
          kind: 'tool_result_error',
          tool: toolName,
          error: truncate(parsedOutput.text || 'Tool execution failed', TRUNCATE.prose),
          ts,
        };
      }
      return {
        kind: 'tool_result_ok',
        tool: toolName,
        summary: truncate(parsedOutput.text || 'Tool completed', TRUNCATE.command),
        ts,
      };
    }

    // Assistant text
    if (role === 'assistant' && itemType === 'message') {
      const content = payload['content'] as Array<Record<string, unknown>> | undefined;
      if (content) {
        for (const block of content) {
          if (block['type'] === 'output_text') {
            return { kind: 'assistant_text', preview: truncate((block['text'] as string) || '', TRUNCATE.prose), ts };
          }
        }
      }
      return null;
    }

    return null;
  }

  if (type === 'token_count') {
    // Skip token count events - not interesting for commentary
    return null;
  }

  if (type === 'turn_context') {
    // Skip turn context - not interesting for commentary
    return null;
  }

  return null;
}

function rememberCallTool(callId: string, toolName: string): void {
  if (callIdToTool.has(callId)) {
    callIdToTool.set(callId, toolName);
    return;
  }
  callIdToTool.set(callId, toolName);
  callIdOrder.push(callId);
  if (callIdOrder.length > MAX_CALL_TRACK) {
    const oldest = callIdOrder.shift();
    if (oldest) callIdToTool.delete(oldest);
  }
}

function resolveCallTool(callId: string): string {
  if (!callId) return 'tool';
  const tool = callIdToTool.get(callId) || 'tool';
  callIdToTool.delete(callId);
  return tool;
}

function isInputRequestTool(tool: string): boolean {
  return ['AskUserQuestion', 'ask_user_question', 'request_user_input'].includes(tool);
}

function extractInputRequest(args: Record<string, unknown>): string {
  const questions = args['questions'];
  if (Array.isArray(questions)) {
    const first = questions[0];
    if (first && typeof first === 'object') {
      const item = first as Record<string, unknown>;
      return truncate(String(item['question'] || item['prompt'] || ''), TRUNCATE.prose);
    }
  }
  return truncate(String(args['question'] || args['prompt'] || ''), TRUNCATE.prose);
}

function parseFunctionCallOutput(output: unknown): { text: string; isError: boolean } {
  let parsed: Record<string, unknown> | null = null;
  let text = '';

  if (typeof output === 'string') {
    try {
      const maybe = JSON.parse(output);
      if (maybe && typeof maybe === 'object') {
        parsed = maybe as Record<string, unknown>;
      } else {
        text = output;
      }
    } catch {
      text = output;
    }
  } else if (output && typeof output === 'object') {
    parsed = output as Record<string, unknown>;
  }

  let explicitError: boolean | null = null;
  let exitCode: number | null = null;

  if (parsed) {
    if (typeof parsed['output'] === 'string') {
      text = parsed['output'] as string;
    } else if (typeof parsed['error'] === 'string') {
      text = parsed['error'] as string;
    } else {
      text = JSON.stringify(parsed);
    }

    if (typeof parsed['is_error'] === 'boolean') {
      explicitError = parsed['is_error'] as boolean;
    }
    if (typeof parsed['error'] === 'string' && (parsed['error'] as string).trim().length > 0) {
      explicitError = true;
    }

    const metadata = parsed['metadata'] as Record<string, unknown> | undefined;
    const rawExitCode = metadata?.['exit_code'];
    if (typeof rawExitCode === 'number' && Number.isFinite(rawExitCode)) {
      exitCode = rawExitCode;
    } else if (typeof rawExitCode === 'string') {
      const parsedExitCode = Number.parseInt(rawExitCode, 10);
      if (Number.isFinite(parsedExitCode)) {
        exitCode = parsedExitCode;
      }
    }
  }

  const cleanText = sanitizeForTui(text);
  const looksFatal = /\b(error:|exception|traceback|permission denied|command not found)\b/i.test(cleanText);
  const isError = exitCode !== null ? exitCode !== 0 : (explicitError ?? looksFatal);
  return { text: cleanText, isError };
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
