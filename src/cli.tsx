#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import meow from 'meow';
import { App } from './app.js';
import { DEFAULT_PROVIDER, DEFAULT_MODEL, DEFAULT_AUTH_FILE } from './config/defaults.js';
import type { ScopeFilter, SessionSource } from './types/session.js';

const cli = meow(
  `
  Usage
    $ aside [options]

  A read-only side chat that watches your running agent session so you can ask
  questions about it without branching the main thread.

  Options
    -p, --provider     LLM provider for the side chat (pi-ai provider id, default: anthropic)
    -m, --model        Model id for the side chat (default: claude-haiku-4-5-20251001)
    --project          Watch only sessions for this project name
    --session          Watch a specific session id (repeatable)
    --source           Watch only "claude", "codex", or "pi" sessions
    --auth-file        OAuth credentials file path (default: ~/.pi/agent/auth.json)
    -v, --version      Show version
    -h, --help         Show help

  Environment Variables
    ANTHROPIC_API_KEY   Needed for --provider anthropic
    OPENAI_API_KEY      Needed for --provider openai
    GEMINI_API_KEY      Needed for --provider google

  Keybindings
    i or /   Focus the chat input (ask a question)
    esc      Unfocus the chat input
    enter    Send your question
    m        Open model picker
    tab / j  Next session
    k        Previous session
    q        Quit

  Examples
    $ aside
    $ aside --source codex
    $ aside --project myrepo --provider openai --model gpt-4o-mini
`,
  {
    importMeta: import.meta,
    flags: {
      provider: { type: 'string', shortFlag: 'p', default: DEFAULT_PROVIDER },
      model: { type: 'string', shortFlag: 'm', default: DEFAULT_MODEL },
      project: { type: 'string' },
      session: { type: 'string', isMultiple: true },
      source: { type: 'string' },
      authFile: { type: 'string', default: DEFAULT_AUTH_FILE },
    },
  },
);

const scopeFilter: ScopeFilter = {};
if (cli.flags.project) {
  scopeFilter.projectName = cli.flags.project;
}
if (cli.flags.session && cli.flags.session.length > 0) {
  scopeFilter.sessionIds = cli.flags.session;
}
if (cli.flags.source === 'claude' || cli.flags.source === 'codex' || cli.flags.source === 'pi') {
  scopeFilter.source = cli.flags.source as SessionSource;
}

render(
  <App
    provider={cli.flags.provider}
    model={cli.flags.model}
    scopeFilter={scopeFilter}
    authFile={cli.flags.authFile}
  />,
);
