import { describe, expect, it } from 'vitest';
import { shouldNotifyForAttention } from '../menubar/src/attention-notification.js';

describe('attention notification policy', () => {
  it('notifies for a newly waiting live session', () => {
    expect(
      shouldNotifyForAttention(
        { id: 'live', status: 'active', needsUser: true },
        new Set(),
      ),
    ).toBe(true);
  });

  it('keeps reconstructed history in the sidebar without an OS alert', () => {
    expect(
      shouldNotifyForAttention(
        { id: 'old', status: 'history', needsUser: true },
        new Set(),
      ),
    ).toBe(false);
  });

  it('does not repeat a notification for an already waiting session', () => {
    expect(
      shouldNotifyForAttention(
        { id: 'live', status: 'idle', needsUser: true },
        new Set(['live']),
      ),
    ).toBe(false);
  });
});
