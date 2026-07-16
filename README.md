# aside

A **read-only bird's-eye chat** for your AI coding agents — **across vendors**.

`aside` watches every Claude Code, Codex, and Pi session on your machine at once
and answers questions about all of them in a single chat, without interrupting
or branching any of them.

> "why did it edit that file?" · "what's running right now?" · "has anything
> been stuck for a while?" — ask `aside`, not the agent.

```
you › what is each of my agents doing, and is anything stuck?

aside › fold (codex): Running isolation checks on the Electron app. Lint,
        typecheck and build passed; pnpm test:e2e just exited 1. Not stuck —
        actively diagnosing.

        aside (claude): Building both frontends. Quiet for 7s, but a build is
        still in progress. Not stuck — mid-build.

        Nothing looks stuck. Both are active and on track.
```

## Why

Two reasons.

**Asking costs you.** When you interrupt an agent to ask a clarifying question,
the question and its answer land in the main context — burning tokens and
sometimes steering the agent off course. `aside` decouples them: it observes
read-only and answers in a chat your agents never see.

**Nobody watches across vendors.** Claude Code's own agent view covers Claude
Code. Your Codex sessions are invisible to it, and always will be. `aside` reads
all of them through one mechanism, so "which of my agents is actually making
progress?" is a question you can ask once and have answered about everything.

It's one chat over every session, not one chat per session.

## What it can and can't see

**Can:** every agent session it can discover on disk — what each is doing, why
it went that way, how long it's been quiet, how much context it's burned.

**Can't:** anything else on your machine. Not your builds, containers, other
terminals, or browser tabs. It reads agent transcripts; that's the whole
mechanism. Ask it about a running `docker compose` and it will tell you that's
outside its view rather than guess.

## How it compares

There are good tools adjacent to this. They mostly *display state*; `aside`
*reasons about it*, and it does so across vendors.

| | scope | what it gives you |
|---|---|---|
| Claude Code agent view (`claude agents`) | Claude Code only | A live list of your sessions and which need input. Native, and better at this than any third party. |
| Observability dashboards (e.g. agents-observe, ai-observer) | varies; some cross-tool | Hook/OTel event streams, token and cost metrics, replay. |
| **aside** | **Claude Code + Codex + Pi, together** | **A chat. Ask "why did it pick that path?", "is that quiet a stall or is it waiting on me?", "which of these is actually progressing?"** |

If you only run Claude Code, use agent view — it's native and it's good. `aside`
earns its place when you run **more than one vendor** and want one thing that
understands all of them, or when you want the *why* rather than the *what*.

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

## Install

```bash
npm install -g @vignesh07/aside
aside
```

Or from source:

```bash
git clone https://github.com/vignesh07/aside.git
cd aside && npm install && npm run build
npm start
```

Needs an API key for the chat provider (e.g. `ANTHROPIC_API_KEY`), or OAuth
credentials at `~/.pi/agent/auth.json`. That key is only for the side chat —
`aside` reads your agents' transcripts straight off disk and needs no
credentials for them.

## Usage

```bash
aside                       # watch everything
aside --source codex        # watch only Codex sessions
aside --project myrepo      # scope to one project
aside --provider openai --model gpt-4o-mini   # pick the observer's model
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
that reuses the **same** TS core (scanners, tailer, `SideChatService`).

Run it from source:

```bash
npm run build                       # build the shared core first
cd menubar && npm install && npm start
```

Build a real `aside.app`:

```bash
cd menubar
npm run icons     # regenerate tray/app icons from the SVG sources (rarely needed)
npm run pack      # unpacked .app -> release/mac-arm64/aside.app
npm run dist      # DMG + zip, arm64 and x64 -> release/
```

It's a menubar-only app (`LSUIElement`) — no dock icon, no Cmd-Tab entry. Click
the bubble in the menubar to drop the chat down.

> **The app is unsigned.** There's no Apple Developer ID behind this, so it
> can't be notarized. macOS will refuse it on first launch ("cannot be opened
> because the developer cannot be verified"). Right-click → Open, or:
> ```bash
> xattr -dr com.apple.quarantine /Applications/aside.app
> ```
> Only do that because you built it or you trust the source. If this ever ships
> to people who aren't you, it needs signing + notarization first.

A dropdown hangs off the menubar with a session picker and the side chat. The
Electron main process drives `MenubarBackend` (a thin, Electron-free wrapper over
the core), so there's no duplicated logic between the TUI and the menubar.

To inspect it without clicking a tray icon (it hides on blur, so it can't be
screenshotted normally):

```bash
npx electron dist/main.js --show                        # pin it open
npx electron dist/main.js --capture /tmp/shot.png \
  --ask "is anything stuck?"                            # render, ask, screenshot, quit
```

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
- [x] macOS menubar frontend (`menubar/`), packaged as a real menubar-only
      `aside.app` with a tray icon — DMG/zip for arm64 + x64
- [ ] code signing + notarization (the app is currently unsigned; see above)
- [ ] model picker in the menubar UI (the TUI has one; menubar is fixed-model)
- [ ] richer transcript view (live feed of what the agents are doing) alongside chat
- [ ] proactive nudges ("session X has been stuck 20m") rather than only
      answering when asked

[`@mariozechner/pi-ai`]: https://www.npmjs.com/package/@mariozechner/pi-ai
