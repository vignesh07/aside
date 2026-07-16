import { describe, it, expect } from 'vitest';
import { MenubarBackend } from '../menubar/src/backend.js';
import { SideChatService } from '../dist/core/side-chat-service.js';
import type { AskParams } from '../dist/core/side-chat-engine.js';
import type { TrackedSession } from '../dist/types/session.js';

function fakeSession(id: string, status: TrackedSession['status'] = 'active'): TrackedSession {
  return {
    id,
    source: 'claude',
    projectName: `proj-${id}`,
    projectDir: '',
    jsonlPath: `/tmp/${id}.jsonl`,
    cwd: '',
    gitBranch: '',
    slug: '',
    model: '',
    version: '',
    usedPercent: 0,
    contextStatus: 'safe',
    status,
    lastEventTime: new Date(0),
    eventCount: 0,
    currentActivity: '',
  };
}

function makeBackend(sessions: TrackedSession[]) {
  const service = new SideChatService({
    ask: async (_p: AskParams) => 'answer',
    setModel: () => {},
  });
  const states: number[] = [];
  const backend = new MenubarBackend(
    { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
    () => states.push(1),
    { scan: () => ({ sessions, jsonlPaths: new Map() }), service },
  );
  return { backend, service };
}

describe('MenubarBackend', () => {
  it('focuses the first session on refresh', () => {
    const { backend } = makeBackend([fakeSession('a'), fakeSession('b')]);
    backend.refresh();
    expect(backend.getState().focusId).toBe('a');
    expect(backend.getState().sessions.map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('keeps an existing valid focus across refreshes', () => {
    const { backend } = makeBackend([fakeSession('a'), fakeSession('b')]);
    backend.refresh();
    backend.selectSession('b');
    backend.refresh();
    expect(backend.getState().focusId).toBe('b');
  });

  it('re-focuses when the focused session disappears', () => {
    const sessions = [fakeSession('a'), fakeSession('b')];
    const { backend } = makeBackend(sessions);
    backend.refresh();
    backend.selectSession('b');
    sessions.pop(); // 'b' vanishes
    backend.refresh();
    expect(backend.getState().focusId).toBe('a');
  });

  it('propagates focus to the service so the prompt deepens that transcript', () => {
    const { backend, service } = makeBackend([fakeSession('a'), fakeSession('b')]);
    backend.refresh();
    backend.selectSession('b');
    expect(service.getFocus()).toBe('b');
  });

  it('answers with no sessions at all — "nothing is running" is a valid answer', async () => {
    const { backend } = makeBackend([]);
    backend.refresh();
    expect(backend.getState().focusId).toBeNull();
    await backend.ask('what is running?');
    expect(backend.getState().messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('routes ask() to the shared bird\'s-eye chat', async () => {
    const { backend } = makeBackend([fakeSession('a')]);
    backend.refresh();
    await backend.ask('what is happening?');
    const msgs = backend.getState().messages;
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(msgs[1]!.content).toBe('answer');
  });

  it('reports idle time per session for the roster', () => {
    const { backend } = makeBackend([fakeSession('a')]);
    backend.refresh();
    // lastEventTime is the epoch, so idleness is the wall clock — just assert it
    // is populated and non-negative rather than pinning a moving number.
    expect(backend.getState().sessions[0]!.idleForMs).toBeGreaterThan(0);
  });
});
