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
    source === 'pi' ? 'PI' :
    'OC';

  const color =
    source === 'claude' ? COLORS.badgeClaude :
    source === 'codex' ? COLORS.badgeCodex :
    source === 'pi' ? COLORS.badgePi :
    COLORS.badgeOpenCode;

  return (
    <Text color={color} bold>
      [{label}]
    </Text>
  );
}
