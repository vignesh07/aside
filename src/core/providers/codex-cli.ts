import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { assembleSystemPrompt } from './types.js';
import type { CompletionRequest, Provider } from './types.js';
import { OBSERVER_CWD } from './claude-session.js';

/**
 * Answer using the user's own Codex CLI, over its existing ChatGPT login.
 *
 * Same delegation shape as claude-cli, and the same reason: Codex owns
 * authentication and token refresh, aside never sees a credential. This is what
 * "sign in with ChatGPT" amounts to for a local tool — the user signs into
 * Codex once (`codex login`), and aside asks Codex.
 *
 * What this deliberately is NOT: presenting a first-party client's OAuth id from
 * a program that isn't that client. Some tools hardcode a vendor's client id to
 * borrow subscription inference; that's forging an identity, both vendors
 * prohibit it, and the ban lands on the user's account, not the tool's.
 */

/** Per-answer ceiling. Codex spawns a model turn; be generous but bounded. */
const TIMEOUT_MS = 180_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/** Numeric sort key from a `codex-cli 0.144.5` version banner. */
function versionRank(output: string): number {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(output);
  if (!match) return 0;
  const [, major, minor, patch] = match as unknown as [string, string, string, string];
  return Number(major) * 1_000_000 + Number(minor) * 1_000 + Number(patch);
}

/**
 * Find the newest working Codex binary.
 *
 * `codex` on PATH is not trustworthy, in two different ways:
 *
 *  - npm's wrapper resolves a per-platform vendor binary that is routinely
 *    missing — a partial or wrong-arch install leaves the wrapper on PATH and no
 *    executable behind it, so it's on PATH and still unusable.
 *  - a second install (Homebrew) may be years old. It answers --version happily
 *    and then rejects the model or config the user actually has, which surfaces
 *    as a baffling error about their own settings.
 *
 * So probe every candidate and take the newest that responds — "first on PATH"
 * and "first that runs" both pick wrong on a machine with two installs.
 */
export function resolveCodexBinary(): string | null {
  const candidates = ['codex', '/opt/homebrew/bin/codex', '/usr/local/bin/codex'];
  let best: { path: string; rank: number } | null = null;

  for (const candidate of candidates) {
    try {
      const out = execFileSync(candidate, ['--version'], {
        encoding: 'utf-8',
        timeout: 10_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const rank = versionRank(out);
      if (!best || rank > best.rank) best = { path: candidate, rank };
    } catch {
      continue; // Present but unusable is the same as absent.
    }
  }
  return best?.path ?? null;
}

export const codexCli: Provider = {
  id: 'codex-cli',
  label: 'Codex (your ChatGPT login, no API key)',
  apiKeyEnv: [],
  requiresApiKey: false,
  // Codex model ids move fast and are gated on CLI version. These are a
  // shortlist; --model passes any id straight through.
  models: [
    { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', recommended: true },
    { id: 'gpt-5-codex', label: 'GPT-5 Codex' },
  ],

  complete(req: CompletionRequest) {
    return askCodex(req);
  },
};

async function askCodex(req: CompletionRequest): Promise<string> {
  const { model, question } = req;
  const binary = resolveCodexBinary();
  if (!binary) {
    throw new Error(
      'codex-cli: no working "codex" found. Install it with `npm i -g @openai/codex@latest` ' +
        'and sign in with `codex login`, or pick another provider.',
    );
  }
  fs.mkdirSync(OBSERVER_CWD, { recursive: true });

  // Codex has no stable per-thread stdin session protocol. Re-sending the
  // bounded persisted history keeps side threads independent; `resume --last`
  // would let one selected session accidentally continue another one's chat.
  const context = assembleSystemPrompt(req);
  const prompt = context ? `${context}\n\n---\n\nQuestion: ${question}` : question;

  // Codex writes its final message here. Asking for the answer directly beats
  // scraping stdout, which interleaves the model's text with Codex's own
  // timestamped logs, token counts, and a repeat of the final message — all of
  // which would land in the chat panel.
  const answerFile = path.join(OBSERVER_CWD, `answer-${process.pid}-${Date.now()}.txt`);

  const args = [
    'exec',
    // Read-only: the observer must not be able to mutate anything. Codex
    // sandboxes model-generated shell commands; this is the strictest policy.
    '--sandbox',
    'read-only',
    // The observer runs in a scratch dir, not a repo. Without this Codex refuses.
    '--skip-git-repo-check',
    // MCP servers are tools, and a read-only observer has no use for them. This
    // also sidesteps a broken server entry in the user's config taking us down
    // with it — their config is not ours to be fragile about.
    '-c',
    'mcp_servers={}',
    '--output-last-message',
    answerFile,
    '--model',
    model,
  ];
  args.push(prompt);

  return new Promise<string>((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: OBSERVER_CWD,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, TIMEOUT_MS);

    child.stdout.on('data', (c: Buffer) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += c.toString();
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr = (stderr + c.toString()).slice(-2_000);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(explain(err, ''));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const answer = readAnswer(answerFile);
      if (timedOut) return reject(new Error(`codex-cli: timed out after ${TIMEOUT_MS / 1000}s.`));
      if (code !== 0) return reject(explain(new Error(`exited with code ${code}`), stderr + stdout));
      resolve(answer || '(no response)');
    });
  });
}

/** Read and clean up the file Codex wrote its final message to. */
function readAnswer(file: string): string {
  try {
    const text = fs.readFileSync(file, 'utf-8').trim();
    fs.rmSync(file, { force: true });
    return text;
  } catch {
    // No file means Codex died before answering; the exit code and stderr carry
    // the real story, so don't mask it with a file-not-found.
    return '';
  }
}

function explain(err: unknown, output: string): Error {
  const e = err as NodeJS.ErrnoException;
  if (e.code === 'ENOENT') {
    return new Error('codex-cli: the "codex" command was not found. Install it and run `codex login`.');
  }
  if (/not logged in|please run.*login|401|unauthorized/i.test(output)) {
    return new Error('codex-cli: Codex is not signed in. Run `codex login` and try again.');
  }
  if (/requires a newer version of Codex/i.test(output)) {
    return new Error(
      'codex-cli: your Codex CLI is too old for that model. Run ' +
        '`npm i -g @openai/codex@latest`, or pick an older model.',
    );
  }
  return new Error(`codex-cli: ${output.trim() || e.message || 'failed'}`.slice(0, 400));
}

/** Forget the conversation, so the next ask starts a fresh Codex session. */
export function resetCodexSession(): void {
  // Kept as a compatibility no-op. Codex side threads are stateless and receive
  // their bounded persisted history on every call.
}
