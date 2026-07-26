import { classifyClaudeLine } from './claude-classifier.js';
import { classifyCodexLine } from './codex-classifier.js';
import { classifyPiLine } from './pi-classifier.js';
import type { SessionEvent } from '../types/events.js';
import type { SessionSource } from '../types/session.js';
import { TRUNCATE } from '../config/defaults.js';

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
 * A JSONL record can contain both visible content and a lifecycle/approval
 * signal. Keep classifyLine for compatibility, while lifecycle consumers use
 * this lossless-enough multi-event view.
 */
export function classifyEvents(raw: string, source: SessionSource): SessionEvent[] {
  const primary = classifyLine(raw, source);
  const supplemental = supplementalEvents(raw, source);
  const events = primary ? [primary, ...supplemental] : supplemental;
  const seen = new Set<string>();
  return events.filter((event) => {
    const key = JSON.stringify(event);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Extract a one-line, human-readable activity description from an event.
 *
 * Events carry prose at full classification width (see {@link TRUNCATE.prose}),
 * which is far too wide for a session card or roster line — so the result is cut
 * to {@link TRUNCATE.activity} here, at the point of display.
 */
export function activityFromEvent(event: SessionEvent): string {
  return clampActivity(describeEvent(event));
}

function clampActivity(s: string): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= TRUNCATE.activity) return oneLine;
  return oneLine.slice(0, TRUNCATE.activity - 3) + '...';
}

function describeEvent(event: SessionEvent): string {
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
    case 'needs_input':
      return `Needs you: ${event.reason}`;
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
    case 'turn_failed':
      return `Turn failed: ${event.error}`;
    case 'turn_interrupted':
      return `Turn interrupted: ${event.reason}`;
    case 'context_health':
      return `Context: ${event.usedPercent}% (${event.status})`;
    case 'session_started':
      return `Session started`;
    default:
      return '';
  }
}

function supplementalEvents(
  raw: string,
  source: SessionSource,
): SessionEvent[] {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return [];
  }
  const ts = typeof parsed['timestamp'] === 'string'
    ? parsed['timestamp']
    : new Date().toISOString();

  if (source === 'codex') {
    const payload = isRecord(parsed['payload']) ? parsed['payload'] : undefined;
    if (
      parsed['type'] === 'event_msg' &&
      payload?.['type'] === 'turn_aborted'
    ) {
      const reason = typeof payload['reason'] === 'string'
        ? payload['reason']
        : 'Turn was interrupted';
      return [{ kind: 'turn_interrupted', reason, ts }];
    }
    return [];
  }

  if (source === 'claude') {
    if (parsed['type'] === 'assistant' && isRecord(parsed['message'])) {
      const stopReason = parsed['message']['stop_reason'];
      if (stopReason === 'end_turn' || stopReason === 'stop_sequence') {
        return [{ kind: 'turn_complete', durationMs: 0, ts }];
      }
    }
    // Claude system lifecycle records are normalized in classifyClaudeLine so
    // retry semantics have one authoritative implementation.
    return [];
  }

  if (parsed['type'] !== 'message' || !isRecord(parsed['message'])) return [];
  const message = parsed['message'];
  const events: SessionEvent[] = [];
  if (message['role'] === 'assistant') {
    if (message['stopReason'] === 'stop') {
      events.push({ kind: 'turn_complete', durationMs: 0, ts });
    } else if (message['stopReason'] === 'aborted') {
      events.push({
        kind: 'turn_interrupted',
        reason: 'Pi turn was interrupted',
        ts,
      });
    } else if (message['stopReason'] === 'error') {
      events.push({
        kind: 'turn_failed',
        error: errorSummary(message['error']) || 'Pi turn failed',
        ts,
      });
    }
  }
  const approval =
    message['role'] === 'toolResult' &&
    isRecord(message['details']) &&
    isRecord(message['details']['envelope'])
      ? message['details']['envelope']['requiresApproval']
      : undefined;
  if (approval === true || isRecord(approval)) {
    events.push({
      kind: 'needs_input',
      reason:
        isRecord(approval) && typeof approval['prompt'] === 'string'
          ? approval['prompt']
          : 'Approve the pending Pi tool action',
      ts,
    });
  }
  return events;
}

function errorSummary(value: unknown): string {
  if (typeof value === 'string') return clampActivity(value);
  if (!isRecord(value)) return '';
  const candidate = value['message'] ?? value['error'] ?? value['type'];
  return typeof candidate === 'string' ? clampActivity(candidate) : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
