import React from 'react';
import { Box, Text } from 'ink';
import { RetroBox } from '../shared/RetroBox.js';
import { SessionCard } from './SessionCard.js';
import { COLORS } from '../../config/defaults.js';
import type { TrackedSession } from '../../types/session.js';
import type { SessionAttention } from '../../types/session.js';

interface SessionListProps {
  sessions: TrackedSession[];
  selectedId: string | null;
  attentionBySession: Map<string, SessionAttention>;
  /** Cards to draw. The caller sizes this to the rows it actually allotted. */
  maxCards?: number;
}

/** Rows one card occupies: name, model, context bar, activity, and its margin. */
export const SESSION_CARD_ROWS = 5;

/** Rows the list spends on chrome: box border (2) plus the title. */
export const SESSION_LIST_CHROME_ROWS = 3;

export function SessionList({
  sessions,
  selectedId,
  attentionBySession,
  maxCards,
}: SessionListProps) {
  // Ink overlaps overflowing text instead of clipping it, so drawing more cards
  // than fit corrupts the frame. Cap the list and account for what's hidden.
  const limit = Math.max(1, Math.trunc(maxCards ?? sessions.length));
  const overflowing = sessions.length > limit;
  // Reserve a row for the "+N more" line so it can't itself overflow.
  const visible = overflowing ? sessions.slice(0, Math.max(1, limit - 1)) : sessions;
  const hidden = sessions.length - visible.length;
  const needsUser = sessions.filter(
    (session) => attentionBySession.get(session.id)?.needsUser,
  ).length;

  return (
    <RetroBox title="THREADS" titleColor={COLORS.header2}>
      <Box flexDirection="column" marginBottom={1}>
        <Text color={selectedId === null ? COLORS.header2 : COLORS.textPrimary} bold>
          {selectedId === null ? '> ' : '  '}◎ all agents
        </Text>
        <Text color={needsUser > 0 ? COLORS.healthCaution : COLORS.textDim}>
          {'   '}{needsUser > 0 ? `${needsUser} need${needsUser === 1 ? 's' : ''} you` : `${sessions.length} total`}
        </Text>
      </Box>
      {sessions.length === 0 ? (
        <Box flexDirection="column" paddingY={1}>
          <Text color={COLORS.textDim}>No agent threads</Text>
          <Text color={COLORS.textDim}>Waiting for agents...</Text>
        </Box>
      ) : (
        <>
          {visible.map((s) => (
            <SessionCard
              key={s.id}
              session={s}
              selected={s.id === selectedId}
              attention={attentionBySession.get(s.id)}
            />
          ))}
          {hidden > 0 && (
            // Named, not silently dropped: the chat still sees every session,
            // so the list must not imply these stopped existing.
            <Text color={COLORS.textDim} wrap="truncate-end">
              +{hidden} more threads
            </Text>
          )}
        </>
      )}
    </RetroBox>
  );
}
