# aside

A **read-only bird's-eye chat** for your AI coding agents. While Claude Code,
Codex, and others run, `aside` watches *all* of their sessions and lets you ask
questions across them — *without* interrupting or branching any main thread.

> "why did it edit that file?" · "what's running right now?" · "has anything
> been stuck for a while?" — ask `aside`, not the agent.

## Why

When you interrupt a coding agent to ask a clarifying question, the question and
its answer become part of the main context — costing tokens and sometimes
steering the agent off course. `aside` decouples the two: it observes your
sessions (read-only) and answers in a separate chat that the agents never see.

It's one chat over every session, not one chat per session. Run three agents
across three repos and ask "which of these is actually making progress?".

## What it can and can't see

**Can:** every agent session it can discover on disk — what each is doing, why
it went that way, how long it's been quiet, how much context it's burned.

**Can't:** anything else on your machine. Not your builds, containers, other
terminals, or browser tabs. It reads agent transcripts; that's the whole
mechanism. Ask it about a running `docker compose` and it will tell you that's
outside its view rather than guess.

## How it works

```
provider adapters → discover + tail every session's JSONL → normalize to events
                                                        ↓
                              roster (all sessions) + budgeted transcript detail
                                                        ↓
                          read-only context for an observer LLM (any provider)
                                                        ↓
                                            TUI  ·  macOS menubar
```

- **Watches** the same on-disk transcripts the agents already write:
  - Claude Code — `~/.claude/projects/**/*.jsonl` (+ the desktop app's store)
  - Codex CLI **and** Codex Desktop — `~/.codex/sessions/**/rollout-*.jsonl`
  - Pi — `~/.pi/agent/sessions/**/*.jsonl`
- **Read-only.** It opens transcripts for reading only and has no tools — it
  can never write to your sessions, files, or shell.
- **Two-tier context.** Every session gets a roster line (status, idle time,
  context usage) — cheap, and it's what answers "what's running?". Transcript
  detail is then allocated under a fixed character budget, ranked by focus and
  liveness, so ten sessions don't blow up (or dilute) the prompt. Anything
  dropped is stated in the prompt, never silently implied to be idle.
- **Idle is computed, not observed.** A session that does nothing writes nothing,
  so elapsed time can't come from a transcript. `aside` derives it from a real
  clock and hands it to the model explicitly.
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
| `tab` / `j` / `k` | focus a session (deepens its detail; never scopes the chat) |
| `q` | quit |

Selecting a session is never required — the chat always spans every session.
Focus just buys the highlighted one a bigger share of the transcript budget.

## Status

Working vertical slice: discover every session → live tail → ask one question
across all of them → answer, over Claude/Codex/Pi. Verify headlessly with:

```bash
node scripts/smoke.mjs
```

which prints the roster the model sees, the budgeted prompt size, and a real
cross-session answer.

To see the TUI itself without an interactive terminal — in a pipe, a CI log, or
an agent session with no TTY — render real frames with:

```bash
node scripts/preview.mjs                       # launch frame
node scripts/preview.mjs m                     # model picker open
node scripts/preview.mjs i "is it stuck?" ENTER --wait 25   # a real Q&A
```

This mounts the actual `<App/>` against your real sessions, so it catches
layout bugs that only appear at a given terminal size.

### Roadmap

- [x] launcher that opens the TUI as a docked tmux/iTerm split, with a tmux
      keybinding to summon it hands-free (`aside dock` / `aside install`)
- [x] shared, framework-agnostic `SideChatService` so every frontend reuses one
      implementation
- [x] bird's-eye view: one chat across every session, with a roster, derived idle
      time, and a budgeted two-tier prompt
- [~] macOS menubar frontend (`menubar/`) — builds + backend is unit-tested;
      tray/window not yet visually verified, no app packaging/icon yet
- [ ] model picker in the menubar UI (the TUI has one; menubar is fixed-model)
- [ ] richer transcript view (live feed of what the agents are doing) alongside chat
- [ ] proactive nudges ("session X has been stuck 20m") rather than only
      answering when asked

[`@mariozechner/pi-ai`]: https://www.npmjs.com/package/@mariozechner/pi-ai
