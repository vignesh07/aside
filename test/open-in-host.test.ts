import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanupExpiredTerminalLaunchers,
  NativeOpenInHost,
  writeTerminalLauncher,
} from '../menubar/src/open-in-host.js';
import type { LaunchIntent } from '../src/core/handoff/index.js';

const roots: string[] = [];

function tempDir(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('NativeOpenInHost', () => {
  it('writes a private launcher with shell-safe arguments', async () => {
    const root = tempDir('aside-terminal-launch-');
    const workspace = path.join(root, "project with ' quote");
    fs.mkdirSync(workspace);
    const intent: Extract<LaunchIntent, { kind: 'cli' }> = {
      kind: 'cli',
      provider: 'claude',
      executable: '/usr/local/bin/claude',
      args: ['--resume', 'id; touch /tmp/should-not-run'],
      cwd: workspace,
      requiresConfirmation: true,
      promptBehavior: 'none',
    };

    const launcher = await writeTerminalLauncher(intent, root);
    const contents = fs.readFileSync(launcher, 'utf8');

    expect(fs.statSync(root).mode & 0o777).toBe(0o700);
    expect(fs.statSync(launcher).mode & 0o777).toBe(0o700);
    expect(contents).toContain("cd -- '");
    expect(contents).toContain('rm -f -- "$0"');
    expect(contents).toContain("'id; touch /tmp/should-not-run'");
    expect(contents).toContain("'\\''");
  });

  it('allowlists deep-link schemes before opening them', async () => {
    const opened: string[] = [];
    const host = new NativeOpenInHost({
      openExternal: async (url) => { opened.push(url); },
      openTerminalScript: async () => {},
      openApplication: async () => {},
    });

    await host.execute({
      kind: 'deep-link',
      provider: 'codex',
      url: 'codex://threads/thread-1',
      cwd: '/tmp',
      requiresConfirmation: true,
      promptBehavior: 'none',
    });
    expect(opened).toEqual(['codex://threads/thread-1']);

    await expect(host.execute({
      kind: 'deep-link',
      provider: 'codex',
      url: 'https://example.com/steal',
      cwd: '/tmp',
      requiresConfirmation: true,
      promptBehavior: 'none',
    })).rejects.toThrow('unsupported application link');
  });

  it('refuses a symbolic-link launcher directory', async () => {
    const parent = tempDir('aside-terminal-symlink-');
    const target = path.join(parent, 'target');
    const symlink = path.join(parent, 'handoffs');
    fs.mkdirSync(target);
    fs.symlinkSync(target, symlink);

    await expect(writeTerminalLauncher({
      kind: 'cli',
      provider: 'claude',
      executable: '/usr/local/bin/claude',
      args: ['--resume', 'session-1'],
      cwd: parent,
      requiresConfirmation: true,
      promptBehavior: 'none',
    }, symlink)).rejects.toThrow('symbolic link');
  });

  it('keeps Cursor workspace launches separate from terminal launches', async () => {
    const applications: Array<[string, string]> = [];
    const appRoot = tempDir('aside-cursor-launch-');
    const cursor = path.join(appRoot, 'Cursor.app');
    fs.mkdirSync(cursor);
    const host = new NativeOpenInHost({
      openExternal: async () => {},
      openTerminalScript: async () => {},
      openApplication: async (application, cwd) => {
        applications.push([application, cwd]);
      },
    });

    await host.execute({
      kind: 'open-workspace',
      provider: 'cursor',
      applicationPath: cursor,
      cwd: appRoot,
      requiresConfirmation: true,
      promptBehavior: 'none',
      contextCarried: false,
    });

    expect(applications).toEqual([[cursor, appRoot]]);
  });

  it('removes expired launchers without touching recent or unrelated files', async () => {
    const root = tempDir('aside-terminal-cleanup-');
    const stale = path.join(root, 'launch-00000000-0000-0000-0000-000000000000.command');
    const recent = path.join(root, 'launch-11111111-1111-1111-1111-111111111111.command');
    const unrelated = path.join(root, 'keep.txt');
    fs.writeFileSync(stale, 'old');
    fs.writeFileSync(recent, 'new');
    fs.writeFileSync(unrelated, 'keep');
    const old = new Date(Date.now() - 25 * 60 * 60 * 1_000);
    fs.utimesSync(stale, old, old);

    await cleanupExpiredTerminalLaunchers(root);

    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(recent)).toBe(true);
    expect(fs.existsSync(unrelated)).toBe(true);
  });

  it('removes a generated launcher when Terminal cannot open it', async () => {
    const root = tempDir('aside-terminal-open-failure-');
    const host = new NativeOpenInHost({
      openExternal: async () => {},
      openTerminalScript: async () => {
        throw new Error('Terminal failed');
      },
      openApplication: async () => {},
      launcherRoot: root,
    });

    await expect(host.execute({
      kind: 'cli',
      provider: 'claude',
      executable: '/usr/local/bin/claude',
      args: ['--resume', 'session-1'],
      cwd: root,
      requiresConfirmation: true,
      promptBehavior: 'none',
    })).rejects.toThrow('Terminal failed');

    expect(
      fs.readdirSync(root).filter((name) => name.endsWith('.command')),
    ).toEqual([]);
  });
});
