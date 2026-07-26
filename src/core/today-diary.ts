import type { ActivityEventRecord } from '../types/activity.js';
import type {
  ActivityEvidenceRef,
  ActivityFactCounts,
  LocalDayRange,
  TodayDiary,
  TodayProjectDiary,
  TodayThreadDiary,
  TodayThreadMember,
} from '../types/today.js';
import type { SessionSource } from '../types/session.js';

const SEARCH_RADIUS_MS = 48 * 60 * 60_000;
const WORK_KINDS = new Set<ActivityEventRecord['kind']>([
  'prompt',
  'work_started',
  'progress',
]);

export interface BuildTodayDiaryOptions {
  nowMs?: number;
  timeZone?: string;
}

/**
 * Returns exact local-calendar-day bounds. The boundary search is based on the
 * formatted calendar date rather than adding 24 hours, so 23/25-hour DST days
 * and zones with non-hour offsets are handled correctly.
 */
export function localDayRange(
  nowMs: number = Date.now(),
  timeZone: string = systemTimeZone(),
): LocalDayRange {
  if (!Number.isFinite(nowMs)) {
    throw new RangeError('nowMs must be a finite timestamp');
  }
  const formatter = createDateFormatter(timeZone);
  const current = dateParts(nowMs, formatter);
  const ordinal = dateOrdinal(current.year, current.month, current.day);
  const approximateMidnight = Date.UTC(
    current.year,
    current.month - 1,
    current.day,
  );
  const startMs = lowerBoundTimestamp(
    approximateMidnight,
    (candidate) =>
      dateOrdinalFromTimestamp(candidate, formatter) >= ordinal,
  );
  const endMs = lowerBoundTimestamp(
    approximateMidnight + 24 * 60 * 60_000,
    (candidate) =>
      dateOrdinalFromTimestamp(candidate, formatter) > ordinal,
  );
  return {
    dateKey: [
      String(current.year).padStart(4, '0'),
      String(current.month).padStart(2, '0'),
      String(current.day).padStart(2, '0'),
    ].join('-'),
    timeZone,
    startMs,
    endMs,
  };
}

/**
 * Builds a deterministic, local-only Today diary from activity ledger facts.
 * `turn_completed` means only that a model turn ended; no success state is
 * inferred or exposed.
 */
export function buildTodayDiary(
  input: ReadonlyArray<ActivityEventRecord>,
  options: BuildTodayDiaryOptions = {},
): TodayDiary {
  const range = localDayRange(
    options.nowMs ?? Date.now(),
    options.timeZone ?? systemTimeZone(),
  );
  const allEvents = uniqueEvents(input);
  const metadata = latestMetadataByThread(allEvents);
  const events = allEvents.filter(
    (event) =>
      event.occurredAtMs >= range.startMs &&
      event.occurredAtMs < range.endMs,
  );

  const projectGroups = new Map<string, ProjectAccumulator>();
  for (const event of events) {
    const projectKey = event.projectPath || event.projectName || '(unknown)';
    const project = projectGroups.get(projectKey) ?? {
      projectKey,
      projectName: event.projectName || basename(event.projectPath) || 'Unknown project',
      projectPath: event.projectPath,
      events: [],
    };
    project.events.push(event);
    projectGroups.set(projectKey, project);
  }

  const projects = [...projectGroups.values()]
    .map((project) => buildProject(project, metadata))
    .sort(compareProjects);
  const counts = countFacts(events);
  return {
    range,
    projectCount: projects.length,
    threadCount: projects.reduce(
      (total, project) => total + project.threadCount,
      0,
    ),
    memberThreadCount: projects.reduce(
      (total, project) => total + project.memberThreadCount,
      0,
    ),
    counts,
    lastObservedWorkAtMs: lastObservedWork(events),
    projects,
  };
}

interface ProjectAccumulator {
  projectKey: string;
  projectName: string;
  projectPath: string;
  events: ActivityEventRecord[];
}

function buildProject(
  project: ProjectAccumulator,
  metadata: Map<string, ActivityEventRecord>,
): TodayProjectDiary {
  const roots = new Map<string, ActivityEventRecord[]>();
  for (const event of project.events) {
    const rootKey =
      event.rootThreadKey ?? event.parentThreadKey ?? event.threadKey;
    const rootEvents = roots.get(rootKey) ?? [];
    rootEvents.push(event);
    roots.set(rootKey, rootEvents);
  }
  const threads = [...roots.entries()]
    .map(([rootKey, events]) => buildThread(rootKey, events, metadata))
    .sort(compareThreads);
  return {
    projectKey: project.projectKey,
    projectName: project.projectName,
    projectPath: project.projectPath,
    threadCount: threads.length,
    memberThreadCount: threads.reduce(
      (total, thread) => total + thread.memberThreadCount,
      0,
    ),
    counts: countFacts(project.events),
    lastObservedWorkAtMs: lastObservedWork(project.events),
    threads,
  };
}

function buildThread(
  rootKey: string,
  events: ActivityEventRecord[],
  metadata: Map<string, ActivityEventRecord>,
): TodayThreadDiary {
  const byMember = new Map<string, ActivityEventRecord[]>();
  for (const event of events) {
    const memberEvents = byMember.get(event.threadKey) ?? [];
    memberEvents.push(event);
    byMember.set(event.threadKey, memberEvents);
  }
  const rootMetadata =
    metadata.get(rootKey) ??
    events.find((event) => event.threadKey === rootKey) ??
    events[events.length - 1]!;
  const members = [...byMember.entries()]
    .map(([threadKey, memberEvents]) =>
      buildMember(threadKey, rootKey, memberEvents),
    )
    .sort(compareMembers);
  const subagents = members.filter((member) => !member.isRoot);
  const memberThreadKeys = [
    rootKey,
    ...members
      .filter((member) => member.threadKey !== rootKey)
      .map((member) => member.threadKey),
  ];
  const sources = [...new Set(events.map((event) => event.source))].sort(
    compareSources,
  );
  return {
    threadKey: rootKey,
    projectName: rootMetadata.projectName,
    projectPath: rootMetadata.projectPath,
    title:
      rootMetadata.title ||
      events.find((event) => event.title)?.title ||
      'Untitled thread',
    sources,
    memberThreadCount: memberThreadKeys.length,
    memberThreadKeys,
    counts: countFacts(events),
    lastObservedWorkAtMs: lastObservedWork(events),
    evidence: evidenceRefs(events),
    subagents,
  };
}

function buildMember(
  threadKey: string,
  rootKey: string,
  events: ActivityEventRecord[],
): TodayThreadMember {
  const latest = latestBySequence(events);
  return {
    threadKey,
    parentThreadKey: latest.parentThreadKey,
    source: latest.source,
    sessionId: latest.sessionId,
    title: latest.title || 'Untitled thread',
    isRoot: threadKey === rootKey,
    counts: countFacts(events),
    lastObservedWorkAtMs: lastObservedWork(events),
    evidence: evidenceRefs(events),
  };
}

export function activityEvidenceRef(
  event: ActivityEventRecord,
): ActivityEvidenceRef {
  return {
    eventId: event.eventId,
    evidenceHash: event.evidenceHash,
    threadKey: event.threadKey,
    kind: event.kind,
    occurredAtMs: event.occurredAtMs,
    observedAtMs: event.observedAtMs,
    summary: event.summary,
  };
}

export function countFacts(
  events: ReadonlyArray<ActivityEventRecord>,
): ActivityFactCounts {
  let waitingCount = 0;
  let errorCount = 0;
  let warningCount = 0;
  let completionCount = 0;
  for (const event of events) {
    if (event.kind === 'input_requested') waitingCount += 1;
    if (event.kind === 'turn_failed') errorCount += 1;
    if (event.kind === 'tool_warning') warningCount += 1;
    if (event.kind === 'turn_completed') completionCount += 1;
  }
  return {
    eventCount: events.length,
    waitingCount,
    errorCount,
    warningCount,
    completionCount,
  };
}

function evidenceRefs(
  events: ReadonlyArray<ActivityEventRecord>,
): ActivityEvidenceRef[] {
  return events.map(activityEvidenceRef);
}

function lastObservedWork(
  events: ReadonlyArray<ActivityEventRecord>,
): number | null {
  let latest: number | null = null;
  for (const event of events) {
    if (!WORK_KINDS.has(event.kind)) continue;
    if (latest === null || event.occurredAtMs > latest) {
      latest = event.occurredAtMs;
    }
  }
  return latest;
}

function uniqueEvents(
  events: ReadonlyArray<ActivityEventRecord>,
): ActivityEventRecord[] {
  const seen = new Set<string>();
  return [...events]
    .filter(
      (event) =>
        Number.isFinite(event.occurredAtMs) &&
        Number.isFinite(event.observedAtMs),
    )
    .sort(compareEvents)
    .filter((event) => {
      if (seen.has(event.eventId)) return false;
      seen.add(event.eventId);
      return true;
    });
}

function latestMetadataByThread(
  events: ReadonlyArray<ActivityEventRecord>,
): Map<string, ActivityEventRecord> {
  const result = new Map<string, ActivityEventRecord>();
  for (const event of events) {
    const current = result.get(event.threadKey);
    if (!current || compareSequence(current, event) < 0) {
      result.set(event.threadKey, event);
    }
  }
  return result;
}

function latestBySequence(
  events: ReadonlyArray<ActivityEventRecord>,
): ActivityEventRecord {
  let latest = events[0]!;
  for (const event of events.slice(1)) {
    if (compareSequence(latest, event) < 0) latest = event;
  }
  return latest;
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

function compareProjects(
  left: TodayProjectDiary,
  right: TodayProjectDiary,
): number {
  return (
    (right.lastObservedWorkAtMs ?? -1) -
      (left.lastObservedWorkAtMs ?? -1) ||
    left.projectName.localeCompare(right.projectName) ||
    left.projectPath.localeCompare(right.projectPath)
  );
}

function compareThreads(
  left: TodayThreadDiary,
  right: TodayThreadDiary,
): number {
  return (
    (right.lastObservedWorkAtMs ?? -1) -
      (left.lastObservedWorkAtMs ?? -1) ||
    left.title.localeCompare(right.title) ||
    left.threadKey.localeCompare(right.threadKey)
  );
}

function compareMembers(
  left: TodayThreadMember,
  right: TodayThreadMember,
): number {
  if (left.isRoot !== right.isRoot) return left.isRoot ? -1 : 1;
  return (
    (right.lastObservedWorkAtMs ?? -1) -
      (left.lastObservedWorkAtMs ?? -1) ||
    left.title.localeCompare(right.title) ||
    left.threadKey.localeCompare(right.threadKey)
  );
}

function compareSources(left: SessionSource, right: SessionSource): number {
  return left.localeCompare(right);
}

function createDateFormatter(timeZone: string): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat('en-CA-u-ca-iso8601', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  } catch {
    throw new RangeError(`Invalid time zone: ${timeZone}`);
  }
}

function dateParts(
  timestamp: number,
  formatter: Intl.DateTimeFormat,
): { year: number; month: number; day: number } {
  const values = new Map(
    formatter
      .formatToParts(timestamp)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  );
  const year = values.get('year');
  const month = values.get('month');
  const day = values.get('day');
  if (!year || !month || !day) {
    throw new RangeError('Unable to resolve local calendar date');
  }
  return { year, month, day };
}

function dateOrdinalFromTimestamp(
  timestamp: number,
  formatter: Intl.DateTimeFormat,
): number {
  const parts = dateParts(timestamp, formatter);
  return dateOrdinal(parts.year, parts.month, parts.day);
}

function dateOrdinal(year: number, month: number, day: number): number {
  return Math.floor(Date.UTC(year, month - 1, day) / (24 * 60 * 60_000));
}

function lowerBoundTimestamp(
  approximate: number,
  predicate: (timestamp: number) => boolean,
): number {
  let low = approximate - SEARCH_RADIUS_MS;
  let high = approximate + SEARCH_RADIUS_MS;
  while (predicate(low)) {
    high = low;
    low -= SEARCH_RADIUS_MS;
  }
  while (!predicate(high)) {
    low = high;
    high += SEARCH_RADIUS_MS;
  }
  while (low + 1 < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (predicate(middle)) high = middle;
    else low = middle;
  }
  return high;
}

function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function basename(path: string): string {
  const compact = path.replace(/\/+$/, '');
  return compact.slice(compact.lastIndexOf('/') + 1);
}
