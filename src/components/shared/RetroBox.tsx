import React from 'react';
import { Box, Text } from 'ink';
import { COLORS } from '../../config/defaults.js';

interface RetroBoxProps {
  title?: string;
  titleColor?: string;
  width?: number | string;
  height?: number | string;
  children: React.ReactNode;
}

export function RetroBox({ title, titleColor, width, height, children }: RetroBoxProps) {
  return (
    <Box
      flexDirection="column"
      width={width ?? '100%'}
      height={height}
      minWidth={0}
      borderStyle="single"
      borderColor={COLORS.border}
    >
      {title && (
        <Box marginLeft={1}>
          <Text color={titleColor ?? COLORS.header2} bold>
            {title}
          </Text>
        </Box>
      )}
      <Box flexDirection="column" paddingX={1} minWidth={0}>
        {children}
      </Box>
    </Box>
  );
}
