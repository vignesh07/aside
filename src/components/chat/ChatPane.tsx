import React from 'react';
import { Box, Text } from 'ink';
import { COLORS } from '../../config/defaults.js';
import { wrapText } from '../../utils/wrap-text.js';
import { stripMarkdown } from '../../utils/markdown.js';
import type { ChatTurn } from '../../types/chat.js';

interface ChatPaneProps {
  messages: ChatTurn[];
  isThinking: boolean;
  /** Scope line: how many sessions the observer can see, and which is focused. */
  watching: string | null;
  /** Scope-specific guidance shown before this durable thread has messages. */
  emptyHint?: string;
  /** Column width available for text, borders and padding already subtracted. */
  width: number;
  /** Rows available for the conversation. Content is clipped to the newest. */
  maxRows: number;
}

interface Line {
  key: string;
  text: string;
  color: string;
  bold?: boolean;
}

/**
 * The conversation, clipped to the newest `maxRows` rows.
 *
 * Clipping is the whole job here. Ink overlaps text that overflows its box
 * instead of cropping it, so an answer taller than the pane will paint straight
 * through the borders and the input below. Counting rows requires wrapping the
 * text ourselves (see {@link wrapText}) — Ink wraps too late for us to measure.
 */
export function ChatPane({
  messages,
  isThinking,
  watching,
  emptyHint = 'Ask what\'s running, what needs you, or select a session to open its persistent side chat.',
  width,
  maxRows,
}: ChatPaneProps) {
  const textWidth = Math.max(1, width);
  const lines: Line[] = [];

  if (messages.length === 0 && !isThinking) {
    for (const [i, text] of wrapText(emptyHint, textWidth).entries()) {
      lines.push({ key: `hint-${i}`, text, color: COLORS.textDim });
    }
  }

  for (const turn of messages) {
    lines.push({
      key: `${turn.id}-who`,
      text: turn.role === 'user' ? 'you' : 'aside',
      color: turn.role === 'user' ? COLORS.header2 : COLORS.badgeClaude,
      bold: true,
    });
    const color = turn.error ? COLORS.healthCritical : COLORS.textPrimary;
    // Ink paints literal text, so unrendered markdown would reach the user as
    // noise. Flatten before wrapping — the syntax would skew the line count too.
    for (const [i, text] of wrapText(stripMarkdown(turn.content), textWidth).entries()) {
      lines.push({ key: `${turn.id}-${i}`, text, color });
    }
    lines.push({ key: `${turn.id}-gap`, text: '', color: COLORS.textDim });
  }

  if (isThinking) {
    lines.push({ key: 'thinking', text: 'aside is thinking…', color: COLORS.live });
  }

  // Keep the tail: the newest turn is the one being read.
  const visible = lines.slice(-Math.max(1, maxRows));

  return (
    <Box flexDirection="column" flexGrow={1} minWidth={0}>
      {watching && (
        <Box marginBottom={1}>
          <Text color={COLORS.textDim} wrap="truncate-end">
            watching: {watching}
          </Text>
        </Box>
      )}
      {visible.map((line) => (
        <Text key={line.key} color={line.color} bold={line.bold} wrap="truncate-end">
          {line.text || ' '}
        </Text>
      ))}
    </Box>
  );
}
