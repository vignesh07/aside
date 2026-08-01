import { describe, expect, it } from 'vitest';
import {
  buildTodayDiary,
  localDayRange,
} from '../src/core/today-diary.js';
import type {
  ActivityEventKind,
  ActivityEventRecord,
  ActivityLifecycle,
  ActivitySeverity,
} from '../src/types/activity.js';

const LA = 'America/Los_Angeles';

function event(
  id: string,
  kind: ActivityEventKind,
  occurredAt: string,
  overrides: Partial<ActivityEventRecord> = {},
): ActivityEventRecord {
  const lifecycle = lifecycleFor(kind);
  const severity = severityFor(kind);
  return {
    seq: Number(id.replace(/\D/g, '')) || 1,
    eventId: id,
    threadKey: 'claude:root',
    source: 'claude',
    sessionId: 'root',
    projectName: 'Aside',
    projectPath: '/Users/test/aside',
    title: 'Ship Aside',
    occurredAtMs: Date.parse(occurredAt),
    observedAtMs: Date.parse(occurredAt) + 25,
    kind,
    lifecycle,
    severity,
    summary: summaryFor(kind),
    evidenceHash: `hash-${id}`,
    seeded: false,
    ...overrides,
  };
}

describe('localDayRange', () => {
  it('uses a 23-hour local day across the spring DST transition', () => {
    const range = localDayRange(Date.parse('2026-03-08T19:00:00.000Z'), LA);

    expect(range).toEqual({
      dateKey: '2026-03-08',
      timeZone: LA,
      startMs: Date.parse('2026-03-08T08:00:00.000Z'),
      endMs: Date.parse('2026-03-09T07:00:00.000Z'),
    });
    expect(range.endMs - range.startMs).toBe(23 * 60 * 60_000);
  });

  it('uses a 25-hour local day across the fall DST transition', () => {
    const range = localDayRange(Date.parse('2026-11-01T20:00:00.000Z'), LA);

    expect(range).toEqual({
      dateKey: '2026-11-01',
      timeZone: LA,
      startMs: Date.parse('2026-11-01T07:00:00.000Z'),
      endMs: Date.parse('2026-11-02T08:00:00.000Z'),
    });
    expect(range.endMs - range.startMs).toBe(25 * 60 * 60_000);
  });

  it('rejects invalid clocks and time zones', () => {
    expect(() => localDayRange(Number.NaN, LA)).toThrow(RangeError);
    expect(() => localDayRange(Date.now(), 'Mars/Olympus')).toThrow(
      'Invalid time zone',
    );
  });
});

describe('buildTodayDiary', () => {
  const nowMs = Date.parse('2026-03-08T19:00:00.000Z');

  it('includes [local midnight, next local midnight) exactly', () => {
    const diary = buildTodayDiary(
      [
        event('before', 'prompt', '2026-03-08T07:59:59.999Z'),
        event('start', 'prompt', '2026-03-08T08:00:00.000Z'),
        event('last', 'progress', '2026-03-09T06:59:59.999Z'),
        event('end', 'progress', '2026-03-09T07:00:00.000Z'),
      ],
      { nowMs, timeZone: LA },
    );

    expect(diary.counts.eventCount).toBe(2);
    expect(diary.projects[0]?.threads[0]?.evidence.map(({ eventId }) => eventId))
      .toEqual(['start', 'last']);
  });

  it('groups projects, rolls subagents into roots, and retains every evidence ref', () => {
    const rootKey = 'claude:root';
    const childKey = 'claude:child';
    const records = [
      event('e1', 'prompt', '2026-03-08T09:00:00.000Z'),
      event('e2', 'turn_completed', '2026-03-08T10:00:00.000Z'),
      event('e3', 'work_started', '2026-03-08T11:00:00.000Z', {
        threadKey: childKey,
        sessionId: 'child',
        parentThreadKey: rootKey,
        rootThreadKey: rootKey,
        title: 'Search subagent',
      }),
      event('e4', 'tool_warning', '2026-03-08T12:00:00.000Z', {
        threadKey: childKey,
        sessionId: 'child',
        parentThreadKey: rootKey,
        rootThreadKey: rootKey,
        title: 'Search subagent',
      }),
      event('e5', 'input_requested', '2026-03-08T13:00:00.000Z', {
        threadKey: childKey,
        sessionId: 'child',
        parentThreadKey: rootKey,
        rootThreadKey: rootKey,
        title: 'Search subagent',
      }),
      event('e6', 'turn_failed', '2026-03-08T09:30:00.000Z', {
        threadKey: 'codex:other',
        source: 'codex',
        sessionId: 'other',
        projectName: 'Other',
        projectPath: '/Users/test/other',
        title: 'Other thread',
      }),
    ];

    const diary = buildTodayDiary([...records, records[3]!], {
      nowMs,
      timeZone: LA,
    });

    expect(diary).toMatchObject({
      projectCount: 2,
      threadCount: 2,
      memberThreadCount: 3,
      overview:
        'Aside followed 2 conversations across 2 projects today. 1 is waiting for you. 1 turn failed.',
      counts: {
        eventCount: 6,
        waitingCount: 1,
        errorCount: 1,
        warningCount: 1,
        completionCount: 1,
      },
      lastObservedWorkAtMs: Date.parse('2026-03-08T11:00:00.000Z'),
    });
    const aside = diary.projects.find(
      (project) => project.projectPath === '/Users/test/aside',
    );
    expect(aside).toMatchObject({
      threadCount: 1,
      memberThreadCount: 2,
      counts: {
        eventCount: 5,
        waitingCount: 1,
        errorCount: 0,
        warningCount: 1,
        completionCount: 1,
      },
    });
    const thread = aside?.threads[0];
    expect(thread).toMatchObject({
      threadKey: rootKey,
      title: 'Ship Aside',
      memberThreadCount: 2,
      memberThreadKeys: [rootKey, childKey],
      lastObservedWorkAtMs: Date.parse('2026-03-08T11:00:00.000Z'),
    });
    expect(thread?.evidence.map(({ eventId }) => eventId)).toEqual([
      'e1',
      'e2',
      'e3',
      'e4',
      'e5',
    ]);
    expect(thread?.evidence.map(({ evidenceHash }) => evidenceHash)).toEqual([
      'hash-e1',
      'hash-e2',
      'hash-e3',
      'hash-e4',
      'hash-e5',
    ]);
    expect(thread?.subagents).toHaveLength(1);
    expect(thread?.subagents[0]).toMatchObject({
      threadKey: childKey,
      parentThreadKey: rootKey,
      isRoot: false,
      digest: {
        state: 'waiting',
        summary: '',
        occurredAtMs: Date.parse('2026-03-08T13:00:00.000Z'),
      },
      counts: {
        eventCount: 3,
        waitingCount: 1,
        warningCount: 1,
      },
    });
    expect(thread?.subagents[0]?.evidence.map(({ eventId }) => eventId)).toEqual([
      'e3',
      'e4',
      'e5',
    ]);
  });

  it('uses root metadata even when only a subagent worked today', () => {
    const rootKey = 'codex:root';
    const diary = buildTodayDiary(
      [
        event('old-root', 'prompt', '2026-03-07T17:00:00.000Z', {
          threadKey: rootKey,
          source: 'codex',
          sessionId: 'root',
          title: 'Canonical root title',
        }),
        event('child-today', 'progress', '2026-03-08T15:00:00.000Z', {
          threadKey: 'codex:child',
          source: 'codex',
          sessionId: 'child',
          parentThreadKey: rootKey,
          rootThreadKey: rootKey,
          title: 'Worker title',
        }),
      ],
      { nowMs, timeZone: LA },
    );

    expect(diary.threadCount).toBe(1);
    expect(diary.memberThreadCount).toBe(2);
    expect(diary.projects[0]?.threads[0]).toMatchObject({
      threadKey: rootKey,
      title: 'Canonical root title',
      memberThreadKeys: [rootKey, 'codex:child'],
    });
  });

  it('counts turn endings without manufacturing a success outcome', () => {
    const diary = buildTodayDiary(
      [event('ended', 'turn_completed', '2026-03-08T12:00:00.000Z')],
      { nowMs, timeZone: LA },
    );
    const thread = diary.projects[0]!.threads[0]!;

    expect(thread.counts.completionCount).toBe(1);
    expect(thread.counts.errorCount).toBe(0);
    expect(Object.hasOwn(thread, 'successful')).toBe(false);
    expect(Object.hasOwn(thread, 'outcome')).toBe(false);
    expect(JSON.stringify(thread).toLowerCase()).not.toContain('succeeded');
  });

  it('uses meaningful prose and preserves a waiting state after tool noise', () => {
    const diary = buildTodayDiary(
      [
        event('prompt1', 'prompt', '2026-03-08T09:00:00.000Z', {
          originKind: 'user_prompt',
          summary: 'Prepare the Today feature for release.',
        }),
        event('prose2', 'progress', '2026-03-08T10:00:00.000Z', {
          originKind: 'assistant_text',
          summary: 'The generated recap now leads the page.',
        }),
        event('wait3', 'input_requested', '2026-03-08T11:00:00.000Z', {
          originKind: 'needs_input',
          summary: 'Approve access to the signing key.',
        }),
        event('tool4', 'progress', '2026-03-08T12:00:00.000Z', {
          originKind: 'tool_result_ok',
          summary: 'exec_command completed',
        }),
      ],
      { nowMs, timeZone: LA },
    );

    expect(diary.projects[0]?.threads[0]?.digest).toEqual({
      state: 'waiting',
      summary: 'The generated recap now leads the page.',
      occurredAtMs: Date.parse('2026-03-08T11:00:00.000Z'),
    });
  });

  it('uses sequence rather than vendor time for the current thread state', () => {
    const diary = buildTodayDiary(
      [
        event('ready1', 'turn_completed', '2026-03-08T12:00:00.000Z', {
          seq: 1,
          originKind: 'turn_complete',
        }),
        event('wait2', 'input_requested', '2026-03-08T11:00:00.000Z', {
          seq: 2,
          observedAtMs: Date.parse('2026-03-08T13:00:00.000Z'),
          originKind: 'needs_input',
          summary: 'Approve the release?',
        }),
      ],
      { nowMs, timeZone: LA },
    );

    expect(diary.projects[0]?.threads[0]?.digest.state).toBe('waiting');
    expect(diary.overview).toContain('1 is waiting for you.');
    expect(diary.overview).not.toContain('ready to review');
  });
});

function lifecycleFor(kind: ActivityEventKind): ActivityLifecycle {
  if (kind === 'session_started' || kind === 'prompt') return 'start';
  if (kind === 'input_requested') return 'blocked';
  if (
    kind === 'turn_completed' ||
    kind === 'turn_failed' ||
    kind === 'turn_interrupted'
  ) {
    return 'terminal';
  }
  return 'progress';
}

function severityFor(kind: ActivityEventKind): ActivitySeverity {
  if (kind === 'turn_failed') return 'error';
  if (kind === 'tool_warning') return 'warning';
  if (kind === 'input_requested' || kind === 'turn_interrupted') {
    return 'attention';
  }
  return 'info';
}

function summaryFor(kind: ActivityEventKind): string {
  switch (kind) {
    case 'input_requested':
      return 'Choose a target';
    case 'turn_failed':
      return 'Provider reported a terminal error';
    case 'turn_completed':
      return 'Latest turn ended';
    case 'tool_warning':
      return 'Tool attempt failed';
    default:
      return kind.replace(/_/g, ' ');
  }
}
