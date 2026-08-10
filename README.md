# Aside

**Persistent side chats for every AI coding-agent session on your machine.**

Aside discovers Claude Code, Codex, Pi, and OpenCode sessions without hooks. It
gives you one fleet-wide conversation plus a separate, durable conversation for
each session—answered by a model you choose, without adding noise to the
agent's own context.

[Website](https://aside.vgnsh.xyz) · [Download for macOS](https://aside.vgnsh.xyz#download)

Ask the fleet:

> What needs me? Is anything stuck? What changed while I was away?

Or open one session:

> Why did it choose this implementation? Catch me up. What does it need next?

The selected session is the chat scope, not merely a dashboard filter. Its side
thread, history, and observer model remain independent from every other thread.

## The product

- **Today diary.** Opening **Today** gives you an immediate local digest. After
  a one-time permission for the selected observer, it prepares one generated
  recap when the saved recap is missing or stale. The supporting work stays
  grouped by project and thread, with waiting and ready-to-review states kept
  visible.
- **Local usage history.** Open **Usage** beside Today for a 90-day or one-year
  view of token and model activity across Codex, Claude Code, Pi, and OpenCode
  where logs expose it. Cost figures are API-equivalent estimates, not
  invoices; local runs show local-model equivalents.
- **Fleet thread.** Ask across recent agents and query-relevant history.
- **Machine-wide full-content search.** Search user prompts, agent replies,
  commands, file targets, failures, and Aside side chats across every discovered
  Claude Code, Codex, Pi, and OpenCode transcript—including older threads with
  no recent writes.
- **Project hierarchy.** Threads are grouped by their working folder. Anything
  quiet for seven days or more sits under a collapsed **Older Threads** section
  but remains searchable. Codex and Claude Code subagents stay searchable and
  appear folded beneath their parent task; they can be hidden from the thread
  list in **Aside Settings** without removing them from search.
- **Session side threads.** Select an agent and keep a persistent conversation
  about exactly that session.
- **Needs-you inbox.** Explicit input-request tools and likely direct questions
  surface in the thread list. The Mac app can notify when a session starts
  waiting for you.
- **Cross-vendor.** Claude Code, Codex CLI/Desktop, Pi, and OpenCode appear in
  one place.
- **Bring your observer.** In the Mac app, explicitly allow an existing Codex
  or Claude Code sign-in, choose any exact model route Pi reports or one of the
  source-audited OpenCode routes Aside supports, or use local Ollama. The TUI
  also supports direct API providers. Model choice persists per thread.
- **Read-only.** Aside has no agent tools. It never sends messages into an agent,
  edits a project, or runs a command on the agent's behalf.

The distinction is deliberate: agent dashboards show state; Aside gives you a
second conversational context about the work, without steering the worker.

## What it can see

Aside reads the session logs these tools already keep on disk:

- Claude Code: `~/.claude/projects/**/*.jsonl` and the desktop session store
- Codex CLI/Desktop: `~/.codex/sessions/**/rollout-*.jsonl`
- Pi: `~/.pi/agent/sessions/**/*.jsonl`
- OpenCode: its local session database (plus legacy local session storage)

It can explain observed prompts, model prose, tool calls, tool results, recent
activity, idle time, and context pressure.

It cannot see unrelated terminals, builds, containers, browser tabs, or anything
else on the machine. If the transcripts do not answer a question, the observer is
instructed to say so rather than guess.

## Privacy boundary

Aside is read-only, but an observer model still needs context to answer or
prepare a Today recap.

- Provider-bound scope is explicit and bounded: recent sessions plus a
  query-relevant history slice for the fleet thread, exactly one session for a
  session side thread, or a curated set of meaningful activity from the local
  day for Today. The full local catalog is never stuffed into a prompt.
- Aside asks separately before Today may use a cloud observer. After that
  permission, opening Today is the generation action. Aside does not create
  recaps at startup or continuously as tool events arrive, and it reuses a
  current saved recap instead of repeating the same provider call.
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
- Normalized activity facts are stored at `~/.aside/activity.sqlite`; raw
  transcript records are not copied into it. Generated recaps and reviews are
  stored at `~/.aside/generated-artifacts.json`. Both are private to the local
  user.
- Full-content search is backed by a rebuildable local index at
  `~/.aside/search.sqlite`. Indexed text is redacted with the same common-secret
  safety net used before provider calls, and search queries never leave the
  machine.
- OpenCode stores current sessions in SQLite. Aside projects the transcript
  fields it supports into private, rebuildable JSONL files under
  `~/.aside/opencode-cache` so those sessions can use the same search, attention,
  and side-chat pipeline. The cache is mode `0700`/`0600`, excludes successful
  tool output and reasoning, rewrites when source content changes, and prunes
  entries when Aside observes their source sessions being deleted in OpenCode.
- Claude Code, Codex, Pi, and OpenCode retain ownership of account setup. Aside
  invokes the selected client in a sanitized child environment with shell API-key
  and token variables removed. OpenCode support is limited to credential-free
  Zen routes and API credentials configured in OpenCode for the selected
  provider; OAuth and well-known credential routes are not supported in this
  release.
- After explicit OpenCode consent, Aside locally reads the private OpenCode auth
  file to filter provider IDs and credential types. Model discovery receives a
  temporary `0600` snapshot containing API entries only. A side-chat request
  receives either an empty snapshot for Zen or only the selected provider's API
  entry. Aside never modifies the canonical auth file, persists these snapshots,
  or sends a credential itself; the audited OpenCode child uses it for the chosen
  upstream route and the snapshot is removed with the isolated runtime.
- Using Pi as the observer sends the scoped, redacted context to the exact
  upstream provider/model named in Aside’s picker. It starts an isolated,
  sessionless Pi request; it never resumes or writes to the Pi session being
  observed.
- Using OpenCode as the observer also pins the exact upstream provider/model.
  Aside only offers the route when the installed OpenCode client can satisfy
  the app's isolated, tool-free observer contract. The observer does not load
  project or user `opencode.json`, user/external plugins, custom endpoint routes,
  or shell API-key variables. Each offered route must match a conservative
  route-metadata matrix plus the audited behavior of the exact supported
  OpenCode build.

The Mac app shows this boundary on first run and keeps it available under
**Aside Settings**.

## How it works

```text
local transcript adapters
        │
        ▼
discover + tail Claude / Codex / Pi / OpenCode sessions
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
| Apple silicon (M1 or newer) | [Aside for Apple silicon](https://aside.vgnsh.xyz/download/mac-arm64) |
| Intel | [Aside for Intel](https://aside.vgnsh.xyz/download/mac-intel) |

Open the DMG, drag **Aside** to **Applications**, and launch it. Aside is a
menubar app, so it appears in the macOS menu bar rather than the Dock.
If macOS hides the icon behind the camera notch, open **Aside** again from
Spotlight or Applications; the existing app window will come forward instead
of starting a duplicate process.

On first launch, Aside detects whether the installed Codex and Claude Code
clients have an account sign-in and whether Pi has available model routes. It
checks only OpenCode's executable and exact supported version until you choose
**Use OpenCode**. Choose **Use
Codex**, **Use Claude Code**, **Use Pi**, or **Use OpenCode** to allow that
client for Aside side chats. **Disconnect** revokes only Aside's permission; it
does not sign those clients out or change Pi's or OpenCode's accounts and
settings.
Today asks separately before it may prepare cloud recaps automatically when
opened. Aside stores only these allow/deny choices at
`~/.aside/providers.json`, never a credential.

For Pi, configure one or more accounts in Pi itself with `/login`. Aside lists
every provider/model Pi reports as available, but deliberately does not inherit
shell-only API-key environment variables. Each Aside thread stores an exact Pi
provider/model; changing Pi's default does not reroute existing threads. Its
isolated observer path requires a current Pi release with `--no-context-files`;
the in-app **Setup Guide** covers setup and updates.

For OpenCode, configure provider access in OpenCode itself. Aside currently
audits the exact OpenCode `1.18.15` CLI contract. It reconstructs a sterile,
tool-free observer and lists only credential-free Zen routes or selected-provider
API-key routes in Aside's conservative source-audited matrix. OAuth and
well-known credential routes are not supported in this release. The observer
does not load user/project `opencode.json`, user/external plugins, custom
endpoint routes, or shell API-key variables. OpenCode auth snapshots are private,
short-lived, and limited to API entries; the canonical auth file is never
modified.
Connecting OpenCode never selects a route automatically: choose the exact
provider/model for the thread. The in-app recovery links open either the
official provider guide or the audited release, depending on what needs fixing.

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

Node.js 22.16 or newer is required. Aside uses Node's built-in read-only SQLite
support to discover OpenCode sessions without invoking migrations or writing to
OpenCode's database.

## Developer harness usage

```bash
aside
aside --source codex
aside --project myrepo

# Observer options
aside --provider codex-cli
aside --provider pi-cli --model anthropic/claude-sonnet-4-6
aside --provider opencode-cli --model openai/gpt-5.4
aside --provider ollama --model llama3.2
aside --provider openai --model gpt-4o-mini
```

The default observer delegates to your installed `claude` CLI with all tools
disabled. Claude Code retains responsibility for authentication and token
refresh. `codex-cli` similarly delegates to your installed Codex client.
`pi-cli` delegates to Pi while pinning the exact upstream `provider/model`
chosen in Aside; Pi retains responsibility for every provider credential.
`opencode-cli` applies the same exact-route contract to the conservative set of
Zen and selected-provider API-key models OpenCode can reconstruct through the
route-metadata matrix and audited exact-version built-ins. OpenCode retains
responsibility for account setup; OAuth and well-known routes remain unavailable
to Aside in this release.

API-backed providers use their normal environment variables:

| provider | credential |
|---|---|
| `claude-cli` | existing Claude Code login |
| `codex-cli` | existing Codex login |
| `pi-cli` | any model Pi reports as available; credentials remain Pi-owned |
| `opencode-cli` | audited OpenCode 1.18.15 Zen routes or a selected provider API credential; no OAuth/well-known routes |
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

Building the Mac app requires Node.js 22.16 or newer.

Useful development commands:

```bash
cd menubar
npm run bundle
npx electron build/main.js --show
npx electron build/main.js --capture /tmp/aside.png
npx electron build/main.js --capture /tmp/aside-today.png --today-generated
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

Release builds use a Developer ID Application certificate and the `fold-notary`
Keychain profile. Credentials never live in the repository.

```bash
xcrun notarytool store-credentials "fold-notary" \
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

The product path is implemented: discover and tail sessions, generate a daily
Today recap, flag likely attention requests, switch between fleet and
per-session durable chats, keep a different observer model per thread, and use
the same core in TUI and Mac app.

The preview DMGs are distributed from a private Railway Bucket through stable
public download routes. The Mac app has explicit provider onboarding and
revocation: it recognizes account-backed Codex and Claude Code clients plus the
exact Pi model routes and the source-audited OpenCode routes Aside supports,
requires per-client
permission before any transcript context can be sent, and keeps API-key-backed
sessions out of the account-login path. Direct API providers remain available
only in the TUI.

## License

MIT
