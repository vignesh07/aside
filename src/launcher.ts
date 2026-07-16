// Docked-pane launcher.
//
// `aside` cannot draw a widget *inside* Claude Code's or Codex's terminal —
// those apps own their render loop and expose no embeddable UI. The next best
// thing, and what actually delivers the "chat bar in the same window" feel, is
// a terminal split: tmux (any terminal) or iTerm2's AppleScript API. `aside
// dock` opens that split; `aside install` binds a tmux key so you can summon it
// without leaving the agent.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type DockSide = 'right' | 'bottom';

export interface DockOptions {
  /** Flags forwarded to the docked `aside` TUI (e.g. ['--source', 'codex']). */
  args: string[];
  side: DockSide;
  /** Pane size as a tmux/iTerm-friendly value, e.g. "40%". */
  size: string;
}

/** Quote a single argument for a POSIX shell. */
function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * The exact command that launches this same `aside` build's TUI — using the
 * running node binary and our own cli.js path, so it works identically whether
 * `aside` was installed globally or is being run from `dist/` in development.
 */
function asideInvocation(extraArgs: string[]): string {
  const cliPath = fileURLToPath(new URL('./cli.js', import.meta.url));
  return [process.execPath, cliPath, ...extraArgs].map(shellQuote).join(' ');
}

/** Flag values relevant to docking, mirrored from the CLI. */
export interface DockFlags {
  provider: string;
  model: string;
  project?: string;
  source?: string;
  session?: string[];
}

/** Defaults the CLI applies, so we only forward flags the user actually changed. */
export interface DockDefaults {
  provider: string;
  model: string;
}

/**
 * Build the argument list forwarded to the docked `aside` TUI. Only non-default
 * scope/model flags are passed through, keeping the docked command minimal.
 * Pure and exported so the passthrough logic is unit-testable.
 */
export function buildDockArgs(flags: DockFlags, defaults: DockDefaults): string[] {
  const args: string[] = [];
  if (flags.provider !== defaults.provider) args.push('--provider', flags.provider);
  if (flags.model !== defaults.model) args.push('--model', flags.model);
  if (flags.project) args.push('--project', flags.project);
  if (flags.source === 'claude' || flags.source === 'codex' || flags.source === 'pi') {
    args.push('--source', flags.source);
  }
  for (const id of flags.session ?? []) args.push('--session', id);
  return args;
}

/**
 * Build the tmux bind-key line that summons the dock. tmux parses its own
 * config quoting before handing the argument to /bin/sh, so we wrap the whole
 * command in single quotes for tmux and double-quote each path inside (handles
 * spaces) — surviving both tmux's parser and the shell. Pure/exported for tests.
 */
export function buildTmuxBindLine(execPath: string, cliPath: string): string {
  const inner = [execPath, cliPath, 'dock'].map((a) => `"${a}"`).join(' ');
  return `bind-key C-a run-shell '${inner}'`;
}

export function isInsideTmux(): boolean {
  return Boolean(process.env['TMUX']);
}

export function isITerm(): boolean {
  return process.env['TERM_PROGRAM'] === 'iTerm.app';
}

/** Open the `aside` TUI in a docked split beside the current pane. */
export function dock(opts: DockOptions): number {
  const cmd = asideInvocation(opts.args);

  if (isInsideTmux()) {
    return dockTmux(cmd, opts);
  }
  if (isITerm()) {
    return dockITerm(cmd, opts);
  }

  process.stderr.write(
    'aside dock: needs tmux or iTerm2 to open a docked pane.\n' +
      'Start tmux (or use iTerm2), or just run `aside` in a separate pane/window.\n',
  );
  return 1;
}

function dockTmux(cmd: string, opts: DockOptions): number {
  // -h splits left/right (pane to the right); -v splits top/bottom.
  const direction = opts.side === 'bottom' ? '-v' : '-h';
  const result = spawnSync('tmux', ['split-window', direction, '-l', opts.size, cmd], {
    stdio: 'inherit',
  });
  if (result.error) {
    process.stderr.write(`aside dock: failed to run tmux: ${result.error.message}\n`);
    return 1;
  }
  return result.status ?? 0;
}

function dockITerm(cmd: string, opts: DockOptions): number {
  // iTerm2: "split vertically" makes a pane to the right; "horizontally" below.
  const splitDir = opts.side === 'bottom' ? 'horizontally' : 'vertically';
  // Embed the shell command in an AppleScript double-quoted string.
  const escaped = cmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = [
    'tell application "iTerm2"',
    '  tell current session of current window',
    `    set newSession to (split ${splitDir} with default profile)`,
    `    tell newSession to write text "exec ${escaped}"`,
    '  end tell',
    'end tell',
  ].join('\n');

  const result = spawnSync('osascript', ['-e', script], { stdio: 'inherit' });
  if (result.error) {
    process.stderr.write(`aside dock: failed to run osascript: ${result.error.message}\n`);
    return 1;
  }
  return result.status ?? 0;
}

const TMUX_MARKER = '# aside: summon docked side chat';

/**
 * Install a tmux keybinding (`<prefix> C-a`) that opens the aside pane, so you
 * can summon it without leaving the agent. Prints the line; with `write`, also
 * appends it to ~/.tmux.conf (idempotently).
 */
export function installTmux(write: boolean): number {
  const cliPath = fileURLToPath(new URL('./cli.js', import.meta.url));
  const bindLine = buildTmuxBindLine(process.execPath, cliPath);
  const block = `${TMUX_MARKER}\n${bindLine}`;

  if (!write) {
    process.stdout.write(
      'Add this to your ~/.tmux.conf to summon aside with `<prefix> C-a`:\n\n' +
        `  ${bindLine}\n\n` +
        'Then reload tmux: `tmux source-file ~/.tmux.conf`.\n' +
        'Or run `aside install --write` to append it automatically.\n',
    );
    return 0;
  }

  const conf = path.join(os.homedir(), '.tmux.conf');
  let existing = '';
  try {
    existing = fs.readFileSync(conf, 'utf-8');
  } catch {
    // No tmux.conf yet — we'll create it.
  }
  if (existing.includes('aside') && existing.includes('dock')) {
    process.stdout.write(`aside: an aside binding already exists in ${conf}; leaving it untouched.\n`);
    return 0;
  }
  const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(conf, `${prefix}\n${block}\n`);
  process.stdout.write(
    `aside: added a binding to ${conf}.\n` +
      'Reload tmux with `tmux source-file ~/.tmux.conf`, then press `<prefix> C-a`.\n',
  );
  return 0;
}
