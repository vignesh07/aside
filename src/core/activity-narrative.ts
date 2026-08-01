import type { ActivityEventRecord } from '../types/activity.js';

const MAX_PROMPTS_PER_THREAD = 2;
const MAX_PROGRESS_PER_THREAD = 4;
const MAX_SIGNALS_PER_THREAD = 2;

/**
 * Keep provider-bound diaries focused on user-visible work. The activity
 * ledger intentionally retains low-level tool evidence for diagnostics, but
 * command launches, tool acknowledgements, and file-operation bookkeeping are
 * implementation mechanics rather than a useful daily narrative.
 */
export function curateNarrativeActivity(
  input: ReadonlyArray<ActivityEventRecord>,
): ActivityEventRecord[] {
  const grouped = new Map<string, ActivityEventRecord[]>();
  for (const event of uniqueEvents(input)) {
    if (!isNarrativeActivity(event)) continue;
    const events = grouped.get(event.threadKey) ?? [];
    events.push(event);
    grouped.set(event.threadKey, events);
  }

  const selected: ActivityEventRecord[] = [];
  for (const events of grouped.values()) {
    const prompts = events
      .filter((event) => event.kind === 'prompt')
      .slice(-MAX_PROMPTS_PER_THREAD);
    const progress = events
      .filter((event) => event.kind === 'progress')
      .slice(-MAX_PROGRESS_PER_THREAD);
    const signals = events
      .filter(
        (event) =>
          event.kind === 'input_requested' ||
          event.kind === 'turn_failed' ||
          event.kind === 'turn_interrupted',
      )
      .slice(-MAX_SIGNALS_PER_THREAD);
    const completion = events
      .filter((event) => event.kind === 'turn_completed')
      .slice(-1);
    selected.push(...prompts, ...progress, ...signals, ...completion);
  }

  return uniqueEvents(selected);
}

export function isNarrativeActivity(event: ActivityEventRecord): boolean {
  if (event.originKind) {
    return (
      event.originKind === 'user_prompt' ||
      event.originKind === 'assistant_text' ||
      event.originKind === 'needs_input' ||
      event.originKind === 'turn_complete' ||
      event.originKind === 'turn_failed' ||
      event.originKind === 'turn_interrupted'
    );
  }
  switch (event.kind) {
    case 'prompt':
      return isMeaningfulPrompt(event.summary);
    case 'progress':
      return isMeaningfulProgress(event.summary);
    case 'input_requested':
    case 'turn_completed':
    case 'turn_failed':
    case 'turn_interrupted':
      return true;
    default:
      return false;
  }
}

export function latestNarrativeSummary(
  input: ReadonlyArray<ActivityEventRecord>,
): string {
  const events = curateNarrativeActivity(input);
  const latest = [...events]
    .reverse()
    .find((event) => event.kind === 'progress' || event.kind === 'prompt');
  return latest?.summary ?? '';
}

function isMeaningfulPrompt(summary: string): boolean {
  const compact = summary.replace(/\s+/g, ' ').trim();
  if (compact.length < 3) return false;
  if (/^(?:task|session) started$/i.test(compact)) return false;
  if (/^<recommended_plugins>/i.test(compact)) return false;
  return true;
}

function isMeaningfulProgress(summary: string): boolean {
  const compact = summary.replace(/\s+/g, ' ').trim();
  if (compact.length < 12) return false;
  if (/^(?:running|command completed):/i.test(compact)) return false;
  if (
    /^(?:wrote|edited)\s+.*(?:[\\/]|\.[A-Za-z0-9_-]{1,16}(?::\d+(?::\d+)?)?)\s*$/i.test(
      compact,
    )
  ) {
    return false;
  }
  if (/^[A-Za-z0-9_.:/-]+ completed$/i.test(compact)) return false;
  if (/^toolu_[A-Za-z0-9_-]+ completed$/i.test(compact)) return false;
  if (
    /^(?:wait|wait_agent|send_message|spawn_agent|list_agents|followup_task|interrupt_agent)(?:\s|:)/i.test(
      compact,
    )
  ) {
    return false;
  }
  return true;
}

function uniqueEvents(
  input: ReadonlyArray<ActivityEventRecord>,
): ActivityEventRecord[] {
  const seenIds = new Set<string>();
  return [...input]
    .filter(
      (event) =>
        Number.isFinite(event.occurredAtMs) && Number.isFinite(event.seq),
    )
    .sort(compareEvents)
    .filter((event) => {
      if (seenIds.has(event.eventId)) return false;
      seenIds.add(event.eventId);
      return true;
    });
}

function compareEvents(
  left: ActivityEventRecord,
  right: ActivityEventRecord,
): number {
  return (
    left.seq - right.seq ||
    left.observedAtMs - right.observedAtMs ||
    left.occurredAtMs - right.occurredAtMs ||
    left.eventId.localeCompare(right.eventId)
  );
}
