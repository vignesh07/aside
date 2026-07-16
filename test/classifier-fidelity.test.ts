// The bird's-eye view is only as good as what survives classification.
//
// These lock in the split that makes "why did the agent pick this path?"
// answerable: prose (where the reasoning lives) is kept wide at classify time,
// and only cut down at the point of display. Data dropped during classification
// is unrecoverable, so the limits matter.

import { describe, it, expect } from 'vitest';
import { classifyLine, activityFromEvent } from '../src/core/event-classifier.js';
import { TRUNCATE } from '../src/config/defaults.js';

const LONG_REASONING =
  'I picked the tmux split approach over an embedded widget because Claude Code owns its ' +
  'terminal render loop and exposes no embeddable interactive widget API, which means any ' +
  'in-TUI chat bar would be fighting the alternate screen buffer forever. A split pane gets ' +
  'the same docked feel without contending for the render loop at all, and it degrades ' +
  'gracefully to iTerm2 when tmux is not present on the machine.';

function claudeAssistantLine(text: string): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: '2026-07-16T12:00:00.000Z',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  });
}

function claudeUserLine(text: string): string {
  return JSON.stringify({
    type: 'user',
    timestamp: '2026-07-16T12:00:00.000Z',
    message: { role: 'user', content: text },
  });
}

describe('prose fidelity through classification', () => {
  it('keeps agent reasoning far past the old 100-char commentary limit', () => {
    const event = classifyLine(claudeAssistantLine(LONG_REASONING), 'claude');
    expect(event?.kind).toBe('assistant_text');
    const preview = (event as { preview: string }).preview;
    // The whole point: the *reason* survives, not just the first clause.
    expect(preview).toContain('owns its terminal render loop');
    expect(preview.length).toBeGreaterThan(100);
  });

  it('keeps user intent, which is what "why" questions hang off', () => {
    const event = classifyLine(claudeUserLine(LONG_REASONING), 'claude');
    expect(event?.kind).toBe('user_prompt');
    expect((event as { summary: string }).summary).toContain('owns its terminal render loop');
  });

  it('still bounds prose so one event cannot dominate the prompt', () => {
    const event = classifyLine(claudeAssistantLine('y'.repeat(5_000)), 'claude');
    expect((event as { preview: string }).preview.length).toBeLessThanOrEqual(TRUNCATE.prose);
  });

  it('keeps tool targets terse — they are identifiers, not arguments', () => {
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-07-16T12:00:00.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/a/'.repeat(200) } }],
      },
    });
    const event = classifyLine(line, 'claude');
    expect(event?.kind).toBe('tool_call');
    expect((event as { target: string }).target.length).toBeLessThanOrEqual(TRUNCATE.target);
  });
});

describe('activityFromEvent', () => {
  it('clamps wide prose down to a one-line label for cards and rosters', () => {
    const event = classifyLine(claudeUserLine(LONG_REASONING), 'claude')!;
    const activity = activityFromEvent(event);
    expect(activity.length).toBeLessThanOrEqual(TRUNCATE.activity);
    expect(activity).toMatch(/^Prompt: /);
  });

  it('never emits a newline, which would break a single-line layout', () => {
    const event = classifyLine(claudeUserLine('first line\nsecond line'), 'claude')!;
    expect(activityFromEvent(event)).not.toMatch(/\n/);
  });

  it('returns empty for events with nothing to say', () => {
    expect(activityFromEvent({ kind: 'unknown', raw: 'x', ts: '' })).toBe('');
  });
});
