import { describe, expect, it } from 'vitest';
import { shouldNotifyForAttention } from '../menubar/src/attention-notification.js';

describe('attention notification policy', () => {
  it('notifies for a newly waiting live session', () => {
    expect(
      shouldNotifyForAttention(
        {
          threadId: 'session:codex:live',
          status: 'active',
          needsUser: true,
        },
        new Set(),
      ),
    ).toBe(true);
  });

  it('keeps reconstructed history in the sidebar without an OS alert', () => {
    expect(
      shouldNotifyForAttention(
        {
          threadId: 'session:codex:old',
          status: 'history',
          needsUser: true,
        },
        new Set(),
      ),
    ).toBe(false);
  });

  it('does not repeat a notification for an already waiting session', () => {
    expect(
      shouldNotifyForAttention(
        {
          threadId: 'session:codex:live',
          status: 'idle',
          needsUser: true,
        },
        new Set(['session:codex:live']),
      ),
    ).toBe(false);
  });

  it('does not notify for an internal worker waiting on its parent', () => {
    expect(
      shouldNotifyForAttention(
        {
          threadId: 'session:codex:worker',
          status: 'active',
          needsUser: true,
          isInternal: true,
        },
        new Set(),
      ),
    ).toBe(false);
  });

  it('does not let one provider suppress a matching id from another provider', () => {
    expect(
      shouldNotifyForAttention(
        {
          threadId: 'session:codex:shared',
          status: 'active',
          needsUser: true,
        },
        new Set(['session:claude:shared']),
      ),
    ).toBe(true);
  });
});
