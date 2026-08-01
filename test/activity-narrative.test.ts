import { describe, expect, it } from 'vitest';
import {
  curateNarrativeActivity,
  latestNarrativeSummary,
} from '../src/core/activity-narrative.js';
import type { ActivityEventRecord } from '../src/types/activity.js';

function event(
  seq: number,
  overrides: Partial<ActivityEventRecord> = {},
): ActivityEventRecord {
  return {
    seq,
    eventId: `event-${seq}`,
    threadKey: 'codex:root',
    source: 'codex',
    sessionId: 'root',
    projectName: 'aside',
    projectPath: '/Users/test/aside',
    title: 'Ship Today',
    occurredAtMs: 1_700_000_000_000 + seq,
    observedAtMs: 1_700_000_000_100 + seq,
    kind: 'progress',
    lifecycle: 'progress',
    severity: 'info',
    summary: 'Aside is preparing a concise release recap.',
    evidenceHash: `hash-${seq}`,
    seeded: false,
    ...overrides,
  };
}

describe('curateNarrativeActivity', () => {
  it('keeps user-visible work and drops tool mechanics using origin kinds', () => {
    const selected = curateNarrativeActivity([
      event(1, {
        kind: 'prompt',
        originKind: 'user_prompt',
        lifecycle: 'start',
        summary: 'Make the Today view feel like a diary.',
      }),
      event(2, {
        kind: 'work_started',
        originKind: 'tool_call',
        summary: 'exec_command: npm test',
      }),
      event(3, {
        kind: 'progress',
        originKind: 'tool_result_ok',
        summary: 'exec_command completed',
      }),
      event(4, {
        originKind: 'assistant_text',
        summary: 'The recap now foregrounds decisions and outcomes.',
      }),
      event(5, {
        kind: 'turn_completed',
        originKind: 'turn_complete',
        lifecycle: 'terminal',
        summary: 'Latest turn ended',
      }),
    ]);

    expect(selected.map((item) => item.eventId)).toEqual([
      'event-1',
      'event-4',
      'event-5',
    ]);
    expect(latestNarrativeSummary(selected)).toBe(
      'The recap now foregrounds decisions and outcomes.',
    );
  });

  it('filters recognizable tool noise from pre-v3 ledger rows', () => {
    const selected = curateNarrativeActivity([
      event(1, { summary: 'wait_agent completed' }),
      event(2, { summary: 'Command completed: npm test' }),
      event(3, { summary: 'Edited /Users/test/aside/main.ts' }),
      event(31, { summary: 'Edited src/main.ts' }),
      event(4, {
        summary: 'The integrated build passed every release check.',
      }),
    ]);

    expect(selected.map((item) => item.eventId)).toEqual(['event-4']);
  });

  it('uses ledger sequence for current prose despite vendor clock skew', () => {
    const selected = curateNarrativeActivity([
      event(1, {
        originKind: 'assistant_text',
        occurredAtMs: 2_000,
        observedAtMs: 2_000,
        summary: 'An older agent update.',
      }),
      event(2, {
        kind: 'prompt',
        originKind: 'user_prompt',
        lifecycle: 'start',
        occurredAtMs: 1_000,
        observedAtMs: 3_000,
        summary: 'A newer user request.',
      }),
    ]);

    expect(selected.at(-1)?.eventId).toBe('event-2');
    expect(latestNarrativeSummary(selected)).toBe('A newer user request.');
  });

  it('deduplicates stable event IDs and bounds each narrative thread', () => {
    const repeated = Array.from({ length: 8 }, (_, index) =>
      event(index + 1, {
        kind: 'prompt',
        originKind: 'user_prompt',
        lifecycle: 'start',
        summary: index < 2 ? 'Review the release.' : `Prompt ${index}`,
      }),
    );
    const progress = Array.from({ length: 7 }, (_, index) =>
      event(20 + index, {
        originKind: 'assistant_text',
        summary: `Meaningful progress update number ${index}.`,
      }),
    );

    const selected = curateNarrativeActivity([
      repeated[0]!,
      ...repeated,
      ...progress,
    ]);

    expect(selected.filter((item) => item.kind === 'prompt')).toHaveLength(2);
    expect(
      selected
        .filter((item) => item.kind === 'prompt')
        .map((item) => item.eventId),
    ).toEqual(['event-7', 'event-8']);
    expect(selected.filter((item) => item.kind === 'progress')).toHaveLength(4);
    expect(selected.at(-1)?.summary).toBe(
      'Meaningful progress update number 6.',
    );
  });

  it('retains a later repeated prompt as new narrative activity', () => {
    const selected = curateNarrativeActivity([
      event(1, {
        kind: 'prompt',
        originKind: 'user_prompt',
        lifecycle: 'start',
        summary: 'Continue.',
      }),
      event(2, {
        kind: 'prompt',
        originKind: 'user_prompt',
        lifecycle: 'start',
        summary: 'Continue.',
      }),
    ]);

    expect(selected.map((item) => item.eventId)).toEqual([
      'event-1',
      'event-2',
    ]);
  });
});
