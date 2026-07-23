import React from 'react';
import { Box, Text } from 'ink';
import { COLORS } from '../../config/defaults.js';

interface FooterProps {
  provider: string;
  model: string;
  sessionCount: number;
}

export function Footer({ provider, model, sessionCount }: FooterProps) {
  return (
    <Box justifyContent="space-between">
      <Text color={COLORS.textDim}>
        {sessionCount} session{sessionCount === 1 ? '' : 's'} · a: fleet · m: thread model · i: ask · q: quit
      </Text>
      <Text color={COLORS.textDim}>
        {provider}/{model}
      </Text>
    </Box>
  );
}
