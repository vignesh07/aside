// The chat pane must never paint more rows than it was given.
//
// Ink overlaps overflowing text instead of clipping it, so a tall answer will
// bleed through the pane's border and the input below it — which is exactly
// what a multi-paragraph observer answer produces. These pin the clipping.

import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { ChatPane } from '../src/components/chat/ChatPane.js';
import type { ChatTurn } from '../src/types/chat.js';

function turn(id: string, role: ChatTurn['role'], content: string): ChatTurn {
  return { id, role, content, timestamp: new Date(0) };
}

function rowsOf(frame: string | undefined): string[] {
  return (frame ?? '').split('\n');
}

const LONG_ANSWER = Array.from({ length: 40 }, (_, i) => `answer line number ${i}`).join(' ');

describe('ChatPane', () => {
  it('clips a long answer to the rows it was given', () => {
    const { lastFrame } = render(
      <ChatPane
        messages={[turn('1', 'assistant', LONG_ANSWER)]}
        isThinking={false}
        watching={null}
        width={40}
        maxRows={6}
      />,
    );
    expect(rowsOf(lastFrame()).length).toBeLessThanOrEqual(6);
  });

  it('keeps the newest content, not the oldest, when clipping', () => {
    const { lastFrame } = render(
      <ChatPane
        messages={[turn('1', 'user', 'FIRST_MARKER'), turn('2', 'assistant', 'LAST_MARKER')]}
        isThinking={false}
        watching={null}
        width={40}
        maxRows={3}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('LAST_MARKER');
    expect(frame).not.toContain('FIRST_MARKER');
  });

  it('never exceeds the given width', () => {
    const { lastFrame } = render(
      <ChatPane
        messages={[turn('1', 'assistant', LONG_ANSWER)]}
        isThinking={false}
        watching={null}
        width={30}
        maxRows={20}
      />,
    );
    for (const row of rowsOf(lastFrame())) {
      expect(row.length).toBeLessThanOrEqual(30);
    }
  });

  it('shows the thinking indicator, which must survive clipping', () => {
    const { lastFrame } = render(
      <ChatPane
        messages={[turn('1', 'user', LONG_ANSWER)]}
        isThinking={true}
        watching={null}
        width={40}
        maxRows={4}
      />,
    );
    expect(lastFrame()).toContain('thinking');
  });

  it('renders the scope line and the empty hint before any chat', () => {
    const { lastFrame } = render(
      <ChatPane messages={[]} isThinking={false} watching="2 sessions" width={60} maxRows={10} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('watching: 2 sessions');
    expect(frame).toMatch(/what's running/);
  });

  it('labels who said what', () => {
    const { lastFrame } = render(
      <ChatPane
        messages={[turn('1', 'user', 'why?'), turn('2', 'assistant', 'because')]}
        isThinking={false}
        watching={null}
        width={40}
        maxRows={20}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('you');
    expect(frame).toContain('aside');
  });

  it('survives a degenerate one-row budget without throwing', () => {
    const { lastFrame } = render(
      <ChatPane
        messages={[turn('1', 'assistant', LONG_ANSWER)]}
        isThinking={false}
        watching={null}
        width={40}
        maxRows={1}
      />,
    );
    expect(rowsOf(lastFrame()).length).toBeLessThanOrEqual(1);
  });
});
