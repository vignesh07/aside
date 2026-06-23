import React from 'react';
import { Box, Text } from 'ink';
import { COLORS } from '../../config/defaults.js';

export function Header() {
  return (
    <Box>
      <Text color={COLORS.header2} bold>
        aside
      </Text>
      <Text color={COLORS.textDim}> — side chat for your agent session (read-only)</Text>
    </Box>
  );
}
