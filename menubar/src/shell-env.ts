// Recover API keys from the user's login shell.
//
// A macOS app launched from Finder, the Dock, or Spotlight inherits launchd's
// environment — not your shell's. So ANTHROPIC_API_KEY, exported from .zshrc,
// simply does not exist in the packaged app, and every question fails with "No
// API key" even though the key is plainly there in any terminal.
//
// This bites specifically because testing an Electron app almost always means
// launching it from a shell, which *does* inherit the environment. The app works
// perfectly right up until someone double-clicks it.
//
// So: spawn the user's shell as a login+interactive shell (which is what sources
// .zprofile and .zshrc), read its environment, and adopt the credential
// variables. This is the same approach VS Code and other Electron dev tools take
// for the same reason.

import { execFileSync } from 'node:child_process';

/**
 * Variables worth importing.
 *
 * Deliberately narrow: adopting a login shell's entire environment inside a
 * running app is an unpredictable blast radius.
 *
 * PATH is the exception, and it's not optional. The default provider answers by
 * spawning the user's `claude` CLI, which lives somewhere like ~/.local/bin or
 * a Homebrew prefix — none of which are in the PATH launchd hands a GUI app
 * (/usr/bin:/bin:/usr/sbin:/sbin). Without the shell's PATH, the packaged app
 * cannot find the CLI at all, and the no-API-key path fails for exactly the
 * users it exists for.
 */
const IMPORTABLE_VAR = /^(PATH|[A-Z0-9_]*(API_KEY|AUTH_TOKEN|API_TOKEN))$/;

/** Ignore absurd values: a credential is not 100kB of shell function. */
const MAX_VALUE_LENGTH = 8_192;

export interface ShellEnvResult {
  /** Variables adopted from the login shell. */
  imported: string[];
  /** Populated when the shell couldn't be read; import is best-effort. */
  error?: string;
}

/**
 * Import PATH and credential variables from the login shell into `process.env`.
 *
 * Credentials never overwrite one that's already set — an explicitly provided
 * environment must win over whatever a dotfile happens to say. PATH is the
 * exception: launchd always sets a minimal one, so "already set" carries no
 * intent, and keeping it would defeat the point of asking.
 *
 * Best-effort by design: a shell that hangs, errors, or prints nothing leaves
 * the process exactly as it was. Failing to import is no worse than never
 * having tried, and must never stop the app from starting.
 */
export function importShellEnv(timeoutMs = 5_000): ShellEnvResult {
  const shell = process.env['SHELL'];
  if (!shell) return { imported: [], error: 'no $SHELL set' };

  let raw: string;
  try {
    // -l sources the login profile, -i sources the interactive rc (.zshrc,
    // where people actually put their keys). Both are needed; -l alone misses
    // .zshrc entirely.
    //
    // stdin is closed so an interactive shell can't block waiting for input,
    // and stderr is dropped because rc files love to print banners.
    raw = execFileSync(shell, ['-l', '-i', '-c', 'printenv'], {
      encoding: 'utf-8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'ignore'],
      // A shell that dumps enormous output shouldn't be able to exhaust memory.
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (err) {
    return { imported: [], error: err instanceof Error ? err.message : String(err) };
  }

  const imported: string[] = [];
  for (const line of raw.split('\n')) {
    // Only KEY=VALUE lines; rc-file banners and theme noise won't match.
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;

    const [, key, value] = match as unknown as [string, string, string];
    if (!IMPORTABLE_VAR.test(key)) continue;
    if (!value || value.length > MAX_VALUE_LENGTH) continue;
    // A credential already in the environment was put there deliberately.
    // A PATH already here came from launchd and means nothing, so take the
    // shell's — otherwise the CLI we need stays unreachable.
    if (key !== 'PATH' && process.env[key]) continue;

    process.env[key] = value;
    imported.push(key);
  }

  return { imported };
}

/**
 * True when the app looks like it was launched from a GUI rather than a shell.
 *
 * Detected via PATH: launchd hands GUI apps a minimal, fixed PATH with no user
 * directories in it. That's the signal that the rest of the shell environment —
 * the CLI's location, any exported keys — is missing too.
 */
export function isMissingShellEnv(): boolean {
  const path = process.env['PATH'] ?? '';
  const hasUserPaths = /\/(usr\/local|opt\/homebrew|\.local|\.npm-global|\.cargo)\/bin/.test(path);
  return !hasUserPaths;
}
