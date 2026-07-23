import React from 'react';
import { Box, Text } from 'ink';
import { COLORS } from '../../config/defaults.js';

export function Header() {
  return (
    <Box>
      <Text color={COLORS.header2} bold>
        aside
      </Text>
      <Text color={COLORS.textDim}> — persistent side threads for your agents</Text>
    </Box>
  );
}
