import React from 'react';
import { Text } from 'ink';
import { COLORS } from '../../config/defaults.js';
import type { ContextHealth } from '../../types/session.js';

interface PixelBarProps {
  percent: number;
  width?: number;
  status: ContextHealth;
}

const FILLED = '\u2588';  // █
const EMPTY = '\u2591';   // ░

export function PixelBar({ percent, width = 12, status }: PixelBarProps) {
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;

  const color =
    status === 'critical' ? COLORS.healthCritical :
    status === 'caution' ? COLORS.healthCaution :
    COLORS.healthSafe;

  return (
    <Text>
      <Text color={color}>{FILLED.repeat(filled)}</Text>
      <Text color={COLORS.textDim}>{EMPTY.repeat(empty)}</Text>
      <Text color={COLORS.textDim}> {percent}%</Text>
    </Text>
  );
}
