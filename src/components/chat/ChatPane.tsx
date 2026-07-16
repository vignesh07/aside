import React from 'react';
import { Box, Text } from 'ink';
import { COLORS } from '../../config/defaults.js';
import type { ChatTurn } from '../../types/chat.js';

interface ChatPaneProps {
  messages: ChatTurn[];
  isThinking: boolean;
  /** Scope line: how many sessions the observer can see, and which is focused. */
  watching: string | null;
  /** How many turns fit; older turns scroll off the top. */
  maxVisible: number;
}

export function ChatPane({ messages, isThinking, watching, maxVisible }: ChatPaneProps) {
  const visible = messages.slice(-maxVisible);

  return (
    <Box flexDirection="column" flexGrow={1} minWidth={0}>
      {watching && (
        <Box marginBottom={1}>
          <Text color={COLORS.textDim} wrap="truncate-end">
            watching: {watching}
          </Text>
        </Box>
      )}

      {messages.length === 0 && !isThinking && (
        <Text color={COLORS.textDim}>
          Ask about any of your agents — "what's running?", "why did it edit that
          file?", "is anything stuck?". One chat, all sessions. It only observes;
          your agents never see this.
        </Text>
      )}

      {visible.map((turn) => (
        <Box key={turn.id} flexDirection="column" marginBottom={1}>
          <Text bold color={turn.role === 'user' ? COLORS.header2 : COLORS.badgeClaude}>
            {turn.role === 'user' ? 'you' : 'aside'}
          </Text>
          <Text color={turn.error ? COLORS.healthCritical : COLORS.textPrimary} wrap="wrap">
            {turn.content}
          </Text>
        </Box>
      ))}

      {isThinking && <Text color={COLORS.live}>aside is thinking…</Text>}
    </Box>
  );
}
