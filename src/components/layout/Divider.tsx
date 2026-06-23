import React from 'react';
import { Text } from 'ink';
import { COLORS } from '../../config/defaults.js';

export function Divider() {
  return <Text color={COLORS.border}>{'─'.repeat(70)}</Text>;
}
