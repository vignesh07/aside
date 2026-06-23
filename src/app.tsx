import React, { useState, useRef } from 'react';
import { Box, useApp, useInput, useStdout } from 'ink';
import { Header } from './components/layout/Header.js';
import { Footer } from './components/layout/Footer.js';
import { ModelPicker } from './components/layout/ModelPicker.js';
import { SessionList } from './components/sessions/SessionList.js';
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
  authFile?: string;
}

export function App({ provider, model, scopeFilter, authFile }: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const columns = Math.max((stdout?.columns ?? 80) - 1, 40);
  const rows = Math.max((stdout?.rows ?? 24) - 1, 12);

  const { sessions, selectedId, selectNext, selectPrev, setSessionActivity, jsonlPaths } =
    useSessions(scopeFilter);

  const [currentProvider, setCurrentProvider] = useState(provider);
  const [currentModel, setCurrentModel] = useState(model);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const modelOptionsRef = useRef(flattenModelCatalog());
  const [modelPickerIndex, setModelPickerIndex] = useState(() =>
    findModelOptionIndex(modelOptionsRef.current, provider, model),
  );

  const [inputFocused, setInputFocused] = useState(false);
  const [inputValue, setInputValue] = useState('');

  const { messages, isThinking, ask } = useSideChat({
    sessions,
    jsonlPaths,
    selectedId,
    provider: currentProvider,
    model: currentModel,
    authFile,
    onSessionActivity: setSessionActivity,
  });

  const selectedSession = sessions.find((s) => s.id === selectedId) ?? null;

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
          setCurrentProvider(picked.provider);
          setCurrentModel(picked.model);
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
    if (key.tab || key.downArrow || input === 'j') {
      selectNext();
      return;
    }
    if (key.upArrow || input === 'k') {
      selectPrev();
    }
  });

  const pickerRows = modelPickerOpen ? 10 : 0;
  const inputRows = 3;
  const chromeRows = 1 /*header*/ + pickerRows + inputRows + 1 /*footer*/;
  const contentRows = Math.max(rows - chromeRows, 6);
  const maxVisible = Math.max(Math.floor(contentRows / 3), 3);

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
          />
        </Box>
      )}

      <Box flexDirection="row" height={contentRows}>
        <Box width="35%" minWidth={0}>
          <SessionList sessions={sessions} selectedId={selectedId} />
        </Box>
        <Box width="65%" minWidth={0}>
          <RetroBox title="side chat" height={contentRows}>
            <ChatPane
              messages={messages}
              isThinking={isThinking}
              watching={selectedSession?.currentActivity ?? null}
              maxVisible={maxVisible}
            />
          </RetroBox>
        </Box>
      </Box>

      <ChatInput
        value={inputValue}
        onChange={setInputValue}
        onSubmit={handleSubmit}
        focused={inputFocused}
        disabled={!selectedId}
      />

      <Footer provider={currentProvider} model={currentModel} sessionCount={sessions.length} />
    </Box>
  );
}
