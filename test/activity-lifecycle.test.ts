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
import { SessionTailer, type TailEvent } from '../src/core/session-tailer.js';
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
    expect(ledger.getHighWaterSeq()).toBe(2);
    expect(ledger.getEvent(events[0]!.eventId)).toEqual(events[0]);
    expect(ledger.getEvent('missing')).toBeNull();
    expect(ledger.getCursors()).toMatchObject([
      { threadKey: 'claude:shared-id' },
      { threadKey: 'codex:shared-id' },
    ]);
    ledger.dispose();
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

  it('markViewed clears completed unread attention', () => {
    const { ledger } = newLedger();
    const session = trackedSession('reviewed');
    ledger.syncSessions([session]);
    record(ledger, session, {
      kind: 'turn_complete',
      durationMs: 20,
      ts: new Date(BASE_MS).toISOString(),
    });

    expect(ledger.attentionFor(session).kind).toBe('completed');
    ledger.markViewed(session);
    expect(ledger.attentionFor(session)).toEqual({
      kind: 'none',
      reason: '',
      sinceMs: null,
      unread: false,
      inferred: false,
      observedLive: false,
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
    expect(ledger.attentionFor(session).kind).toBe('none');
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
});
