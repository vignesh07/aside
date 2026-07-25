import { describe, it, expect } from 'vitest';
import {
  renderRoster,
  renderDetail,
  renderWorld,
  renderHistory,
  allocateTranscriptBudget,
  tailWithinBudget,
  formatDuration,
  MIN_DETAIL_CHARS,
} from '../src/core/world-view.js';
import { formatEvent } from '../src/core/transcript-format.js';
import { sessionThreadId } from '../src/types/chat.js';
import type { SessionEvent } from '../src/types/events.js';
import type { ChatTurn } from '../src/types/chat.js';
import type { SessionSource } from '../src/types/session.js';
import type { SessionSnapshot, WorldSnapshot } from '../src/types/world.js';

const NOW = new Date('2026-07-16T12:00:00.000Z');

function snap(over: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    id: 'a',
    source: 'claude',
    projectName: 'proj',
    title: '',
    gitBranch: 'main',
    model: 'claude-opus-4-8',
    status: 'active',
    idleForMs: 0,
    currentActivity: '',
    contextUsedPercent: 0,
    contextStatus: 'safe',
    transcript: [],
    ...over,
  };
}

function key(id: string, source: SessionSource = 'claude'): string {
  return sessionThreadId(source, id);
}

function world(
  sessions: SessionSnapshot[],
  focusThreadId: string | null = null,
): WorldSnapshot {
  return {
    now: NOW,
    totalSessionCount: sessions.length,
    sessions,
    focusThreadId,
  };
}

/** n events, each rendering to a line of roughly `chars` characters. */
function bulkTranscript(n: number, chars = 100): SessionEvent[] {
  return Array.from({ length: n }, (_, i) => ({
    kind: 'assistant_text' as const,
    preview: `${i}`.padEnd(chars, 'x'),
    ts: '',
  }));
}

describe('formatDuration', () => {
  it.each([
    [0, '0s'],
    [4_000, '4s'],
    [59_000, '59s'],
    [60_000, '1m'],
    [14 * 60_000, '14m'],
    [3 * 3_600_000, '3h'],
    [2 * 86_400_000, '2d'],
  ])('formats %ims as %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });

  it('clamps negative clock skew to zero rather than printing nonsense', () => {
    expect(formatDuration(-5_000)).toBe('0s');
  });
});

describe('renderRoster', () => {
  it('says plainly when no agent threads were discovered', () => {
    expect(renderRoster(world([]))).toMatch(/No Claude Code, Codex, or Pi threads/);
  });

  it('lists every session, including ones with no transcript detail', () => {
    const out = renderRoster(world([snap({ id: 'a' }), snap({ id: 'b', projectName: 'other' })]));
    expect(out).toContain('[claude:a]');
    expect(out).toContain('[claude:b]');
    expect(out).toContain('(2)');
  });

  it('states idle duration, which the transcript alone can never convey', () => {
    const out = renderRoster(world([snap({ idleForMs: 14 * 60_000, status: 'idle' })]));
    expect(out).toMatch(/IDLE/);
    expect(out).toMatch(/quiet for 14m/);
  });

  it('marks the focused session', () => {
    const out = renderRoster(
      world([snap({ id: 'a' }), snap({ id: 'b' })], key('b')),
    );
    const lineB = out.split('\n').find((l) => l.includes('[claude:b]'))!;
    const lineA = out.split('\n').find((l) => l.includes('[claude:a]'))!;
    expect(lineB).toMatch(/focused/);
    expect(lineA).not.toMatch(/focused/);
  });

  it('marks only the focused provider when two providers reuse an id', () => {
    const sessions = [
      snap({ id: 'shared', source: 'claude' }),
      snap({ id: 'shared', source: 'codex' }),
    ];
    const out = renderRoster(world(sessions, key('shared', 'codex')));
    const claude = out
      .split('\n')
      .find((line) => line.includes('[claude:shared]'))!;
    const codex = out
      .split('\n')
      .find((line) => line.includes('[codex:shared]'))!;

    expect(codex).toMatch(/focused/);
    expect(claude).not.toMatch(/focused/);
  });

  it('includes context usage when known', () => {
    const out = renderRoster(world([snap({ contextUsedPercent: 82, contextStatus: 'caution' })]));
    expect(out).toMatch(/context 82% \(caution\)/);
  });
});

describe('allocateTranscriptBudget', () => {
  it('ignores sessions with no transcript — they cost nothing', () => {
    const { perSession } = allocateTranscriptBudget([snap({ id: 'empty' })], null, 10_000);
    expect(perSession.size).toBe(0);
  });

  it('gives a focused session more than an equally-live unfocused one', () => {
    const sessions = [
      snap({ id: 'a', transcript: bulkTranscript(20) }),
      snap({ id: 'b', transcript: bulkTranscript(20) }),
    ];
    const { perSession } = allocateTranscriptBudget(sessions, key('a'), 10_000);
    expect(perSession.get(key('a'))!).toBeGreaterThan(
      perSession.get(key('b'))!,
    );
  });

  it('budgets matching vendor ids independently and weights only the focused provider', () => {
    const sessions = [
      snap({
        id: 'shared',
        source: 'claude',
        transcript: bulkTranscript(20),
      }),
      snap({
        id: 'shared',
        source: 'codex',
        transcript: bulkTranscript(20),
      }),
    ];
    const { perSession, omitted } = allocateTranscriptBudget(
      sessions,
      key('shared', 'codex'),
      10_000,
    );

    expect(perSession.size).toBe(2);
    expect(perSession.get(key('shared', 'codex'))!).toBeGreaterThan(
      perSession.get(key('shared', 'claude'))!,
    );
    expect(omitted).toEqual([]);
  });

  it('ranks live sessions above idle ones, and idle above history', () => {
    const sessions = [
      snap({ id: 'active', status: 'active', transcript: bulkTranscript(20) }),
      snap({ id: 'idle', status: 'idle', transcript: bulkTranscript(20) }),
      snap({ id: 'history', status: 'history', transcript: bulkTranscript(20) }),
    ];
    const { perSession } = allocateTranscriptBudget(sessions, null, 30_000);
    expect(perSession.get(key('active'))!).toBeGreaterThan(
      perSession.get(key('idle'))!,
    );
    expect(perSession.get(key('idle'))!).toBeGreaterThan(
      perSession.get(key('history'))!,
    );
  });

  it('never exceeds the total budget', () => {
    const sessions = Array.from({ length: 6 }, (_, i) =>
      snap({ id: `s${i}`, transcript: bulkTranscript(50) }),
    );
    const { perSession } = allocateTranscriptBudget(sessions, key('s0'), 10_000);
    const spent = [...perSession.values()].reduce((a, b) => a + b, 0);
    expect(spent).toBeLessThanOrEqual(10_000);
  });

  it('drops the weakest sessions rather than handing out useless slivers', () => {
    // 20 sessions against a budget that can only fund a few at usable depth.
    const sessions = Array.from({ length: 20 }, (_, i) =>
      snap({ id: `s${i}`, status: 'idle', transcript: bulkTranscript(50) }),
    );
    const { perSession, omitted } = allocateTranscriptBudget(
      sessions,
      key('s0'),
      4_000,
    );
    expect(perSession.size).toBeGreaterThan(0);
    expect(omitted.length).toBeGreaterThan(0);
    for (const share of perSession.values()) {
      expect(share).toBeGreaterThanOrEqual(MIN_DETAIL_CHARS);
    }
    expect(perSession.size + omitted.length).toBe(20);
  });

  it('keeps the focused session when budget forces drops', () => {
    const sessions = Array.from({ length: 20 }, (_, i) =>
      snap({ id: `s${i}`, status: 'idle', transcript: bulkTranscript(50) }),
    );
    const { perSession } = allocateTranscriptBudget(
      sessions,
      key('s19'),
      4_000,
    );
    expect(perSession.has(key('s19'))).toBe(true);
  });

  it('gives a lone session the whole budget even if it is below the floor', () => {
    const { perSession, omitted } = allocateTranscriptBudget(
      [snap({ id: 'only', transcript: bulkTranscript(5) })],
      null,
      MIN_DETAIL_CHARS,
    );
    expect(perSession.get(key('only'))).toBe(MIN_DETAIL_CHARS);
    expect(omitted).toEqual([]);
  });

  it('omits everything when the budget cannot fund even one session', () => {
    const { perSession, omitted } = allocateTranscriptBudget(
      [snap({ id: 'a', transcript: bulkTranscript(5) })],
      null,
      10,
    );
    expect(perSession.size).toBe(0);
    expect(omitted).toEqual([key('a')]);
  });
});

describe('tailWithinBudget', () => {
  it('keeps the most recent events, not the oldest', () => {
    const lines = tailWithinBudget(bulkTranscript(10, 100), 350);
    expect(lines.length).toBeLessThan(10);
    // bulkTranscript numbers each event; the last one must survive.
    expect(lines.at(-1)).toContain('9');
    expect(lines.some((l) => l.includes('[agent] 0'))).toBe(false);
  });

  it('preserves oldest-first order within what it keeps', () => {
    const lines = tailWithinBudget(bulkTranscript(10, 100), 350);
    const nums = lines.map((l) => Number(l.replace(/[^0-9]/g, '').replace(/x+$/, '')[0]));
    expect(nums).toEqual([...nums].sort((a, b) => a - b));
  });

  it('drops empty (unknown) event lines', () => {
    const lines = tailWithinBudget(
      [
        { kind: 'user_prompt', summary: 'hi', ts: '' },
        { kind: 'unknown', raw: 'x', ts: '' },
      ],
      10_000,
    );
    expect(lines).toEqual(['[user] hi']);
  });

  it('always keeps at least one event, even one over budget', () => {
    const lines = tailWithinBudget(bulkTranscript(3, 500), 10);
    expect(lines).toHaveLength(1);
  });

  it('returns nothing for an empty transcript', () => {
    expect(tailWithinBudget([], 1_000)).toEqual([]);
  });
});

describe('renderDetail', () => {
  it('is empty when no session has any activity', () => {
    expect(renderDetail(world([snap({ id: 'a' })]))).toBe('');
  });

  it('labels each block with its session id', () => {
    const out = renderDetail(world([snap({ id: 'a', transcript: bulkTranscript(3) })]));
    expect(out).toContain('[claude:a]');
    expect(out).toContain('=== Recent activity ===');
  });

  it('states that omitted sessions were omitted, rather than implying they were idle', () => {
    const sessions = Array.from({ length: 20 }, (_, i) =>
      snap({ id: `s${i}`, status: 'idle', transcript: bulkTranscript(50) }),
    );
    const out = renderDetail(world(sessions, key('s0')), 4_000);
    expect(out).toMatch(/omitted to fit the context budget/);
  });

  it('says nothing about omissions when everything fits', () => {
    const out = renderDetail(world([snap({ id: 'a', transcript: bulkTranscript(3) })]), 50_000);
    expect(out).not.toMatch(/omitted/);
  });
});

describe('renderWorld', () => {
  it('states the current time so idle math is anchored', () => {
    expect(renderWorld(world([]))).toContain(NOW.toISOString());
  });

  it('includes the roster even when no session has transcript detail', () => {
    const out = renderWorld(world([snap({ id: 'a', idleForMs: 60_000 })]));
    expect(out).toContain('[claude:a]');
    expect(out).toMatch(/quiet for 1m/);
  });

  it('states when the prompt contains only a relevant subset of discovered history', () => {
    const partial = {
      ...world([snap({ id: 'a' })]),
      totalSessionCount: 344,
    };
    const out = renderWorld(partial);
    expect(out).toContain('1 relevant of 344 discovered');
    expect(out).toMatch(/remain searchable and selectable/);
  });

  it('puts the roster before the detail', () => {
    const out = renderWorld(world([snap({ id: 'a', transcript: bulkTranscript(3) })]));
    expect(out.indexOf('Agent sessions aside can see')).toBeLessThan(
      out.indexOf('=== Recent activity ==='),
    );
  });

  it('has no dangling blank sections when there is no detail', () => {
    const out = renderWorld(world([snap({ id: 'a' })]));
    expect(out).not.toMatch(/\n\n\n/);
  });
});

describe('renderHistory', () => {
  it('is empty when there is no prior chat', () => {
    expect(renderHistory([])).toBe('');
  });

  it('labels user vs assistant turns', () => {
    const turns: ChatTurn[] = [
      { id: '1', role: 'user', content: 'why?', timestamp: new Date(0) },
      { id: '2', role: 'assistant', content: 'because', timestamp: new Date(0) },
    ];
    const out = renderHistory(turns);
    expect(out).toMatch(/User asked: why\?/);
    expect(out).toMatch(/You answered: because/);
  });
});

describe('formatEvent', () => {
  const cases: Array<[SessionEvent, RegExp]> = [
    [{ kind: 'user_prompt', summary: 'fix the bug', ts: '' }, /\[user\] fix the bug/],
    [{ kind: 'assistant_text', preview: 'sure', ts: '' }, /\[agent\] sure/],
    [{ kind: 'tool_call', tool: 'Edit', target: 'a.ts', ts: '' }, /\[tool\] Edit → a\.ts/],
    [{ kind: 'tool_result_error', tool: 'Bash', error: 'boom', ts: '' }, /\[tool ERROR\] Bash: boom/],
    [{ kind: 'file_edited', path: 'x.ts', ts: '' }, /\[edited file\] x\.ts/],
    [{ kind: 'bash_complete', command: 'ls', exitCode: 0, ts: '' }, /\[bash done exit=0\] ls/],
  ];
  for (const [event, re] of cases) {
    it(`renders ${event.kind}`, () => {
      expect(formatEvent(event)).toMatch(re);
    });
  }

  it('renders unknown events as empty (so they are filtered out)', () => {
    expect(formatEvent({ kind: 'unknown', raw: '...', ts: '' })).toBe('');
  });
});
