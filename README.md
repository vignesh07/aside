# aside

A **read-only side chat** for your AI coding agent. While Claude Code, Codex, or
another agent runs, `aside` watches its session and lets you ask questions about
it — *without* interrupting or branching the main thread.

> "by the way, why did it edit that file?" — ask `aside`, not the agent.

## Why

When you interrupt a coding agent to ask a clarifying question, the question and
its answer become part of the main context — costing tokens and sometimes
steering the agent off course. `aside` decouples the two: it observes the main
session (read-only) and answers in a separate chat that the agent never sees.

## How it works

```
provider adapters → discover + tail session JSONL → normalize to events
                                                        ↓
                          read-only context for a side-chat LLM (any provider)
                                                        ↓
                                                  TUI (this repo)
```

- **Watches** the same on-disk transcripts the agents already write:
  - Claude Code — `~/.claude/projects/**/*.jsonl` (+ the desktop app's store)
  - Codex CLI **and** Codex Desktop — `~/.codex/sessions/**/rollout-*.jsonl`
  - Pi — `~/.pi/agent/sessions/**/*.jsonl`
- **Read-only.** It opens transcripts for reading only and has no tools — it
  can never write to your session, files, or shell.
- **Any provider** for the chat itself (via [`@mariozechner/pi-ai`]). Defaults
  to Claude.

The session scanning, tailing, classification, session picker, and model picker
are reused from [`talkatui`](https://github.com/) — `aside` swaps the
auto-commentary engine for an interactive, read-only Q&A engine.

## Usage

```bash
npm install
npm run build
node dist/cli.js                 # or: npm start — run in the current pane

node dist/cli.js --source codex  # watch only Codex sessions
node dist/cli.js --project myrepo --provider openai --model gpt-4o-mini
```

### Docked side chat (the "chat bar in the same window" feel)

`aside` can't draw inside another app's terminal UI, so the docked feel is a
terminal split:

```bash
aside dock                 # open aside in a split pane (tmux or iTerm2)
aside dock --side bottom   # dock below instead of to the right
aside install --write      # bind <prefix> C-a in tmux to summon it hands-free
```

In tmux this is the real win: bind a key once with `aside install`, then summon
the side chat without ever leaving the agent in the other pane.

### macOS menubar (for the Codex / Claude desktop apps)

For the GUI agents, a TUI split doesn't fit — so there's an Electron menubar app
that reuses the **same** TS core (scanners, tailer, `SideChatService`):

```bash
npm run build            # build the shared core first
cd menubar && npm install && npm start
```

A dropdown hangs off the menubar with a session picker and the side chat. The
Electron main process drives `MenubarBackend` (a thin, Electron-free wrapper over
the core), so there's no duplicated logic between the TUI and the menubar.

Needs an API key for the chat provider (e.g. `ANTHROPIC_API_KEY`), or OAuth
credentials at `~/.pi/agent/auth.json`.

### Keys

| key | action |
|---|---|
| `i` or `/` | focus the chat input |
| `esc` | unfocus |
| `enter` | send |
| `m` | model picker |
| `tab` / `j` / `k` | switch session |
| `q` | quit |

## Status

Working vertical slice: discovery → live tail → ask a question → answer, across
Claude/Codex/Pi sessions. Verify the pipeline headlessly with:

```bash
node scripts/smoke.mjs
```

### Roadmap

- [x] launcher that opens the TUI as a docked tmux/iTerm split, with a tmux
      keybinding to summon it hands-free (`aside dock` / `aside install`)
- [x] shared, framework-agnostic `SideChatService` so every frontend reuses one
      implementation
- [~] macOS menubar frontend (`menubar/`) — builds + backend is unit-tested;
      tray/window not yet visually verified, no app packaging/icon yet
- [ ] model picker in the menubar UI (the TUI has one; menubar is fixed-model)
- [ ] richer transcript view (live feed of what the agent is doing) alongside chat

[`@mariozechner/pi-ai`]: https://www.npmjs.com/package/@mariozechner/pi-ai
