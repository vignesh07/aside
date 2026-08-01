export interface TodayGenerationGate {
  active: boolean;
  attemptedThisEntry: boolean;
  generating: boolean;
  eventCount: number;
  hasArtifact: boolean;
  artifactIsStale: boolean;
  authReady: boolean;
  providerUsable: boolean;
  consentGranted: boolean;
}

/** Pure policy for the one automatic provider call allowed by a Today entry. */
export function shouldGenerateTodayOnEntry(gate: TodayGenerationGate): boolean {
  return (
    gate.active &&
    !gate.attemptedThisEntry &&
    !gate.generating &&
    gate.eventCount > 0 &&
    (!gate.hasArtifact || gate.artifactIsStale) &&
    gate.authReady &&
    gate.providerUsable &&
    gate.consentGranted
  );
}
