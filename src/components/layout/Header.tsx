import React from 'react';
import { Box, Text } from 'ink';
import { COLORS } from '../../config/defaults.js';

export function Header() {
  return (
    <Box>
      <Text color={COLORS.header2} bold>
        aside
      </Text>
      <Text color={COLORS.textDim}> — read-only bird's-eye chat for your agents</Text>
    </Box>
  );
}
