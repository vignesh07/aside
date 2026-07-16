import React from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import { COLORS } from '../../config/defaults.js';

interface ChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  focused: boolean;
}

export function ChatInput({ value, onChange, onSubmit, focused }: ChatInputProps) {
  return (
    <Box borderStyle="single" borderColor={focused ? COLORS.header2 : COLORS.border} paddingX={1}>
      <Text color={focused ? COLORS.header2 : COLORS.textDim}>{'› '}</Text>
      {focused ? (
        // Never disabled: "nothing is running" is a valid answer to a valid
        // question, so the chat stays open even with no sessions discovered.
        <TextInput
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          placeholder="ask about your agents…"
        />
      ) : (
        <Text color={COLORS.textDim}>press i to ask · tab to focus a session · q to quit</Text>
      )}
    </Box>
  );
}
