import React, { useState, useRef } from 'react';
import { Box, useApp, useInput, useStdout } from 'ink';
import { Header } from './components/layout/Header.js';
import { Footer } from './components/layout/Footer.js';
import {
  ModelPicker,
  MODEL_PICKER_CHROME_ROWS,
  MODEL_PICKER_MAX_VISIBLE,
} from './components/layout/ModelPicker.js';
import {
  SessionList,
  SESSION_CARD_ROWS,
  SESSION_LIST_CHROME_ROWS,
} from './components/sessions/SessionList.js';
import { ChatPane } from './components/chat/ChatPane.js';
import { ChatInput } from './components/chat/ChatInput.js';
import { RetroBox } from './components/shared/RetroBox.js';
import { useSessions } from './hooks/use-sessions.js';
import { useSideChat } from './hooks/use-side-chat.js';
import { flattenModelCatalog, findModelOptionIndex } from './config/model-catalog.js';
import type { ScopeFilter } from './types/session.js';

export interface AppProps {
  provider: string;
  model: string;
  scopeFilter: ScopeFilter;
}

export function App({ provider, model, scopeFilter }: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const columns = Math.max((stdout?.columns ?? 80) - 1, 40);
  const rows = Math.max((stdout?.rows ?? 24) - 1, 12);

  const { sessions, selectedId, selectSession, selectNext, selectPrev, setSessionActivity, jsonlPaths } =
    useSessions(scopeFilter);

  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const modelOptionsRef = useRef(flattenModelCatalog());
  const [modelPickerIndex, setModelPickerIndex] = useState(() =>
    findModelOptionIndex(modelOptionsRef.current, provider, model),
  );

  const [inputFocused, setInputFocused] = useState(false);
  const [inputValue, setInputValue] = useState('');

  const {
    messages,
    isThinking,
    provider: currentProvider,
    model: currentModel,
    attentionBySession,
    ask,
    setModel,
  } = useSideChat({
    sessions,
    jsonlPaths,
    selectedSessionId: selectedId,
    defaultProvider: provider,
    defaultModel: model,
    onSessionActivity: setSessionActivity,
  });

  const focusedSession = sessions.find((s) => s.id === selectedId) ?? null;
  const needsUserCount = sessions.filter(
    (session) => attentionBySession.get(session.id)?.needsUser,
  ).length;
  const recentSessionCount = sessions.filter(
    (session) => session.status === 'active' || session.status === 'idle',
  ).length;
  const scopeLine =
    focusedSession
      ? `${focusedSession.source}/${focusedSession.projectName} · persistent session thread`
      : sessions.length === 0
        ? 'fleet thread · no agent sessions found'
        : `fleet thread · ${recentSessionCount} recent · ${sessions.length} total` +
          (needsUserCount > 0 ? ` · ${needsUserCount} need${needsUserCount === 1 ? 's' : ''} you` : '');
  const chatTitle = focusedSession ? `${focusedSession.projectName} · side chat` : 'fleet chat';
  const emptyHint = focusedSession
    ? `Ask about this ${focusedSession.source} session — what it changed, why it made a decision, or what it needs next. This thread stays with the session.`
    : 'Ask across recent agents or search historical work. Select a session to open its persistent side chat.';

  const handleSubmit = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    ask(trimmed);
    setInputValue('');
  };

  useInput((input, key) => {
    if (modelPickerOpen) {
      const optionCount = modelOptionsRef.current.length;
      if (key.escape || input === 'm') {
        setModelPickerOpen(false);
        return;
      }
      if (optionCount === 0) return;
      if (key.tab || key.downArrow || input === 'j') {
        setModelPickerIndex((prev) => (prev + 1) % optionCount);
        return;
      }
      if (key.upArrow || input === 'k') {
        setModelPickerIndex((prev) => (prev - 1 + optionCount) % optionCount);
        return;
      }
      if (key.return) {
        const picked = modelOptionsRef.current[modelPickerIndex];
        if (picked) {
          setModel(picked.provider, picked.model);
        }
        setModelPickerOpen(false);
      }
      return;
    }

    // While typing into the side chat, let TextInput own the keystrokes.
    if (inputFocused) {
      if (key.escape) setInputFocused(false);
      return;
    }

    if (input === 'q') {
      exit();
      return;
    }
    if (input === 'm') {
      setModelPickerIndex(findModelOptionIndex(modelOptionsRef.current, currentProvider, currentModel));
      setModelPickerOpen(true);
      return;
    }
    if (input === 'i' || input === '/') {
      setInputFocused(true);
      return;
    }
    if (input === 'a') {
      selectSession(null);
      return;
    }
    if (key.tab || key.downArrow || input === 'j') {
      selectNext();
      return;
    }
    if (key.upArrow || input === 'k') {
      selectPrev();
    }
  });

  // Height budgeting. Ink overlaps text that overflows a fixed-height Box rather
  // than clipping it, so every box here is sized to what its contents actually
  // need — and its contents are told how much room they got. Guessing a height
  // (the picker used to be a hardcoded 10 against ~13 rows of content) corrupts
  // the frame instead of cropping it.
  const inputRows = 3;
  const available = Math.max(rows - 1 /*header*/ - inputRows - 1 /*footer*/, 6);

  // The picker takes at most half the pane, and never more rows than it can fill.
  const pickerOptionRows = modelPickerOpen
    ? Math.max(1, Math.min(MODEL_PICKER_MAX_VISIBLE, Math.floor(available / 2) - MODEL_PICKER_CHROME_ROWS))
    : 0;
  const pickerRows = modelPickerOpen ? pickerOptionRows + MODEL_PICKER_CHROME_ROWS : 0;

  const contentRows = Math.max(available - pickerRows, 4);
  const FLEET_THREAD_ROWS = 3;
  const maxCards = Math.max(
    1,
    Math.floor(
      (contentRows - SESSION_LIST_CHROME_ROWS - FLEET_THREAD_ROWS) / SESSION_CARD_ROWS,
    ),
  );

  // Chat pane: RetroBox border (2) + title (1) + the "watching" line and its
  // margin (2). What's left is what the conversation may paint into.
  const CHAT_CHROME_ROWS = 5;
  const chatRows = Math.max(1, contentRows - CHAT_CHROME_ROWS);
  // 65% column, less the box border (2) and its horizontal padding (2).
  const chatWidth = Math.max(20, Math.floor(columns * 0.65) - 4);

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Header />

      {modelPickerOpen && (
        <Box height={pickerRows}>
          <ModelPicker
            options={modelOptionsRef.current}
            selectedIndex={modelPickerIndex}
            currentProvider={currentProvider}
            currentModel={currentModel}
            maxVisible={pickerOptionRows}
          />
        </Box>
      )}

      <Box flexDirection="row" height={contentRows}>
        <Box width="35%" minWidth={0}>
          <SessionList
            sessions={sessions}
            selectedId={selectedId}
            attentionBySession={attentionBySession}
            maxCards={maxCards}
          />
        </Box>
        <Box width="65%" minWidth={0}>
          <RetroBox title={chatTitle} height={contentRows}>
            <ChatPane
              messages={messages}
              isThinking={isThinking}
              watching={scopeLine}
              emptyHint={emptyHint}
              width={chatWidth}
              maxRows={chatRows}
            />
          </RetroBox>
        </Box>
      </Box>

      <ChatInput
        value={inputValue}
        onChange={setInputValue}
        onSubmit={handleSubmit}
        focused={inputFocused}
        scopeLabel={focusedSession?.projectName ?? 'all agents'}
      />

      <Footer provider={currentProvider} model={currentModel} sessionCount={sessions.length} />
    </Box>
  );
}
