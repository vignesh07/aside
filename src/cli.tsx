#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import meow from 'meow';
import { App } from './app.js';
import { DEFAULT_PROVIDER, DEFAULT_MODEL } from './config/defaults.js';
import type { ScopeFilter, SessionSource } from './types/session.js';

const cli = meow(
  `
  Usage
    $ aside [options]            Run the side chat in the current pane
    $ aside dock [options]       Open the side chat in a docked split (tmux / iTerm2)
    $ aside install [--write]    Add a tmux key (<prefix> C-a) to summon the dock

  A read-only bird's-eye chat for your AI coding agents. Watches every Claude
  Code, Codex and Pi session on this machine and answers questions across all
  of them — "what's running?", "why did it pick that path?", "is anything
  stuck?" — without interrupting or branching any of them.

  It only ever reads. It has no tools and cannot touch your sessions.

  Options
    -p, --provider     Who answers: claude-cli (default), ollama, anthropic, openai
    -m, --model        Model id for the side chat (default: claude-haiku-4-5-20251001)
    --project          Watch only sessions for this project name
    --session          Watch a specific session id (repeatable)
    --source           Watch only "claude", "codex", or "pi" sessions
    --side             Dock side: "right" (default) or "bottom"
    --size             Dock pane size (default: 40%)
    --write            (install) append the binding to ~/.tmux.conf
    -v, --version      Show version
    -h, --help         Show help

  Credentials
    No API key needed. By default aside answers by running your own "claude"
    CLI (with all tools disabled), so it uses the Claude Code login you already
    have. It never reads your tokens — Claude Code stays in charge of auth.

    --provider ollama     a local model: no key, and nothing leaves the machine
    --provider anthropic  ANTHROPIC_API_KEY, if you'd rather use an API key
    --provider openai     OPENAI_API_KEY

    Reading your agents' transcripts needs no credential at all — those are just
    files on disk. Credentials only matter for the observer's own answers.

  Keybindings
    i or /   Focus the chat input (ask a question)
    esc      Unfocus the chat input
    enter    Send your question
    m        Open model picker
    tab / j  Focus next session (deepens its detail; the chat spans them all)
    k        Focus previous session
    q        Quit

  Examples
    $ aside
    $ aside --source codex
    $ aside dock --source codex          # docked split beside your agent
    $ aside install --write              # bind <prefix> C-a to summon it
    $ aside --project myrepo --provider openai --model gpt-4o-mini
    $ aside --provider ollama --model llama3.2   # local, no API key
`,
  {
    importMeta: import.meta,
    // The help text opens with its own summary; meow would otherwise print the
    // package.json description above it and say the same thing twice.
    description: false,
    flags: {
      provider: { type: 'string', shortFlag: 'p', default: DEFAULT_PROVIDER },
      model: { type: 'string', shortFlag: 'm', default: DEFAULT_MODEL },
      project: { type: 'string' },
      session: { type: 'string', isMultiple: true },
      source: { type: 'string' },
      side: { type: 'string', default: 'right' },
      size: { type: 'string', default: '40%' },
      write: { type: 'boolean', default: false },
    },
  },
);

const command = cli.input[0];

// `install` doesn't need session flags — handle it first.
if (command === 'install') {
  const { installTmux } = await import('./launcher.js');
  process.exit(installTmux(cli.flags.write));
}

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

// `dock` opens the TUI in a split pane and forwards the same scope/model flags.
if (command === 'dock') {
  const { dock, buildDockArgs } = await import('./launcher.js');
  const args = buildDockArgs(cli.flags, {
    provider: DEFAULT_PROVIDER,
    model: DEFAULT_MODEL,
  });
  const side = cli.flags.side === 'bottom' ? 'bottom' : 'right';
  process.exit(dock({ args, side, size: cli.flags.size }));
}

render(
  <App
    provider={cli.flags.provider}
    model={cli.flags.model}
    scopeFilter={scopeFilter}
  />,
);
