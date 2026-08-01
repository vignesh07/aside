import { describe, expect, it } from 'vitest';
import { MenubarBackend } from '../menubar/src/backend.js';
import {
  ActivityLedger,
  InMemoryActivityLedgerStore,
} from '../dist/core/activity-ledger.js';
import { curateNarrativeActivity } from '../dist/core/activity-narrative.js';
import { packActivityEvidence } from '../dist/core/activity-evidence-pack.js';
import { buildTodayDiary } from '../src/core/today-diary.js';
import {
  captureProviderAuthCoordinator,
  captureSideChatService,
  captureUsageSearchService,
  generatedTodayCaptureFixture,
  TODAY_CAPTURE_MODEL,
  TODAY_CAPTURE_PROVIDER,
} from '../menubar/src/capture-fixtures.js';

describe('generated Today capture fixture', () => {
  it('provides a complete recap state without a provider call', () => {
    const fixture = generatedTodayCaptureFixture();
    const diary = buildTodayDiary(fixture.activity.events, {
      nowMs: Date.parse(fixture.now),
      timeZone: fixture.timeZone,
    });
    const artifact = fixture.artifacts[0]!;

    expect(diary.range.dateKey).toBe(artifact.day);
    expect(diary).toMatchObject({
      projectCount: 2,
      threadCount: 2,
      counts: { eventCount: 6, completionCount: 2 },
    });
    expect(artifact.inputHighWaterSeq).toBe(6);
    expect(artifact.inputHash).toBe(
      packActivityEvidence(curateNarrativeActivity(fixture.activity.events))
        .inputHash,
    );
    expect(fixture.sessions.map((session) => session.id)).toEqual([
      'capture-today',
      'capture-release',
    ]);
    expect(fixture.sessions.every((session) => session.jsonlPath === '')).toBe(
      true,
    );
    expect(artifact.evidenceIds).toEqual([
      'capture-today-progress',
      'capture-release-progress',
    ]);
    expect(
      artifact.evidenceIds.every((id) =>
        fixture.activity.events.some((event) => event.eventId === id),
      ),
    ).toBe(true);
    expect(artifact.markdown).toContain('generated daily recap');
  });

  it('renders the fixture artifact as current in the backend view', () => {
    const fixture = generatedTodayCaptureFixture();
    const now = () => new Date(fixture.now);
    const service = captureSideChatService();
    const backend = new MenubarBackend(
      { provider: TODAY_CAPTURE_PROVIDER, model: TODAY_CAPTURE_MODEL },
      () => {},
      {
        scan: () => ({ sessions: fixture.sessions, jsonlPaths: new Map() }),
        service,
        models: () => [
          {
            provider: TODAY_CAPTURE_PROVIDER,
            model: 'claude-haiku-4-5-20251001',
            recommended: true,
          },
        ],
        activity: new ActivityLedger(
          new InMemoryActivityLedgerStore(fixture.activity),
          now,
        ),
        artifacts: {
          load: () => fixture.artifacts,
          save: () => {},
        },
        now,
        timeZone: fixture.timeZone,
      },
    );

    expect(backend.getToday()).toMatchObject({
      artifact: { id: 'capture-generated-today-recap' },
      artifactEvidenceMissingCount: 0,
      newEventCount: 0,
      artifactIsStale: false,
    });
    backend.stop();
  });

  it('returns fresh state for every capture', () => {
    const first = generatedTodayCaptureFixture();
    const second = generatedTodayCaptureFixture();

    first.activity.events[0]!.summary = 'mutated';
    first.artifacts[0]!.evidenceIds.length = 0;

    expect(second.activity.events[0]!.summary).toBe(
      'Make Today read like a useful diary of the day.',
    );
    expect(second.artifacts[0]!.evidenceIds).toHaveLength(2);
  });

  it('uses deterministic account probes instead of vendor or network calls', async () => {
    await expect(
      captureProviderAuthCoordinator().getStatuses(),
    ).resolves.toEqual([
      { provider: 'codex-cli', state: 'signed_in', enabled: true },
      { provider: 'claude-cli', state: 'signed_in', enabled: true },
      {
        provider: 'ollama',
        state: 'error',
        enabled: false,
        reason: 'no_models',
      },
    ]);
    expect(
      captureProviderAuthCoordinator(false).todayRecapsEnabled('claude-cli'),
    ).toBe(false);
  });

  it('uses deterministic aggregate counters for usage captures', async () => {
    const search = captureUsageSearchService();
    const usage = await search.usage?.({
      rangeDays: 365,
      providers: [],
      models: [],
    });

    expect(usage).toMatchObject({
      endDate: '2026-07-31',
      totals: { activeDays: 13 },
    });
    expect(usage?.totals.totalTokens).toBeGreaterThan(4_000_000);
    expect(usage?.providers.map((provider) => provider.id)).toEqual([
      'openai',
      'anthropic',
      'google',
      'ollama',
    ]);
    search.dispose();
  });
});
