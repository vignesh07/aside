import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  MAX_ATTENTION_SEEDS_PER_SYNC,
  MAX_FLEET_CONTEXT_SESSIONS,
  SideChatService,
  type AskEngine,
} from '../src/core/side-chat-service.js';
import type { AskParams } from '../src/core/side-chat-engine.js';
import type { TrackedSession } from '../src/types/session.js';
import { sessionThreadId } from '../src/types/chat.js';
import type { ChatThread } from '../src/types/chat.js';
import type {
  ThreadStore,
  ThreadStoreSaveOptions,
} from '../src/core/thread-store.js';

class FakeEngine implements AskEngine {
  calls: AskParams[] = [];
  constructor(private responder: (p: AskParams) => Promise<string> = async () => 'ok') {}
  async ask(params: AskParams): Promise<string> {
    this.calls.push(params);
    return this.responder(params);
  }
  setModel(): void {}
}

const NOW = new Date('2026-07-16T12:00:00.000Z');
const clock = () => NOW;

function session(id: string, over: Partial<TrackedSession> = {}): TrackedSession {
  return {
    id,
    source: 'claude',
    projectName: `proj-${id}`,
    projectDir: '',
    jsonlPath: `/tmp/${id}.jsonl`,
    cwd: '',
    gitBranch: 'main',
    slug: '',
    model: '',
    version: '',
    usedPercent: 0,
    contextStatus: 'safe',
    status: 'active',
    lastEventTime: NOW,
    eventCount: 0,
    currentActivity: '',
    ...over,
  };
}

function claudeAssistantLine(text: string): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: NOW.toISOString(),
    message: {
      content: [{ type: 'text', text }],
    },
  });
}

function claudeUserLine(text: string): string {
  return JSON.stringify({
    type: 'user',
    timestamp: NOW.toISOString(),
    message: { content: text },
  });
}

function claudeInputRequestLine(question: string): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: NOW.toISOString(),
    message: {
      content: [{
        type: 'tool_use',
        name: 'AskUserQuestion',
        input: { questions: [{ question }] },
      }],
    },
  });
}

describe('SideChatService.ask', () => {
  it('appends a user turn then an assistant turn', async () => {
    const engine = new FakeEngine(async () => 'because the test said so');
    const svc = new SideChatService(engine, {}, clock);
    await svc.ask('why?');

    const chat = svc.getChat();
    expect(chat.map((t) => t.role)).toEqual(['user', 'assistant']);
    expect(chat[0]!.content).toBe('why?');
    expect(chat[1]!.content).toBe('because the test said so');
    expect(chat[1]!.error).toBe(false);
  });

  it('answers with no session selected — the whole world is the scope', async () => {
    const engine = new FakeEngine();
    const svc = new SideChatService(engine, {}, clock);
    await svc.ask("what's running?");
    expect(engine.calls).toHaveLength(1);
    expect(engine.calls[0]!.world.focusId).toBeNull();
    expect(engine.calls[0]!.world.totalSessionCount).toBe(0);
  });

  it('passes prior turns as history but not the current question', async () => {
    const engine = new FakeEngine();
    const svc = new SideChatService(engine, {}, clock);
    await svc.ask('first');
    await svc.ask('second');

    const secondCall = engine.calls[1]!;
    expect(secondCall.question).toBe('second');
    expect(secondCall.history.map((t) => t.content)).toEqual(['first', 'ok']);
    expect(secondCall.history.some((t) => t.content === 'second')).toBe(false);
  });

  it('keeps independent persistent conversations for each session', async () => {
    const engine = new FakeEngine();
    const svc = new SideChatService(engine, {}, clock);
    svc.setFocus('a');
    await svc.ask('about a');
    svc.setFocus('b');
    await svc.ask('about b');

    expect(svc.getChat().map((t) => t.content)).toEqual(['about b', 'ok']);
    expect(engine.calls[1]!.history).toEqual([]);
    svc.setFocus('a');
    expect(svc.getChat().map((t) => t.content)).toEqual(['about a', 'ok']);
    expect(engine.calls.map((call) => call.threadId)).toEqual(['session:a', 'session:b']);
  });

  it('keeps same-id sessions from different sources in separate chats and scopes', async () => {
    const engine = new FakeEngine();
    const svc = new SideChatService(engine, {}, clock);
    svc.syncSessions([
      session('same', { source: 'codex' }),
      session('same', { source: 'claude' }),
    ], new Map());

    svc.selectThread(sessionThreadId('codex', 'same'));
    await svc.ask('codex only');
    svc.selectThread(sessionThreadId('claude', 'same'));
    await svc.ask('claude only');

    expect(svc.getChat().map((turn) => turn.content)).toEqual([
      'claude only',
      'ok',
    ]);
    expect(
      svc.getThread(sessionThreadId('codex', 'same')).turns.map(
        (turn) => turn.content,
      ),
    ).toEqual(['codex only', 'ok']);
    expect(engine.calls.map((call) => call.world.sessions[0]?.source)).toEqual([
      'codex',
      'claude',
    ]);
  });

  it('records an error turn when the engine throws', async () => {
    const engine = new FakeEngine(async () => {
      throw new Error('rate limited');
    });
    const svc = new SideChatService(engine, {}, clock);
    await svc.ask('hi');

    const last = svc.getChat().at(-1)!;
    expect(last.role).toBe('assistant');
    expect(last.error).toBe(true);
    expect(last.content).toContain('rate limited');
  });

  it('toggles thinking true during the call and false after', async () => {
    let resolve!: (v: string) => void;
    const engine = new FakeEngine(() => new Promise<string>((r) => (resolve = r)));
    const log: boolean[] = [];
    const svc = new SideChatService(engine, { onThinking: (_id, t) => log.push(t) }, clock);

    const pending = svc.ask('q');
    expect(svc.isThinking()).toBe(true);
    resolve('done');
    await pending;
    expect(svc.isThinking()).toBe(false);
    expect(log).toEqual([true, false]);
  });

  it('is a no-op for an empty question', async () => {
    const engine = new FakeEngine();
    const svc = new SideChatService(engine, {}, clock);
    await svc.ask('   ');
    expect(engine.calls).toHaveLength(0);
    expect(svc.getChat()).toEqual([]);
  });
});

describe('SideChatService.snapshot', () => {
  it('derives idle time from the injected clock', async () => {
    const svc = new SideChatService(new FakeEngine(), {}, clock);
    svc.syncSessions(
      [session('a', { lastEventTime: new Date(NOW.getTime() - 14 * 60_000) })],
      new Map(),
    );
    expect(svc.snapshot().sessions[0]!.idleForMs).toBe(14 * 60_000);
  });

  it('clamps future timestamps to zero instead of reporting negative idleness', () => {
    const svc = new SideChatService(new FakeEngine(), {}, clock);
    svc.syncSessions([session('a', { lastEventTime: new Date(NOW.getTime() + 5_000) })], new Map());
    expect(svc.snapshot().sessions[0]!.idleForMs).toBe(0);
  });

  it('scopes a session side thread to exactly the selected session', () => {
    const svc = new SideChatService(new FakeEngine(), {}, clock);
    svc.syncSessions([session('a'), session('b'), session('c')], new Map());
    svc.setFocus('b');
    const snap = svc.snapshot();
    expect(snap.sessions.map((s) => s.id)).toEqual(['b']);
    expect(snap.focusId).toBe('b');
    expect(snap.totalSessionCount).toBe(1);
  });

  it('keeps every session in fleet scope when the catalog fits the bound', () => {
    const svc = new SideChatService(new FakeEngine(), {}, clock);
    svc.syncSessions([session('a'), session('b'), session('c')], new Map());
    expect(svc.snapshot().sessions.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    expect(svc.snapshot().focusId).toBeNull();
    expect(svc.snapshot().totalSessionCount).toBe(3);
  });

  it('keeps internal workers out of fleet context but selectable on demand', () => {
    const svc = new SideChatService(new FakeEngine(), {}, clock);
    svc.syncSessions(
      [
        session('root', { source: 'codex' }),
        session('worker', {
          source: 'codex',
          isInternal: true,
          parentSessionId: 'root',
        }),
      ],
      new Map(),
    );

    expect(svc.snapshot().sessions.map((item) => item.id)).toEqual(['root']);
    expect(svc.snapshot().totalSessionCount).toBe(1);
    expect(svc.getThreads().map((thread) => thread.id)).toEqual(['fleet']);

    svc.selectThread('session:worker');
    expect(svc.snapshot().sessions.map((item) => item.id)).toEqual(['worker']);
    expect(svc.getThreads().map((thread) => thread.id)).toEqual([
      'fleet',
      'session:codex:worker',
    ]);
  });

  it('reports an empty world when nothing is running', () => {
    const svc = new SideChatService(new FakeEngine(), {}, clock);
    expect(svc.snapshot().sessions).toEqual([]);
  });

  it('bounds fleet context but reports the complete discovered count', () => {
    const svc = new SideChatService(new FakeEngine(), {}, clock);
    const sessions = Array.from({ length: MAX_FLEET_CONTEXT_SESSIONS + 12 }, (_, index) =>
      session(`s${index}`, {
        status: 'history',
        projectName: index === MAX_FLEET_CONTEXT_SESSIONS + 11
          ? 'needle-project'
          : `archive-${index}`,
        lastEventTime: new Date(NOW.getTime() - index * 60_000),
      }),
    );
    svc.syncSessions(sessions, new Map());

    const snap = svc.snapshot('fleet', 'find needle-project');
    expect(snap.totalSessionCount).toBe(sessions.length);
    expect(snap.sessions).toHaveLength(MAX_FLEET_CONTEXT_SESSIONS);
    expect(snap.sessions.some((item) => item.projectName === 'needle-project')).toBe(true);
  });

  it('hydrates a historical transcript when its session thread is selected', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aside-history-'));
    const jsonlPath = path.join(root, 'history.jsonl');
    fs.writeFileSync(
      jsonlPath,
      `${JSON.stringify({
        type: 'assistant',
        timestamp: NOW.toISOString(),
        message: { content: [{ type: 'text', text: 'historical answer' }] },
      })}\n`,
    );
    try {
      const svc = new SideChatService(new FakeEngine(), {}, clock);
      svc.syncSessions(
        [session('old', { status: 'history', jsonlPath })],
        new Map([['old', jsonlPath]]),
      );
      expect(svc.getTranscript('old')).toEqual([]);
      svc.selectThread('session:old');
      expect(svc.getTranscript('old')).toEqual([
        expect.objectContaining({ kind: 'assistant_text', preview: 'historical answer' }),
      ]);
      svc.dispose();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('retries a selected historical hydration after its deferred projection appears', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aside-deferred-history-'));
    const jsonlPath = path.join(root, 'history.jsonl');
    const tracked = session('deferred', {
      status: 'history',
      jsonlPath,
    });
    try {
      const svc = new SideChatService(new FakeEngine(), {}, clock);
      const paths = new Map([['deferred', jsonlPath]]);
      svc.syncSessions([tracked], paths);
      svc.selectThread('session:deferred');
      expect(svc.getTranscript(tracked)).toEqual([]);

      fs.writeFileSync(jsonlPath, `${claudeAssistantLine('projection is ready')}\n`);
      svc.syncSessions([tracked], paths);

      expect(svc.getTranscript(tracked)).toContainEqual(
        expect.objectContaining({
          kind: 'assistant_text',
          preview: 'projection is ready',
        }),
      );
      svc.dispose();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('replaces derived state when a session path changes or disappears', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aside-retargeted-session-'));
    const firstPath = path.join(root, 'first.jsonl');
    const secondPath = path.join(root, 'second.jsonl');
    fs.writeFileSync(firstPath, `${claudeAssistantLine('old private projection')}\n`);
    fs.writeFileSync(secondPath, `${claudeAssistantLine('new canonical projection')}\n`);
    const tracked = session('retargeted', { jsonlPath: firstPath });
    const resets: string[] = [];
    const completed: string[] = [];
    const svc = new SideChatService(
      new FakeEngine(),
      {
        onProjectionReset: (id) => resets.push(id),
        onProjectionResetComplete: (id) => completed.push(id),
      },
      clock,
    );

    try {
      svc.syncSessions([tracked], new Map([['retargeted', firstPath]]));
      expect(svc.getTranscript(tracked)).toContainEqual(
        expect.objectContaining({ preview: 'old private projection' }),
      );

      const retargeted = { ...tracked, jsonlPath: secondPath };
      svc.syncSessions(
        [retargeted],
        new Map([['retargeted', secondPath]]),
      );
      expect(svc.getTranscript(retargeted)).toContainEqual(
        expect.objectContaining({ preview: 'new canonical projection' }),
      );
      expect(svc.getTranscript(retargeted)).not.toContainEqual(
        expect.objectContaining({ preview: 'old private projection' }),
      );

      svc.syncSessions([], new Map());
      svc.syncSessions(
        [retargeted],
        new Map([['retargeted', secondPath]]),
      );
      expect(svc.getTranscript(retargeted)).toEqual([
        expect.objectContaining({ preview: 'new canonical projection' }),
      ]);
      expect(resets).toHaveLength(4);
      expect(completed).toEqual(resets);
      svc.dispose();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('replays a selected historical session after an atomic same-path rewrite', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aside-history-rewrite-'));
    const jsonlPath = path.join(root, 'history.jsonl');
    fs.writeFileSync(jsonlPath, `${claudeAssistantLine('old private text')}\n`);
    const tracked = session('same-path-history', {
      status: 'history',
      jsonlPath,
    });
    const svc = new SideChatService(new FakeEngine(), {}, clock);
    const paths = new Map([['same-path-history', jsonlPath]]);
    try {
      svc.syncSessions([tracked], paths);
      svc.selectThread('session:same-path-history');
      expect(svc.getTranscript(tracked)).toContainEqual(
        expect.objectContaining({ preview: 'old private text' }),
      );

      const replacement = path.join(root, 'replacement.jsonl');
      fs.writeFileSync(replacement, `${claudeAssistantLine('new canonical text')}\n`);
      fs.renameSync(replacement, jsonlPath);
      svc.syncSessions([tracked], paths);

      expect(svc.getTranscript(tracked)).toContainEqual(
        expect.objectContaining({ preview: 'new canonical text' }),
      );
      expect(svc.getTranscript(tracked)).not.toContainEqual(
        expect.objectContaining({ preview: 'old private text' }),
      );
    } finally {
      svc.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('replays a same-path rewrite after an active session was temporarily historical', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aside-paused-tail-rewrite-'));
    const jsonlPath = path.join(root, 'session.jsonl');
    const openCodeText = (sourceId: string, text: string): string => JSON.stringify({
      schema: 'aside.opencode.v1',
      id: sourceId,
      sourceId,
      sessionId: 'status-transition',
      timestamp: NOW.toISOString(),
      type: 'text',
      role: 'assistant',
      text,
    });
    fs.writeFileSync(jsonlPath, `${openCodeText('old', 'old private text')}\n`);
    const active = session('status-transition', {
      source: 'opencode',
      status: 'active',
      jsonlPath,
    });
    const svc = new SideChatService(new FakeEngine(), {}, clock);
    const paths = new Map([['status-transition', jsonlPath]]);

    try {
      svc.syncSessions([active], paths);
      expect(svc.getTranscript(active)).toContainEqual(
        expect.objectContaining({ preview: 'old private text' }),
      );

      const historical = { ...active, status: 'history' as const };
      svc.syncSessions([historical], paths);
      expect(
        (svc as unknown as { tailer: { tailedSessionIds: string[] } })
          .tailer.tailedSessionIds,
      ).toEqual([]);

      const replacement = path.join(root, 'replacement.jsonl');
      fs.writeFileSync(
        replacement,
        `${openCodeText('new', 'new canonical text')}\n`,
      );
      fs.renameSync(replacement, jsonlPath);
      svc.syncSessions([{ ...historical, status: 'active' }], paths);

      expect(svc.getTranscript(active)).toContainEqual(
        expect.objectContaining({ preview: 'new canonical text' }),
      );
      expect(svc.getTranscript(active)).not.toContainEqual(
        expect.objectContaining({ preview: 'old private text' }),
      );
    } finally {
      svc.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('recomputes unselected historical attention after a same-path rewrite', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aside-attention-rewrite-'));
    const jsonlPath = path.join(root, 'history.jsonl');
    fs.writeFileSync(jsonlPath, `${claudeInputRequestLine('Approve the old request?')}\n`);
    const tracked = session('attention-history', {
      status: 'history',
      source: 'claude',
      jsonlPath,
    });
    const svc = new SideChatService(new FakeEngine(), {}, clock);
    const paths = new Map([['attention-history', jsonlPath]]);
    try {
      svc.syncSessions([tracked], paths);
      expect(svc.getSessionAttention(tracked)).toMatchObject({ needsUser: true });

      const replacement = path.join(root, 'replacement.jsonl');
      fs.writeFileSync(replacement, `${claudeAssistantLine('Request was cleared.')}\n`);
      fs.renameSync(replacement, jsonlPath);
      svc.syncSessions([tracked], paths);

      expect(svc.getSessionAttention(tracked)).toEqual({
        needsUser: false,
        reason: '',
      });
      expect(svc.getTranscript(tracked)).toEqual([]);
    } finally {
      svc.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('SideChatService restart attention reconstruction', () => {
  it('atomically rebuilds transcript, attention, and search state after projection replacement', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aside-projection-reset-'));
    const jsonlPath = path.join(root, 'projection.jsonl');
    const tracked = session('projection', {
      source: 'opencode',
      jsonlPath,
      status: 'active',
    });
    const record = (fields: Record<string, unknown>): string => JSON.stringify({
      schema: 'aside.opencode.v1',
      id: String(fields['sourceId'] ?? fields['type'] ?? 'record'),
      sourceId: String(fields['sourceId'] ?? fields['type'] ?? 'record'),
      sessionId: 'projection',
      timestamp: NOW.toISOString(),
      ...fields,
    });
    const header = record({ type: 'session', sourceId: 'session', cwd: root });
    const waiting = record({
      type: 'tool',
      sourceId: 'question',
      tool: 'question',
      state: 'pending',
      input: { question: 'Approve the password request?' },
    });
    const oldText = record({
      type: 'text',
      sourceId: 'old-text',
      role: 'assistant',
      text: 'private text removed by the rewrite',
    });
    fs.writeFileSync(jsonlPath, `${[header, oldText, waiting].join('\n')}\n`);

    const attentionChanges: Array<{ needsUser: boolean; became: boolean }> = [];
    const seeded: boolean[] = [];
    const activities: Array<{ activity: string; seeded: boolean }> = [];
    const svc = new SideChatService(
      new FakeEngine(),
      {
        onAttention: (_id, attention, became) => {
          attentionChanges.push({ needsUser: attention.needsUser, became });
        },
        onEvent: (_id, _source, _event, isSeed) => seeded.push(isSeed),
        onActivity: (_id, activity, _source, isSeed) => {
          activities.push({ activity, seeded: isSeed });
        },
      },
      clock,
    );
    const internals = svc as unknown as {
      tailer: { readNewLines(sessionId: string, path: string): void };
      searchableTail(session: TrackedSession): string;
      searchCache: Map<string, unknown>;
    };

    try {
      svc.syncSessions([tracked], new Map([['projection', jsonlPath]]));
      expect(svc.getSessionAttention(tracked)).toMatchObject({ needsUser: true });
      expect(internals.searchableTail(tracked)).toContain('private text');
      expect(internals.searchCache.size).toBe(1);

      const replacementPath = path.join(root, 'replacement.jsonl');
      fs.writeFileSync(replacementPath, `${[header, waiting].join('\n')}\n`);
      fs.renameSync(replacementPath, jsonlPath);
      internals.tailer.readNewLines(
        sessionThreadId('opencode', 'projection'),
        jsonlPath,
      );
      expect(svc.getTranscript(tracked)).toContainEqual(
        expect.objectContaining({
          kind: 'needs_input',
          reason: 'Approve the password request?',
        }),
      );
      expect(svc.getTranscript(tracked)).not.toContainEqual(
        expect.objectContaining({ preview: 'private text removed by the rewrite' }),
      );
      expect(attentionChanges).toEqual([{ needsUser: true, became: true }]);
      expect(internals.searchCache.size).toBe(0);

      const surviving = record({
        type: 'text',
        sourceId: 'surviving-text',
        role: 'assistant',
        text: 'The replacement is now canonical.',
      });
      const clearedPath = path.join(root, 'cleared.jsonl');
      fs.writeFileSync(clearedPath, `${[header, surviving].join('\n')}\n`);
      fs.renameSync(clearedPath, jsonlPath);
      internals.tailer.readNewLines(
        sessionThreadId('opencode', 'projection'),
        jsonlPath,
      );

      expect(svc.getTranscript(tracked)).toEqual([
        expect.objectContaining({ kind: 'session_started' }),
        expect.objectContaining({
          kind: 'assistant_text',
          preview: 'The replacement is now canonical.',
        }),
      ]);
      expect(svc.getSessionAttention(tracked)).toEqual({
        needsUser: false,
        reason: '',
      });
      expect(attentionChanges).toEqual([
        { needsUser: true, became: true },
        { needsUser: false, became: false },
      ]);
      expect(seeded.every(Boolean)).toBe(true);
      expect(activities).toEqual([
        {
          activity: 'Needs you: Approve the password request?',
          seeded: true,
        },
        {
          activity: 'Needs you: Approve the password request?',
          seeded: true,
        },
        { activity: 'Responding...', seeded: true },
      ]);
    } finally {
      svc.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('restores needs-user state for a historical session without selecting or tailing it', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aside-attention-restart-'));
    const jsonlPath = path.join(root, 'waiting.jsonl');
    const changes: Array<{ needsUser: boolean; becameNeedsUser: boolean }> = [];
    fs.writeFileSync(
      jsonlPath,
      [
        claudeAssistantLine('Should I deploy this to production?'),
        JSON.stringify({
          type: 'system',
          subtype: 'turn_response',
          durationMs: 100,
          timestamp: NOW.toISOString(),
        }),
      ].join('\n') + '\n',
    );

    try {
      const svc = new SideChatService(
        new FakeEngine(),
        {
          onAttention: (_id, attention, becameNeedsUser) => {
            changes.push({ needsUser: attention.needsUser, becameNeedsUser });
          },
        },
        clock,
      );
      svc.syncSessions(
        [session('waiting', {
          status: 'history',
          jsonlPath,
          lastEventTime: new Date(NOW.getTime() - 6 * 24 * 60 * 60_000),
        })],
        new Map([['waiting', jsonlPath]]),
      );

      expect(svc.getSessionAttention('waiting')).toEqual({
        needsUser: true,
        reason: 'Should I deploy this to production?',
      });
      expect(changes).toEqual([{ needsUser: true, becameNeedsUser: true }]);
      expect(svc.getTranscript('waiting')).toEqual([]);
      expect(
        (svc as unknown as { tailer: { tailedSessionIds: string[] } })
          .tailer.tailedSessionIds,
      ).toEqual([]);
      svc.dispose();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('suppresses heuristic questions from stale historical sessions', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aside-attention-stale-'));
    const jsonlPath = path.join(root, 'stale-question.jsonl');
    fs.writeFileSync(
      jsonlPath,
      `${claudeAssistantLine('Should I deploy this old branch?')}\n`,
    );

    try {
      const svc = new SideChatService(new FakeEngine(), {}, clock);
      svc.syncSessions(
        [session('stale-question', {
          status: 'history',
          jsonlPath,
          lastEventTime: new Date(NOW.getTime() - 8 * 24 * 60 * 60_000),
        })],
        new Map([['stale-question', jsonlPath]]),
      );

      expect(svc.getSessionAttention('stale-question')).toEqual({
        needsUser: false,
        reason: '',
      });
      svc.dispose();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('restores an explicit input request regardless of historical age', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aside-attention-explicit-'));
    const jsonlPath = path.join(root, 'explicit-wait.jsonl');
    fs.writeFileSync(
      jsonlPath,
      `${claudeInputRequestLine('Approve the production deployment?')}\n`,
    );

    try {
      const svc = new SideChatService(new FakeEngine(), {}, clock);
      svc.syncSessions(
        [session('explicit-wait', {
          status: 'history',
          jsonlPath,
          lastEventTime: new Date(NOW.getTime() - 365 * 24 * 60 * 60_000),
        })],
        new Map([['explicit-wait', jsonlPath]]),
      );

      expect(svc.getSessionAttention('explicit-wait')).toEqual({
        needsUser: true,
        reason: 'Approve the production deployment?',
      });
      svc.dispose();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('replays the tail in order so later user activity clears an older request', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aside-attention-clear-'));
    const jsonlPath = path.join(root, 'answered.jsonl');
    fs.writeFileSync(
      jsonlPath,
      [
        claudeAssistantLine('Which environment should I deploy to?'),
        claudeUserLine('Use staging.'),
      ].join('\n') + '\n',
    );

    try {
      const svc = new SideChatService(new FakeEngine(), {}, clock);
      svc.syncSessions(
        [session('answered', { status: 'history', jsonlPath })],
        new Map([['answered', jsonlPath]]),
      );

      expect(svc.getSessionAttention('answered')).toEqual({
        needsUser: false,
        reason: '',
      });
      svc.dispose();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('drains the historical catalog promptly in bounded event-loop chunks', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aside-attention-bounded-'));
    const count = MAX_ATTENTION_SEEDS_PER_SYNC * 2 + 3;
    const sessions: TrackedSession[] = [];
    const paths = new Map<string, string>();
    for (let index = 0; index < count; index += 1) {
      const id = `history-${index}`;
      const jsonlPath = path.join(root, `${id}.jsonl`);
      fs.writeFileSync(
        jsonlPath,
        `${claudeInputRequestLine(`Approve item ${index}?`)}\n`,
      );
      sessions.push(session(id, {
        status: 'history',
        jsonlPath,
        lastEventTime: new Date(NOW.getTime() - (index + 1) * 24 * 60 * 60_000),
      }));
      paths.set(id, jsonlPath);
    }

    try {
      const svc = new SideChatService(new FakeEngine(), {}, clock);
      svc.syncSessions(sessions, paths);
      expect(
        sessions.filter((item) => svc.getSessionAttention(item.id).needsUser),
      ).toHaveLength(MAX_ATTENTION_SEEDS_PER_SYNC);
      expect(svc.getSessionAttention(`history-${count - 1}`).needsUser).toBe(false);

      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(
        sessions.filter((item) => svc.getSessionAttention(item.id).needsUser),
      ).toHaveLength(MAX_ATTENTION_SEEDS_PER_SYNC * 2);
      expect(svc.getSessionAttention(`history-${count - 1}`).needsUser).toBe(false);

      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(
        sessions.filter((item) => svc.getSessionAttention(item.id).needsUser),
      ).toHaveLength(count);
      expect(sessions.every((item) => svc.getTranscript(item.id).length === 0)).toBe(true);
      expect(
        (svc as unknown as { tailer: { tailedSessionIds: string[] } })
          .tailer.tailedSessionIds,
      ).toEqual([]);
      svc.dispose();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('retries a missing historical transcript on a later scanner sync', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aside-attention-retry-'));
    const jsonlPath = path.join(root, 'appears-later.jsonl');
    const oldSession = session('appears-later', {
      status: 'history',
      jsonlPath,
      lastEventTime: new Date(NOW.getTime() - 30 * 24 * 60 * 60_000),
    });

    try {
      const svc = new SideChatService(new FakeEngine(), {}, clock);
      const paths = new Map([['appears-later', jsonlPath]]);
      svc.syncSessions([oldSession], paths);
      expect(svc.getSessionAttention('appears-later').needsUser).toBe(false);

      fs.writeFileSync(
        jsonlPath,
        `${claudeInputRequestLine('Choose a release channel?')}\n`,
      );
      svc.syncSessions([oldSession], paths);
      expect(svc.getSessionAttention('appears-later')).toEqual({
        needsUser: true,
        reason: 'Choose a release channel?',
      });
      svc.dispose();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('SideChatService focus', () => {
  it('round-trips the focused session', () => {
    const svc = new SideChatService(new FakeEngine(), {}, clock);
    expect(svc.getFocus()).toBeNull();
    svc.setFocus('a');
    expect(svc.getFocus()).toBe('a');
    svc.setFocus(null);
    expect(svc.getFocus()).toBeNull();
  });

  it('persists thread history and per-thread model selection', async () => {
    class MemoryStore implements ThreadStore {
      threads: ChatThread[] = [];
      load() {
        return this.threads;
      }
      save(threads: ChatThread[]) {
        this.threads = structuredClone(threads);
      }
    }
    const store = new MemoryStore();
    const first = new SideChatService(new FakeEngine(), {}, clock, {
      provider: 'claude-cli',
      model: 'haiku',
      store,
    });
    first.setFocus('a');
    first.setModel('ollama', 'llama3.2');
    await first.ask('remember this');

    const restored = new SideChatService(new FakeEngine(), {}, clock, {
      provider: 'claude-cli',
      model: 'haiku',
      store,
    });
    restored.setFocus('a');
    expect(restored.getChat().map((turn) => turn.content)).toEqual(['remember this', 'ok']);
    expect(restored.getActiveThread().provider).toBe('ollama');
    expect(restored.getActiveThread().model).toBe('llama3.2');
  });

  it('migrates a legacy side chat only when one source owns its session id', () => {
    class MemoryStore implements ThreadStore {
      threads: ChatThread[] = [{
        id: 'session:legacy',
        scope: { kind: 'session', source: null, sessionId: 'legacy' },
        provider: 'ollama',
        model: 'llama3.2',
        turns: [{
          id: 'legacy-turn',
          role: 'user',
          content: 'keep this history',
          timestamp: NOW,
        }],
        thinking: false,
        updatedAt: NOW,
      }];
      migrations = new Map<string, string>();
      load() { return structuredClone(this.threads); }
      save(threads: ChatThread[], options?: ThreadStoreSaveOptions) {
        this.threads = structuredClone(threads);
        this.migrations = new Map(options?.migrations);
      }
    }
    const store = new MemoryStore();
    const svc = new SideChatService(new FakeEngine(), {}, clock, { store });
    svc.syncSessions([session('legacy', { source: 'opencode' })], new Map());

    const canonical = sessionThreadId('opencode', 'legacy');
    expect(svc.getThreads().map((thread) => thread.id)).toEqual([
      'fleet',
      canonical,
    ]);
    expect(svc.getThread(canonical).turns[0]?.content).toBe('keep this history');
    expect(store.migrations).toEqual(new Map([['session:legacy', canonical]]));
  });

  it('leaves an ambiguous legacy side chat unassigned', () => {
    const legacy: ChatThread = {
      id: 'session:same',
      scope: { kind: 'session', source: null, sessionId: 'same' },
      provider: 'ollama',
      model: 'llama3.2',
      turns: [],
      thinking: false,
      updatedAt: NOW,
    };
    const store: ThreadStore = {
      load: () => [legacy],
      save: () => {},
    };
    const svc = new SideChatService(new FakeEngine(), {}, clock, { store });
    svc.syncSessions([
      session('same', { source: 'codex' }),
      session('same', { source: 'opencode' }),
    ], new Map());

    expect(svc.getThreads().map((thread) => thread.id)).toEqual([
      'session:same',
      'fleet',
    ]);
    svc.selectThread('session:same');
    expect(svc.getActiveThreadId()).toBe('fleet');
  });
});
