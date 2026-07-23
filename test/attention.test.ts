import { describe, expect, it } from 'vitest';
import { attentionAfterEvent } from '../src/core/side-chat-service.js';
import { classifyClaudeLine } from '../src/core/claude-classifier.js';
import { classifyCodexLine } from '../src/core/codex-classifier.js';
import { classifyPiLine } from '../src/core/pi-classifier.js';

const clear = { needsUser: false, reason: '' };

describe('needs-user signals', () => {
  it('recognizes explicit input-request tools across Claude, Codex, and Pi', () => {
    const question = 'Which deployment should I use?';
    const claude = classifyClaudeLine(JSON.stringify({
      type: 'assistant',
      timestamp: '2026-07-23T12:00:00.000Z',
      message: {
        content: [{
          type: 'tool_use',
          name: 'AskUserQuestion',
          input: { questions: [{ question }] },
        }],
      },
    }));
    const codex = classifyCodexLine(JSON.stringify({
      type: 'response_item',
      timestamp: '2026-07-23T12:00:00.000Z',
      payload: {
        type: 'function_call',
        name: 'request_user_input',
        arguments: JSON.stringify({ questions: [{ question }] }),
        call_id: 'call-1',
      },
    }));
    const pi = classifyPiLine(JSON.stringify({
      type: 'message',
      timestamp: '2026-07-23T12:00:00.000Z',
      message: {
        role: 'assistant',
        content: [{
          type: 'toolCall',
          name: 'ask_user_question',
          arguments: { questions: [{ question }] },
        }],
      },
    }));

    for (const event of [claude, codex, pi]) {
      expect(event).toMatchObject({ kind: 'needs_input', reason: question });
    }
  });

  it('marks direct assistant questions and clears after user activity', () => {
    const waiting = attentionAfterEvent(clear, {
      kind: 'assistant_text',
      preview: 'Should I ship this now?',
      ts: '',
    });
    expect(waiting).toEqual({ needsUser: true, reason: 'Should I ship this now?' });
    expect(
      attentionAfterEvent(waiting, { kind: 'user_prompt', summary: 'yes', ts: '' }),
    ).toEqual(clear);
  });

  it('does not clear an explicit wait just because a turn completed', () => {
    const waiting = { needsUser: true, reason: 'Approve production deploy?' };
    expect(
      attentionAfterEvent(waiting, { kind: 'turn_complete', durationMs: 100, ts: '' }),
    ).toEqual(waiting);
  });
});
