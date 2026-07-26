import { describe, expect, it } from 'vitest';
import {
  packActivityEvidence,
  stableEvidenceRef,
} from '../src/core/activity-evidence-pack.js';
import type { ActivityEventRecord } from '../src/types/activity.js';

const BASE_TIME = Date.parse('2026-07-26T12:00:00.000Z');

function activity(
  seq: number,
  overrides: Partial<ActivityEventRecord> = {},
): ActivityEventRecord {
  return {
    seq,
    eventId: `event-${seq}`,
    threadKey: 'codex:thread-private',
    source: 'codex',
    sessionId: 'thread-private',
    projectName: 'aside',
    projectPath: '/Users/test/private-project',
    title: 'Implement content search',
    occurredAtMs: BASE_TIME + seq * 1_000,
    observedAtMs: BASE_TIME + seq * 1_000,
    kind: 'progress',
    lifecycle: 'progress',
    severity: 'info',
    summary: `Normalized event ${seq}`,
    originId: `vendor-private-${seq}`,
    evidenceHash: String(seq).padStart(64, '0'),
    seeded: false,
    ...overrides,
  };
}

describe('packActivityEvidence', () => {
  it('is deterministic across input ordering and provides stable references', () => {
    const events = [activity(3), activity(1), activity(2)];
    const forward = packActivityEvidence(events);
    const reverse = packActivityEvidence([...events].reverse());

    expect(reverse).toEqual(forward);
    expect(forward.evidence.map((item) => item.seq)).toEqual([1, 2, 3]);
    expect(forward.evidence.map((item) => item.ref)).toEqual([
      stableEvidenceRef('event-1'),
      stableEvidenceRef('event-2'),
      stableEvidenceRef('event-3'),
    ]);
    expect(forward.inputHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('strictly enforces event and provider-text character budgets', () => {
    const events = Array.from({ length: 8 }, (_, index) =>
      activity(index + 1, {
        summary: `Event ${index + 1} ${'detail '.repeat(30)}`,
      }),
    );
    const pack = packActivityEvidence(events, {
      maxEvents: 3,
      maxCharacters: 260,
    });

    expect(pack.evidence.length).toBeLessThanOrEqual(3);
    expect(pack.characterCount).toBe(pack.text.length);
    expect(pack.characterCount).toBeLessThanOrEqual(260);
    expect(pack.highWaterSeq).toBe(8);
    expect(pack.omittedEventCount).toBe(8 - pack.evidence.length);
    expect(pack.evidence.at(-1)?.seq).toBe(8);
  });

  it('redacts scoped labels and excludes transcript-only metadata from model text', () => {
    const pack = packActivityEvidence([
      activity(1, {
        projectPath: '/Users/test/sk-proj-projectpathsecret123456',
        projectName: 'aside api_key=sk-proj-projectnamesecret123456',
        title: 'Deploy password=title-secret-value',
        originId: 'raw-vendor-origin',
        summary:
          'Deploy with api_key=sk-proj-abcdefghijklmnopqrstuv and password=hunter2',
      }),
    ]);

    expect(pack.text).toContain('[REDACTED]');
    expect(pack.text).not.toContain('sk-proj-abcdefghijklmnopqrstuv');
    expect(pack.text).not.toContain('projectnamesecret');
    expect(pack.text).not.toContain('title-secret-value');
    expect(pack.text).not.toContain('hunter2');
    expect(pack.text).not.toContain('projectpathsecret');
    expect(pack.text).not.toContain('raw-vendor-origin');
    expect(pack.evidence[0]).not.toHaveProperty('threadKey');
    expect(pack.evidence[0]).not.toHaveProperty('originId');
    expect(pack.evidence[0]).toMatchObject({
      projectName: 'aside api_key=[REDACTED]',
      title: 'Deploy password=[REDACTED]',
    });
  });

  it('deduplicates stable event IDs and hashes only selected redacted input', () => {
    const original = activity(1);
    const duplicate = activity(99, {
      eventId: original.eventId,
      occurredAtMs: original.occurredAtMs,
      summary: 'A later duplicate hydration',
    });
    const first = packActivityEvidence([duplicate, original]);
    const second = packActivityEvidence([original]);

    expect(first.evidenceIds).toEqual(['event-1']);
    expect(first.inputHash).toBe(second.inputHash);
  });

  it('resolves conflicting duplicate records deterministically', () => {
    const left = activity(4, {
      evidenceHash: 'a'.repeat(64),
      summary: 'First normalized record',
    });
    const right = activity(4, {
      evidenceHash: 'b'.repeat(64),
      summary: 'Conflicting normalized record',
    });

    expect(packActivityEvidence([left, right])).toEqual(
      packActivityEvidence([right, left]),
    );
  });

  it('returns an empty but valid pack when no complete citation fits', () => {
    const pack = packActivityEvidence([activity(7)], {
      maxEvents: 10,
      maxCharacters: 12,
    });

    expect(pack).toMatchObject({
      highWaterSeq: 7,
      evidenceIds: [],
      evidence: [],
      text: '',
      characterCount: 0,
      omittedEventCount: 1,
    });
  });
});
