import { describe, it, expect } from 'vitest';
import {
  SYSTEM_PROMPT,
  renderTranscript,
  renderHistory,
  formatEvent,
} from '../src/core/side-chat-engine.js';
import type { SessionEvent } from '../src/types/events.js';
import type { ChatTurn } from '../src/types/chat.js';

describe('SYSTEM_PROMPT', () => {
  it('declares the observer read-only with no tools', () => {
    expect(SYSTEM_PROMPT).toMatch(/READ-ONLY/);
    expect(SYSTEM_PROMPT.toLowerCase()).toMatch(/no tools|cannot edit/);
  });
});

describe('formatEvent', () => {
  const cases: Array<[SessionEvent, RegExp]> = [
    [{ kind: 'user_prompt', summary: 'fix the bug', ts: '' }, /\[user\] fix the bug/],
    [{ kind: 'assistant_text', preview: 'sure', ts: '' }, /\[agent\] sure/],
    [{ kind: 'tool_call', tool: 'Edit', target: 'a.ts', ts: '' }, /\[tool\] Edit → a\.ts/],
    [{ kind: 'tool_result_error', tool: 'Bash', error: 'boom', ts: '' }, /\[tool ERROR\] Bash: boom/],
    [{ kind: 'file_edited', path: 'x.ts', ts: '' }, /\[edited file\] x\.ts/],
    [{ kind: 'bash_complete', command: 'ls', exitCode: 0, ts: '' }, /\[bash done exit=0\] ls/],
  ];
  for (const [event, re] of cases) {
    it(`renders ${event.kind}`, () => {
      expect(formatEvent(event)).toMatch(re);
    });
  }

  it('renders unknown events as empty (so they are filtered out)', () => {
    expect(formatEvent({ kind: 'unknown', raw: '...', ts: '' })).toBe('');
  });
});

describe('renderTranscript', () => {
  it('notes when nothing has been observed yet', () => {
    expect(renderTranscript('proj', [])).toMatch(/No activity has been observed/);
  });

  it('lists events oldest-first under the session name', () => {
    const out = renderTranscript('proj', [
      { kind: 'user_prompt', summary: 'first', ts: '' },
      { kind: 'assistant_text', preview: 'second', ts: '' },
    ]);
    expect(out).toContain('session "proj"');
    expect(out.indexOf('first')).toBeLessThan(out.indexOf('second'));
  });

  it('treats an all-unknown transcript as no observed activity', () => {
    const out = renderTranscript('proj', [{ kind: 'unknown', raw: 'x', ts: '' }]);
    expect(out).toMatch(/No activity has been observed/);
  });

  it('emits no dangling empty lines when some events are unknown', () => {
    const out = renderTranscript('proj', [
      { kind: 'user_prompt', summary: 'hi', ts: '' },
      { kind: 'unknown', raw: 'x', ts: '' },
    ]);
    expect(out.split('\n').filter((l) => l.trim() === '')).toHaveLength(0);
  });
});

describe('renderHistory', () => {
  it('is empty when there is no prior chat', () => {
    expect(renderHistory([])).toBe('');
  });

  it('labels user vs assistant turns', () => {
    const turns: ChatTurn[] = [
      { id: '1', role: 'user', content: 'why?', timestamp: new Date(0) },
      { id: '2', role: 'assistant', content: 'because', timestamp: new Date(0) },
    ];
    const out = renderHistory(turns);
    expect(out).toMatch(/User asked: why\?/);
    expect(out).toMatch(/You answered: because/);
  });
});
