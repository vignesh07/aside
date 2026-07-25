import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { GitSnapshot } from './types.js';

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT = 2 * 1024 * 1024;
const MAX_CHANGED_FILES = 200;

async function git(cwd: string, args: string[], trim = true): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    maxBuffer: MAX_GIT_OUTPUT,
    timeout: 5_000,
  });
  return trim ? stdout.trim() : stdout;
}

function emptySnapshot(error?: string): GitSnapshot {
  return {
    available: false,
    dirty: false,
    stagedCount: 0,
    unstagedCount: 0,
    untrackedCount: 0,
    changedFiles: [],
    ...(error ? { error } : {}),
  };
}

/**
 * Capture launch-time repository identity and dirtiness without reading file
 * contents or invoking a shell. The handoff therefore describes the actual
 * worktree being opened rather than relying on stale transcript metadata.
 */
export async function captureGitSnapshot(cwd: string): Promise<GitSnapshot> {
  try {
    const cwdStat = await stat(cwd);
    if (!cwdStat.isDirectory()) return emptySnapshot('Workspace is not a directory.');
  } catch {
    return emptySnapshot('Workspace is unavailable.');
  }

  try {
    const repositoryRoot = await git(cwd, ['rev-parse', '--show-toplevel']);
    const head = await git(cwd, ['rev-parse', 'HEAD']).catch(() => undefined);
    const branch = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
      .catch(() => undefined);
    const rawStatus = await git(cwd, [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=normal',
    ], false);

    let stagedCount = 0;
    let unstagedCount = 0;
    let untrackedCount = 0;
    const changedFiles: string[] = [];
    const records = rawStatus ? rawStatus.split('\0').filter(Boolean) : [];

    for (let index = 0; index < records.length; index += 1) {
      const record = records[index]!;
      const x = record[0] ?? ' ';
      const y = record[1] ?? ' ';
      const file = record.slice(3);

      if (x === '?' && y === '?') {
        untrackedCount += 1;
      } else {
        if (x !== ' ' && x !== '?') stagedCount += 1;
        if (y !== ' ' && y !== '?') unstagedCount += 1;
      }
      if (changedFiles.length < MAX_CHANGED_FILES && file) changedFiles.push(file);

      // Porcelain v1 emits a second NUL-delimited path for renames/copies.
      if (x === 'R' || x === 'C') {
        const destination = records[index + 1];
        if (destination && changedFiles.length < MAX_CHANGED_FILES) {
          changedFiles.push(destination);
        }
        index += 1;
      }
    }

    return {
      available: true,
      repositoryRoot,
      ...(branch ? { branch } : {}),
      ...(head ? { head } : {}),
      dirty: stagedCount + unstagedCount + untrackedCount > 0,
      stagedCount,
      unstagedCount,
      untrackedCount,
      changedFiles,
    };
  } catch {
    return emptySnapshot('Workspace is not a Git repository.');
  }
}
