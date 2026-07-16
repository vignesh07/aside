import { execFile } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { promisify } from 'node:util';
import type { CompletionRequest, Provider } from './types.js';

const execFileAsync = promisify(execFile);

/**
 * Sessions the observer itself creates land under this directory.
 *
 * `claude -p` writes a transcript for every invocation, exactly like any other
 * Claude Code session — so without this, aside would discover its own answers on
 * disk and start reporting itself as one of the user's agents. Running with a
 * dedicated cwd makes those sessions identifiable by project path, so the
 * scanner can drop them. See OBSERVER_PROJECT_MARKER.
 */
export const OBSERVER_CWD = path.join(os.tmpdir(), 'aside-observer');

/** Stable substring of the observer's own project path, used to filter it out. */
export const OBSERVER_PROJECT_MARKER = 'aside-observer';

/** Answers are a side panel's worth. A stuck CLI must not hang the chat forever. */
const TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/**
 * Credential variables that would override the user's subscription login.
 *
 * Claude Code prefers an API key when one is present — it prints
 * "connectors are disabled because ANTHROPIC_API_KEY ... takes precedence over
 * your claude.ai login". Since this provider exists *specifically* to use the
 * login the user already pays for, the key is stripped from the child's
 * environment. Leaving it would silently bill their API account instead.
 */
const OVERRIDING_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];

/**
 * Ask the user's own Claude Code CLI, using the login it already holds.
 *
 * This is the "no API key" path, and it works by *delegation*, not by borrowing
 * credentials. aside never reads a token: it runs the vendor's own client, which
 * owns authentication and refresh, exactly as if the user had typed the command.
 * (The same pattern CodexBar uses for Codex.)
 *
 * The alternative — lifting OAuth tokens out of ~/.claude or the keychain — would
 * mean presenting aside to Anthropic as Claude Code. That's client impersonation,
 * and the account it risks is the user's own. Not worth it, and unnecessary.
 */
export const claudeCli: Provider = {
  id: 'claude-cli',
  label: 'Claude Code (your login, no API key)',
  apiKeyEnv: [],
  requiresApiKey: false,
  models: [
    { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', recommended: true },
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
    { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
  ],

  async complete({ model, systemPrompt, question, signal }: CompletionRequest) {
    fs.mkdirSync(OBSERVER_CWD, { recursive: true });

    const env = { ...process.env };
    for (const key of OVERRIDING_VARS) delete env[key];

    try {
      const { stdout } = await execFileAsync(
        'claude',
        [
          '-p',
          question,
          // "" disables every built-in tool. aside is a read-only observer, and
          // Claude Code ships with Write/Edit/Bash enabled — telling the model it
          // has no tools is not the same as it having none. This is the mechanism
          // that makes the read-only promise true rather than aspirational.
          '--tools',
          '',
          '--append-system-prompt',
          systemPrompt,
          '--model',
          model,
        ],
        {
          cwd: OBSERVER_CWD,
          env,
          timeout: TIMEOUT_MS,
          maxBuffer: MAX_OUTPUT_BYTES,
          ...(signal ? { signal } : {}),
        },
      );
      return stdout.trim() || '(no response)';
    } catch (err: unknown) {
      throw explain(err);
    }
  },
};

function explain(err: unknown): Error {
  const e = err as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };

  if (e.code === 'ENOENT') {
    return new Error(
      'claude-cli: the `claude` command was not found. Install Claude Code, or pick a ' +
        'different provider. (If aside was launched from Finder it may not see your ' +
        'PATH — launching from a terminal is a quick way to check.)',
    );
  }
  if (e.killed) {
    return new Error(`claude-cli: timed out after ${TIMEOUT_MS / 1000}s.`);
  }

  const stderr = (e.stderr ?? '').trim();
  if (/not logged in|please run.*login|authentication/i.test(stderr)) {
    return new Error('claude-cli: Claude Code is not logged in. Run `claude` once and sign in.');
  }
  return new Error(`claude-cli: ${stderr || e.message || 'failed'}`.slice(0, 400));
}
