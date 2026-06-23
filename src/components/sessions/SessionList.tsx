import React from 'react';
import { Box, Text } from 'ink';
import { RetroBox } from '../shared/RetroBox.js';
import { SessionCard } from './SessionCard.js';
import { COLORS } from '../../config/defaults.js';
import type { TrackedSession } from '../../types/session.js';

interface SessionListProps {
  sessions: TrackedSession[];
  selectedId: string | null;
}

export function SessionList({ sessions, selectedId }: SessionListProps) {
  return (
    <RetroBox title="SESSIONS" titleColor={COLORS.header2}>
      {sessions.length === 0 ? (
        <Box flexDirection="column" paddingY={1}>
          <Text color={COLORS.textDim}>No active sessions</Text>
          <Text color={COLORS.textDim}>Waiting for agents...</Text>
        </Box>
      ) : (
        sessions.map((s) => (
          <SessionCard
            key={s.id}
            session={s}
            selected={s.id === selectedId}
          />
        ))
      )}
    </RetroBox>
  );
}
