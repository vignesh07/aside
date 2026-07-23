import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  MAX_FLEET_CONTEXT_SESSIONS,
  SideChatService,
  type AskEngine,
} from '../src/core/side-chat-service.js';
import type { AskParams } from '../src/core/side-chat-engine.js';
import type { TrackedSession } from '../src/types/session.js';
import type { ChatThread } from '../src/types/chat.js';
import type { ThreadStore } from '../src/core/thread-store.js';

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
});
