// A long-lived `claude` process: one conversation, many turns.
//
// The obvious implementation — run `claude -p <question>` per question — is
// wrong twice over. It pays full CLI startup on every question (~23s vs ~3s
// warm), and the process has no memory, so continuity has to be faked by
// re-sending the entire chat history in each prompt: cost climbing with the age
// of the conversation, and a history budget to police.
//
// `--input-format stream-json` keeps the process alive: JSON messages in, JSON
// events out, and Claude Code holds the conversation itself. That makes this a
// real chat — you ask, you close it, you come back, and it still knows what you
// were talking about — with no history threading on our side at all.

import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createVendorCliEnv } from './vendor-cli-env.js';

/**
 * Sessions the observer itself creates land here.
 *
 * Claude Code writes a transcript for its own session too — so without a
 * dedicated cwd, aside would discover its own conversation on disk, list itself
 * among the user's agents, and report its own observations back to them.
 */
export const OBSERVER_CWD = path.join(os.tmpdir(), 'aside-observer');

/** Stable substring of the observer's own project path, used to filter it out. */
export const OBSERVER_PROJECT_MARKER = 'aside-observer';

/** Per-answer ceiling. A wedged CLI must not hang the chat forever. */
const ANSWER_TIMEOUT_MS = 180_000;

interface PendingAsk {
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export function composeClaudeTurnContent(
  context: string,
  question: string,
  persistedHistory: string,
  starting: boolean,
): string {
  const restoredContext =
    starting && persistedHistory
      ? [context, persistedHistory].filter(Boolean).join('\n\n')
      : context;
  return restoredContext
    ? `${restoredContext}\n\n---\n\nQuestion: ${question}`
    : question;
}

export function claudeObserverArgs(
  model: string,
  systemPrompt: string,
): string[] {
  return [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    // stream-json output requires --verbose; without it the CLI refuses.
    '--verbose',
    // Disable CLAUDE.md, skills, plugins, hooks, MCP servers, custom agents,
    // output styles, and every other user/project customization. Authentication
    // remains owned by Claude Code.
    '--safe-mode',
    // An observer receives all context in the prompt and needs no agent tools.
    '--tools',
    '',
    '--append-system-prompt',
    systemPrompt,
    '--model',
    model,
  ];
}

/**
 * One continuous conversation with the user's own Claude Code CLI.
 *
 * Not thread-safe by design: a chat is a sequence. Asks are serialised, because
 * two questions interleaved on one stdin would produce two answers with no way
 * to tell which belonged to which.
 */
export class ClaudeSession {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private pending: PendingAsk | null = null;
  /** Serialises asks: each waits for the previous to settle. */
  private tail: Promise<unknown> = Promise.resolve();
  private startedWith: { model: string; systemPrompt: string } | null = null;

  /**
   * Ask a question, starting or reusing the session.
   *
   * `systemPrompt` is the observer's static role and is fixed when the process
   * starts. The volatile part — what the agents are doing right now — is
   * `context`, sent with each question, because it changes between turns and a
   * system prompt cannot be revised once the session is live.
   */
  ask(
    model: string,
    systemPrompt: string,
    context: string,
    question: string,
    persistedHistory = '',
  ): Promise<string> {
    const run = () => this.askOne(model, systemPrompt, context, question, persistedHistory);
    // Chain onto the tail so asks never interleave, and so one failure doesn't
    // poison the queue for the next question.
    const result = this.tail.then(run, run);
    this.tail = result.catch(() => undefined);
    return result;
  }

  private async askOne(
    model: string,
    systemPrompt: string,
    context: string,
    question: string,
    persistedHistory: string,
  ): Promise<string> {
    // The system prompt and model are baked in at spawn, so a change to either
    // means a new conversation. Restarting loses history — but the alternative
    // is answering as a persona the user just changed away from.
    const changed =
      this.startedWith &&
      (this.startedWith.model !== model || this.startedWith.systemPrompt !== systemPrompt);
    if (changed) this.dispose();

    const starting = this.child === null || this.child.killed;
    const child = this.ensureStarted(model, systemPrompt);

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        // Kill rather than leave it wedged: a session that missed one answer
        // will desynchronise every answer after it.
        this.dispose();
        reject(new Error(`claude-cli: timed out after ${ANSWER_TIMEOUT_MS / 1000}s.`));
      }, ANSWER_TIMEOUT_MS);

      this.pending = { resolve, reject, timer };

      // A warm CLI process remembers prior turns. A new process does not, so
      // restore the durable local history exactly once after app restart,
      // provider failure, or a model change.
      const content = composeClaudeTurnContent(
        context,
        question,
        persistedHistory,
        starting,
      );
      try {
        child.stdin.write(
          `${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`,
        );
      } catch (err) {
        clearTimeout(timer);
        this.pending = null;
        reject(new Error(`claude-cli: could not write to the session (${String(err)})`));
      }
    });
  }

  private ensureStarted(model: string, systemPrompt: string): ChildProcessWithoutNullStreams {
    if (this.child && !this.child.killed) return this.child;

    fs.mkdirSync(OBSERVER_CWD, { recursive: true });

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(
        'claude',
        claudeObserverArgs(model, systemPrompt),
        {
          cwd: OBSERVER_CWD,
          env: createVendorCliEnv(),
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
    } catch (err) {
      throw explain(err);
    }

    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk));

    let stderr = '';
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-2_000);
    });

    child.on('error', (err) => this.fail(explain(err)));
    child.on('close', (code) => {
      this.child = null;
      this.startedWith = null;
      if (this.pending) {
        // Claude Code reports user-facing failures on stdout, not stderr — "Not
        // logged in · Please run /login" arrives with an empty stderr — so the
        // buffered stdout is the more useful diagnostic here.
        this.fail(explain(Object.assign(new Error(`exited with code ${code}`), {
          stderr,
          stdout: this.buffer,
        })));
      }
      this.buffer = '';
    });

    this.child = child;
    this.startedWith = { model, systemPrompt };
    return child;
  }

  /** Parse newline-delimited JSON events; a `result` event completes an ask. */
  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;

      let event: { type?: string; subtype?: string; result?: unknown; is_error?: boolean };
      try {
        event = JSON.parse(line);
      } catch {
        continue; // Not every line is ours to understand.
      }
      if (event.type !== 'result') continue;

      const pending = this.pending;
      if (!pending) continue;
      this.pending = null;
      clearTimeout(pending.timer);

      const text = typeof event.result === 'string' ? event.result.trim() : '';
      if (event.is_error) {
        pending.reject(new Error(`claude-cli: ${text || 'the session reported an error'}`));
      } else {
        pending.resolve(text || '(no response)');
      }
    }
  }

  private fail(err: Error): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    clearTimeout(pending.timer);
    pending.reject(err);
  }

  /** Stop the session. The next ask starts a fresh one. */
  dispose(): void {
    this.child?.kill();
    this.child = null;
    this.startedWith = null;
    this.buffer = '';
  }

  /** True while a conversation is live. */
  get isRunning(): boolean {
    return this.child !== null && !this.child.killed;
  }
}

export function explain(err: unknown): Error {
  const e = err as NodeJS.ErrnoException & { stderr?: string; stdout?: string };

  if (e.code === 'ENOENT') {
    return new Error(
      'claude-cli: the "claude" command was not found. Install Claude Code, or pick another ' +
        'provider (--provider ollama needs nothing). If aside was launched from Finder it ' +
        'may not have your PATH.',
    );
  }

  const output = `${(e.stdout ?? '').trim()}\n${(e.stderr ?? '').trim()}`.trim();
  if (/not logged in|please run\s*\/?login|authentication/i.test(output)) {
    return new Error(
      'claude-cli: Claude Code is not logged in. Run "claude" in a terminal and sign in, ' +
        'then try again.',
    );
  }
  return new Error(`claude-cli: ${output || e.message || 'failed'}`.slice(0, 400));
}
