import { describe, it, expect, vi } from 'vitest';
import {
  MenubarBackend,
  type MenubarSessionTarget,
} from '../menubar/src/backend.js';
import { SideChatService } from '../dist/core/side-chat-service.js';
import {
  ActivityLedger,
  InMemoryActivityLedgerStore,
} from '../dist/core/activity-ledger.js';
import type { AskParams } from '../dist/core/side-chat-engine.js';
import type { TrackedSession } from '../dist/types/session.js';
import type {
  ActivityEventRecord,
  ActivityLedgerState,
} from '../dist/types/activity.js';
import type {
  GeneratedArtifact,
  GeneratedDailyRecapArtifact,
  GeneratedThreadReviewArtifact,
} from '../dist/types/generated-artifact.js';
import type {
  GeneratedArtifactStore,
} from '../dist/core/generated-artifact-store.js';
import type {
  GenerateDailyRecapRequest,
  GenerateThreadReviewRequest,
  ObserverAnalysisEngineLike,
} from '../dist/core/observer-analysis-engine.js';
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

const ANALYSIS_NOW = new Date('2026-07-26T18:00:00.000Z');

interface BackendTestDeps {
  activity?: ActivityLedger;
  artifacts?: GeneratedArtifactStore;
  analysis?: ObserverAnalysisEngineLike;
  now?: () => Date;
  timeZone?: string;
}

function makeBackend(
  sessions: TrackedSession[],
  search?: ThreadSearchService,
  deps: BackendTestDeps = {},
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
  const activity =
    deps.activity ??
    new ActivityLedger(
      new InMemoryActivityLedgerStore(),
      deps.now,
    );
  const backend = new MenubarBackend(
    { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
    () => states.push(1),
    {
      scan: () => ({ sessions, jsonlPaths: new Map() }),
      service,
      models: () => FAKE_MODELS,
      search,
      activity,
      artifacts: deps.artifacts ?? new MemoryArtifactStore(),
      analysis: deps.analysis ?? analysisEngine().engine,
      now: deps.now,
      timeZone: deps.timeZone,
    },
  );
  return { backend, service, activity, setModelCalls, askCalls };
}

function activityEvent(
  seq: number,
  overrides: Partial<ActivityEventRecord> = {},
): ActivityEventRecord {
  const occurredAtMs = ANALYSIS_NOW.getTime() - (10 - seq) * 1_000;
  return {
    seq,
    eventId: `event-${seq}`,
    threadKey: 'codex:root',
    source: 'codex',
    sessionId: 'root',
    projectName: 'aside',
    projectPath: '/Users/vignesh/aside',
    title: 'Ship the observer',
    occurredAtMs,
    observedAtMs: occurredAtMs,
    kind: 'progress',
    lifecycle: 'progress',
    severity: 'info',
    summary: `Observed event ${seq}`,
    evidenceHash: String(seq).padStart(64, '0'),
    seeded: false,
    ...overrides,
  };
}

function activityLedger(
  events: ActivityEventRecord[],
  now: () => Date = () => ANALYSIS_NOW,
): ActivityLedger {
  const state: ActivityLedgerState = { events, cursors: [] };
  return new ActivityLedger(new InMemoryActivityLedgerStore(state), now);
}

class MemoryArtifactStore implements GeneratedArtifactStore {
  artifacts: GeneratedArtifact[];
  readonly saves: GeneratedArtifact[][] = [];

  constructor(initial: GeneratedArtifact[] = []) {
    this.artifacts = initial.map(cloneArtifact);
  }

  load(): GeneratedArtifact[] {
    return this.artifacts.map(cloneArtifact);
  }

  save(artifacts: GeneratedArtifact[]): void {
    this.artifacts = artifacts.map(cloneArtifact);
    this.saves.push(this.artifacts.map(cloneArtifact));
  }
}

function cloneArtifact(artifact: GeneratedArtifact): GeneratedArtifact {
  return { ...artifact, evidenceIds: [...artifact.evidenceIds] };
}

function analysisEngine(options: {
  onDaily?: (request: GenerateDailyRecapRequest) => Promise<GeneratedDailyRecapArtifact>;
  onThread?: (request: GenerateThreadReviewRequest) => Promise<GeneratedThreadReviewArtifact>;
} = {}) {
  const generateDailyRecap = vi.fn(
    options.onDaily ??
      (async (request: GenerateDailyRecapRequest) =>
        dailyArtifact(request)),
  );
  const generateThreadReview = vi.fn(
    options.onThread ??
      (async (request: GenerateThreadReviewRequest) =>
        threadArtifact(request)),
  );
  const engine: ObserverAnalysisEngineLike = {
    generateDailyRecap,
    generateThreadReview,
  };
  return { engine, generateDailyRecap, generateThreadReview };
}

function dailyArtifact(
  request: GenerateDailyRecapRequest,
): GeneratedDailyRecapArtifact {
  return {
    id: `daily-${request.day}-${request.evidence.inputHash.slice(0, 8)}`,
    kind: 'daily_recap',
    day: request.day,
    createdAt: ANALYSIS_NOW.toISOString(),
    provider: request.provider,
    model: request.model,
    inputHighWaterSeq: request.evidence.highWaterSeq,
    inputHash: request.evidence.inputHash,
    evidenceIds: request.evidence.evidenceIds.slice(0, 1),
    markdown: 'A factual recap [1]',
  };
}

function threadArtifact(
  request: GenerateThreadReviewRequest,
): GeneratedThreadReviewArtifact {
  return {
    id: `thread-${request.evidence.inputHash.slice(0, 8)}`,
    kind: 'thread_review',
    threadKey: request.threadKey,
    createdAt: ANALYSIS_NOW.toISOString(),
    provider: request.provider,
    model: request.model,
    inputHighWaterSeq: request.evidence.highWaterSeq,
    inputHash: request.evidence.inputHash,
    evidenceIds: request.evidence.evidenceIds.slice(0, 1),
    markdown: 'An evidence-backed review [1]',
  };
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
    const completedAt = Date.now() + 1_000;
    activity.recordAgentEvent({
      sessionId: session.id,
      source: session.source,
      event: {
        kind: 'assistant_text',
        preview: 'Implemented the attention-card context.',
        ts: new Date(completedAt - 10).toISOString(),
      },
      seeded: false,
      rawLine: JSON.stringify({ id: 'done-text', type: 'assistant_text' }),
      ordinal: 0,
    });
    activity.recordAgentEvent({
      sessionId: session.id,
      source: session.source,
      event: {
        kind: 'turn_complete',
        durationMs: 10,
        ts: new Date(completedAt).toISOString(),
      },
      seeded: false,
      rawLine: JSON.stringify({ id: 'done-1', type: 'task_complete' }),
      ordinal: 0,
    });

    expect(backend.getState()).toMatchObject({
      attentionCount: 1,
      unreadAttentionCount: 1,
      attentionCounts: { completed: 1 },
      sessions: [{
        attentionHeadline: 'Last turn ended',
        attentionContext: 'Implemented the attention-card context.',
        attentionSince: completedAt,
      }],
    });
    backend.selectThread('session:done');
    expect(backend.getState().unreadAttentionCount).toBe(1);
    const cursorRevision = backend.getState().activityCursorRevision;

    backend.markThreadViewed('session:done');
    expect(backend.getState()).toMatchObject({
      attentionCount: 1,
      unreadAttentionCount: 0,
      sessions: [{
        needsAttention: true,
        attentionKind: 'completed',
        attentionUnread: false,
      }],
    });

    backend.resolveThreadAttention('session:done');
    expect(backend.getState()).toMatchObject({
      attentionCount: 0,
      unreadAttentionCount: 0,
    });
    expect(backend.getState().activityCursorRevision).not.toBe(cursorRevision);
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

  it('builds Today deterministically without starting provider inference', () => {
    const root = fakeSession('root');
    root.source = 'codex';
    const events = [
      activityEvent(1, {
        kind: 'work_started',
        lifecycle: 'progress',
        summary: 'Started implementation',
      }),
      activityEvent(2, {
        kind: 'input_requested',
        lifecycle: 'blocked',
        severity: 'attention',
        summary: 'Choose a release channel',
      }),
    ];
    const activity = activityLedger(events);
    const analysis = analysisEngine();
    const { backend } = makeBackend([root], undefined, {
      activity,
      analysis: analysis.engine,
      now: () => ANALYSIS_NOW,
      timeZone: 'UTC',
    });
    backend.refresh();

    const today = backend.getToday();

    expect(today).toMatchObject({
      provider: 'claude-cli',
      diary: {
        range: { dateKey: '2026-07-26', timeZone: 'UTC' },
        projectCount: 1,
        threadCount: 1,
        memberThreadCount: 1,
        counts: { eventCount: 2, waitingCount: 1 },
      },
      artifact: null,
      artifactEvidence: [],
      artifactEvidenceMissingCount: 0,
      narrativeEventCount: 1,
      newEventCount: 1,
      artifactIsStale: false,
    });
    expect(today.insights.map((insight) => insight.kind)).toEqual(['waiting']);
    expect(backend.getState().activityHighWaterSeq).toBe(2);
    expect(backend.getTodayAnalysisTarget()).toMatchObject({
      threadId: 'fleet',
      provider: today.provider,
      model: today.model,
    });
    expect(analysis.generateDailyRecap).not.toHaveBeenCalled();
    expect(analysis.generateThreadReview).not.toHaveBeenCalled();
  });

  it('generates Today only when asked, strips local paths, and detects later activity', async () => {
    const root = fakeSession('root');
    root.source = 'codex';
    const activity = activityLedger([
      activityEvent(1, {
        originKind: 'assistant_text',
        projectName: '/opt/private-repo',
        title: 'Edit /workspace/aside/src/main.ts',
        summary:
          'Wrote /Users/vignesh/My Project [Final], #1; Draft & QA/SecretRepo/main.ts and ' +
          'file:///Users/vignesh/My Project/private.ts after using ' +
          '"/Volumes/External Disk/Secret Repo/release.dmg" with ' +
          'C:\\Users\\vignesh\\My Project\\secret.txt; see https://example.com/My%20Project/docs',
      }),
    ]);
    const artifacts = new MemoryArtifactStore();
    const analysis = analysisEngine();
    const { backend } = makeBackend([root], undefined, {
      activity,
      artifacts,
      analysis: analysis.engine,
      now: () => ANALYSIS_NOW,
      timeZone: 'UTC',
    });
    backend.refresh();

    expect(analysis.generateDailyRecap).not.toHaveBeenCalled();
    const target = backend.getTodayAnalysisTarget();
    const generated = await backend.generateTodayRecap(target);

    expect(analysis.generateDailyRecap).toHaveBeenCalledTimes(1);
    const request = analysis.generateDailyRecap.mock.calls[0]![0];
    expect(request.evidence.text).toContain('[LOCAL_PATH]');
    expect(request.evidence.text).not.toContain('/Users/vignesh');
    expect(request.evidence.text).not.toContain('/opt/private-repo');
    expect(request.evidence.text).not.toContain('/workspace/aside');
    expect(request.evidence.text).not.toContain('file:///Users/vignesh');
    expect(request.evidence.text).not.toContain('SecretRepo');
    expect(request.evidence.text).not.toContain('[Final]');
    expect(request.evidence.text).not.toContain('#1');
    expect(request.evidence.text).not.toContain('; Draft');
    expect(request.evidence.text).not.toContain('& QA');
    expect(request.evidence.text).not.toContain('External Disk');
    expect(request.evidence.text).not.toContain('C:\\Users\\vignesh');
    expect(request.evidence.text).toContain(
      'https://example.com/My%20Project/docs',
    );
    expect(generated).toMatchObject({
      artifact: { kind: 'daily_recap', day: '2026-07-26' },
      artifactEvidence: [{ eventId: 'event-1' }],
      artifactEvidenceMissingCount: 0,
      newEventCount: 0,
      artifactIsStale: false,
    });
    expect(artifacts.saves).toHaveLength(1);

    activity.recordAgentEvent({
      sessionId: root.id,
      source: root.source,
      event: {
        kind: 'assistant_text',
        preview: 'Additional observed progress',
        ts: '2026-07-26T18:01:00.000Z',
      },
      seeded: false,
      rawLine: JSON.stringify({ id: 'later-progress' }),
      ordinal: 0,
    });

    expect(backend.getToday()).toMatchObject({
      newEventCount: 1,
      artifactIsStale: true,
    });
  });

  it('keeps tool mechanics out of recap evidence and reuses the same narrative input', async () => {
    const root = fakeSession('root');
    root.source = 'codex';
    const activity = activityLedger([
      activityEvent(1, {
        kind: 'prompt',
        originKind: 'user_prompt',
        lifecycle: 'start',
        summary: 'Make Today a useful automatic recap.',
      }),
      activityEvent(2, {
        kind: 'work_started',
        originKind: 'tool_call',
        summary: 'exec_command: npm test',
      }),
      activityEvent(3, {
        originKind: 'tool_result_ok',
        summary: 'exec_command completed',
      }),
      activityEvent(4, {
        originKind: 'assistant_text',
        summary: 'The recap now focuses on decisions and outcomes.',
      }),
    ]);
    const artifacts = new MemoryArtifactStore();
    const analysis = analysisEngine();
    const { backend } = makeBackend([root], undefined, {
      activity,
      artifacts,
      analysis: analysis.engine,
      now: () => ANALYSIS_NOW,
      timeZone: 'UTC',
    });
    backend.refresh();
    const target = backend.getTodayAnalysisTarget();

    await backend.generateTodayRecap(target);

    expect(analysis.generateDailyRecap).toHaveBeenCalledTimes(1);
    const request = analysis.generateDailyRecap.mock.calls[0]![0];
    expect(request.evidence.evidenceIds).toEqual(['event-1', 'event-4']);
    expect(request.evidence.text).not.toContain('exec_command');
    expect(backend.getToday()).toMatchObject({
      newEventCount: 0,
      artifactIsStale: false,
    });

    await backend.generateTodayRecap(target);

    expect(analysis.generateDailyRecap).toHaveBeenCalledTimes(1);
    expect(artifacts.saves).toHaveLength(1);

    activity.recordAgentEvent({
      sessionId: root.id,
      source: root.source,
      event: {
        kind: 'tool_call',
        tool: 'exec_command',
        target: 'npm run check',
        ts: '2026-07-26T18:01:00.000Z',
      },
      seeded: false,
      rawLine: JSON.stringify({ id: 'later-tool-call' }),
      ordinal: 0,
    });

    expect(backend.getToday()).toMatchObject({
      newEventCount: 0,
      artifactIsStale: false,
    });
    await backend.generateTodayRecap(target);
    expect(analysis.generateDailyRecap).toHaveBeenCalledTimes(1);
  });

  it('marks a same-watermark artifact stale when its narrative input changed', async () => {
    const root = fakeSession('root');
    root.source = 'codex';
    const record = activityEvent(1, {
      originKind: 'assistant_text',
      summary: 'The release recap now reflects the finished Today design.',
    });
    const staleArtifact: GeneratedDailyRecapArtifact = {
      id: 'old-daily-input',
      kind: 'daily_recap',
      day: '2026-07-26',
      createdAt: '2026-07-26T17:00:00.000Z',
      provider: 'codex-cli',
      model: 'gpt-5.6-sol',
      inputHighWaterSeq: 1,
      inputHash: 'f'.repeat(64),
      evidenceIds: [record.eventId],
      markdown: 'An older recap [1]',
    };
    const analysis = analysisEngine();
    const { backend } = makeBackend([root], undefined, {
      activity: activityLedger([record]),
      artifacts: new MemoryArtifactStore([staleArtifact]),
      analysis: analysis.engine,
      now: () => ANALYSIS_NOW,
      timeZone: 'UTC',
    });
    backend.refresh();

    expect(backend.getToday()).toMatchObject({
      newEventCount: 0,
      artifactIsStale: true,
    });

    await backend.generateTodayRecap(backend.getTodayAnalysisTarget());
    expect(analysis.generateDailyRecap).toHaveBeenCalledTimes(1);
    expect(backend.getToday()).toMatchObject({ artifactIsStale: false });
  });

  it('does not call a provider when Today contains only tool mechanics', async () => {
    const root = fakeSession('root');
    root.source = 'codex';
    const artifacts = new MemoryArtifactStore();
    const analysis = analysisEngine();
    const { backend } = makeBackend([root], undefined, {
      activity: activityLedger([
        activityEvent(1, {
          kind: 'work_started',
          originKind: 'tool_call',
          summary: 'exec_command: npm test',
        }),
        activityEvent(2, {
          originKind: 'tool_result_ok',
          summary: 'exec_command completed',
        }),
      ]),
      artifacts,
      analysis: analysis.engine,
      now: () => ANALYSIS_NOW,
      timeZone: 'UTC',
    });
    backend.refresh();

    const result = await backend.generateTodayRecap(
      backend.getTodayAnalysisTarget(),
    );

    expect(result.artifact).toBeNull();
    expect(result.narrativeEventCount).toBe(0);
    expect(result.newEventCount).toBe(0);
    expect(analysis.generateDailyRecap).not.toHaveBeenCalled();
    expect(artifacts.saves).toHaveLength(0);
  });

  it('coalesces duplicate Today generation clicks into one provider call', async () => {
    const root = fakeSession('root');
    root.source = 'codex';
    const activity = activityLedger([activityEvent(1)]);
    const artifacts = new MemoryArtifactStore();
    let finish!: (artifact: GeneratedDailyRecapArtifact) => void;
    let captured!: GenerateDailyRecapRequest;
    const analysis = analysisEngine({
      onDaily: (request) => {
        captured = request;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    });
    const { backend } = makeBackend([root], undefined, {
      activity,
      artifacts,
      analysis: analysis.engine,
      now: () => ANALYSIS_NOW,
      timeZone: 'UTC',
    });
    backend.refresh();
    const target = backend.getTodayAnalysisTarget();

    const first = backend.generateTodayRecap(target);
    const second = backend.generateTodayRecap(target);

    expect(second).toBe(first);
    expect(analysis.generateDailyRecap).toHaveBeenCalledTimes(1);
    finish(dailyArtifact(captured));
    await expect(first).resolves.toMatchObject({
      artifact: { kind: 'daily_recap' },
    });
    await second;
    expect(artifacts.saves).toHaveLength(1);
  });

  it('rejects a stale analysis authorization target before inference', () => {
    const root = fakeSession('root');
    root.source = 'codex';
    const analysis = analysisEngine();
    const { backend } = makeBackend([root], undefined, {
      activity: activityLedger([activityEvent(1)]),
      analysis: analysis.engine,
      now: () => ANALYSIS_NOW,
      timeZone: 'UTC',
    });
    backend.refresh();
    const target = backend.getTodayAnalysisTarget();
    backend.setModel('openai', 'gpt-4o-mini', target);

    expect(() => backend.generateTodayRecap(target)).toThrow(
      'thread changed',
    );
    expect(analysis.generateDailyRecap).not.toHaveBeenCalled();
  });

  it('rolls descendants into root reviews but keeps subagent reviews exact', () => {
    const root = fakeSession('root');
    root.source = 'codex';
    const child = fakeSession('child');
    child.source = 'codex';
    child.isInternal = true;
    child.parentSessionId = 'root';
    const grandchild = fakeSession('grandchild');
    grandchild.source = 'codex';
    grandchild.isInternal = true;
    grandchild.parentSessionId = 'child';
    const events = [
      activityEvent(1),
      activityEvent(2, {
        eventId: 'child-event',
        threadKey: 'codex:child',
        sessionId: 'child',
        parentThreadKey: 'codex:root',
        rootThreadKey: 'codex:root',
        title: 'Search worker',
        kind: 'tool_warning',
        severity: 'warning',
        summary: 'A child warning',
      }),
      activityEvent(3, {
        eventId: 'grandchild-event',
        threadKey: 'codex:grandchild',
        sessionId: 'grandchild',
        parentThreadKey: 'codex:child',
        rootThreadKey: 'codex:root',
        title: 'Nested worker',
        kind: 'turn_completed',
        lifecycle: 'terminal',
        summary: 'Latest turn ended',
      }),
    ];
    const analysis = analysisEngine();
    const { backend } = makeBackend(
      [root, child, grandchild],
      undefined,
      {
        activity: activityLedger(events),
        analysis: analysis.engine,
        now: () => ANALYSIS_NOW,
        timeZone: 'UTC',
      },
    );
    backend.refresh();
    const rootSelection: MenubarSessionTarget = {
      threadId: 'session:root',
      source: 'codex',
    };
    const childSelection: MenubarSessionTarget = {
      threadId: 'session:child',
      source: 'codex',
    };

    const rootReview = backend.getThreadReview(rootSelection);
    const childReview = backend.getThreadReview(childSelection);

    expect(rootReview).toMatchObject({
      threadKey: 'codex:root',
      rootThreadKey: 'codex:root',
      isInternal: false,
      includedThreadKeys: [
        'codex:root',
        'codex:child',
        'codex:grandchild',
      ],
      counts: { eventCount: 3, warningCount: 1, completionCount: 1 },
      newEventCount: 3,
    });
    expect(rootReview.evidence.map((event) => event.eventId)).toEqual([
      'event-1',
      'child-event',
      'grandchild-event',
    ]);
    expect(childReview).toMatchObject({
      threadKey: 'codex:child',
      rootThreadKey: 'codex:root',
      isInternal: true,
      includedThreadKeys: ['codex:child'],
      counts: { eventCount: 1, warningCount: 1 },
    });
    expect(childReview.evidence.map((event) => event.eventId)).toEqual([
      'child-event',
    ]);
    expect(backend.getThreadReviewAnalysisTarget(childSelection)).toMatchObject({
      threadId: 'session:child',
      provider: childReview.provider,
      model: childReview.model,
    });
    expect(analysis.generateThreadReview).not.toHaveBeenCalled();
  });

  it('generates a root review from only that root and its descendants', async () => {
    const root = fakeSession('root');
    root.source = 'codex';
    const child = fakeSession('child');
    child.source = 'codex';
    child.isInternal = true;
    child.parentSessionId = 'root';
    const unrelated = fakeSession('unrelated');
    unrelated.source = 'claude';
    const artifacts = new MemoryArtifactStore();
    const analysis = analysisEngine();
    const { backend } = makeBackend(
      [root, child, unrelated],
      undefined,
      {
        activity: activityLedger([
          activityEvent(1),
          activityEvent(2, {
            eventId: 'child-event',
            threadKey: 'codex:child',
            sessionId: 'child',
            parentThreadKey: 'codex:root',
            rootThreadKey: 'codex:root',
          }),
          activityEvent(3, {
            eventId: 'foreign-event',
            threadKey: 'claude:unrelated',
            sessionId: 'unrelated',
            source: 'claude',
          }),
        ]),
        artifacts,
        analysis: analysis.engine,
        now: () => ANALYSIS_NOW,
        timeZone: 'UTC',
      },
    );
    backend.refresh();
    const selection: MenubarSessionTarget = {
      threadId: 'session:root',
      source: 'codex',
    };

    const review = await backend.generateThreadReview(
      selection,
      backend.getThreadReviewAnalysisTarget(selection),
    );

    const request = analysis.generateThreadReview.mock.calls[0]![0];
    expect(request.threadKey).toBe('codex:root');
    expect(request.evidence.evidenceIds).toEqual([
      'event-1',
      'child-event',
    ]);
    expect(request.evidence.evidenceIds).not.toContain('foreign-event');
    expect(review).toMatchObject({
      artifact: {
        kind: 'thread_review',
        threadKey: 'codex:root',
      },
      newEventCount: 0,
      artifactIsStale: false,
    });
    expect(artifacts.saves).toHaveLength(1);
  });

  it('requires a source-qualified live session for thread reviews', () => {
    const codex = fakeSession('same-id');
    codex.source = 'codex';
    const claude = fakeSession('same-id');
    claude.source = 'claude';
    const { backend } = makeBackend([codex, claude], undefined, {
      activity: activityLedger([
        activityEvent(1, {
          threadKey: 'codex:same-id',
          sessionId: 'same-id',
          source: 'codex',
        }),
        activityEvent(2, {
          eventId: 'claude-event',
          threadKey: 'claude:same-id',
          sessionId: 'same-id',
          source: 'claude',
        }),
      ]),
      now: () => ANALYSIS_NOW,
      timeZone: 'UTC',
    });
    backend.refresh();

    expect(
      backend
        .getThreadReview({
          threadId: 'session:same-id',
          source: 'codex',
        })
        .evidence.map((event) => event.eventId),
    ).toEqual(['event-1']);
    expect(() =>
      backend.getThreadReview({
        threadId: 'fleet',
        source: 'codex',
      }),
    ).toThrow('valid agent thread');
    expect(() =>
      backend.getThreadReview({
        threadId: 'session:missing',
        source: 'codex',
      }),
    ).toThrow('no longer available');
  });

  it('resolves artifact citations only inside the requested review scope', () => {
    const root = fakeSession('root');
    root.source = 'codex';
    const other = fakeSession('other');
    other.source = 'claude';
    const artifacts = new MemoryArtifactStore([
      {
        id: 'stored-review',
        kind: 'thread_review',
        threadKey: 'codex:root',
        createdAt: '2026-07-26T17:00:00.000Z',
        provider: 'claude-cli',
        model: 'claude-sonnet-4-20250514',
        inputHighWaterSeq: 1,
        inputHash: 'a'.repeat(64),
        evidenceIds: ['event-1', 'foreign-event'],
        markdown: 'Stored review [1][2]',
      },
    ]);
    const { backend } = makeBackend([root, other], undefined, {
      activity: activityLedger([
        activityEvent(1),
        activityEvent(2, {
          eventId: 'foreign-event',
          threadKey: 'claude:other',
          sessionId: 'other',
          source: 'claude',
        }),
        activityEvent(3, { eventId: 'event-3' }),
      ]),
      artifacts,
      now: () => ANALYSIS_NOW,
      timeZone: 'UTC',
    });
    backend.refresh();

    expect(
      backend.getThreadReview({
        threadId: 'session:root',
        source: 'codex',
      }),
    ).toMatchObject({
      artifact: { id: 'stored-review' },
      artifactEvidence: [{ eventId: 'event-1' }],
      artifactEvidenceMissingCount: 1,
      newEventCount: 1,
      artifactIsStale: true,
    });
  });

  it('rejects an analysis artifact that escapes its requested thread scope', async () => {
    const root = fakeSession('root');
    root.source = 'codex';
    const artifacts = new MemoryArtifactStore();
    const analysis = analysisEngine({
      onThread: async (request) => ({
        ...threadArtifact(request),
        threadKey: 'codex:someone-else',
      }),
    });
    const { backend } = makeBackend([root], undefined, {
      activity: activityLedger([activityEvent(1)]),
      artifacts,
      analysis: analysis.engine,
      now: () => ANALYSIS_NOW,
      timeZone: 'UTC',
    });
    backend.refresh();
    const selection: MenubarSessionTarget = {
      threadId: 'session:root',
      source: 'codex',
    };

    await expect(
      backend.generateThreadReview(
        selection,
        backend.getThreadReviewAnalysisTarget(selection),
      ),
    ).rejects.toThrow('evidence scope');
    expect(artifacts.saves).toHaveLength(0);
  });
});
