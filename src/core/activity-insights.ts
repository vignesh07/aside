import { createHash } from 'node:crypto';
import type {
  ActivityEventRecord,
  ThreadActivityCursor,
} from '../types/activity.js';
import type {
  ActivityEvidenceRef,
  ActivityInsight,
  ActivityInsightKind,
  ActivityInsightOptions,
} from '../types/today.js';
import { activityEvidenceRef } from './today-diary.js';

export const QUIET_WORK_AFTER_MS = 20 * 60_000;
export const WARNING_BURST_COUNT = 3;
export const WARNING_BURST_WINDOW_MS = 10 * 60_000;
export const WARNING_BURST_FRESHNESS_MS = 30 * 60_000;

/**
 * Generates evidence-backed local insights. This is deterministic rules code:
 * it does not call a model, summarize raw transcripts, or infer that a task
 * succeeded merely because a model turn ended.
 */
export function buildActivityInsights(
  input: ReadonlyArray<ActivityEventRecord>,
  options: ActivityInsightOptions = {},
): ActivityInsight[] {
  const nowMs = options.nowMs ?? Date.now();
  if (!Number.isFinite(nowMs)) {
    throw new RangeError('nowMs must be a finite timestamp');
  }
  const quietAfterMs = validPositive(
    options.quietAfterMs,
    QUIET_WORK_AFTER_MS,
  );
  const warningBurstCount = validCount(
    options.warningBurstCount,
    WARNING_BURST_COUNT,
  );
  const warningBurstWindowMs = validPositive(
    options.warningBurstWindowMs,
    WARNING_BURST_WINDOW_MS,
  );
  const warningBurstFreshnessMs = validPositive(
    options.warningBurstFreshnessMs,
    WARNING_BURST_FRESHNESS_MS,
  );
  const cursors = new Map(
    [...(options.cursors ?? [])].map((cursor) => [
      cursor.threadKey,
      cursor,
    ]),
  );
  const byThread = groupUniqueEvents(input);
  const insights: ActivityInsight[] = [];

  for (const [threadKey, events] of byThread) {
    const phase = latestLifecycle(events);
    if (phase?.kind === 'input_requested') {
      insights.push(
        insight(
          'waiting',
          'attention',
          phase,
          'Waiting for input',
          phase.summary || 'This turn is waiting for a response.',
          [phase],
        ),
      );
    }
    if (phase?.kind === 'turn_failed') {
      insights.push(
        insight(
          'terminal_failure',
          'error',
          phase,
          'Turn failed',
          phase.summary || 'The agent reported a terminal turn failure.',
          [phase],
        ),
      );
    }
    if (
      phase?.kind === 'work_started' &&
      !phase.seeded &&
      nowMs >= phase.occurredAtMs + quietAfterMs
    ) {
      insights.push(
        insight(
          'quiet_work',
          'warning',
          phase,
          'Observed work went quiet',
          `No later lifecycle event was observed for ${formatDuration(
            nowMs - phase.occurredAtMs,
          )}.`,
          [phase],
        ),
      );
    }
    if (
      phase?.kind === 'turn_completed' &&
      isUnreviewed(phase, cursors.get(threadKey))
    ) {
      insights.push(
        insight(
          'unreviewed_completion',
          'info',
          phase,
          'Turn ended — ready to review',
          'The model turn ended. Review its output before deciding the task outcome.',
          [phase],
        ),
      );
    }

    const burst = latestWarningBurst(
      events,
      nowMs,
      warningBurstCount,
      warningBurstWindowMs,
      warningBurstFreshnessMs,
    );
    if (burst) {
      const trigger = burst[burst.length - 1]!;
      insights.push(
        insight(
          'warning_burst',
          'warning',
          trigger,
          'Repeated tool warnings',
          `${burst.length} tool warnings were observed within ${formatDuration(
            warningBurstWindowMs,
          )}.`,
          burst,
        ),
      );
    }
  }

  const seen = new Set<string>();
  return insights
    .sort(compareInsights)
    .filter((item) => {
      if (seen.has(item.insightId)) return false;
      seen.add(item.insightId);
      return true;
    });
}

function insight(
  kind: ActivityInsightKind,
  severity: ActivityInsight['severity'],
  trigger: ActivityEventRecord,
  headline: string,
  detail: string,
  evidence: ReadonlyArray<ActivityEventRecord>,
): ActivityInsight {
  const refs = uniqueEvidence(evidence);
  const insightId = createHash('sha256')
    .update(
      [kind, trigger.threadKey, ...refs.map((ref) => ref.eventId)].join('\0'),
    )
    .digest('hex')
    .slice(0, 24);
  return {
    insightId,
    kind,
    severity,
    threadKey: trigger.threadKey,
    rootThreadKey:
      trigger.rootThreadKey ??
      trigger.parentThreadKey ??
      trigger.threadKey,
    projectName: trigger.projectName,
    projectPath: trigger.projectPath,
    title: trigger.title,
    occurredAtMs: trigger.occurredAtMs,
    headline,
    detail,
    evidence: refs,
  };
}

function groupUniqueEvents(
  events: ReadonlyArray<ActivityEventRecord>,
): Map<string, ActivityEventRecord[]> {
  const sorted = [...events]
    .filter(
      (event) =>
        Number.isFinite(event.occurredAtMs) &&
        Number.isFinite(event.observedAtMs),
    )
    .sort(compareSequence);
  const seen = new Set<string>();
  const grouped = new Map<string, ActivityEventRecord[]>();
  for (const event of sorted) {
    if (seen.has(event.eventId)) continue;
    seen.add(event.eventId);
    const thread = grouped.get(event.threadKey) ?? [];
    thread.push(event);
    grouped.set(event.threadKey, thread);
  }
  return grouped;
}

function latestLifecycle(
  events: ReadonlyArray<ActivityEventRecord>,
): ActivityEventRecord | null {
  let latest: ActivityEventRecord | null = null;
  for (const event of events) {
    if (event.kind !== 'tool_warning') latest = event;
  }
  return latest;
}

function isUnreviewed(
  completion: ActivityEventRecord,
  cursor: ThreadActivityCursor | undefined,
): boolean {
  if (!cursor) return false;
  const reviewedThrough = Math.max(
    cursor.viewedThroughSeq,
    cursor.resolvedThroughSeq,
  );
  const beyondBaseline =
    !completion.seeded || completion.occurredAtMs > cursor.baselineAtMs;
  return beyondBaseline && completion.seq > reviewedThrough;
}

function latestWarningBurst(
  events: ReadonlyArray<ActivityEventRecord>,
  nowMs: number,
  minimumCount: number,
  windowMs: number,
  freshnessMs: number,
): ActivityEventRecord[] | null {
  const warnings = events
    .filter((event) => event.kind === 'tool_warning')
    .sort(compareEvents);
  if (warnings.length < minimumCount) return null;
  let latest: ActivityEventRecord[] | null = null;
  let start = 0;
  for (let end = 0; end < warnings.length; end += 1) {
    while (
      warnings[end]!.occurredAtMs - warnings[start]!.occurredAtMs >
      windowMs
    ) {
      start += 1;
    }
    const candidate = warnings.slice(start, end + 1);
    if (
      candidate.length >= minimumCount &&
      nowMs - warnings[end]!.occurredAtMs <= freshnessMs &&
      warnings[end]!.occurredAtMs <= nowMs
    ) {
      latest = candidate;
    }
  }
  return latest;
}

function uniqueEvidence(
  events: ReadonlyArray<ActivityEventRecord>,
): ActivityEvidenceRef[] {
  const seen = new Set<string>();
  const refs: ActivityEvidenceRef[] = [];
  for (const event of events) {
    if (seen.has(event.eventId)) continue;
    seen.add(event.eventId);
    refs.push(activityEvidenceRef(event));
  }
  return refs;
}

function compareEvents(
  left: ActivityEventRecord,
  right: ActivityEventRecord,
): number {
  return (
    left.occurredAtMs - right.occurredAtMs ||
    left.seq - right.seq ||
    left.eventId.localeCompare(right.eventId)
  );
}

function compareSequence(
  left: ActivityEventRecord,
  right: ActivityEventRecord,
): number {
  return (
    left.seq - right.seq ||
    left.observedAtMs - right.observedAtMs ||
    left.eventId.localeCompare(right.eventId)
  );
}

function compareInsights(
  left: ActivityInsight,
  right: ActivityInsight,
): number {
  return (
    insightPriority(left.kind) - insightPriority(right.kind) ||
    right.occurredAtMs - left.occurredAtMs ||
    left.threadKey.localeCompare(right.threadKey) ||
    left.insightId.localeCompare(right.insightId)
  );
}

function insightPriority(kind: ActivityInsightKind): number {
  switch (kind) {
    case 'terminal_failure':
      return 0;
    case 'waiting':
      return 1;
    case 'warning_burst':
      return 2;
    case 'quiet_work':
      return 3;
    case 'unreviewed_completion':
      return 4;
  }
}

function validPositive(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value! > 0 ? value! : fallback;
}

function validCount(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value! > 1 ? value! : fallback;
}

function formatDuration(durationMs: number): string {
  const minutes = Math.max(1, Math.floor(durationMs / 60_000));
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0
    ? `${hours} ${hours === 1 ? 'hour' : 'hours'}`
    : `${hours}h ${remainder}m`;
}
