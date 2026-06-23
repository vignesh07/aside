import React from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import { COLORS } from '../../config/defaults.js';

interface ChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  focused: boolean;
  disabled: boolean;
}

export function ChatInput({ value, onChange, onSubmit, focused, disabled }: ChatInputProps) {
  return (
    <Box borderStyle="single" borderColor={focused ? COLORS.header2 : COLORS.border} paddingX={1}>
      <Text color={focused ? COLORS.header2 : COLORS.textDim}>{'› '}</Text>
      {focused ? (
        <TextInput
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          placeholder={disabled ? 'no session selected' : 'ask about this session…'}
        />
      ) : (
        <Text color={COLORS.textDim}>press i to ask · tab to switch session · q to quit</Text>
      )}
    </Box>
  );
}
