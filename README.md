# Aside

**Persistent side chats for every AI coding-agent session on your machine.**

Aside discovers Claude Code, Codex, and Pi sessions without hooks. It gives you
one fleet-wide conversation plus a separate, durable conversation for each
session—answered by a model you choose, without adding noise to the agent's own
context.

[Website](https://aside.vgnsh.xyz) · [Download for macOS](https://aside.vgnsh.xyz#download)

Ask the fleet:

> What needs me? Is anything stuck? What changed while I was away?

Or open one session:

> Why did it choose this implementation? Catch me up. What does it need next?

The selected session is the chat scope, not merely a dashboard filter. Its side
thread, history, and observer model remain independent from every other thread.

## The product

- **Fleet thread.** Ask across recent agents and query-relevant history.
- **Machine-wide thread search.** Browse and filter every discovered Claude
  Code, Codex, and Pi transcript, including older threads with no recent writes.
- **Project hierarchy.** Threads are grouped by their working folder. Anything
  quiet for seven days or more sits under a collapsed **Older Threads** section
  but remains searchable.
- **Session side threads.** Select an agent and keep a persistent conversation
  about exactly that session.
- **Needs-you inbox.** Explicit input-request tools and likely direct questions
  surface in the thread list. The Mac app can notify when a session starts
  waiting for you.
- **Cross-vendor.** Claude Code, Codex CLI/Desktop, and Pi appear in one place.
- **Bring your observer.** In the Mac app, explicitly connect an existing
  ChatGPT or Claude account sign-in, or use local Ollama. The TUI also supports
  direct API providers. Model choice persists per thread.
- **Read-only.** Aside has no agent tools. It never sends messages into an agent,
  edits a project, or runs a command on the agent's behalf.

The distinction is deliberate: agent dashboards show state; Aside gives you a
second conversational context about the work, without steering the worker.

## What it can see

Aside reads the session logs these tools already keep on disk:

- Claude Code: `~/.claude/projects/**/*.jsonl` and the desktop session store
- Codex CLI/Desktop: `~/.codex/sessions/**/rollout-*.jsonl`
- Pi: `~/.pi/agent/sessions/**/*.jsonl`

It can explain observed prompts, model prose, tool calls, tool results, recent
activity, idle time, and context pressure.

It cannot see unrelated terminals, builds, containers, browser tabs, or anything
else on the machine. If the transcripts do not answer a question, the observer is
instructed to say so rather than guess.

## Privacy boundary

Aside is read-only, but an observer model still needs context to answer.

- Only the active scope is sent: recent sessions plus a bounded,
  query-relevant history slice for the fleet thread, or exactly one session for
  a session side thread. The full local catalog is never stuffed into a prompt.
- Common credential forms—private keys, provider/GitHub/Slack tokens, AWS access
  keys, JWTs, authorization headers, and generic secret assignments—are redacted
  immediately before a provider call.
- Redaction is a safety net, not a proof that arbitrary sensitive prose can
  always be recognized. Do not use a cloud observer on transcripts you are not
  comfortable sending to that provider.
- Choose `ollama` when transcript context must stay on the machine.
- Aside's own side-chat history is stored at `~/.aside/threads.json`. The
  directory is mode `0700` and the file is mode `0600`. The TUI and Mac app
  merge writes so they can run together without erasing each other's threads.
- Aside never reads or copies OAuth tokens from Claude Code, Codex, Keychain, or
  their auth files. It delegates account-backed replies to the installed vendor
  client in a sanitized child environment with API-key and token variables
  removed.

The Mac app shows this boundary on first run and keeps it available under
**Aside Settings**.

## How it works

```text
local transcript adapters
        │
        ▼
discover + tail Claude / Codex / Pi sessions
        │
        ├── normalized activity + needs-user signals ──► thread sidebar
        │
        ▼
fleet scope or one selected session
        │
        ▼
bounded context + secret redaction + durable thread history
        │
        ▼
observer model ──► TUI or macOS menubar app
```

Prompts have fixed roster and transcript bounds. Recent sessions stay in fleet
context; historical metadata and transcript tails are ranked against the
question. A session thread contains only its selected session. Idle time comes
from the clock rather than guessed transcript timestamps. “History” only means
the transcript is quiet—it does not claim the agent window was closed.

## Install

### macOS app

Download the current signed, notarized, and stapled preview:

| Mac | Download |
|---|---|
| Apple silicon (M1 or newer) | [Aside for Apple silicon](https://aside-production-fd82.up.railway.app/download/mac-arm64) |
| Intel | [Aside for Intel](https://aside-production-fd82.up.railway.app/download/mac-intel) |

Open the DMG, drag **Aside** to **Applications**, and launch it. Aside is a
menubar app, so it appears in the macOS menu bar rather than the Dock.
If macOS hides the icon behind the camera notch, open **Aside** again from
Spotlight or Applications; the existing app window will come forward instead
of starting a duplicate process.

On first launch, Aside detects whether the installed Codex and Claude clients
already have an account sign-in, but does not use either one automatically.
Choose **Use ChatGPT** or **Use Claude** to allow that client for Aside side
chats. **Disconnect** revokes only Aside's permission; it does not sign Codex,
Claude Code, ChatGPT, or Claude out on the rest of the Mac. Aside stores only
these allow/deny choices at `~/.aside/providers.json`, never a credential.

The [release manifest](https://aside-production-fd82.up.railway.app/releases/latest.json)
contains the current version, filenames, byte sizes, and SHA-256 checksums.
Installed builds download signed updates in the background and offer a
**Restart to Update** action when the next version is ready. A manual installer
remains available in **Aside Settings** if automatic updating fails.

### Developer harness

The terminal interface is an internal development harness for the shared
session core, not a distributed Aside product:

```bash
npm install
npm run check
npm start
```

Node.js 20 or newer is required.

## Developer harness usage

```bash
aside
aside --source codex
aside --project myrepo

# Observer options
aside --provider codex-cli
aside --provider ollama --model llama3.2
aside --provider openai --model gpt-4o-mini
```

The default observer delegates to your installed `claude` CLI with all tools
disabled. Claude Code retains responsibility for authentication and token
refresh. `codex-cli` similarly delegates to your installed Codex client.

API-backed providers use their normal environment variables:

| provider | credential |
|---|---|
| `claude-cli` | existing Claude Code login |
| `codex-cli` | existing Codex login |
| `ollama` | none; local inference |
| `anthropic` | `ANTHROPIC_API_KEY` |
| `openai` | `OPENAI_API_KEY` |

### TUI keys

| key | action |
|---|---|
| `i` or `/` | focus the side-chat input |
| `enter` | send |
| `esc` | leave the input/model picker |
| `tab`, `j`, `k` | move between fleet and session threads |
| `a` | return to the fleet thread |
| `m` | choose the observer model for this thread |
| `q` | quit |

### Dock beside an agent

```bash
aside dock
aside dock --side bottom
aside install --write
```

`aside dock` opens a tmux or iTerm2 split. `aside install --write` adds a tmux
binding at `<prefix> C-a`.

## macOS menubar app

The Mac app is a two-pane thread control room: sessions and attention states on
the left, the selected persistent conversation on the right.

Run it from source:

```bash
npm run build
cd menubar
npm install
npm start
```

Building the Mac app requires Node.js 22.12 or newer.

Useful development commands:

```bash
cd menubar
npm run bundle
npx electron build/main.js --show
npx electron build/main.js --capture /tmp/aside.png
```

Build packages:

```bash
cd menubar
npm run pack       # unpacked arm64 .app
npm run pack:x64   # unpacked x64 .app
npm run release    # signed/notarized/stapled arm64 + x64 DMGs and ZIPs
npm run verify:signing
```

The app is menubar-only (`LSUIElement`), with no Dock or Cmd-Tab entry. Click the
tray icon to open it; right-click for Aside Settings or Quit.

### Signing and notarization

Release builds use a Developer ID Application certificate and the `aside-notary`
Keychain profile. Credentials never live in the repository.

```bash
xcrun notarytool store-credentials "aside-notary" \
  --apple-id "<apple-id>" \
  --team-id 8ZS766K9K4 \
  --password "<app-specific-password>"
```

`npm run release` signs and notarizes the app, then signs and staples the DMGs.
`npm run verify:signing` checks the deep signature, hardened runtime,
entitlements, stapled tickets, and Gatekeeper verdict.

## Verification

```bash
npm run check                    # typecheck + clean-build test suite
npm audit --omit=dev             # production dependency audit
npm pack --dry-run               # inspect the npm artifact
node scripts/smoke.mjs           # real scanner/prompt/provider smoke path
node scripts/preview.mjs         # headless render of the actual TUI
```

GitHub Actions runs the clean test suite, production audits, npm pack dry run,
and both menubar TypeScript/bundle builds from a fresh checkout.

## Current status

The product path is implemented: discover and tail sessions, flag likely
attention requests, switch between fleet and per-session durable chats, keep a
different observer model per thread, and use the same core in TUI and Mac app.

The preview DMGs are distributed from a private Railway Bucket through stable
public download routes. The Mac app has explicit provider onboarding and
revocation: it recognizes account-backed Codex and Claude client sessions,
requires per-provider permission before any transcript context can be sent, and
keeps API-key-backed sessions out of the account-login path. Direct API providers
remain available only in the TUI.

## License

MIT
