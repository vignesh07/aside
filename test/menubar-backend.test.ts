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
  it('auto-selects the first session on refresh', () => {
    const { backend } = makeBackend([fakeSession('a'), fakeSession('b')]);
    backend.refresh();
    expect(backend.getState().selectedId).toBe('a');
    expect(backend.getState().sessions.map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('keeps an existing valid selection across refreshes', () => {
    const { backend } = makeBackend([fakeSession('a'), fakeSession('b')]);
    backend.refresh();
    backend.selectSession('b');
    backend.refresh();
    expect(backend.getState().selectedId).toBe('b');
  });

  it('re-selects when the chosen session disappears', () => {
    const sessions = [fakeSession('a'), fakeSession('b')];
    const { backend } = makeBackend(sessions);
    backend.refresh();
    backend.selectSession('b');
    sessions.pop(); // 'b' vanishes
    backend.refresh();
    expect(backend.getState().selectedId).toBe('a');
  });

  it('routes ask() to the selected session', async () => {
    const { backend } = makeBackend([fakeSession('a')]);
    backend.refresh();
    await backend.ask('what is happening?');
    const msgs = backend.getState().messages;
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(msgs[1]!.content).toBe('answer');
  });

  it('reports an empty selection when there are no sessions', () => {
    const { backend } = makeBackend([]);
    backend.refresh();
    expect(backend.getState().selectedId).toBeNull();
    expect(backend.getState().messages).toEqual([]);
  });
});
