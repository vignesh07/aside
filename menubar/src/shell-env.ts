// Recover the executable PATH from the user's login shell.
//
// A macOS app launched from Finder, the Dock, or Spotlight inherits launchd's
// minimal PATH, not the one configured by Homebrew, a version manager, or the
// user's shell. The packaged app then cannot find an installed `claude` or
// `codex` executable even though it works in every terminal.
//
// This bites specifically because testing an Electron app almost always means
// launching it from a shell, which *does* inherit the environment. The app works
// perfectly right up until someone double-clicks it.
//
// So: spawn the user's shell as a login+interactive shell (which is what sources
// .zprofile and .zshrc), read its environment, and adopt PATH only. API keys,
// auth tokens, and every other shell variable stay out of the GUI process.

import { execFileSync } from 'node:child_process';

/**
 * The only variable worth importing.
 *
 * Adopting a login shell's entire environment would make ambient credentials
 * available to a GUI the user never authorized to use them. PATH is the narrow
 * exception: it locates the vendor CLI, whose own cached login remains under
 * that client's control.
 */
const PATH_MARKER = '__ASIDE_PATH__=';
const PRINT_PATH_COMMAND = `printf '${PATH_MARKER}%s\\n' "$PATH"`;

/** Ignore absurd values: PATH is not 100kB of shell function output. */
const MAX_VALUE_LENGTH = 8_192;

export interface ShellEnvResult {
  /** Variables adopted from the login shell. */
  imported: string[];
  /** Populated when the shell couldn't be read; import is best-effort. */
  error?: string;
}

/**
 * Import PATH from the login shell into `process.env`.
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
    raw = execFileSync(shell, ['-l', '-i', '-c', PRINT_PATH_COMMAND], {
      encoding: 'utf-8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'ignore'],
      // A shell that dumps enormous output shouldn't be able to exhaust memory.
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (err) {
    return { imported: [], error: err instanceof Error ? err.message : String(err) };
  }

  // Interactive rc files sometimes print banners. Select only our fixed marker;
  // the command itself never asks the shell to emit any other environment value.
  let line: string | undefined;
  for (const candidate of raw.split('\n')) {
    if (candidate.startsWith(PATH_MARKER)) line = candidate;
  }
  const value = line?.slice(PATH_MARKER.length);
  if (!value || value.length > MAX_VALUE_LENGTH) return { imported: [] };
  process.env['PATH'] = value;
  return { imported: ['PATH'] };
}

/**
 * True when the app looks like it was launched from a GUI rather than a shell.
 *
 * Detected via PATH: launchd hands GUI apps a minimal, fixed PATH with no user
 * directories in it. That's the signal that the CLI's location is missing.
 */
export function isMissingShellEnv(): boolean {
  const path = process.env['PATH'] ?? '';
  const hasUserPaths = /\/(usr\/local|opt\/homebrew|\.local|\.npm-global|\.cargo)\/bin/.test(path);
  return !hasUserPaths;
}
