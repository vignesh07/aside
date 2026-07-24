"use client";

import { useEffect, useState } from "react";
import Image from "next/image";

const APPLE_SILICON_DOWNLOAD =
  "https://aside-production-fd82.up.railway.app/download/mac-arm64";
const INTEL_DOWNLOAD =
  "https://aside-production-fd82.up.railway.app/download/mac-intel";

const demoSteps = [
  {
    label: "Notice",
    title: "Two threads need you",
    detail: "Aside lifts direct questions out of the background.",
  },
  {
    label: "Select",
    title: "Open the right thread",
    detail: "Its transcript and side chat stay scoped to that session.",
  },
  {
    label: "Ask",
    title: "Get the blocker, not a recap",
    detail: "A separate model answers without interrupting the agent.",
  },
];

const questions = [
  "What needs me right now?",
  "Why did this thread change the schema?",
  "What changed while I was away?",
  "Which session is failing tests?",
];

function Arrow() {
  return <span aria-hidden="true">↗</span>;
}

function Brand() {
  return (
    <a className="brand" href="#top" aria-label="Aside home">
      <Image src="/aside-icon.svg" alt="" width={32} height={32} />
      <span>Aside</span>
    </a>
  );
}

function DownloadButtons({ inverse = false }: { inverse?: boolean }) {
  return (
    <div className={`download-cluster${inverse ? " inverse" : ""}`}>
      <a
        className="button button-primary"
        href={APPLE_SILICON_DOWNLOAD}
        data-download="apple-silicon"
      >
        Download for Mac <Arrow />
      </a>
      <a className="intel-link" href={INTEL_DOWNLOAD}>
        Intel Mac
      </a>
    </div>
  );
}

function AppDemo() {
  const [step, setStep] = useState(0);

  useEffect(() => {
    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    if (reducedMotion) return;

    const timer = window.setInterval(() => {
      setStep((current) => (current + 1) % demoSteps.length);
    }, 4200);

    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="demo-wrap" aria-label="Aside product demonstration">
      <div className="demo-window">
        <div className="demo-titlebar">
          <div className="traffic-lights" aria-hidden="true">
            <i />
            <i />
            <i />
          </div>
          <span>Aside</span>
          <span className="demo-titlebar-spacer" />
        </div>

        <div className="demo-app">
          <aside className="demo-sidebar">
            <div className="demo-sidebar-head">
              <div className="mini-brand">
                <span className="mini-mark">a</span>
                <strong>Aside</strong>
              </div>
              <div className="thread-count">17</div>
            </div>

            <div className="demo-search">⌕&nbsp;&nbsp;Search all threads</div>

            <button
              className={`demo-thread all-agents${step === 0 ? " selected" : ""}`}
              onClick={() => setStep(0)}
            >
              <span className="thread-glyph">⌘</span>
              <span>
                <strong>All agents</strong>
                <small>3 recent · 17 total</small>
              </span>
              {step === 0 && <b className="needs-count">2</b>}
            </button>

            <div className="project-label">
              <span>⌄</span>
              <strong>atlas</strong>
              <small>3</small>
            </div>

            <button
              className={`demo-thread${step > 0 ? " selected" : ""}`}
              onClick={() => setStep(1)}
            >
              <span className="agent-mark codex">X</span>
              <span>
                <strong>Prepare the release</strong>
                <small>codex · active</small>
              </span>
              <i className="needs-dot" title="Needs you" />
            </button>

            <button className="demo-thread" onClick={() => setStep(1)}>
              <span className="agent-mark claude">C</span>
              <span>
                <strong>Audit the database</strong>
                <small>claude · 8m</small>
              </span>
            </button>

            <div className="project-label second">
              <span>⌄</span>
              <strong>northstar</strong>
              <small>2</small>
            </div>

            <button className="demo-thread quiet" onClick={() => setStep(1)}>
              <span className="agent-mark codex">X</span>
              <span>
                <strong>Fix search indexing</strong>
                <small>codex · 22m</small>
              </span>
            </button>
          </aside>

          <section className="demo-chat" aria-live="polite">
            <header className="demo-chat-head">
              <div>
                <strong>{step === 0 ? "All agents" : "Prepare the release"}</strong>
                <small>
                  {step === 0
                    ? "3 recent · 17 total · fleet conversation"
                    : "atlas · codex · active"}
                </small>
              </div>
              {step > 0 && <span className="read-only-pill">Read only</span>}
            </header>

            <div className={`demo-chat-body step-${step}`}>
              {step === 0 ? (
                <div className="attention-view">
                  <p className="section-kicker">Needs you</p>
                  <h3>Two threads are waiting.</h3>
                  <div className="attention-row">
                    <span className="agent-mark codex">X</span>
                    <div>
                      <strong>Prepare the release</strong>
                      <small>“Can I restart the signed app now?”</small>
                    </div>
                    <span className="waiting-time">now</span>
                  </div>
                  <div className="attention-row muted-row">
                    <span className="agent-mark claude">C</span>
                    <div>
                      <strong>Review the migration</strong>
                      <small>“Which rollback path should I use?”</small>
                    </div>
                    <span className="waiting-time">4m</span>
                  </div>
                </div>
              ) : (
                <>
                  <div className="message observer">
                    <span>Aside</span>
                    <p>
                      This thread built and notarized the Mac release. It is
                      waiting for one decision before it can finish.
                    </p>
                  </div>
                  {step === 2 && (
                    <>
                      <div className="message user">
                        <p>What is this waiting on?</p>
                      </div>
                      <div className="message observer answer">
                        <span>Aside</span>
                        <p>
                          The signed update is downloaded. It needs your
                          approval to restart the app and verify the new
                          version.
                        </p>
                      </div>
                    </>
                  )}
                </>
              )}
            </div>

            <div className="demo-composer">
              <span>
                {step === 0
                  ? "Ask across all agents…"
                  : "Ask about this thread…"}
              </span>
              <button
                aria-label="Show answer in the product demo"
                onClick={() => setStep(2)}
              >
                ↑
              </button>
              <small>{step === 0 ? "ChatGPT · fleet" : "ChatGPT · this thread"}</small>
            </div>
          </section>
        </div>
      </div>

      <div className="demo-controls" role="tablist" aria-label="Demo steps">
        {demoSteps.map((item, index) => (
          <button
            key={item.label}
            className={step === index ? "active" : ""}
            onClick={() => setStep(index)}
            role="tab"
            aria-selected={step === index}
          >
            <span>{String(index + 1).padStart(2, "0")}</span>
            <strong>{item.title}</strong>
            <small>{item.detail}</small>
            <i aria-hidden="true" />
          </button>
        ))}
      </div>
    </div>
  );
}

export default function Home() {
  return (
    <main id="top">
      <nav className="site-nav" aria-label="Primary navigation">
        <Brand />
        <div className="nav-links">
          <a href="#how-it-works">How it works</a>
          <a href="#privacy">Privacy</a>
          <a href="#faq">FAQ</a>
        </div>
        <a className="nav-download" href={APPLE_SILICON_DOWNLOAD}>
          Download <span aria-hidden="true">↓</span>
        </a>
      </nav>

      <section className="hero section-shell" id="download">
        <div className="hero-copy">
          <p className="eyebrow hero-rise">A side chat for your coding agents</p>
          <h1 className="hero-rise hero-delay-1">
            Ask about the work.
            <br />
            Don&apos;t interrupt it.
          </h1>
          <p className="hero-summary hero-rise hero-delay-2">
            Aside finds the Codex, Claude Code, and Pi threads already on your
            Mac. Pick one and ask a separate model what changed, why it chose
            that path, or what it needs next.
          </p>
          <div className="hero-actions hero-rise hero-delay-3">
            <DownloadButtons />
            <p>Preview for macOS · Signed and notarized</p>
          </div>
        </div>
        <div className="hero-proof hero-rise hero-delay-4">
          <AppDemo />
        </div>
      </section>

      <section className="statement section-shell reveal">
        <p>Your agents already run in parallel.</p>
        <h2>Your attention doesn&apos;t.</h2>
      </section>

      <section className="workflow section-shell" id="how-it-works">
        <div className="section-heading reveal">
          <p className="eyebrow">The useful layer beside the work</p>
          <h2>Dashboards show status. Aside lets you ask why.</h2>
          <p>
            It does not launch agents, steer them, or merge their context. It
            reads the transcripts they already keep and gives you a second
            conversation about the work.
          </p>
        </div>

        <div className="feature-sequence">
          <article className="feature-row reveal">
            <div className="feature-index">01</div>
            <div className="feature-copy">
              <p className="eyebrow">Search the work, not just the title</p>
              <h3>Find the thread from what happened inside it.</h3>
              <p>
                Search prompts, agent replies, commands, file paths, failures,
                and Aside side chats across Codex, Claude Code, and Pi—even
                older work. The index stays on your Mac.
              </p>
              <p className="feature-note">
                <strong>Coming next:</strong> Codex subagents, folded beneath
                the task that spawned them.
              </p>
            </div>
            <div className="feature-visual project-visual" aria-hidden="true">
              <div className="visual-search">
                ⌕&nbsp;&nbsp; Railway auto-deploy
              </div>
              <div className="folder-row open">
                <span>⌄</span>
                <strong>atlas</strong>
                <small>2 results</small>
              </div>
              <div className="compact-thread active">
                <span>Prepare the release</span>
                <small>agent reply</small>
              </div>
              <div className="compact-thread">
                <span>Fix the deployment</span>
                <small>command</small>
              </div>
              <div className="folder-row">
                <span>›</span>
                <strong>Older Threads</strong>
                <small>12</small>
              </div>
            </div>
          </article>

          <article className="feature-row flip reveal">
            <div className="feature-index">02</div>
            <div className="feature-copy">
              <p className="eyebrow">Start with the one that needs you</p>
              <h3>Questions rise above activity.</h3>
              <p>
                Direct input requests and likely questions move to the top.
                When a live session starts waiting, Aside can send a Mac
                notification.
              </p>
            </div>
            <div className="feature-visual notification-visual" aria-hidden="true">
              <div className="mac-notification">
                <span className="mini-mark">a</span>
                <div>
                  <p>
                    <strong>Aside</strong>
                    <small>now</small>
                  </p>
                  <b>atlas needs you</b>
                  <span>Prepare the release is waiting for your approval.</span>
                </div>
              </div>
            </div>
          </article>

          <article className="feature-row reveal">
            <div className="feature-index">03</div>
            <div className="feature-copy">
              <p className="eyebrow">One session. One side chat.</p>
              <h3>The second conversation persists.</h3>
              <p>
                Every discovered session keeps its own conversation and model
                choice. Close Aside, switch projects, and continue where you
                stopped.
              </p>
            </div>
            <div className="feature-visual prompt-visual" aria-hidden="true">
              {questions.map((question, index) => (
                <div key={question} className={index === 0 ? "chosen" : ""}>
                  <span>{question}</span>
                  <small>{index === 0 ? "Asked now" : "Try this"}</small>
                </div>
              ))}
            </div>
          </article>
        </div>
      </section>

      <section className="privacy" id="privacy">
        <div className="section-shell privacy-inner">
          <div className="section-heading inverse reveal">
            <p className="eyebrow">Observer, never operator</p>
            <h2>Read-only is a boundary, not a slogan.</h2>
            <p>
              Aside can read supported agent transcripts and ask an observer
              model about them. It cannot send a message to an agent, edit a
              project, or run a command.
            </p>
          </div>

          <div className="privacy-rules">
            <article className="reveal">
              <span>01</span>
              <h3>Search and history stay on this Mac.</h3>
              <p>
                The searchable index, thread list, and every side chat are
                stored locally with user-only permissions. Search queries never
                leave your machine.
              </p>
            </article>
            <article className="reveal">
              <span>02</span>
              <h3>Cloud context is scoped.</h3>
              <p>
                A session chat sends only that session to the model you chose.
                Common credential patterns are redacted first.
              </p>
            </article>
            <article className="reveal">
              <span>03</span>
              <h3>Your login stays with the vendor.</h3>
              <p>
                Aside delegates replies to Codex or Claude Code. It never reads
                their OAuth tokens or imports API keys from your shell.
              </p>
            </article>
          </div>

          <div className="local-note reveal">
            <div className="local-orb" aria-hidden="true">
              <span>o</span>
            </div>
            <div>
              <strong>Need transcript context to stay entirely local?</strong>
              <p>Choose an installed Ollama model for that side chat.</p>
            </div>
          </div>
        </div>
      </section>

      <section className="install section-shell">
        <div className="install-copy reveal">
          <p className="eyebrow">A native Mac utility</p>
          <h2>Install once. Keep working.</h2>
          <p>
            Drag Aside to Applications and open it. It lives in your menu bar,
            stays out of the Dock, and downloads future signed updates inside
            the app.
          </p>
          <DownloadButtons />
        </div>
        <div className="install-card reveal">
          <div className="mac-menu">
            <span>⌘</span>
            <span>File</span>
            <span>Edit</span>
            <span>View</span>
            <i />
            <span className="tray-bubble">···</span>
            <span>9:41</span>
          </div>
          <div className="menu-popover">
            <div className="popover-head">
              <span className="mini-mark">a</span>
              <div>
                <strong>Aside</strong>
                <small>2 threads need you</small>
              </div>
            </div>
            <button>
              Open Aside <span>⌘O</span>
            </button>
            <button>
              Check for Updates <span>⌘U</span>
            </button>
            <button>
              Aside Settings <span>⌘,</span>
            </button>
          </div>
        </div>
      </section>

      <section className="support-strip">
        <div className="section-shell">
          <p>Reads sessions from</p>
          <div>
            <span>
              <b>X</b> Codex
            </span>
            <span>
              <b>C</b> Claude Code
            </span>
            <span>
              <b>π</b> Pi
            </span>
          </div>
        </div>
      </section>

      <section className="faq section-shell" id="faq">
        <div className="section-heading reveal">
          <p className="eyebrow">Before you install</p>
          <h2>Straight answers.</h2>
        </div>
        <div className="faq-list">
          <details className="reveal">
            <summary>
              Does Aside control my coding agents? <span>+</span>
            </summary>
            <p>
              No. Aside is a read-only observer. It cannot message an agent,
              edit your project, or run commands.
            </p>
          </details>
          <details className="reveal">
            <summary>
              Does everything stay local? <span>+</span>
            </summary>
            <p>
              Your thread and content-search indexes, plus side-chat history,
              do. When you choose a cloud model, Aside sends scoped, redacted
              transcript context to that provider. Choose Ollama to keep model
              context local.
            </p>
          </details>
          <details className="reveal">
            <summary>
              Do I need separate API keys? <span>+</span>
            </summary>
            <p>
              No. Aside can use the ChatGPT account already connected through
              Codex or the Claude account connected through Claude Code. It
              does not copy their credentials.
            </p>
          </details>
          <details className="reveal">
            <summary>
              Which agents are supported? <span>+</span>
            </summary>
            <p>
              Aside currently discovers Codex, Claude Code, and Pi transcripts
              stored on your Mac.
            </p>
          </details>
          <details className="reveal">
            <summary>
              How do updates work? <span>+</span>
            </summary>
            <p>
              After the first signed install, Aside downloads future signed
              updates inside the app and asks you to restart when one is ready.
            </p>
          </details>
        </div>
      </section>

      <section className="final-cta">
        <div className="section-shell reveal">
          <Image src="/aside-icon.svg" alt="" width={72} height={72} />
          <p className="eyebrow">Aside for macOS</p>
          <h2>Know what needs you.</h2>
          <p>Then ask why.</p>
          <DownloadButtons inverse />
        </div>
      </section>

      <footer className="site-footer">
        <div className="section-shell">
          <Brand />
          <p>Read-only side chats for coding agents.</p>
          <div>
            <span>macOS preview · v0.1.5</span>
            <a href="#privacy">Privacy</a>
            <a href="#top">Back to top ↑</a>
          </div>
        </div>
      </footer>
    </main>
  );
}
