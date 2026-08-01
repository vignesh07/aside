import { describe, expect, it } from 'vitest';
import { shouldGenerateTodayOnEntry } from '../menubar/src/today-generation.js';

const ready = {
  active: true,
  attemptedThisEntry: false,
  generating: false,
  eventCount: 4,
  hasArtifact: false,
  artifactIsStale: false,
  authReady: true,
  providerUsable: true,
  consentGranted: true,
};

describe('Today entry generation policy', () => {
  it('generates a missing or stale recap on an intentional Today entry', () => {
    expect(shouldGenerateTodayOnEntry(ready)).toBe(true);
    expect(
      shouldGenerateTodayOnEntry({
        ...ready,
        hasArtifact: true,
        artifactIsStale: true,
      }),
    ).toBe(true);
  });

  it('does not regenerate a current cached recap', () => {
    expect(
      shouldGenerateTodayOnEntry({
        ...ready,
        hasArtifact: true,
        artifactIsStale: false,
      }),
    ).toBe(false);
  });

  it('cannot retry automatically within the same entry', () => {
    expect(
      shouldGenerateTodayOnEntry({ ...ready, attemptedThisEntry: true }),
    ).toBe(false);
    expect(shouldGenerateTodayOnEntry({ ...ready, generating: true })).toBe(false);
  });

  it('does not run in the background, without activity, or without a provider', () => {
    expect(shouldGenerateTodayOnEntry({ ...ready, active: false })).toBe(false);
    expect(shouldGenerateTodayOnEntry({ ...ready, eventCount: 0 })).toBe(false);
    expect(shouldGenerateTodayOnEntry({ ...ready, authReady: false })).toBe(false);
    expect(shouldGenerateTodayOnEntry({ ...ready, providerUsable: false })).toBe(false);
    expect(shouldGenerateTodayOnEntry({ ...ready, consentGranted: false })).toBe(false);
  });
});
