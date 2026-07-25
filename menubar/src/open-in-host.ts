import { randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { LaunchIntent } from '../../dist/core/handoff/index.js';
import type { OpenInLaunchHost } from './open-in.js';

const LAUNCHER_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

export interface NativeOpenInHostDeps {
  openExternal(url: string): Promise<void>;
  openTerminalScript(scriptPath: string): Promise<void>;
  openApplication(applicationPath: string, cwd: string): Promise<void>;
  launcherRoot?: string;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function removeExpiredLaunchers(root: string): Promise<void> {
  const cutoff = Date.now() - LAUNCHER_MAX_AGE_MS;
  const names = await readdir(root).catch(() => []);
  await Promise.all(
    names
      .filter((name) => /^launch-[0-9a-f-]+\.command$/.test(name))
      .map(async (name) => {
        const candidate = path.join(root, name);
        const metadata = await stat(candidate).catch(() => undefined);
        if (metadata?.isFile() && metadata.mtimeMs < cutoff) {
          await unlink(candidate).catch(() => undefined);
        }
      }),
  );
}

/** Remove stale private Terminal launchers, including on app startup. */
export async function cleanupExpiredTerminalLaunchers(
  root = path.join(os.homedir(), '.aside', 'handoffs'),
): Promise<void> {
  const metadata = await lstat(root).catch(() => undefined);
  if (!metadata) return;
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('Aside launcher directory must be a real directory, not a symbolic link.');
  }
  await removeExpiredLaunchers(root);
}

/**
 * Create a private macOS Terminal launcher without using `shell: true`.
 *
 * Arguments are single-quoted individually, so vendor session IDs and paths
 * remain data even if they contain whitespace or shell metacharacters.
 */
export async function writeTerminalLauncher(
  intent: Extract<LaunchIntent, { kind: 'cli' }>,
  root = path.join(os.homedir(), '.aside', 'handoffs'),
): Promise<string> {
  if (!path.isAbsolute(intent.cwd) || !path.isAbsolute(intent.executable)) {
    throw new Error('Aside refused an untrusted launch path.');
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error('Aside launcher directory must be a real directory, not a symbolic link.');
  }
  await chmod(root, 0o700);
  await removeExpiredLaunchers(root);
  const scriptPath = path.join(root, `launch-${randomUUID()}.command`);
  const command = [intent.executable, ...intent.args].map(shellQuote).join(' ');
  const script = [
    '#!/bin/zsh',
    'set -e',
    `cd -- ${shellQuote(intent.cwd)}`,
    'rm -f -- "$0"',
    `exec ${command}`,
    '',
  ].join('\n');
  await writeFile(scriptPath, script, {
    encoding: 'utf8',
    mode: 0o700,
    flag: 'wx',
  });
  await chmod(scriptPath, 0o700);
  return scriptPath;
}

function assertAllowedDeepLink(intent: Extract<LaunchIntent, { kind: 'deep-link' }>) {
  const protocol = new URL(intent.url).protocol;
  const expected =
    intent.provider === 'codex'
      ? 'codex:'
      : intent.provider === 'claude'
        ? 'claude-cli:'
        : null;
  if (!expected || protocol !== expected) {
    throw new Error('Aside refused an unsupported application link.');
  }
}

/** Host adapter that performs only an already-confirmed, allowlisted intent. */
export class NativeOpenInHost implements OpenInLaunchHost {
  constructor(private readonly deps: NativeOpenInHostDeps) {}

  async execute(intent: LaunchIntent): Promise<void> {
    if (intent.requiresConfirmation !== true) {
      throw new Error('Aside refused an unconfirmed launch.');
    }
    if (intent.kind === 'deep-link') {
      assertAllowedDeepLink(intent);
      await this.deps.openExternal(intent.url);
      return;
    }
    if (intent.kind === 'open-workspace') {
      if (
        !path.isAbsolute(intent.cwd) ||
        !path.isAbsolute(intent.applicationPath) ||
        path.extname(intent.applicationPath) !== '.app'
      ) {
        throw new Error('Aside refused an untrusted application path.');
      }
      await this.deps.openApplication(intent.applicationPath, intent.cwd);
      return;
    }
    const launcher = await writeTerminalLauncher(
      intent,
      this.deps.launcherRoot,
    );
    try {
      await this.deps.openTerminalScript(launcher);
    } catch (error) {
      await unlink(launcher).catch(() => undefined);
      throw error;
    }
  }
}
