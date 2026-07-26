import { describe, expect, it } from 'vitest';
import { shouldNotifyForAttention } from '../menubar/src/attention-notification.js';

describe('attention notification policy', () => {
  it('notifies for a newly waiting live session', () => {
    expect(
      shouldNotifyForAttention(
        {
          id: 'live',
          status: 'active',
          needsUser: true,
          attentionObservedLive: true,
        },
        new Set(),
      ),
    ).toBe(true);
  });

  it('keeps reconstructed history in the sidebar without an OS alert', () => {
    expect(
      shouldNotifyForAttention(
        {
          id: 'old',
          status: 'history',
          needsUser: true,
          attentionObservedLive: true,
        },
        new Set(),
      ),
    ).toBe(false);
  });

  it('does not repeat a notification for an already waiting session', () => {
    expect(
      shouldNotifyForAttention(
        {
          id: 'live',
          status: 'idle',
          needsUser: true,
          attentionObservedLive: true,
        },
        new Set(['live:waiting']),
      ),
    ).toBe(false);
  });

  it('notifies for a newly observed live completion or terminal failure', () => {
    expect(
      shouldNotifyForAttention(
        {
          id: 'done',
          status: 'active',
          needsUser: false,
          attentionKind: 'completed',
          attentionUnread: true,
          attentionObservedLive: true,
        },
        new Set(),
      ),
    ).toBe(true);
    expect(
      shouldNotifyForAttention(
        {
          id: 'failed',
          status: 'idle',
          needsUser: false,
          attentionKind: 'failed',
          attentionUnread: true,
          attentionObservedLive: true,
        },
        new Set(),
      ),
    ).toBe(true);
  });

  it('never notifies for inferred stalls or forgotten timers', () => {
    for (const attentionKind of ['stalled', 'forgotten'] as const) {
      expect(
        shouldNotifyForAttention(
          {
            id: attentionKind,
            status: 'active',
            needsUser: false,
            attentionKind,
            attentionUnread: true,
            attentionObservedLive: true,
          },
          new Set(),
        ),
      ).toBe(false);
    }
  });

  it('does not notify for an internal worker waiting on its parent', () => {
    expect(
      shouldNotifyForAttention(
        {
          id: 'worker',
          status: 'active',
          needsUser: true,
          isInternal: true,
          attentionObservedLive: true,
        },
        new Set(),
      ),
    ).toBe(false);
  });

  it('keeps startup replay in the inbox without treating it as a fresh alert', () => {
    expect(
      shouldNotifyForAttention(
        {
          id: 'replayed',
          status: 'active',
          needsUser: true,
          attentionObservedLive: false,
        },
        new Set(),
      ),
    ).toBe(false);
  });
});
