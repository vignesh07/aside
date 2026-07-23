import type { SessionEvent } from '../types/events.js';

/**
 * Render one normalized event as a transcript line for the observer model.
 *
 * Returns '' for events with nothing to say (e.g. `unknown`); callers filter
 * those out rather than emitting blank lines, which would read as lost activity.
 */
export function formatEvent(event: SessionEvent): string {
  switch (event.kind) {
    case 'session_started':
      return `[session started] project=${event.project} branch=${event.branch} model=${event.model}`;
    case 'user_prompt':
      return `[user] ${event.summary}`;
    case 'assistant_text':
      return `[agent] ${event.preview}`;
    case 'tool_call':
      return `[tool] ${event.tool} → ${event.target}`;
    case 'tool_result_ok':
      return `[tool ok] ${event.tool}: ${event.summary}`;
    case 'tool_result_error':
      return `[tool ERROR] ${event.tool}: ${event.error}`;
    case 'tool_rejected':
      return `[tool rejected by user] ${event.tool}`;
    case 'needs_input':
      return `[NEEDS USER] ${event.reason}`;
    case 'bash_running':
      return `[bash running ${event.elapsedSeconds}s] ${event.command}`;
    case 'bash_complete':
      return `[bash done exit=${event.exitCode}] ${event.command}`;
    case 'file_written':
      return `[wrote file] ${event.path}`;
    case 'file_edited':
      return `[edited file] ${event.path}`;
    case 'turn_complete':
      return `[turn complete in ${(event.durationMs / 1000).toFixed(1)}s]`;
    case 'context_health':
      return `[context ${event.usedPercent}% used (${event.status})]`;
    case 'unknown':
      return '';
    default:
      return '';
  }
}
