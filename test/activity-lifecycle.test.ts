import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_MAX_RECORDS,
  ActivityLedger,
  InMemoryActivityLedgerStore,
  STALLED_AFTER_MS,
  threadKey,
  type RecordedAgentEvent,
} from '../src/core/activity-ledger.js';
import { classifyEvents } from '../src/core/event-classifier.js';
import {
  SessionTailer,
  tryReadJsonlTailLines,
  type TailEvent,
  type TailResetEvent,
} from '../src/core/session-tailer.js';
import type { SessionEvent } from '../src/types/events.js';
import type {
  SessionSource,
  TrackedSession,
} from '../src/types/session.js';

const BASE_MS = Date.parse('2026-07-26T12:00:00.000Z');

function trackedSession(
  id: string,
  source: SessionSource = 'claude',
  overrides: Partial<TrackedSession> = {},
): TrackedSession {
  return {
    id,
    source,
    projectName: 'aside',
    projectDir: '/Users/test/aside',
    jsonlPath: `/tmp/${source}-${id}.jsonl`,
    cwd: '/Users/test/aside',
    gitBranch: 'main',
    slug: id.slice(0, 8),
    model: 'test-model',
    version: '1.0',
    usedPercent: 0,
    contextStatus: 'safe',
    status: 'idle',
    lastEventTime: new Date(BASE_MS - 1),
    eventCount: 0,
    currentActivity: '',
    ...overrides,
  };
}

function newLedger(clock: () => Date = () => new Date(BASE_MS)) {
  const store = new InMemoryActivityLedgerStore();
  const ledger = new ActivityLedger(store, clock);
  return { ledger, store };
}

class ThrowOnceReplacementStore extends InMemoryActivityLedgerStore {
  private shouldThrow = true;

  override replaceThreadEvents(
    key: string,
    events: import('../src/types/activity.js').ActivityEventRecord[],
  ): void {
    if (this.shouldThrow) {
      this.shouldThrow = false;
      throw new Error('disk full');
    }
    super.replaceThreadEvents(key, events);
  }
}

function record(
  ledger: ActivityLedger,
  session: Pick<TrackedSession, 'id' | 'source'>,
  event: SessionEvent,
  options: {
    seeded?: boolean;
    rawLine?: string;
    ordinal?: number;
  } = {},
): void {
  const input: RecordedAgentEvent & { source: SessionSource } = {
    sessionId: session.id,
    source: session.source,
    event,
    seeded: options.seeded ?? false,
    rawLine:
      options.rawLine ??
      JSON.stringify({
        id: `${session.source}-${session.id}-${event.kind}-${event.ts}`,
        timestamp: event.ts,
        event,
      }),
    ordinal: options.ordinal ?? 0,
  };
  ledger.recordAgentEvent(input);
}

describe('activity ledger lifecycle and attention', () => {
  it('baselines imported history without flooding completed or forgotten attention', () => {
    const nowMs = BASE_MS + 2 * 24 * 60 * 60_000;
    const { ledger } = newLedger(() => new Date(nowMs));
    const completed = trackedSession('old-completed', 'claude', {
      status: 'history',
      lastEventTime: new Date(BASE_MS),
    });
    const quietWork = trackedSession('old-work', 'codex', {
      status: 'history',
      lastEventTime: new Date(BASE_MS),
    });
    const explicitWait = trackedSession('old-wait', 'pi', {
      status: 'history',
      lastEventTime: new Date(BASE_MS),
    });
    ledger.syncSessions([completed, quietWork, explicitWait]);

    record(
      ledger,
      completed,
      { kind: 'turn_complete', durationMs: 10, ts: new Date(BASE_MS).toISOString() },
      { seeded: true },
    );
    record(
      ledger,
      quietWork,
      {
        kind: 'tool_call',
        tool: 'Bash',
        target: 'npm test',
        ts: new Date(BASE_MS).toISOString(),
      },
      { seeded: true },
    );
    record(
      ledger,
      explicitWait,
      {
        kind: 'needs_input',
        reason: 'Choose a deployment target',
        ts: new Date(BASE_MS).toISOString(),
      },
      { seeded: true },
    );

    expect(ledger.attentionFor(completed).kind).toBe('none');
    expect(ledger.attentionFor(quietWork).kind).toBe('none');
    expect(ledger.attentionFor(explicitWait)).toMatchObject({
      kind: 'waiting',
      reason: 'Choose a deployment target',
      unread: false,
      inferred: false,
    });
    ledger.dispose();
  });

  it('keeps same-id sessions from different sources and evidence IDs distinct', () => {
    const { ledger } = newLedger();
    const claude = trackedSession('shared-id', 'claude');
    const codex = trackedSession('shared-id', 'codex');
    ledger.syncSessions([claude, codex]);
    const ts = new Date(BASE_MS).toISOString();

    record(
      ledger,
      claude,
      { kind: 'user_prompt', summary: 'Claude prompt', ts },
      {
        rawLine: JSON.stringify({
          uuid: 'same-vendor-origin',
          timestamp: ts,
          type: 'user',
        }),
      },
    );
    record(
      ledger,
      codex,
      { kind: 'user_prompt', summary: 'Codex prompt', ts },
      {
        rawLine: JSON.stringify({
          id: 'same-vendor-origin',
          timestamp: ts,
          type: 'event_msg',
        }),
      },
    );

    const events = ledger.getEvents();
    expect(events).toHaveLength(2);
    expect(new Set(events.map((event) => event.threadKey))).toEqual(
      new Set([threadKey('claude', 'shared-id'), threadKey('codex', 'shared-id')]),
    );
    expect(new Set(events.map((event) => event.eventId)).size).toBe(2);
    expect(events.map((event) => event.originKind)).toEqual([
      'user_prompt',
      'user_prompt',
    ]);
    expect(ledger.getHighWaterSeq()).toBe(2);
    expect(ledger.getEvent(events[0]!.eventId)).toEqual(events[0]);
    expect(ledger.getEvent('missing')).toBeNull();
    expect(ledger.getCursors()).toMatchObject([
      { threadKey: 'claude:shared-id' },
      { threadKey: 'codex:shared-id' },
    ]);
    ledger.dispose();
  });

  it('removes stale durable attention before replaying a replacement projection', () => {
    const { ledger, store } = newLedger();
    const openCode = trackedSession('projection-reset', 'opencode');
    ledger.syncSessions([openCode]);
    record(ledger, openCode, {
      kind: 'needs_input',
      reason: 'Approve the password request?',
      ts: new Date(BASE_MS).toISOString(),
    }, { seeded: true, rawLine: '{"id":"deleted-question"}' });
    ledger.flush();
    expect(ledger.attentionFor(openCode).kind).toBe('waiting');
    expect(store.load().events).toHaveLength(1);

    ledger.resetAgentProjection(openCode.id, openCode.source);
    expect(ledger.attentionFor(openCode).kind).toBe('none');
    expect(ledger.getEvents({ threadKey: threadKey('opencode', openCode.id) }))
      .toEqual([]);
    expect(store.load().events).toEqual([]);

    record(ledger, openCode, {
      kind: 'assistant_text',
      preview: 'The replacement is canonical.',
      ts: new Date(BASE_MS).toISOString(),
    }, { seeded: true, rawLine: '{"id":"surviving-text"}' });
    expect(ledger.attentionFor(openCode).kind).toBe('none');
    ledger.dispose();
  });

  it('keeps surviving event sequences and resolved state across an identical rewrite', () => {
    const { ledger, store } = newLedger();
    const openCode = trackedSession('stable-rebase', 'opencode');
    const event = {
      kind: 'turn_complete' as const,
      durationMs: 100,
      ts: new Date(BASE_MS).toISOString(),
    };
    const evidence = {
      seeded: true,
      rawLine: '{"id":"stable-completion","type":"turn"}',
    };
    ledger.syncSessions([openCode]);
    record(ledger, openCode, event, evidence);
    const before = ledger.getEvents({
      threadKey: threadKey('opencode', openCode.id),
    })[0]!;
    ledger.markResolved(openCode);
    ledger.flush();
    expect(ledger.attentionFor(openCode).kind).toBe('none');

    ledger.beginAgentProjectionRebase(openCode.id, openCode.source);
    record(ledger, openCode, event, evidence);
    ledger.finishAgentProjectionRebase(openCode.id, openCode.source);

    const after = ledger.getEvent(before.eventId)!;
    expect(after.seq).toBe(before.seq);
    expect(ledger.attentionFor(openCode).kind).toBe('none');
    expect(store.load().events).toEqual([after]);
    ledger.dispose();
  });

  it('replaces changed event content with a new unread sequence', () => {
    const { ledger, store } = newLedger();
    const openCode = trackedSession('edited-rebase', 'opencode');
    const originalRawLine =
      '{"id":"stable-assistant-part","type":"text","text":"old private summary"}';
    ledger.syncSessions([openCode]);
    record(ledger, openCode, {
      kind: 'turn_failed',
      error: 'old private summary',
      ts: new Date(BASE_MS).toISOString(),
    }, { seeded: true, rawLine: originalRawLine });
    const before = ledger.getEvents({
      threadKey: threadKey('opencode', openCode.id),
    })[0]!;
    ledger.markResolved(openCode);
    ledger.flush();

    ledger.beginAgentProjectionRebase(openCode.id, openCode.source);
    record(ledger, openCode, {
      kind: 'turn_failed',
      error: 'new canonical summary',
      ts: new Date(BASE_MS + 1_000).toISOString(),
    }, {
      seeded: true,
      rawLine:
        '{"id":"stable-assistant-part","type":"text","text":"new canonical summary"}',
    });
    ledger.finishAgentProjectionRebase(openCode.id, openCode.source);

    const after = ledger.getEvent(before.eventId)!;
    expect(after.seq).toBeGreaterThan(before.seq);
    expect(after.summary).toBe('new canonical summary');
    expect(after.evidenceHash).not.toBe(before.evidenceHash);
    expect(after.occurredAtMs).toBe(BASE_MS + 1_000);
    expect(ledger.attentionFor(openCode)).toMatchObject({ unread: true });
    expect(store.load().events).toEqual([after]);
    ledger.dispose();
  });

  it('persists canonical replay order independently from stable cursor sequences', () => {
    const { ledger, store } = newLedger();
    const openCode = trackedSession('reordered-rebase', 'opencode');
    const failed = {
      kind: 'turn_failed' as const,
      error: 'Canonical failure',
      ts: new Date(BASE_MS).toISOString(),
    };
    const completed = {
      kind: 'turn_complete' as const,
      durationMs: 5,
      ts: new Date(BASE_MS + 1).toISOString(),
    };
    const failedEvidence = { seeded: false, rawLine: '{"id":"failed"}' };
    const completedEvidence = { seeded: false, rawLine: '{"id":"completed"}' };
    ledger.syncSessions([openCode]);
    record(ledger, openCode, failed, failedEvidence);
    record(ledger, openCode, completed, completedEvidence);
    ledger.flush();
    expect(ledger.attentionFor(openCode).kind).toBe('completed');

    ledger.beginAgentProjectionRebase(openCode.id, openCode.source);
    record(ledger, openCode, completed, completedEvidence);
    record(ledger, openCode, failed, failedEvidence);
    ledger.finishAgentProjectionRebase(openCode.id, openCode.source);
    expect(ledger.attentionFor(openCode).kind).toBe('failed');

    const restored = new ActivityLedger(store, () => new Date(BASE_MS + 10));
    restored.syncSessions([openCode]);
    expect(restored.attentionFor(openCode).kind).toBe('failed');
    restored.dispose();
    ledger.dispose();
  });

  it('bridges stable identity across an incomplete header and final projection', () => {
    const { ledger } = newLedger();
    const openCode = trackedSession('deferred-rebase', 'opencode');
    const completion = {
      kind: 'turn_complete' as const,
      durationMs: 5,
      ts: new Date(BASE_MS).toISOString(),
    };
    const evidence = { seeded: true, rawLine: '{"id":"stable-completion"}' };
    ledger.syncSessions([openCode]);
    record(ledger, openCode, completion, evidence);
    const original = ledger.getEvents()[0]!;
    ledger.markResolved(openCode);

    ledger.beginAgentProjectionRebase(openCode.id, openCode.source);
    record(ledger, openCode, {
      kind: 'session_started',
      ts: new Date(BASE_MS - 1).toISOString(),
    }, { seeded: true, rawLine: '{"id":"building-header"}' });
    ledger.finishAgentProjectionRebase(openCode.id, openCode.source, false);
    expect(ledger.getEvent(original.eventId)).toBeNull();

    ledger.beginAgentProjectionRebase(openCode.id, openCode.source);
    record(ledger, openCode, completion, evidence);
    ledger.finishAgentProjectionRebase(openCode.id, openCode.source, true);

    expect(ledger.getEvent(original.eventId)?.seq).toBe(original.seq);
    expect(ledger.attentionFor(openCode).kind).toBe('none');
    ledger.dispose();
  });

  it('does not prune unseen durable events after a bounded canonical read', () => {
    const { ledger, store } = newLedger();
    const openCode = trackedSession('bounded-rebase', 'opencode');
    ledger.syncSessions([openCode]);
    record(ledger, openCode, {
      kind: 'assistant_text',
      preview: 'older retained evidence',
      ts: new Date(BASE_MS).toISOString(),
    }, { seeded: true, rawLine: '{"id":"older"}' });
    record(ledger, openCode, {
      kind: 'turn_complete',
      durationMs: 1,
      ts: new Date(BASE_MS + 1).toISOString(),
    }, { seeded: true, rawLine: '{"id":"newer"}' });
    ledger.flush();

    ledger.beginAgentProjectionRebase(openCode.id, openCode.source);
    record(ledger, openCode, {
      kind: 'turn_complete',
      durationMs: 1,
      ts: new Date(BASE_MS + 1).toISOString(),
    }, { seeded: true, rawLine: '{"id":"newer"}' });
    ledger.finishAgentProjectionRebase(
      openCode.id,
      openCode.source,
      false,
      false,
    );

    expect(ledger.getEvents().map((event) => event.summary)).toEqual([
      'older retained evidence',
      'Latest turn ended',
    ]);
    expect(store.load().events.map((event) => event.summary)).toEqual([
      'older retained evidence',
      'Latest turn ended',
    ]);
    ledger.dispose();
  });

  it('removes one deleted event from a complete rewrite of more than 100 records', () => {
    const { ledger, store } = newLedger();
    const openCode = trackedSession('large-complete-rebase', 'opencode');
    const total = 151;
    const removedIndex = 75;
    const eventFor = (index: number) => ({
      kind: 'assistant_text' as const,
      preview: `canonical event ${index}`,
      ts: new Date(BASE_MS + index).toISOString(),
    });
    const evidenceFor = (index: number) => ({
      seeded: true,
      rawLine: JSON.stringify({ id: `canonical-${index}`, type: 'text' }),
    });

    ledger.syncSessions([openCode]);
    for (let index = 0; index < total; index += 1) {
      record(ledger, openCode, eventFor(index), evidenceFor(index));
    }
    ledger.flush();
    const originalSeqs = new Map(
      ledger.getEvents().map((event) => [event.summary, event.seq]),
    );

    ledger.beginAgentProjectionRebase(openCode.id, openCode.source);
    for (let index = 0; index < total; index += 1) {
      if (index === removedIndex) continue;
      record(ledger, openCode, eventFor(index), evidenceFor(index));
    }
    ledger.finishAgentProjectionRebase(
      openCode.id,
      openCode.source,
      true,
      true,
    );

    const replacement = ledger.getEvents();
    expect(replacement).toHaveLength(total - 1);
    expect(replacement.some(
      (event) => event.summary === `canonical event ${removedIndex}`,
    )).toBe(false);
    expect(replacement.every(
      (event) => originalSeqs.get(event.summary) === event.seq,
    )).toBe(true);
    expect(replacement.map((event) => event.canonicalOrder)).toEqual(
      Array.from({ length: total - 1 }, (_, index) => index + 1),
    );
    expect(store.load().events).toEqual(replacement);
    ledger.dispose();
  });

  it('restores memory after a durable replacement failure and retries cleanly', () => {
    const store = new ThrowOnceReplacementStore();
    const ledger = new ActivityLedger(store, () => new Date(BASE_MS));
    const openCode = trackedSession('failed-replace', 'opencode');
    ledger.syncSessions([openCode]);
    record(ledger, openCode, {
      kind: 'assistant_text',
      preview: 'old private summary',
      ts: new Date(BASE_MS).toISOString(),
    }, { seeded: true, rawLine: '{"id":"old"}' });
    ledger.flush();

    ledger.beginAgentProjectionRebase(openCode.id, openCode.source);
    record(ledger, openCode, {
      kind: 'assistant_text',
      preview: 'new canonical summary',
      ts: new Date(BASE_MS + 1).toISOString(),
    }, { seeded: true, rawLine: '{"id":"new"}' });
    expect(() =>
      ledger.finishAgentProjectionRebase(openCode.id, openCode.source),
    ).toThrow('disk full');
    expect(ledger.getEvents().map((event) => event.summary)).toEqual([
      'old private summary',
    ]);
    expect(store.load().events.map((event) => event.summary)).toEqual([
      'old private summary',
    ]);

    ledger.beginAgentProjectionRebase(openCode.id, openCode.source);
    record(ledger, openCode, {
      kind: 'assistant_text',
      preview: 'new canonical summary',
      ts: new Date(BASE_MS + 1).toISOString(),
    }, { seeded: true, rawLine: '{"id":"new"}' });
    ledger.finishAgentProjectionRebase(openCode.id, openCode.source);
    expect(ledger.getEvents().map((event) => event.summary)).toEqual([
      'new canonical summary',
    ]);
    expect(store.load().events.map((event) => event.summary)).toEqual([
      'new canonical summary',
    ]);
    ledger.dispose();
  });

  it('prunes deleted OpenCode activity only after an authoritative scan', () => {
    const store = new InMemoryActivityLedgerStore();
    const openCode = trackedSession('deleted-cold-start', 'opencode');
    const first = new ActivityLedger(store, () => new Date(BASE_MS));
    first.syncSessions([openCode]);
    record(first, openCode, {
      kind: 'assistant_text',
      preview: 'private summary',
      ts: new Date(BASE_MS).toISOString(),
    }, { seeded: true, rawLine: '{"id":"private"}' });
    first.flush();
    first.dispose();

    const failedScan = new ActivityLedger(store, () => new Date(BASE_MS + 1));
    failedScan.syncSessions([], new Set());
    expect(failedScan.getEvents()).toHaveLength(1);
    failedScan.dispose();

    const authoritative = new ActivityLedger(store, () => new Date(BASE_MS + 2));
    authoritative.syncSessions([], new Set(['opencode']));
    expect(authoritative.getEvents()).toEqual([]);
    expect(store.load().events).toEqual([]);
    authoritative.dispose();
  });

  it('treats a recoverable tool error as a warning before successful completion', () => {
    const { ledger } = newLedger();
    const session = trackedSession('recovered');
    ledger.syncSessions([session]);
    const warningAt = new Date(BASE_MS).toISOString();
    const completedAt = new Date(BASE_MS + 1_000).toISOString();

    record(ledger, session, {
      kind: 'tool_result_error',
      tool: 'Bash',
      error: 'First attempt failed',
      ts: warningAt,
    });
    record(ledger, session, {
      kind: 'turn_complete',
      durationMs: 1_000,
      ts: completedAt,
    });

    expect(
      ledger.getEvents({ threadKey: threadKey('claude', session.id) }).map(
        ({ kind, severity }) => [kind, severity],
      ),
    ).toEqual([
      ['tool_warning', 'warning'],
      ['turn_completed', 'info'],
    ]);
    expect(ledger.attentionFor(session)).toMatchObject({
      kind: 'completed',
      unread: true,
      inferred: false,
    });
    ledger.dispose();
  });

  it('keeps explicit waiting actionable even after it has been viewed', () => {
    const { ledger } = newLedger();
    const session = trackedSession('waiting');
    ledger.syncSessions([session]);
    record(ledger, session, {
      kind: 'needs_input',
      reason: 'Approve production deployment?',
      ts: new Date(BASE_MS).toISOString(),
    });

    expect(ledger.attentionFor(session)).toMatchObject({
      kind: 'waiting',
      headline: 'Waiting for you',
      context: 'Approve production deployment?',
      sinceMs: BASE_MS,
      unread: true,
      inferred: false,
    });
    ledger.markViewed(session);
    expect(ledger.attentionFor(session)).toMatchObject({
      kind: 'waiting',
      unread: false,
      inferred: false,
    });
    ledger.dispose();
  });

  it('keeps an input request anchored to its log timestamp after turn completion', () => {
    const { ledger } = newLedger();
    const session = trackedSession('waiting-after-turn');
    ledger.syncSessions([session]);
    record(ledger, session, {
      kind: 'needs_input',
      reason: 'Approve access to the signing key?',
      ts: new Date(BASE_MS).toISOString(),
    });
    record(ledger, session, {
      kind: 'turn_complete',
      durationMs: 200,
      ts: new Date(BASE_MS + 200).toISOString(),
    });

    expect(
      ledger.attentionFor(session, {
        needsUser: true,
        reason: 'Approve access to the signing key?',
      }),
    ).toMatchObject({
      kind: 'waiting',
      headline: 'Waiting for you',
      context: 'Approve access to the signing key?',
      sinceMs: BASE_MS,
    });
    ledger.dispose();
  });

  it('does not anchor a long current request to an older turn', () => {
    const { ledger } = newLedger();
    const session = trackedSession('long-current-wait');
    ledger.syncSessions([session]);
    record(ledger, session, {
      kind: 'needs_input',
      reason: 'Old approval request',
      ts: new Date(BASE_MS).toISOString(),
    });
    record(ledger, session, {
      kind: 'turn_complete',
      durationMs: 10,
      ts: new Date(BASE_MS + 10).toISOString(),
    });
    record(ledger, session, {
      kind: 'user_prompt',
      summary: 'Start another task',
      ts: new Date(BASE_MS + 20).toISOString(),
    });
    const longReason = `${'Review this deployment detail carefully. '.repeat(9)}Proceed?`;
    record(ledger, session, {
      kind: 'assistant_text',
      preview: longReason,
      ts: new Date(BASE_MS + 30).toISOString(),
    });
    record(ledger, session, {
      kind: 'turn_complete',
      durationMs: 10,
      ts: new Date(BASE_MS + 40).toISOString(),
    });

    const attention = ledger.attentionFor(session, {
      needsUser: true,
      reason: longReason,
    });
    expect(attention).toMatchObject({
      kind: 'waiting',
      sinceMs: BASE_MS + 30,
    });
    expect(attention.context).toMatch(/^Review this deployment detail/);
    expect(attention.context.length).toBeLessThanOrEqual(240);
    ledger.dispose();
  });

  it('infers a stall only for live work at the exact twenty-minute boundary', () => {
    let nowMs = BASE_MS;
    const { ledger } = newLedger(() => new Date(nowMs));
    const live = trackedSession('live-work');
    const seeded = trackedSession('seeded-work', 'codex');
    ledger.syncSessions([live, seeded]);
    const ts = new Date(BASE_MS).toISOString();

    record(ledger, live, {
      kind: 'tool_call',
      tool: 'Bash',
      target: 'long-running-check',
      ts,
    });
    record(
      ledger,
      seeded,
      {
        kind: 'tool_call',
        tool: 'exec_command',
        target: 'historical-check',
        ts,
      },
      { seeded: true },
    );

    nowMs = BASE_MS + STALLED_AFTER_MS - 1;
    expect(ledger.attentionFor(live).kind).toBe('none');
    nowMs = BASE_MS + STALLED_AFTER_MS;
    expect(ledger.attentionFor(live)).toMatchObject({
      kind: 'stalled',
      unread: true,
      inferred: true,
    });
    expect(ledger.attentionFor(seeded).kind).toBe('none');
    ledger.dispose();
  });

  it('marks completed attention read without resolving it', () => {
    const { ledger } = newLedger();
    const session = trackedSession('reviewed');
    ledger.syncSessions([session]);
    record(ledger, session, {
      kind: 'assistant_text',
      preview: 'Implemented the requested window resizing and verified it.',
      ts: new Date(BASE_MS).toISOString(),
    });
    record(ledger, session, {
      kind: 'turn_complete',
      durationMs: 20,
      ts: new Date(BASE_MS + 20).toISOString(),
    });

    expect(ledger.attentionFor(session)).toMatchObject({
      kind: 'completed',
      headline: 'Last turn ended',
      context: 'Implemented the requested window resizing and verified it.',
      sinceMs: BASE_MS + 20,
      unread: true,
    });
    ledger.markViewed(session);
    expect(ledger.attentionFor(session)).toMatchObject({
      kind: 'completed',
      headline: 'Last turn ended',
      context: 'Implemented the requested window resizing and verified it.',
      unread: false,
    });
    ledger.markResolved(session);
    expect(ledger.attentionFor(session).kind).toBe('none');
    ledger.dispose();
  });

  it('never borrows completion context from an older turn', () => {
    const { ledger } = newLedger();
    const session = trackedSession('bounded-context');
    ledger.syncSessions([session]);
    record(ledger, session, {
      kind: 'assistant_text',
      preview: 'Old turn summary that must not leak forward.',
      ts: new Date(BASE_MS).toISOString(),
    });
    record(ledger, session, {
      kind: 'turn_complete',
      durationMs: 20,
      ts: new Date(BASE_MS + 20).toISOString(),
    });
    record(ledger, session, {
      kind: 'user_prompt',
      summary: 'Check the new release candidate',
      ts: new Date(BASE_MS + 30).toISOString(),
    });
    record(ledger, session, {
      kind: 'turn_complete',
      durationMs: 20,
      ts: new Date(BASE_MS + 50).toISOString(),
    });

    expect(ledger.attentionFor(session)).toMatchObject({
      kind: 'completed',
      context: 'Check the new release candidate',
    });
    ledger.dispose();
  });

  it('does not treat an unread event restored from a prior run as live now', () => {
    const store = new InMemoryActivityLedgerStore();
    const first = new ActivityLedger(store, () => new Date(BASE_MS));
    const session = trackedSession('restored');
    first.syncSessions([session]);
    record(first, session, {
      kind: 'turn_complete',
      durationMs: 20,
      ts: new Date(BASE_MS).toISOString(),
    });
    first.flush();

    const restored = new ActivityLedger(
      store,
      () => new Date(BASE_MS + 1_000),
    );
    restored.syncSessions([session]);
    expect(restored.attentionFor(session)).toMatchObject({
      kind: 'completed',
      unread: true,
      observedLive: false,
    });
    restored.dispose();
    first.dispose();
  });

  it('restores viewed attention as read but unresolved', () => {
    const store = new InMemoryActivityLedgerStore();
    const first = new ActivityLedger(store, () => new Date(BASE_MS));
    const session = trackedSession('viewed-restored');
    first.syncSessions([session]);
    record(first, session, {
      kind: 'assistant_text',
      preview: 'The release candidate is ready for review.',
      ts: new Date(BASE_MS).toISOString(),
    });
    record(first, session, {
      kind: 'turn_complete',
      durationMs: 20,
      ts: new Date(BASE_MS + 20).toISOString(),
    });
    first.markViewed(session);
    first.flush();

    const restored = new ActivityLedger(
      store,
      () => new Date(BASE_MS + 1_000),
    );
    restored.syncSessions([session]);
    expect(restored.attentionFor(session)).toMatchObject({
      kind: 'completed',
      context: 'The release candidate is ready for review.',
      unread: false,
      observedLive: false,
    });
    restored.dispose();
    first.dispose();
  });

  it('advances sequence numbers beyond durable cursors after event pruning', () => {
    const store = new InMemoryActivityLedgerStore({
      events: [],
      cursors: [{
        threadKey: 'claude:pruned',
        baselineAtMs: 0,
        viewedThroughSeq: 40,
        resolvedThroughSeq: 40,
      }],
    });
    const ledger = new ActivityLedger(store, () => new Date(BASE_MS));
    const session = trackedSession('pruned');
    ledger.syncSessions([session]);
    record(ledger, session, {
      kind: 'turn_complete',
      durationMs: 20,
      ts: new Date(BASE_MS).toISOString(),
    });

    expect(ledger.getEvents()).toMatchObject([{ seq: 41 }]);
    expect(ledger.attentionFor(session)).toMatchObject({
      kind: 'completed',
      unread: true,
    });
    ledger.dispose();
  });

  it('restores lifecycle order by sequence even when a store returns newest first', () => {
    const { ledger: source } = newLedger();
    const session = trackedSession('descending-restore');
    source.syncSessions([session]);
    record(source, session, {
      kind: 'tool_call',
      tool: 'Bash',
      target: 'npm test',
      ts: new Date(BASE_MS).toISOString(),
    });
    record(source, session, {
      kind: 'turn_complete',
      durationMs: 20,
      ts: new Date(BASE_MS + 1).toISOString(),
    });
    const restored = new ActivityLedger(
      new InMemoryActivityLedgerStore({
        events: source.getEvents().reverse(),
        cursors: [{
          threadKey: 'claude:descending-restore',
          baselineAtMs: 0,
          viewedThroughSeq: 0,
          resolvedThroughSeq: 0,
        }],
      }),
      () => new Date(BASE_MS + 1_000),
    );
    restored.syncSessions([session]);

    expect(restored.attentionFor(session)).toMatchObject({
      kind: 'completed',
      unread: true,
    });
    restored.dispose();
    source.dispose();
  });

  it('keeps large transcript seeding bounded without sorting on every event', () => {
    const { ledger } = newLedger();
    const session = trackedSession('large-seed');
    ledger.syncSessions([session]);
    const total = ACTIVITY_MAX_RECORDS + 100;
    const startedAt = performance.now();

    for (let index = 0; index < total; index += 1) {
      record(
        ledger,
        session,
        {
          kind: 'assistant_text',
          preview: `Seed event ${index}`,
          ts: new Date(BASE_MS + index).toISOString(),
        },
        { rawLine: JSON.stringify({ id: `seed-${index}` }) },
      );
    }

    const elapsedMs = performance.now() - startedAt;
    const events = ledger.getEvents();
    expect(events).toHaveLength(ACTIVITY_MAX_RECORDS);
    expect(events[0]?.seq).toBe(101);
    expect(elapsedMs).toBeLessThan(3_000);
    ledger.dispose();
  });
});

describe('vendor lifecycle classification', () => {
  it('keeps retrying Claude API errors as warnings and fails only after exhaustion', () => {
    const ts = new Date(BASE_MS).toISOString();
    expect(
      classifyEvents(
        JSON.stringify({
          type: 'system',
          subtype: 'turn_duration',
          durationMs: 2_500,
          timestamp: ts,
        }),
        'claude',
      ),
    ).toEqual([{ kind: 'turn_complete', durationMs: 2_500, ts }]);
    expect(
      classifyEvents(
        JSON.stringify({
          type: 'system',
          subtype: 'api_error',
          error: { message: 'Rate limited' },
          retryAttempt: 1,
          maxRetries: 3,
          retryInMs: 1_000,
          timestamp: ts,
        }),
        'claude',
      ),
    ).toEqual([{
      kind: 'tool_result_error',
      tool: 'Claude API',
      error: 'Rate limited',
      ts,
    }]);
    expect(
      classifyEvents(
        JSON.stringify({
          type: 'system',
          subtype: 'api_error',
          error: { message: 'Rate limited' },
          retryAttempt: 3,
          maxRetries: 3,
          timestamp: ts,
        }),
        'claude',
      ),
    ).toEqual([{ kind: 'turn_failed', error: 'Rate limited', ts }]);
  });

  it('ends in reviewable completion after a Claude retry succeeds', () => {
    const { ledger } = newLedger();
    const session = trackedSession('claude-retry');
    ledger.syncSessions([session]);
    const retryAt = new Date(BASE_MS).toISOString();
    const doneAt = new Date(BASE_MS + 1_000).toISOString();
    const retry = classifyEvents(
      JSON.stringify({
        type: 'system',
        subtype: 'api_error',
        error: { message: 'Overloaded' },
        retryAttempt: 1,
        maxRetries: 4,
        retryInMs: 500,
        timestamp: retryAt,
      }),
      'claude',
    )[0]!;
    const completed = classifyEvents(
      JSON.stringify({
        type: 'system',
        subtype: 'turn_duration',
        durationMs: 1_000,
        timestamp: doneAt,
      }),
      'claude',
    )[0]!;
    record(ledger, session, retry);
    record(ledger, session, completed);

    expect(ledger.getEvents().map((event) => event.kind)).toEqual([
      'tool_warning',
      'turn_completed',
    ]);
    expect(ledger.attentionFor(session)).toMatchObject({
      kind: 'completed',
      unread: true,
    });
    ledger.dispose();
  });

  it('uses Claude assistant stop reasons and coalesces a later duration record', () => {
    const { ledger } = newLedger();
    const session = trackedSession('claude-stop-reason');
    ledger.syncSessions([session]);
    const ts = new Date(BASE_MS).toISOString();
    const finalEvents = classifyEvents(
      JSON.stringify({
        type: 'assistant',
        timestamp: ts,
        message: {
          role: 'assistant',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'Implemented and verified.' }],
        },
      }),
      'claude',
    );
    expect(finalEvents).toEqual([
      {
        kind: 'assistant_text',
        preview: 'Implemented and verified.',
        ts,
      },
      { kind: 'turn_complete', durationMs: 0, ts },
    ]);
    for (const [ordinal, event] of finalEvents.entries()) {
      record(ledger, session, event, { ordinal });
    }
    expect(ledger.attentionFor(session).kind).toBe('completed');
    ledger.markViewed(session);

    const duration = classifyEvents(
      JSON.stringify({
        type: 'system',
        subtype: 'turn_duration',
        durationMs: 2_000,
        timestamp: new Date(BASE_MS + 1).toISOString(),
      }),
      'claude',
    )[0]!;
    record(ledger, session, duration);

    expect(
      ledger.getEvents().filter((event) => event.kind === 'turn_completed'),
    ).toHaveLength(1);
    expect(ledger.attentionFor(session)).toMatchObject({
      kind: 'completed',
      context: 'Implemented and verified.',
      unread: false,
    });
    ledger.dispose();
  });

  it('classifies Codex turn_aborted as interruption rather than failure', () => {
    const ts = new Date(BASE_MS).toISOString();
    const events = classifyEvents(
      JSON.stringify({
        timestamp: ts,
        type: 'event_msg',
        payload: { type: 'turn_aborted', reason: 'interrupted' },
      }),
      'codex',
    );

    expect(events).toEqual([
      { kind: 'turn_interrupted', reason: 'interrupted', ts },
    ]);
    expect(events.some((event) => event.kind === 'turn_failed')).toBe(false);
  });

  it('classifies Pi stop and nested approval-request envelopes', () => {
    const ts = new Date(BASE_MS).toISOString();
    const stop = classifyEvents(
      JSON.stringify({
        type: 'message',
        timestamp: ts,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Done' }],
          stopReason: 'stop',
        },
      }),
      'pi',
    );
    expect(stop).toEqual([
      { kind: 'assistant_text', preview: 'Done', ts },
      { kind: 'turn_complete', durationMs: 0, ts },
    ]);

    const approval = classifyEvents(
      JSON.stringify({
        type: 'message',
        timestamp: ts,
        message: {
          role: 'toolResult',
          toolName: 'write',
          isError: false,
          content: [{ type: 'text', text: 'Approval required' }],
          details: {
            envelope: {
              requiresApproval: {
                type: 'approval_request',
                prompt: 'Approve writing this file?',
                items: [],
                preview: '',
                resumeToken: 'token',
              },
            },
          },
        },
      }),
      'pi',
    );
    expect(approval).toContainEqual({
      kind: 'needs_input',
      reason: 'Approve writing this file?',
      ts,
    });
  });
});

describe('session tailer record boundaries', () => {
  it('reports whether a bounded tail covers the whole projection', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aside-tail-complete-'));
    const jsonlPath = path.join(root, 'session.jsonl');
    const lines = ['one', 'two', 'three'];
    fs.writeFileSync(jsonlPath, `${lines.join('\n')}\n`);
    try {
      expect(tryReadJsonlTailLines(jsonlPath, 3, 1_024)).toEqual({
        lines,
        success: true,
        complete: true,
      });
      expect(tryReadJsonlTailLines(jsonlPath, 2, 1_024)).toEqual({
        lines: ['two', 'three'],
        success: true,
        complete: false,
      });
      expect(tryReadJsonlTailLines(jsonlPath, 3, 6)).toMatchObject({
        success: true,
        complete: false,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reassembles a record that was already partial when tailing started', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aside-start-partial-'));
    const jsonlPath = path.join(root, 'session.jsonl');
    const complete = JSON.stringify({
      type: 'message',
      timestamp: new Date(BASE_MS).toISOString(),
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    });
    const split = Math.floor(complete.length / 2);
    fs.writeFileSync(jsonlPath, complete.slice(0, split));
    const tailer = new SessionTailer();
    const received: TailEvent[] = [];
    tailer.on('line', (event: TailEvent) => received.push(event));
    const readNewLines = (
      tailer as unknown as {
        readNewLines(sessionId: string, path: string): void;
      }
    ).readNewLines.bind(tailer);

    try {
      tailer.startTailing('startup-partial', jsonlPath);
      expect(received).toEqual([]);
      fs.appendFileSync(jsonlPath, `${complete.slice(split)}\n`);
      readNewLines('startup-partial', jsonlPath);
      expect(received).toEqual([{
        sessionId: 'startup-partial',
        line: complete,
        isSeed: false,
      }]);
    } finally {
      tailer.stopAll();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves a partial JSONL append until its terminating newline arrives', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aside-partial-tail-'));
    const jsonlPath = path.join(root, 'session.jsonl');
    fs.writeFileSync(jsonlPath, '');
    const tailer = new SessionTailer();
    const received: TailEvent[] = [];
    tailer.on('line', (event: TailEvent) => received.push(event));
    const readNewLines = (
      tailer as unknown as {
        readNewLines(sessionId: string, path: string): void;
      }
    ).readNewLines.bind(tailer);

    try {
      tailer.startTailing('partial', jsonlPath);
      const complete = JSON.stringify({
        type: 'message',
        timestamp: new Date(BASE_MS).toISOString(),
        message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      });
      const split = Math.floor(complete.length / 2);
      fs.appendFileSync(jsonlPath, complete.slice(0, split));
      readNewLines('partial', jsonlPath);
      expect(received).toEqual([]);

      fs.appendFileSync(jsonlPath, `${complete.slice(split)}\n`);
      readNewLines('partial', jsonlPath);
      expect(received).toEqual([
        { sessionId: 'partial', line: complete, isSeed: false },
      ]);
    } finally {
      tailer.stopAll();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('resets its offset and watch handle after an atomic file replacement', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aside-replaced-tail-'));
    const jsonlPath = path.join(root, 'session.jsonl');
    const original = JSON.stringify({ id: 'old', type: 'message' });
    const replacement = [
      JSON.stringify({ id: 'new-1', type: 'message' }),
      JSON.stringify({ id: 'new-2', type: 'message', padding: 'longer' }),
    ];
    fs.writeFileSync(jsonlPath, `${original}\n`);
    const tailer = new SessionTailer();
    const received: TailEvent[] = [];
    const resets: TailResetEvent[] = [];
    tailer.on('line', (event: TailEvent) => received.push(event));
    tailer.on('reset', (event: TailResetEvent) => resets.push(event));
    const readNewLines = (
      tailer as unknown as {
        readNewLines(sessionId: string, path: string): void;
      }
    ).readNewLines.bind(tailer);

    try {
      tailer.startTailing('replaced', jsonlPath);
      expect(received).toEqual([]);
      expect(resets).toEqual([{
        sessionId: 'replaced',
        lines: [original],
        complete: true,
      }]);
      resets.length = 0;

      const tempPath = path.join(root, 'replacement.tmp');
      fs.writeFileSync(tempPath, `${replacement.join('\n')}\n`);
      fs.renameSync(tempPath, jsonlPath);
      readNewLines('replaced', jsonlPath);

      expect(received).toEqual([]);
      expect(resets).toEqual([{
        sessionId: 'replaced',
        lines: replacement,
        complete: true,
      }]);

      const appended = JSON.stringify({ id: 'after-reset', type: 'message' });
      fs.appendFileSync(jsonlPath, `${appended}\n`);
      readNewLines('replaced', jsonlPath);
      expect(received).toEqual([{
        sessionId: 'replaced',
        line: appended,
        isSeed: false,
      }]);
    } finally {
      tailer.stopAll();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('retries an unreadable replacement instead of accepting an empty reset', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aside-retry-reset-'));
    const jsonlPath = path.join(root, 'session.jsonl');
    const original = JSON.stringify({ id: 'old', type: 'message' });
    const replacement = JSON.stringify({ id: 'new', type: 'message' });
    fs.writeFileSync(jsonlPath, `${original}\n`);
    const tailer = new SessionTailer();
    const resets: TailResetEvent[] = [];
    tailer.on('reset', (event: TailResetEvent) => resets.push(event));
    const readNewLines = (
      tailer as unknown as {
        readNewLines(sessionId: string, path: string): void;
      }
    ).readNewLines.bind(tailer);

    try {
      tailer.startTailing('retry-reset', jsonlPath);
      resets.length = 0;
      fs.rmSync(jsonlPath);
      fs.mkdirSync(jsonlPath);
      readNewLines('retry-reset', jsonlPath);
      expect(resets).toEqual([]);

      fs.rmdirSync(jsonlPath);
      fs.writeFileSync(jsonlPath, `${replacement}\n`);
      readNewLines('retry-reset', jsonlPath);
      expect(resets).toEqual([{
        sessionId: 'retry-reset',
        lines: [replacement],
        complete: true,
      }]);
    } finally {
      tailer.stopAll();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('emits one reset batch for same-inode truncation and preserves a partial tail', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aside-truncated-tail-'));
    const jsonlPath = path.join(root, 'session.jsonl');
    fs.writeFileSync(jsonlPath, `${JSON.stringify({ id: 'long-original', padding: 'x'.repeat(200) })}\n`);
    const tailer = new SessionTailer();
    const received: TailEvent[] = [];
    const resets: TailResetEvent[] = [];
    tailer.on('line', (event: TailEvent) => received.push(event));
    tailer.on('reset', (event: TailResetEvent) => resets.push(event));
    const readNewLines = (
      tailer as unknown as {
        readNewLines(sessionId: string, path: string): void;
      }
    ).readNewLines.bind(tailer);

    try {
      tailer.startTailing('truncated', jsonlPath);
      resets.length = 0;
      received.length = 0;
      const complete = JSON.stringify({ id: 'replacement', type: 'message' });
      const partial = JSON.stringify({ id: 'partial', type: 'message' });
      const split = Math.floor(partial.length / 2);
      fs.truncateSync(jsonlPath, 0);
      fs.appendFileSync(jsonlPath, `${complete}\n${partial.slice(0, split)}`);
      readNewLines('truncated', jsonlPath);
      expect(resets).toEqual([{
        sessionId: 'truncated',
        lines: [complete],
        complete: false,
      }]);
      expect(received).toEqual([]);

      fs.appendFileSync(jsonlPath, `${partial.slice(split)}\n`);
      readNewLines('truncated', jsonlPath);
      expect(received).toEqual([{
        sessionId: 'truncated',
        line: partial,
        isSeed: false,
      }]);
    } finally {
      tailer.stopAll();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('detects a same-inode same-size overwrite as a canonical reset', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aside-same-size-tail-'));
    const jsonlPath = path.join(root, 'session.jsonl');
    const original = JSON.stringify({ id: 'same', text: 'old-value' });
    const replacement = JSON.stringify({ id: 'same', text: 'new-value' });
    expect(replacement.length).toBe(original.length);
    fs.writeFileSync(jsonlPath, `${original}\n`);
    const tailer = new SessionTailer();
    const resets: TailResetEvent[] = [];
    tailer.on('reset', (event: TailResetEvent) => resets.push(event));
    const readNewLines = (
      tailer as unknown as {
        readNewLines(sessionId: string, path: string): void;
      }
    ).readNewLines.bind(tailer);

    try {
      tailer.startTailing('same-size', jsonlPath);
      resets.length = 0;
      fs.writeFileSync(jsonlPath, `${replacement}\n`);
      readNewLines('same-size', jsonlPath);
      expect(resets).toEqual([{
        sessionId: 'same-size',
        lines: [replacement],
        complete: true,
      }]);
    } finally {
      tailer.stopAll();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('retries a canonical reset when its consumer fails to commit', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aside-reset-listener-'));
    const jsonlPath = path.join(root, 'session.jsonl');
    const original = JSON.stringify({ id: 'old', type: 'message' });
    const replacement = JSON.stringify({ id: 'new', type: 'message' });
    fs.writeFileSync(jsonlPath, `${original}\n`);
    const tailer = new SessionTailer();
    let armed = false;
    let attempts = 0;
    let accepted: TailResetEvent | null = null;
    tailer.on('reset', (event: TailResetEvent) => {
      if (!armed) return;
      attempts += 1;
      if (attempts === 1) throw new Error('durable replacement failed');
      accepted = event;
    });
    const readNewLines = (
      tailer as unknown as {
        readNewLines(sessionId: string, path: string): void;
      }
    ).readNewLines.bind(tailer);

    try {
      tailer.startTailing('retry-listener', jsonlPath);
      armed = true;
      const tempPath = path.join(root, 'replacement.tmp');
      fs.writeFileSync(tempPath, `${replacement}\n`);
      fs.renameSync(tempPath, jsonlPath);
      readNewLines('retry-listener', jsonlPath);
      expect(attempts).toBe(1);
      expect(accepted).toBeNull();
      readNewLines('retry-listener', jsonlPath);
      expect(attempts).toBe(2);
      expect(accepted).toEqual({
        sessionId: 'retry-listener',
        lines: [replacement],
        complete: true,
      });
    } finally {
      tailer.stopAll();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
