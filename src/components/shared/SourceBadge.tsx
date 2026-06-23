import React from 'react';
import { Text } from 'ink';
import { COLORS } from '../../config/defaults.js';
import type { SessionSource } from '../../types/session.js';

interface SourceBadgeProps {
  source: SessionSource;
}

export function SourceBadge({ source }: SourceBadgeProps) {
  const label =
    source === 'claude' ? 'CC' :
    source === 'codex' ? 'CX' :
    'PI';

  const color =
    source === 'claude' ? COLORS.badgeClaude :
    source === 'codex' ? COLORS.badgeCodex :
    COLORS.badgePi;

  return (
    <Text color={color} bold>
      [{label}]
    </Text>
  );
}
