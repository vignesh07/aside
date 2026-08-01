import type {
  ActivityEventRecord,
  ActivityLedgerState,
} from '../../dist/types/activity.js';
import type { GeneratedDailyRecapArtifact } from '../../dist/types/generated-artifact.js';
import type { TrackedSession } from '../../dist/types/session.js';
import { curateNarrativeActivity } from '../../dist/core/activity-narrative.js';
import { packActivityEvidence } from '../../dist/core/activity-evidence-pack.js';
import { SideChatService } from '../../dist/core/side-chat-service.js';
import {
  ProviderAuthCoordinator,
  type ProviderAuthId,
} from './provider-auth.js';
import {
  buildUsageSnapshot,
  type UsageAggregateRow,
} from './usage-analytics.js';
import type { ThreadSearchService } from './search-types.js';

const TODAY_CAPTURE_NOW = '2026-07-31T19:00:00.000Z';
const TODAY_CAPTURE_DAY = '2026-07-31';
const TODAY_CAPTURE_TIME_ZONE = 'UTC';
export const TODAY_CAPTURE_PROVIDER = 'claude-cli';
export const TODAY_CAPTURE_MODEL = 'claude-haiku-4-5-20251001';

export interface GeneratedTodayCaptureFixture {
  now: string;
  timeZone: string;
  activity: ActivityLedgerState;
  artifacts: GeneratedDailyRecapArtifact[];
  sessions: TrackedSession[];
}

/** Provider/account state for captures, with no filesystem, CLI, or HTTP I/O. */
export function captureProviderAuthCoordinator(
  todayRecapsEnabled = true,
): ProviderAuthCoordinator {
  return new ProviderAuthCoordinator({
    consentStore: {
      load: () => ({
        enabled: new Set<ProviderAuthId>(['codex-cli', 'claude-cli']),
        todayRecaps: new Set<ProviderAuthId>(
          todayRecapsEnabled ? ['codex-cli', 'claude-cli'] : [],
        ),
      }),
      setEnabled: () => {},
      setTodayRecapsEnabled: () => {},
    },
    resolveBinary: (provider) =>
      provider === 'codex-cli' ? '/capture/bin/codex' : '/capture/bin/claude',
    runCommand: async (command) => ({
      exitCode: 0,
      stdout: command.executable.endsWith('/codex')
        ? 'Logged in using ChatGPT\n'
        : JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }),
      stderr: '',
      timedOut: false,
      spawnFailed: false,
    }),
    buildEnvironment: () => ({ PATH: '/capture/bin' }),
    fetch: async () =>
      new Response(JSON.stringify({ models: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ollamaHost: () => 'http://127.0.0.1:11434',
  });
}

/** Durable-chat state for captures, isolated from the user's real thread store. */
export function captureSideChatService(): SideChatService {
  return new SideChatService(
    {
      ask: async () => {
        throw new Error('Generated Today captures never call a provider.');
      },
      setModel: () => {},
    },
    {},
    () => new Date(TODAY_CAPTURE_NOW),
    {
      provider: TODAY_CAPTURE_PROVIDER,
      model: TODAY_CAPTURE_MODEL,
    },
  );
}

const USAGE_CAPTURE_ROWS: UsageAggregateRow[] = [
  usageRow('2026-04-18', 'openai', 'gpt-5.6-sol', 92_000, 168_000, 14_000, 4),
  usageRow('2026-05-03', 'anthropic', 'claude-opus-4-8', 74_000, 133_000, 19_000, 3),
  usageRow('2026-05-19', 'openai', 'gpt-5.6-terra', 118_000, 205_000, 23_000, 5),
  usageRow('2026-06-02', 'anthropic', 'claude-sonnet-5', 63_000, 187_000, 17_000, 4),
  usageRow('2026-06-14', 'google', 'gemini-3.1-pro-preview', 55_000, 91_000, 12_000, 3),
  usageRow('2026-06-28', 'openai', 'gpt-5.6-sol', 126_000, 284_000, 31_000, 6),
  usageRow('2026-07-08', 'anthropic', 'claude-opus-4-8', 84_000, 246_000, 21_000, 5),
  usageRow('2026-07-19', 'openai', 'gpt-5.6-terra', 142_000, 317_000, 28_000, 7),
  usageRow('2026-07-25', 'ollama', 'qwen3-coder:30b', 211_000, 52_000, 25_000, 4, true),
  usageRow('2026-07-28', 'anthropic', 'claude-sonnet-5', 97_000, 304_000, 33_000, 7),
  usageRow('2026-07-29', 'openai', 'gpt-5.6-sol', 169_000, 429_000, 46_000, 8),
  usageRow('2026-07-30', 'google', 'gemini-3.5-flash', 121_000, 198_000, 29_000, 6),
  usageRow('2026-07-31', 'openai', 'gpt-5.6-sol', 153_000, 386_000, 41_000, 7),
];

/** Deterministic token dashboard for screenshot QA; it never opens a transcript. */
export function captureUsageSearchService(): ThreadSearchService {
  return {
    syncSessions: () => {},
    syncSideChats: () => {},
    search: async () => [],
    usage: async (query) =>
      buildUsageSnapshot(
        USAGE_CAPTURE_ROWS,
        query,
        Date.parse(TODAY_CAPTURE_NOW),
      ),
    rebuild: () => {},
    getStatus: () => ({
      phase: 'ready',
      indexedThreads: 4,
      totalThreads: 4,
      indexedBytes: 1,
      totalBytes: 1,
    }),
    onStatus: () => () => {},
    dispose: () => {},
  };
}

/**
 * A complete, deterministic Today state for screenshot QA.
 *
 * Keeping this fixture in memory prevents captures from reading or replacing
 * the user's private activity database and generated recaps. The artifact is
 * already present, so opening Today never needs a provider call.
 */
export function generatedTodayCaptureFixture(): GeneratedTodayCaptureFixture {
  const events: ActivityEventRecord[] = [
    event(1, {
      eventId: 'capture-today-prompt',
      threadKey: 'codex:capture-today',
      source: 'codex',
      sessionId: 'capture-today',
      projectName: 'Aside',
      projectPath: '/capture/aside',
      title: 'Prepare Today for release',
      occurredAt: '2026-07-31T15:10:00.000Z',
      kind: 'prompt',
      originKind: 'user_prompt',
      lifecycle: 'start',
      summary: 'Make Today read like a useful diary of the day.',
    }),
    event(2, {
      eventId: 'capture-today-progress',
      threadKey: 'codex:capture-today',
      source: 'codex',
      sessionId: 'capture-today',
      projectName: 'Aside',
      projectPath: '/capture/aside',
      title: 'Prepare Today for release',
      occurredAt: '2026-07-31T15:32:00.000Z',
      kind: 'progress',
      originKind: 'assistant_text',
      lifecycle: 'progress',
      summary: 'Reframed the page around a generated recap and project narrative.',
    }),
    event(3, {
      eventId: 'capture-today-complete',
      threadKey: 'codex:capture-today',
      source: 'codex',
      sessionId: 'capture-today',
      projectName: 'Aside',
      projectPath: '/capture/aside',
      title: 'Prepare Today for release',
      occurredAt: '2026-07-31T16:05:00.000Z',
      kind: 'turn_completed',
      originKind: 'turn_complete',
      lifecycle: 'terminal',
      summary: 'The Today polish pass is ready for review.',
    }),
    event(4, {
      eventId: 'capture-release-prompt',
      threadKey: 'claude:capture-release',
      source: 'claude',
      sessionId: 'capture-release',
      projectName: 'Aside website',
      projectPath: '/capture/aside-website',
      title: 'Verify the release path',
      occurredAt: '2026-07-31T17:00:00.000Z',
      kind: 'prompt',
      originKind: 'user_prompt',
      lifecycle: 'start',
      summary: 'Check the signed update and website version references.',
    }),
    event(5, {
      eventId: 'capture-release-progress',
      threadKey: 'claude:capture-release',
      source: 'claude',
      sessionId: 'capture-release',
      projectName: 'Aside website',
      projectPath: '/capture/aside-website',
      title: 'Verify the release path',
      occurredAt: '2026-07-31T17:28:00.000Z',
      kind: 'progress',
      originKind: 'assistant_text',
      lifecycle: 'progress',
      summary: 'Confirmed the release feed and both Mac architectures.',
    }),
    event(6, {
      eventId: 'capture-release-complete',
      threadKey: 'claude:capture-release',
      source: 'claude',
      sessionId: 'capture-release',
      projectName: 'Aside website',
      projectPath: '/capture/aside-website',
      title: 'Verify the release path',
      occurredAt: '2026-07-31T17:44:00.000Z',
      kind: 'turn_completed',
      originKind: 'turn_complete',
      lifecycle: 'terminal',
      summary: 'The release path is ready for a final installed-app smoke test.',
    }),
  ];
  const evidence = packActivityEvidence(curateNarrativeActivity(events));

  return {
    now: TODAY_CAPTURE_NOW,
    timeZone: TODAY_CAPTURE_TIME_ZONE,
    activity: {
      events,
      cursors: [
        {
          threadKey: 'codex:capture-today',
          baselineAtMs: 0,
          viewedThroughSeq: 3,
          resolvedThroughSeq: 3,
        },
        {
          threadKey: 'claude:capture-release',
          baselineAtMs: 0,
          viewedThroughSeq: 6,
          resolvedThroughSeq: 6,
        },
      ],
    },
    artifacts: [
      {
        id: 'capture-generated-today-recap',
        kind: 'daily_recap',
        day: TODAY_CAPTURE_DAY,
        createdAt: '2026-07-31T18:40:00.000Z',
        provider: 'claude-cli',
        model: TODAY_CAPTURE_MODEL,
        inputHighWaterSeq: evidence.highWaterSeq,
        inputHash: evidence.inputHash,
        evidenceIds: [
          'capture-today-progress',
          'capture-release-progress',
        ],
        markdown:
          'Summary\n' +
          'Today centered on getting Aside ready to ship. The Today view was reshaped around a generated daily recap, while the release path was checked for both Mac architectures. [1][2]\n\n' +
          'Work and outcomes\n' +
          '• The activity view now leads with a generated recap and groups the day by project. [1]\n' +
          '• The signed update feed and Apple silicon and Intel builds were verified. [2]\n\n' +
          'Still open\n' +
          'Run the final installed-app update smoke test before publishing. [2]',
      },
    ],
    sessions: [
      session({
        id: 'capture-today',
        source: 'codex',
        projectName: 'Aside',
        title: 'Prepare Today for release',
        projectPath: '/capture/aside',
        lastEventAt: '2026-07-31T16:05:00.000Z',
        eventCount: 3,
      }),
      session({
        id: 'capture-release',
        source: 'claude',
        projectName: 'Aside website',
        title: 'Verify the release path',
        projectPath: '/capture/aside-website',
        lastEventAt: '2026-07-31T17:44:00.000Z',
        eventCount: 3,
      }),
    ],
  };
}

function session(input: {
  id: string;
  source: TrackedSession['source'];
  projectName: string;
  title: string;
  projectPath: string;
  lastEventAt: string;
  eventCount: number;
}): TrackedSession {
  return {
    id: input.id,
    source: input.source,
    projectName: input.projectName,
    title: input.title,
    projectDir: input.projectPath,
    jsonlPath: '',
    cwd: input.projectPath,
    gitBranch: 'codex/today-release',
    slug: input.id,
    model: '',
    version: '',
    usedPercent: 0,
    contextStatus: 'safe',
    status: 'history',
    lastEventTime: new Date(input.lastEventAt),
    eventCount: input.eventCount,
    currentActivity: '',
  };
}

function usageRow(
  day: string,
  provider: string,
  model: string,
  inputTokens: number,
  cachedInputTokens: number,
  outputTokens: number,
  requests: number,
  local = false,
): UsageAggregateRow {
  return {
    day,
    provider,
    model,
    local: local ? 1 : 0,
    input_tokens: inputTokens,
    cached_input_tokens: cachedInputTokens,
    cache_write_5m_input_tokens: 0,
    cache_write_1h_input_tokens: 0,
    output_tokens: outputTokens,
    reasoning_output_tokens: 0,
    requests,
  };
}

function event(
  seq: number,
  input: {
    eventId: string;
    threadKey: string;
    source: ActivityEventRecord['source'];
    sessionId: string;
    projectName: string;
    projectPath: string;
    title: string;
    occurredAt: string;
    kind: ActivityEventRecord['kind'];
    originKind: NonNullable<ActivityEventRecord['originKind']>;
    lifecycle: ActivityEventRecord['lifecycle'];
    summary: string;
  },
): ActivityEventRecord {
  const occurredAtMs = Date.parse(input.occurredAt);
  return {
    seq,
    eventId: input.eventId,
    threadKey: input.threadKey,
    source: input.source,
    sessionId: input.sessionId,
    projectName: input.projectName,
    projectPath: input.projectPath,
    title: input.title,
    occurredAtMs,
    observedAtMs: occurredAtMs + 1_000,
    kind: input.kind,
    originKind: input.originKind,
    lifecycle: input.lifecycle,
    severity: 'info',
    summary: input.summary,
    evidenceHash: seq.toString(16).padStart(64, '0'),
    seeded: false,
  };
}
