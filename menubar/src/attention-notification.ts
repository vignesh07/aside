export interface AttentionNotificationCandidate {
  /** Provider-qualified durable thread identity (`session:<source>:<id>`). */
  threadId: string;
  status: 'active' | 'idle' | 'history';
  needsUser: boolean;
  isInternal?: boolean;
}

/**
 * Historical attention is an inbox signal, not a new live event. Restrict
 * system notifications to newly waiting live sessions so restart recovery
 * cannot create a stale alert storm.
 */
export function shouldNotifyForAttention(
  session: AttentionNotificationCandidate,
  previouslyWaiting: ReadonlySet<string>,
): boolean {
  return (
    !session.isInternal &&
    (session.status === 'active' || session.status === 'idle') &&
    session.needsUser &&
    !previouslyWaiting.has(session.threadId)
  );
}
