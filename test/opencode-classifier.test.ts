import { describe, expect, it } from 'vitest';
import { classifyOpenCodeLine } from '../src/core/opencode-classifier.js';

const TS = '2026-08-09T20:00:00.000Z';

function line(record: Record<string, unknown>): string {
  return JSON.stringify({
    schema: 'aside.opencode.v1',
    id: 'event-1',
    sourceId: 'source-1',
    timestamp: TS,
    sessionId: 'ses_1',
    ...record,
  });
}

describe('OpenCode normalized transcript classification', () => {
  it('classifies user and assistant text', () => {
    expect(classifyOpenCodeLine(line({
      type: 'text',
      role: 'user',
      text: 'Please inspect the release',
    }))).toEqual({
      kind: 'user_prompt',
      summary: 'Please inspect the release',
      ts: TS,
    });
    expect(classifyOpenCodeLine(line({
      type: 'text',
      role: 'assistant',
      text: 'The signed build is ready.',
    }))).toEqual({
      kind: 'assistant_text',
      preview: 'The signed build is ready.',
      ts: TS,
    });
  });

  it('maps tool lifecycle and question waits without guessing on normal tools', () => {
    expect(classifyOpenCodeLine(line({
      type: 'tool',
      tool: 'bash',
      state: 'running',
      input: { command: 'npm test' },
    }))).toEqual({
      kind: 'tool_call',
      tool: 'bash',
      target: 'npm test',
      ts: TS,
    });
    expect(classifyOpenCodeLine(line({
      type: 'tool',
      tool: 'question',
      state: 'running',
      input: { questions: [{ question: 'Approve the password request?' }] },
    }))).toEqual({
      kind: 'needs_input',
      reason: 'Approve the password request?',
      ts: TS,
    });
    expect(classifyOpenCodeLine(line({
      type: 'tool',
      tool: 'bash',
      state: 'completed',
      title: 'Run tests',
    }))).toEqual({
      kind: 'tool_result_ok',
      tool: 'bash',
      summary: 'Run tests',
      ts: TS,
    });
    expect(classifyOpenCodeLine(line({
      type: 'tool',
      tool: 'bash',
      state: 'error',
      error: 'Command exited 1',
    }))).toEqual({
      kind: 'tool_result_error',
      tool: 'bash',
      error: 'Command exited 1',
      ts: TS,
    });
  });

  it('maps terminal statuses and ignores usage-only records', () => {
    expect(classifyOpenCodeLine(line({
      type: 'turn',
      status: 'completed',
      durationMs: 1200,
    }))).toEqual({ kind: 'turn_complete', durationMs: 1200, ts: TS });
    expect(classifyOpenCodeLine(line({
      type: 'turn',
      status: 'failed',
      error: 'Provider rejected the request',
    }))).toEqual({
      kind: 'turn_failed',
      error: 'Provider rejected the request',
      ts: TS,
    });
    expect(classifyOpenCodeLine(line({
      type: 'turn',
      status: 'interrupted',
      error: 'Stopped by user',
    }))).toEqual({
      kind: 'turn_interrupted',
      reason: 'Stopped by user',
      ts: TS,
    });
    expect(classifyOpenCodeLine(line({
      type: 'usage',
      tokens: { input: 10, output: 5 },
    }))).toBeNull();
  });

  it('rejects malformed and non-Aside records', () => {
    expect(classifyOpenCodeLine('{')).toBeNull();
    expect(classifyOpenCodeLine(JSON.stringify({ type: 'text', text: 'raw DB row' })))
      .toBeNull();
  });
});
