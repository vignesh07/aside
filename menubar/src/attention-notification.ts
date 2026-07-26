export interface AttentionNotificationCandidate {
  id: string;
  status: 'active' | 'idle' | 'history';
  needsUser: boolean;
  attentionKind?: 'none' | 'waiting' | 'failed' | 'interrupted' | 'completed' | 'stalled' | 'forgotten';
  attentionUnread?: boolean;
  attentionObservedLive?: boolean;
  isInternal?: boolean;
}

export function attentionNotificationKey(
  session: AttentionNotificationCandidate,
): string | null {
  if (session.attentionObservedLive !== true) return null;
  const kind = session.needsUser ? 'waiting' : session.attentionKind;
  if (
    kind !== 'waiting' &&
    kind !== 'completed' &&
    kind !== 'failed' &&
    kind !== 'interrupted'
  ) {
    return null;
  }
  if (kind !== 'waiting' && !session.attentionUnread) return null;
  return `${session.id}:${kind}`;
}

/**
 * Historical attention is an inbox signal, not a new live event. Restrict
 * system notifications to newly waiting live sessions so restart recovery
 * cannot create a stale alert storm.
 */
export function shouldNotifyForAttention(
  session: AttentionNotificationCandidate,
  previouslyNotified: ReadonlySet<string>,
): boolean {
  const key = attentionNotificationKey(session);
  return (
    !session.isInternal &&
    (session.status === 'active' || session.status === 'idle') &&
    key !== null &&
    !previouslyNotified.has(key)
  );
}
