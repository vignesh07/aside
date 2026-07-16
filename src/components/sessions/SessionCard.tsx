import React from 'react';
import { Box, Text } from 'ink';
import { COLORS } from '../../config/defaults.js';
import { SourceBadge } from '../shared/SourceBadge.js';
import { PixelBar } from '../shared/PixelBar.js';
import { timeAgo } from '../../utils/time-ago.js';
import type { TrackedSession } from '../../types/session.js';

interface SessionCardProps {
  session: TrackedSession;
  selected: boolean;
}

export function SessionCard({ session, selected }: SessionCardProps) {
  const statusIcon =
    session.status === 'active' ? '*' :
    session.status === 'idle' ? 'z' :
    'x';

  const nameColor =
    session.status === 'active' ? COLORS.sessionActive :
    session.status === 'idle' ? COLORS.sessionIdle :
    COLORS.sessionEnded;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={COLORS.header2}>{selected ? '> ' : '  '}</Text>
        <SourceBadge source={session.source} />
        <Text> </Text>
        <Text color={nameColor} bold wrap="truncate-end">{session.projectName}</Text>
        <Text color={COLORS.textDim} wrap="truncate-end"> ({session.gitBranch})</Text>
      </Box>
      <Box marginLeft={3} flexDirection="column">
        <Text color={COLORS.textDim} wrap="truncate-end">{session.model}</Text>
        {session.source === 'claude' && (
          <PixelBar
            percent={session.usedPercent}
            status={session.contextStatus}
          />
        )}
        <Text wrap="truncate-end">
          <Text>{statusIcon} </Text>
          <Text color={COLORS.textDim}>
            {session.status === 'active'
              ? // Falls back to a word: a bare status icon on an empty line reads
                // as a rendering glitch rather than "running, nothing seen yet".
                session.currentActivity || 'active'
              : `${session.status === 'idle' ? 'Idle' : 'Ended'} ${timeAgo(session.lastEventTime)}`}
          </Text>
        </Text>
      </Box>
    </Box>
  );
}
