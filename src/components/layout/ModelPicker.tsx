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
  /** Option rows to draw. The caller sizes this to the rows it actually allotted. */
  maxVisible?: number;
}

/**
 * Rows the picker spends on anything that isn't an option: box border (2),
 * title, the hint line, the "Current:" line, and the margin above the list.
 * Callers add this to their option count to reserve the right height — Ink
 * overlaps text rather than clipping it, so an under-sized box corrupts the
 * frame instead of just cropping it.
 */
export const MODEL_PICKER_CHROME_ROWS = 6;

export const MODEL_PICKER_MAX_VISIBLE = 7;

const CLEAR_PAD = 220;

function labelFor(option: ModelOption): string {
  const recommended = option.recommended ? ' (recommended)' : '';
  return `[${option.provider}] ${option.label ?? option.model}${recommended}`;
}

export function ModelPicker({
  options,
  selectedIndex,
  currentProvider,
  currentModel,
  maxVisible = MODEL_PICKER_MAX_VISIBLE,
}: ModelPickerProps) {
  if (options.length === 0) {
    return (
      <RetroBox title="MODEL PICKER" titleColor={COLORS.header1}>
        <Text color={COLORS.textDim}>No observer models are configured.</Text>
      </RetroBox>
    );
  }

  const safeSelectedIndex = Number.isFinite(selectedIndex) ? Math.trunc(selectedIndex) : 0;
  const normalizedSelected = ((safeSelectedIndex % options.length) + options.length) % options.length;
  const windowSize = Math.max(1, Math.trunc(maxVisible));
  // Keep highlight movement intuitive: move down through visible rows first,
  // then scroll once the cursor reaches the bottom of the visible window.
  const start = Math.max(0, Math.min(
    normalizedSelected - (windowSize - 1),
    Math.max(options.length - windowSize, 0)
  ));
  const visible = options.slice(start, start + windowSize);

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
