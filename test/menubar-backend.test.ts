import { describe, it, expect } from 'vitest';
import { MenubarBackend } from '../menubar/src/backend.js';
import { SideChatService } from '../dist/core/side-chat-service.js';
import {
  ActivityLedger,
  InMemoryActivityLedgerStore,
} from '../dist/core/activity-ledger.js';
import type { AskParams } from '../dist/core/side-chat-engine.js';
import type { TrackedSession } from '../dist/types/session.js';
import type {
  IndexableThread,
  SearchIndexStatus,
  ThreadSearchResult,
  ThreadSearchService,
} from '../menubar/src/search-types.js';

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

const FAKE_MODELS = [
  { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', recommended: true },
  { provider: 'openai', model: 'gpt-4o-mini' },
];

function makeBackend(
  sessions: TrackedSession[],
  search?: ThreadSearchService,
) {
  const setModelCalls: Array<[string, string]> = [];
  const askCalls: AskParams[] = [];
  const service = new SideChatService({
    ask: async (params: AskParams) => {
      askCalls.push(params);
      return 'answer';
    },
    setModel: (p: string, m: string) => setModelCalls.push([p, m]),
  });
  const states: number[] = [];
  const activity = new ActivityLedger(new InMemoryActivityLedgerStore());
  const backend = new MenubarBackend(
    { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
    () => states.push(1),
    {
      scan: () => ({ sessions, jsonlPaths: new Map() }),
      service,
      models: () => FAKE_MODELS,
      search,
      activity,
    },
  );
  return { backend, service, activity, setModelCalls, askCalls };
}

describe('MenubarBackend', () => {
  it('opens on the fleet thread and exposes session thread ids', () => {
    const { backend } = makeBackend([fakeSession('a'), fakeSession('b')]);
    backend.refresh();
    expect(backend.getState().activeThreadId).toBe('fleet');
    expect(backend.getState().sessions.map((s) => s.id)).toEqual(['a', 'b']);
    expect(backend.getState().sessions.map((s) => s.threadId)).toEqual([
      'session:a',
      'session:b',
    ]);
  });

  it('keeps an existing valid session thread across refreshes', () => {
    const { backend } = makeBackend([fakeSession('a'), fakeSession('b')]);
    backend.refresh();
    backend.selectThread('session:b');
    backend.refresh();
    expect(backend.getState().activeThreadId).toBe('session:b');
  });

  it('returns to fleet when the selected session disappears', () => {
    const sessions = [fakeSession('a'), fakeSession('b')];
    const { backend } = makeBackend(sessions);
    backend.refresh();
    backend.selectThread('session:b');
    sessions.pop(); // 'b' vanishes
    backend.refresh();
    expect(backend.getState().activeThreadId).toBe('fleet');
  });

  it('propagates thread selection to the scoped service conversation', () => {
    const { backend, service } = makeBackend([fakeSession('a'), fakeSession('b')]);
    backend.refresh();
    backend.selectThread('session:b');
    expect(service.getFocus()).toBe('b');
  });

  it('answers with no sessions at all — "nothing is running" is a valid answer', async () => {
    const { backend } = makeBackend([]);
    backend.refresh();
    expect(backend.getState().activeThreadId).toBe('fleet');
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

  it('keeps an authorized ask bound to its originating thread', async () => {
    const { backend, askCalls } = makeBackend([fakeSession('a'), fakeSession('b')]);
    backend.refresh();
    backend.selectThread('session:a');
    const state = backend.getState();
    const target = {
      threadId: state.activeThreadId,
      provider: state.provider,
      model: state.model,
    };

    backend.selectThread('session:b');
    await backend.ask('still about a', target);

    expect(askCalls[0]?.threadId).toBe('session:a');
    expect(backend.getState().activeThreadId).toBe('session:b');
  });

  it('rejects a captured ask if that thread changed provider meanwhile', async () => {
    const { backend, askCalls } = makeBackend([fakeSession('a')]);
    backend.refresh();
    const state = backend.getState();
    const target = {
      threadId: state.activeThreadId,
      provider: state.provider,
      model: state.model,
    };
    backend.setModel('openai', 'gpt-4o-mini');

    await expect(backend.ask('stale authorization', target)).rejects.toThrow(
      'thread changed',
    );
    expect(askCalls).toHaveLength(0);
  });

  it('offers the model catalog so the menubar can switch provider', () => {
    const { backend } = makeBackend([fakeSession('a')]);
    backend.refresh();
    // Cross-provider is the product's whole position; a fixed-model menubar
    // can't deliver it.
    expect(backend.getState().models.map((m) => m.provider)).toEqual(['anthropic', 'openai']);
  });

  it('routes a model switch to the engine and reflects it in state', () => {
    const { backend, setModelCalls } = makeBackend([fakeSession('a')]);
    backend.refresh();
    backend.setModel('openai', 'gpt-4o-mini');
    expect(setModelCalls).toEqual([['openai', 'gpt-4o-mini']]);
    expect(backend.getState().provider).toBe('openai');
    expect(backend.getState().model).toBe('gpt-4o-mini');
  });

  it('retargets untouched threads when the connected-account default changes', () => {
    const { backend, service } = makeBackend([fakeSession('a'), fakeSession('b')]);
    backend.refresh();

    backend.setDefaultModel('openai', 'gpt-4o-mini');

    expect(service.getThread('fleet').provider).toBe('openai');
    expect(service.getThread('session:a').provider).toBe('openai');
    expect(service.getThread('session:b').provider).toBe('openai');
    expect(service.getThread('session:b').model).toBe('gpt-4o-mini');
  });

  it('keeps an existing conversation pinned when the default changes', async () => {
    const { backend, service } = makeBackend([fakeSession('a')]);
    backend.refresh();
    await backend.ask('keep this conversation');

    backend.setDefaultModel('openai', 'gpt-4o-mini');

    expect(service.getThread('fleet').provider).toBe('claude-cli');
    expect(service.getThread('fleet').turns).toHaveLength(2);
    expect(service.getThread('session:a').provider).toBe('openai');
  });

  it('applies an authorized model switch only to its originating thread', () => {
    const { backend, service } = makeBackend([fakeSession('a'), fakeSession('b')]);
    backend.refresh();
    backend.selectThread('session:a');
    const state = backend.getState();
    const target = {
      threadId: state.activeThreadId,
      provider: state.provider,
      model: state.model,
    };

    backend.selectThread('session:b');
    backend.setModel('openai', 'gpt-4o-mini', target);

    expect(service.getThread('session:a').provider).toBe('openai');
    expect(service.getThread('session:b').provider).toBe('claude-cli');
    expect(backend.getState().activeThreadId).toBe('session:b');
  });

  it('rejects a model outside the catalog', () => {
    const { backend, setModelCalls } = makeBackend([fakeSession('a')]);
    backend.refresh();
    backend.setModel('unknown', '--malicious');
    expect(setModelCalls).toEqual([]);
    expect(backend.getState().provider).toBe('claude-cli');
  });

  it('reports idle time per session for the roster', () => {
    const { backend } = makeBackend([fakeSession('a')]);
    backend.refresh();
    // lastEventTime is the epoch, so idleness is the wall clock — just assert it
    // is populated and non-negative rather than pinning a moving number.
    expect(backend.getState().sessions[0]!.idleForMs).toBeGreaterThan(0);
  });

  it('keeps a hidden selection unread until the visible UI marks it viewed', () => {
    const session = fakeSession('done');
    session.source = 'codex';
    session.lastEventTime = new Date(Date.now() - 1_000);
    const { backend, activity } = makeBackend([session]);
    backend.refresh();
    activity.recordAgentEvent({
      sessionId: session.id,
      source: session.source,
      event: {
        kind: 'turn_complete',
        durationMs: 10,
        ts: new Date(Date.now() + 1_000).toISOString(),
      },
      seeded: false,
      rawLine: JSON.stringify({ id: 'done-1', type: 'task_complete' }),
      ordinal: 0,
    });

    expect(backend.getState()).toMatchObject({
      attentionCount: 1,
      unreadAttentionCount: 1,
      attentionCounts: { completed: 1 },
    });
    backend.selectThread('session:done');
    expect(backend.getState().unreadAttentionCount).toBe(1);

    backend.markThreadViewed('session:done');
    expect(backend.getState()).toMatchObject({
      attentionCount: 0,
      unreadAttentionCount: 0,
    });
  });

  it('merges ranked transcript matches with current metadata and drops stale rows', async () => {
    const a = fakeSession('a');
    a.title = 'Needle migration';
    const b = fakeSession('b');
    const result: ThreadSearchResult = {
      sessionId: 'b',
      source: 'claude',
      kind: 'assistant',
      snippet: [{ text: 'needle', match: true }],
      score: -10,
    };
    const stale: ThreadSearchResult = {
      ...result,
      sessionId: 'missing',
    };
    const status: SearchIndexStatus = {
      phase: 'ready',
      indexedThreads: 2,
      totalThreads: 2,
      indexedBytes: 10,
      totalBytes: 10,
    };
    const search: ThreadSearchService = {
      syncSessions: () => {},
      syncSideChats: () => {},
      search: async () => [result, stale],
      rebuild: () => {},
      getStatus: () => status,
      onStatus: () => () => {},
      dispose: () => {},
    };
    const { backend } = makeBackend([a, b], search);
    backend.refresh();

    const matches = await backend.searchThreads('needle');

    expect(matches.map((match) => match.sessionId)).toEqual(['b', 'a']);
    expect(backend.getState().searchIndex).toBe(status);
  });

  it('keeps subagents directly searchable', async () => {
    const parent = fakeSession('parent');
    parent.source = 'codex';
    const child = fakeSession('child');
    child.source = 'codex';
    child.isInternal = true;
    child.parentSessionId = 'parent';
    const synced: IndexableThread[][] = [];
    const search: ThreadSearchService = {
      syncSessions: (sessions) => synced.push(sessions),
      syncSideChats: () => {},
      search: async () => [{
        sessionId: 'child',
        source: 'codex',
        kind: 'assistant',
        snippet: [{ text: 'hidden worker answer', match: true }],
        score: -12,
      }],
      rebuild: () => {},
      getStatus: () => ({
        phase: 'ready',
        indexedThreads: 2,
        totalThreads: 2,
        indexedBytes: 20,
        totalBytes: 20,
      }),
      onStatus: () => () => {},
      dispose: () => {},
    };
    const { backend } = makeBackend([parent, child], search);

    backend.refresh();
    const matches = await backend.searchThreads('hidden');

    expect(backend.getState().sessions.map((session) => session.id)).toEqual([
      'parent',
      'child',
    ]);
    expect(synced.at(-1)?.map((session) => session.sessionId)).toEqual([
      'parent',
      'child',
    ]);
    expect(matches).toEqual([{
      sessionId: 'child',
      source: 'codex',
      kind: 'assistant',
      snippet: [{ text: 'hidden worker answer', match: true }],
      score: -12,
    }]);
  });

  it('counts an attentive subagent in the inbox hierarchy', () => {
    const parent = fakeSession('parent');
    parent.source = 'codex';
    parent.lastEventTime = new Date(Date.now() - 2_000);
    const child = fakeSession('child');
    child.source = 'codex';
    child.isInternal = true;
    child.parentSessionId = 'parent';
    child.lastEventTime = new Date(Date.now() - 1_000);
    const { backend, activity } = makeBackend([parent, child]);
    backend.refresh();

    activity.recordAgentEvent({
      sessionId: child.id,
      source: child.source,
      event: {
        kind: 'needs_input',
        reason: 'Review the worker result',
        ts: new Date().toISOString(),
      },
      seeded: false,
      rawLine: JSON.stringify({ id: 'child-wait', type: 'needs_input' }),
      ordinal: 0,
    });

    expect(backend.getState()).toMatchObject({
      attentionCount: 1,
      unreadAttentionCount: 1,
      attentionCounts: { waiting: 1 },
    });
    expect(backend.getState().sessions.find((session) => session.id === 'child'))
      .toMatchObject({
        isInternal: true,
        needsAttention: true,
        attentionKind: 'waiting',
      });
  });
});
