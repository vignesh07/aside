import { createHash } from 'node:crypto';
import { redactSensitiveText } from './redact-sensitive.js';
import type { ActivityEventRecord } from '../types/activity.js';
import type {
  ActivityEvidenceItem,
  ActivityEvidencePack,
  ActivityEvidencePackBudget,
} from '../types/evidence-pack.js';

export const DEFAULT_EVIDENCE_PACK_BUDGET: ActivityEvidencePackBudget = {
  maxEvents: 120,
  maxCharacters: 12_000,
};

const PACK_VERSION = 1 as const;
const ELLIPSIS = '…';
const MAX_PROJECT_NAME_CHARACTERS = 96;
const MAX_TITLE_CHARACTERS = 160;
const MAX_SUMMARY_CHARACTERS = 240;

/**
 * Projects normalized activity events into a deterministic, provider-ready
 * evidence pack. Redacted display labels provide enough scope for analysis,
 * while raw transcript records, paths, origin IDs, and thread IDs are
 * intentionally not part of the model-bound text.
 */
export function packActivityEvidence(
  events: readonly ActivityEventRecord[],
  budget: Partial<ActivityEvidencePackBudget> = {},
): ActivityEvidencePack {
  const limits = normalizeBudget(budget);
  const ordered = deduplicate(events).sort(compareEvents);
  const highWaterSeq = ordered.reduce(
    (highest, event) => Math.max(highest, event.seq),
    0,
  );

  // Work newest-first while applying limits so a large history retains its
  // most recent outcomes. Reverse again before rendering for readable time
  // order. Newline allocation is independent of final ordering.
  const accepted: Array<{ evidence: ActivityEvidenceItem; line: string }> = [];
  let remainingCharacters = limits.maxCharacters;
  for (
    let index = ordered.length - 1;
    index >= 0 && accepted.length < limits.maxEvents;
    index -= 1
  ) {
    const event = ordered[index]!;
    const separatorCharacters = accepted.length === 0 ? 0 : 1;
    const available = remainingCharacters - separatorCharacters;
    if (available <= 0) break;

    const rendered = renderEvidence(event, available);
    if (!rendered) continue;
    accepted.push(rendered);
    remainingCharacters -= separatorCharacters + rendered.line.length;
  }
  accepted.reverse();

  const evidence = accepted.map((entry) => entry.evidence);
  const text = accepted.map((entry) => entry.line).join('\n');
  const inputHash = hashCanonicalInput(highWaterSeq, evidence);

  return {
    version: PACK_VERSION,
    highWaterSeq,
    inputHash,
    evidenceIds: evidence.map((item) => item.eventId),
    evidence,
    text,
    characterCount: text.length,
    omittedEventCount: ordered.length - evidence.length,
  };
}

export function stableEvidenceRef(eventId: string): string {
  if (/^[A-Za-z0-9_.:-]{1,160}$/.test(eventId)) {
    return `activity:${eventId}`;
  }
  return `activity-sha256:${createHash('sha256')
    .update(eventId)
    .digest('hex')}`;
}

function renderEvidence(
  event: ActivityEventRecord,
  maxCharacters: number,
): { evidence: ActivityEvidenceItem; line: string } | null {
  const ref = stableEvidenceRef(event.eventId);
  const occurredAt = new Date(event.occurredAtMs).toISOString();
  const projectName =
    sanitizeAndClamp(event.projectName, MAX_PROJECT_NAME_CHARACTERS) ||
    'Unknown project';
  const title =
    sanitizeAndClamp(event.title, MAX_TITLE_CHARACTERS) || 'Untitled thread';
  const prefix = [
    `[${ref}]`,
    occurredAt,
    `${event.source}/${event.kind}`,
    projectName,
    title,
  ].join(' · ');
  if (prefix.length > maxCharacters) return null;

  const sanitizedSummary = sanitizeAndClamp(
    event.summary,
    MAX_SUMMARY_CHARACTERS,
  );
  const fullLine = sanitizedSummary ? `${prefix} ${sanitizedSummary}` : prefix;
  let line = fullLine;
  let summary = sanitizedSummary;
  let truncated = false;

  if (fullLine.length > maxCharacters) {
    const availableSummary = maxCharacters - prefix.length - 1;
    if (availableSummary <= 0) {
      summary = '';
      line = prefix;
    } else if (availableSummary === 1) {
      summary = ELLIPSIS;
      line = `${prefix} ${summary}`;
    } else {
      summary = `${sanitizedSummary.slice(0, availableSummary - 1)}${ELLIPSIS}`;
      line = `${prefix} ${summary}`;
    }
    truncated = true;
  }

  return {
    evidence: {
      ref,
      eventId: event.eventId,
      seq: event.seq,
      occurredAtMs: event.occurredAtMs,
      source: event.source,
      projectName,
      title,
      kind: event.kind,
      lifecycle: event.lifecycle,
      severity: event.severity,
      summary,
      evidenceHash: event.evidenceHash,
      truncated,
    },
    line,
  };
}

function sanitizeAndClamp(value: string, maxCharacters: number): string {
  const sanitized = redactSensitiveText(value)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (sanitized.length <= maxCharacters) return sanitized;
  return `${sanitized.slice(0, maxCharacters - 1)}${ELLIPSIS}`;
}

function deduplicate(
  events: readonly ActivityEventRecord[],
): ActivityEventRecord[] {
  const byId = new Map<string, ActivityEventRecord>();
  for (const event of events) {
    const current = byId.get(event.eventId);
    if (!current || compareEvents(event, current) < 0) {
      byId.set(event.eventId, event);
    }
  }
  return [...byId.values()];
}

function compareEvents(
  left: ActivityEventRecord,
  right: ActivityEventRecord,
): number {
  return (
    left.occurredAtMs - right.occurredAtMs ||
    left.seq - right.seq ||
    left.eventId.localeCompare(right.eventId) ||
    left.evidenceHash.localeCompare(right.evidenceHash) ||
    left.kind.localeCompare(right.kind) ||
    left.summary.localeCompare(right.summary)
  );
}

function normalizeBudget(
  budget: Partial<ActivityEvidencePackBudget>,
): ActivityEvidencePackBudget {
  return {
    maxEvents: boundedInteger(
      budget.maxEvents,
      DEFAULT_EVIDENCE_PACK_BUDGET.maxEvents,
    ),
    maxCharacters: boundedInteger(
      budget.maxCharacters,
      DEFAULT_EVIDENCE_PACK_BUDGET.maxCharacters,
    ),
  };
}

function boundedInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function hashCanonicalInput(
  highWaterSeq: number,
  evidence: ActivityEvidenceItem[],
): string {
  const canonical = {
    version: PACK_VERSION,
    highWaterSeq,
    evidence: evidence.map((item) => ({
      ref: item.ref,
      eventId: item.eventId,
      seq: item.seq,
      occurredAtMs: item.occurredAtMs,
      source: item.source,
      projectName: item.projectName,
      title: item.title,
      kind: item.kind,
      lifecycle: item.lifecycle,
      severity: item.severity,
      summary: item.summary,
      evidenceHash: item.evidenceHash,
    })),
  };
  return createHash('sha256')
    .update(JSON.stringify(canonical))
    .digest('hex');
}
