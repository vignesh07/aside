import { describe, expect, it } from 'vitest';
import {
  buildActivityInsights,
  QUIET_WORK_AFTER_MS,
  WARNING_BURST_FRESHNESS_MS,
} from '../src/core/activity-insights.js';
import type {
  ActivityEventKind,
  ActivityEventRecord,
  ActivityLifecycle,
  ActivitySeverity,
  ThreadActivityCursor,
} from '../src/types/activity.js';

const NOW = Date.parse('2026-07-26T18:00:00.000Z');

function event(
  id: string,
  kind: ActivityEventKind,
  ageMs: number,
  overrides: Partial<ActivityEventRecord> = {},
): ActivityEventRecord {
  return {
    seq: Number(id.replace(/\D/g, '')) || 1,
    eventId: id,
    threadKey: 'claude:root',
    source: 'claude',
    sessionId: 'root',
    projectName: 'Aside',
    projectPath: '/Users/test/aside',
    title: 'Ship Aside',
    occurredAtMs: NOW - ageMs,
    observedAtMs: NOW - ageMs + 10,
    kind,
    lifecycle: lifecycleFor(kind),
    severity: severityFor(kind),
    summary: summaryFor(kind),
    evidenceHash: `hash-${id}`,
    seeded: false,
    ...overrides,
  };
}

function cursor(
  overrides: Partial<ThreadActivityCursor> = {},
): ThreadActivityCursor {
  return {
    threadKey: 'claude:root',
    baselineAtMs: 0,
    viewedThroughSeq: 0,
    resolvedThroughSeq: 0,
    ...overrides,
  };
}

describe('buildActivityInsights', () => {
  it('rejects an invalid evaluation clock', () => {
    expect(() => buildActivityInsights([], { nowMs: Number.NaN })).toThrow(
      RangeError,
    );
  });

  it('reports explicit waiting with a single decisive evidence ref', () => {
    const waiting = event('e2', 'input_requested', 1_000);
    const insights = buildActivityInsights(
      [event('e1', 'work_started', 2_000), waiting],
      { nowMs: NOW },
    );

    expect(insights).toHaveLength(1);
    expect(insights[0]).toMatchObject({
      kind: 'waiting',
      severity: 'attention',
      threadKey: 'claude:root',
      rootThreadKey: 'claude:root',
      headline: 'Waiting for input',
      detail: 'Approve the next step',
      evidence: [
        {
          eventId: 'e2',
          evidenceHash: 'hash-e2',
          threadKey: 'claude:root',
        },
      ],
    });
  });

  it('does not keep waiting or terminal failure after a later lifecycle event', () => {
    const waitingThenProgress = buildActivityInsights(
      [
        event('e1', 'input_requested', 2_000),
        event('e2', 'progress', 1_000),
      ],
      { nowMs: NOW },
    );
    const failureThenPrompt = buildActivityInsights(
      [
        event('e3', 'turn_failed', 2_000),
        event('e4', 'prompt', 1_000),
      ],
      { nowMs: NOW },
    );

    expect(waitingThenProgress.map(({ kind }) => kind)).not.toContain('waiting');
    expect(failureThenPrompt.map(({ kind }) => kind)).not.toContain(
      'terminal_failure',
    );
  });

  it('uses monotonic ledger sequence instead of vendor timestamp order', () => {
    const insights = buildActivityInsights(
      [
        event('e1', 'input_requested', 1_000, { seq: 1 }),
        event('e2', 'progress', 10_000, { seq: 2 }),
      ],
      { nowMs: NOW },
    );

    expect(insights.map(({ kind }) => kind)).not.toContain('waiting');
  });

  it('distinguishes an explicit terminal failure from recoverable tool warnings', () => {
    const warningsOnly = buildActivityInsights(
      [event('e1', 'tool_warning', 1_000)],
      { nowMs: NOW },
    );
    const terminal = event('e2', 'turn_failed', 500, {
      rootThreadKey: 'claude:parent',
    });
    const failed = buildActivityInsights(
      [event('e1', 'tool_warning', 1_000), terminal],
      { nowMs: NOW },
    );

    expect(warningsOnly).toEqual([]);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      kind: 'terminal_failure',
      headline: 'Turn failed',
      rootThreadKey: 'claude:parent',
      evidence: [{ eventId: 'e2', evidenceHash: 'hash-e2' }],
    });
  });

  it('detects a fresh warning burst, dedupes replayed events, and has a stable id', () => {
    const records = [
      event('e1', 'tool_warning', 9 * 60_000),
      event('e2', 'tool_warning', 5 * 60_000),
      event('e3', 'tool_warning', 1 * 60_000),
    ];
    const first = buildActivityInsights([...records, records[1]!], {
      nowMs: NOW,
    });
    const second = buildActivityInsights([...records].reverse(), {
      nowMs: NOW,
    });

    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      kind: 'warning_burst',
      severity: 'warning',
      headline: 'Repeated tool warnings',
    });
    expect(first[0]?.evidence.map(({ eventId }) => eventId)).toEqual([
      'e1',
      'e2',
      'e3',
    ]);
    expect(first[0]?.insightId).toBe(second[0]?.insightId);
  });

  it('does not surface an old warning burst as a live insight', () => {
    const old = WARNING_BURST_FRESHNESS_MS + 1;
    const insights = buildActivityInsights(
      [
        event('e1', 'tool_warning', old + 2_000),
        event('e2', 'tool_warning', old + 1_000),
        event('e3', 'tool_warning', old),
      ],
      { nowMs: NOW },
    );

    expect(insights).toEqual([]);
  });

  it('infers quiet work only from non-seeded work starts at the threshold', () => {
    const live = buildActivityInsights(
      [event('e1', 'work_started', QUIET_WORK_AFTER_MS)],
      { nowMs: NOW },
    );
    const tooSoon = buildActivityInsights(
      [event('e2', 'work_started', QUIET_WORK_AFTER_MS - 1)],
      { nowMs: NOW },
    );
    const seeded = buildActivityInsights(
      [
        event('e3', 'work_started', QUIET_WORK_AFTER_MS * 2, {
          seeded: true,
        }),
      ],
      { nowMs: NOW },
    );
    const laterProgress = buildActivityInsights(
      [
        event('e4', 'work_started', QUIET_WORK_AFTER_MS * 2),
        event('e5', 'progress', 1_000),
      ],
      { nowMs: NOW },
    );

    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({
      kind: 'quiet_work',
      headline: 'Observed work went quiet',
      evidence: [{ eventId: 'e1' }],
    });
    expect(tooSoon).toEqual([]);
    expect(seeded).toEqual([]);
    expect(laterProgress).toEqual([]);
  });

  it('reports a turn ending only when its durable cursor says it is unreviewed', () => {
    const completion = event('e8', 'turn_completed', 1_000, { seq: 8 });
    const unreviewed = buildActivityInsights([completion], {
      nowMs: NOW,
      cursors: [cursor({ viewedThroughSeq: 7, resolvedThroughSeq: 7 })],
    });
    const reviewed = buildActivityInsights([completion], {
      nowMs: NOW,
      cursors: [cursor({ viewedThroughSeq: 8 })],
    });
    const unknownReviewState = buildActivityInsights([completion], {
      nowMs: NOW,
    });

    expect(unreviewed).toHaveLength(1);
    expect(unreviewed[0]).toMatchObject({
      kind: 'unreviewed_completion',
      headline: 'Turn ended — ready to review',
      evidence: [{ eventId: 'e8' }],
    });
    expect(unreviewed[0]?.detail.toLowerCase()).not.toContain('success');
    expect(unreviewed[0]?.detail).toContain('deciding the task outcome');
    expect(reviewed).toEqual([]);
    expect(unknownReviewState).toEqual([]);
  });

  it('does not resurrect seeded completions at or before the install baseline', () => {
    const completion = event('e8', 'turn_completed', 1_000, {
      seq: 8,
      seeded: true,
    });
    const insights = buildActivityInsights([completion], {
      nowMs: NOW,
      cursors: [
        cursor({
          baselineAtMs: completion.occurredAtMs,
          viewedThroughSeq: 0,
        }),
      ],
    });

    expect(insights).toEqual([]);
  });

  it('keeps source-qualified threads and their evidence independent', () => {
    const claude = event('claude-wait', 'input_requested', 1_000);
    const codex = event('codex-wait', 'input_requested', 1_000, {
      seq: 1,
      threadKey: 'codex:root',
      source: 'codex',
      sessionId: 'root',
      evidenceHash: 'codex-hash',
    });
    const insights = buildActivityInsights([codex, claude], { nowMs: NOW });

    expect(insights).toHaveLength(2);
    expect(new Set(insights.map(({ threadKey }) => threadKey))).toEqual(
      new Set(['claude:root', 'codex:root']),
    );
    const insightIds = new Set(insights.map(({ insightId }) => insightId));
    expect(insightIds.size).toBe(2);
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
      return 'Approve the next step';
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
