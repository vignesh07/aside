import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
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

/** Session id of the last answer, so follow-ups continue the same conversation. */
let lastSessionActive = false;

/**
 * Find a Codex binary that actually runs.
 *
 * `codex` on PATH is not trustworthy: npm's wrapper resolves a per-platform
 * vendor binary that is routinely missing (a partial install leaves the wrapper
 * on PATH and the executable absent), and a Homebrew install may be too old for
 * the model in the user's config. So probe candidates and take the first that
 * responds, rather than assuming the first on PATH is usable.
 */
export function resolveCodexBinary(): string | null {
  const candidates = ['codex', '/opt/homebrew/bin/codex', '/usr/local/bin/codex'];
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore', timeout: 10_000 });
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
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

async function askCodex({ model, systemPrompt, context, question }: CompletionRequest): Promise<string> {
  const binary = resolveCodexBinary();
  if (!binary) {
    throw new Error(
      'codex-cli: no working "codex" found. Install it with `npm i -g @openai/codex@latest` ' +
        'and sign in with `codex login`, or pick another provider.',
    );
  }
  fs.mkdirSync(OBSERVER_CWD, { recursive: true });

  // Codex has no persistent stdin protocol like Claude Code's stream-json, but
  // `exec resume --last` continues its own most recent session — so continuity
  // comes from Codex's session store rather than from us re-sending history.
  const resume = lastSessionActive ? ['resume', '--last'] : [];
  const prompt = context ? `${context}\n\n---\n\nQuestion: ${question}` : question;

  const args = [
    'exec',
    ...resume,
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
    '--model',
    model,
  ];
  if (systemPrompt && !lastSessionActive) {
    // Codex has no --append-system-prompt; fold the role into the first turn.
    args.push(`${systemPrompt}\n\n---\n\n${prompt}`);
  } else {
    args.push(prompt);
  }

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
      if (timedOut) return reject(new Error(`codex-cli: timed out after ${TIMEOUT_MS / 1000}s.`));
      if (code !== 0) return reject(explain(new Error(`exited with code ${code}`), stderr + stdout));
      lastSessionActive = true;
      resolve(extractAnswer(stdout));
    });
  });
}

/**
 * Pull the agent's reply out of `codex exec` output.
 *
 * Codex prefixes log lines with a bracketed timestamp and interleaves them with
 * the model's text. Returning the raw stream would put its own logging in the
 * chat panel, so drop anything that looks like a log line.
 */
function extractAnswer(stdout: string): string {
  const lines = stdout
    .split('\n')
    .filter((l) => !/^\[\d{4}-\d{2}-\d{2}T/.test(l.trim()))
    .filter((l) => !/^(thinking|codex|tokens used|User instructions:)/i.test(l.trim()));
  return lines.join('\n').trim() || '(no response)';
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
  lastSessionActive = false;
}
