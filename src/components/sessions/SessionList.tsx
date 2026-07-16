import React from 'react';
import { Box, Text } from 'ink';
import { RetroBox } from '../shared/RetroBox.js';
import { SessionCard } from './SessionCard.js';
import { COLORS } from '../../config/defaults.js';
import type { TrackedSession } from '../../types/session.js';

interface SessionListProps {
  sessions: TrackedSession[];
  selectedId: string | null;
  /** Cards to draw. The caller sizes this to the rows it actually allotted. */
  maxCards?: number;
}

/** Rows one card occupies: name, model, context bar, activity, and its margin. */
export const SESSION_CARD_ROWS = 5;

/** Rows the list spends on chrome: box border (2) plus the title. */
export const SESSION_LIST_CHROME_ROWS = 3;

export function SessionList({ sessions, selectedId, maxCards }: SessionListProps) {
  // Ink overlaps overflowing text instead of clipping it, so drawing more cards
  // than fit corrupts the frame. Cap the list and account for what's hidden.
  const limit = Math.max(1, Math.trunc(maxCards ?? sessions.length));
  const overflowing = sessions.length > limit;
  // Reserve a row for the "+N more" line so it can't itself overflow.
  const visible = overflowing ? sessions.slice(0, Math.max(1, limit - 1)) : sessions;
  const hidden = sessions.length - visible.length;

  return (
    <RetroBox title="SESSIONS" titleColor={COLORS.header2}>
      {sessions.length === 0 ? (
        <Box flexDirection="column" paddingY={1}>
          <Text color={COLORS.textDim}>No active sessions</Text>
          <Text color={COLORS.textDim}>Waiting for agents...</Text>
        </Box>
      ) : (
        <>
          {visible.map((s) => (
            <SessionCard key={s.id} session={s} selected={s.id === selectedId} />
          ))}
          {hidden > 0 && (
            // Named, not silently dropped: the chat still sees every session,
            // so the list must not imply these stopped existing.
            <Text color={COLORS.textDim} wrap="truncate-end">
              +{hidden} more (still watched)
            </Text>
          )}
        </>
      )}
    </RetroBox>
  );
}
