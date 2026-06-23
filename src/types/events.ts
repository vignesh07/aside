export type SessionEvent =
  | { kind: 'session_started'; project: string; branch: string; model: string; ts: string }
  | { kind: 'user_prompt'; summary: string; ts: string }
  | { kind: 'assistant_text'; preview: string; ts: string }
  | { kind: 'tool_call'; tool: string; target: string; ts: string }
  | { kind: 'tool_result_ok'; tool: string; summary: string; ts: string }
  | { kind: 'tool_result_error'; tool: string; error: string; ts: string }
  | { kind: 'tool_rejected'; tool: string; ts: string }
  | { kind: 'bash_running'; command: string; elapsedSeconds: number; ts: string }
  | { kind: 'bash_complete'; command: string; exitCode: number; ts: string }
  | { kind: 'file_written'; path: string; ts: string }
  | { kind: 'file_edited'; path: string; ts: string }
  | { kind: 'turn_complete'; durationMs: number; ts: string }
  | { kind: 'context_health'; usedPercent: number; status: string; ts: string }
  | { kind: 'unknown'; raw: string; ts: string };
