import { classifyClaudeLine } from './claude-classifier.js';
import { classifyCodexLine } from './codex-classifier.js';
import { classifyPiLine } from './pi-classifier.js';
import type { SessionEvent } from '../types/events.js';
import type { SessionSource } from '../types/session.js';

/**
 * Classify a raw JSONL line based on the session source.
 */
export function classifyLine(raw: string, source: SessionSource): SessionEvent | null {
  if (source === 'claude') {
    return classifyClaudeLine(raw);
  }
  if (source === 'codex') {
    return classifyCodexLine(raw);
  }
  return classifyPiLine(raw);
}

/**
 * Extract a human-readable activity description from an event.
 */
export function activityFromEvent(event: SessionEvent): string {
  switch (event.kind) {
    case 'user_prompt':
      return `Prompt: ${event.summary}`;
    case 'assistant_text':
      return `Responding...`;
    case 'tool_call':
      return `${event.tool}: ${event.target}`;
    case 'tool_result_ok':
      return `${event.tool || 'Tool'} completed`;
    case 'tool_result_error':
      return `${event.tool || 'Tool'} FAILED`;
    case 'tool_rejected':
      return `${event.tool} rejected`;
    case 'bash_running':
      return `Running: ${event.command}`;
    case 'bash_complete':
      return `Bash done (exit ${event.exitCode})`;
    case 'file_written':
      return `Writing ${event.path}`;
    case 'file_edited':
      return `Editing ${event.path}`;
    case 'turn_complete':
      return `Turn complete (${(event.durationMs / 1000).toFixed(1)}s)`;
    case 'context_health':
      return `Context: ${event.usedPercent}% (${event.status})`;
    case 'session_started':
      return `Session started`;
    default:
      return '';
  }
}
