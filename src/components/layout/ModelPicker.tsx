import React from 'react';
import { Box, Text } from 'ink';
import { RetroBox } from '../shared/RetroBox.js';
import { COLORS } from '../../config/defaults.js';
import type { ModelOption } from '../../config/model-catalog.js';

interface ModelPickerProps {
  options: ModelOption[];
  selectedIndex: number;
  currentProvider: string;
  currentModel: string;
}

const MAX_VISIBLE = 7;
const CLEAR_PAD = 220;

function labelFor(option: ModelOption): string {
  const recommended = option.recommended ? ' (recommended)' : '';
  return `[${option.provider}] ${option.label ?? option.model}${recommended}`;
}

export function ModelPicker({ options, selectedIndex, currentProvider, currentModel }: ModelPickerProps) {
  if (options.length === 0) {
    return (
      <RetroBox title="MODEL PICKER" titleColor={COLORS.header1}>
        <Text color={COLORS.textDim}>No models available from pi-ai.</Text>
      </RetroBox>
    );
  }

  const safeSelectedIndex = Number.isFinite(selectedIndex) ? Math.trunc(selectedIndex) : 0;
  const normalizedSelected = ((safeSelectedIndex % options.length) + options.length) % options.length;
  // Keep highlight movement intuitive: move down through visible rows first,
  // then scroll once the cursor reaches the bottom of the visible window.
  const start = Math.max(0, Math.min(
    normalizedSelected - (MAX_VISIBLE - 1),
    Math.max(options.length - MAX_VISIBLE, 0)
  ));
  const visible = options.slice(start, start + MAX_VISIBLE);

  return (
    <RetroBox title="MODEL PICKER" titleColor={COLORS.header1}>
      <Text color={COLORS.textDim}>enter: select  esc: cancel  up/down/j/k: navigate</Text>
      <Text color={COLORS.textDim} wrap="truncate-end">
        Current: [{currentProvider}] {currentModel}
      </Text>
      <Box marginTop={1} flexDirection="column">
        {visible.map((opt, i) => {
          const absoluteIndex = start + i;
          const selected = absoluteIndex === normalizedSelected;
          const color = selected ? COLORS.header2 : COLORS.textDim;
          const prefix = selected ? '>>' : '  ';
          const rowText = `${prefix} ${labelFor(opt)}`.padEnd(CLEAR_PAD, ' ');
          return (
            <Text
              key={`${opt.provider}:${opt.model}`}
              color={color}
              bold={selected}
              wrap="truncate-end"
            >
              {rowText}
            </Text>
          );
        })}
      </Box>
    </RetroBox>
  );
}
