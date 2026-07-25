import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanupExpiredHandoffCapsules,
  createHandoffBundle,
  HANDOFF_SCHEMA_VERSION,
  writeHandoffCapsule,
} from '../src/core/handoff/index.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTemp(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(directory);
  return directory;
}

describe('agent handoff bundle', () => {
  it('creates a bounded, redacted, provenance-bearing bundle with live Git state', async () => {
    const workspace = makeTemp('aside-handoff-workspace-');
    execFileSync('git', ['init', '-q', workspace]);
    execFileSync('git', ['-C', workspace, 'config', 'user.email', 'aside@example.test']);
    execFileSync('git', ['-C', workspace, 'config', 'user.name', 'Aside Tests']);
    fs.writeFileSync(path.join(workspace, 'tracked.txt'), 'first\n');
    execFileSync('git', ['-C', workspace, 'add', 'tracked.txt']);
    execFileSync('git', ['-C', workspace, 'commit', '-qm', 'initial']);
    fs.writeFileSync(path.join(workspace, 'tracked.txt'), 'changed\n');
    fs.writeFileSync(path.join(workspace, 'new.txt'), 'untracked\n');

    const secret = ['sk', 'proj', 'abcdefghijklmnopqrstuvwxyz'].join('-');
    const bundle = await createHandoffBundle({
      source: {
        provider: 'codex',
        sessionId: 'source-1',
        title: `Fix auth with api_key=${secret}`,
      },
      workspace: {
        cwd: workspace,
        projectName: 'Aside',
        recordedBranch: 'stale-branch',
      },
      recentTranscript: [
        { role: 'user', text: 'oldest prompt' },
        { role: 'user', text: `Ship it with api_key=${secret}` },
        { role: 'assistant', text: 'Implementation is ready for review.' },
      ],
      relevantFiles: ['src/main.ts'],
      nextActions: ['Run tests'],
      maxTranscriptEntries: 2,
    });

    expect(bundle.schema).toBe('aside.agent-handoff');
    expect(bundle.schemaVersion).toBe(HANDOFF_SCHEMA_VERSION);
    expect(bundle.source.title).not.toContain(secret);
    expect(JSON.stringify(bundle)).not.toContain(secret);
    expect(bundle.objective).toContain('[REDACTED]');
    expect(bundle.currentState).toBe('Implementation is ready for review.');
    expect(bundle.recentTranscript).toHaveLength(2);
    expect(bundle.redaction.omittedTranscriptEntries).toBe(1);
    expect(bundle.redaction.fieldsChanged).toBeGreaterThan(0);
    expect(bundle.workspace.git.available).toBe(true);
    expect(bundle.workspace.git.dirty).toBe(true);
    expect(bundle.workspace.git.unstagedCount).toBe(1);
    expect(bundle.workspace.git.untrackedCount).toBe(1);
    expect(bundle.workspace.git.changedFiles).toEqual(
      expect.arrayContaining(['tracked.txt', 'new.txt']),
    );
    expect(bundle.provenance).toEqual({
      generatedBy: 'Aside',
      sourceUnchanged: true,
      transcriptIsExcerpt: true,
      hiddenProviderStateIncluded: false,
    });
  });

  it('keeps optional Aside side-chat separate and opt-in', async () => {
    const workspace = makeTemp('aside-handoff-side-chat-');
    const withoutSideChat = await createHandoffBundle({
      source: { provider: 'claude', sessionId: 'claude-1' },
      workspace: { cwd: workspace },
      recentTranscript: [{ role: 'user', text: 'Source prompt' }],
    });
    const withSideChat = await createHandoffBundle({
      source: { provider: 'claude', sessionId: 'claude-1' },
      workspace: { cwd: workspace },
      recentTranscript: [{ role: 'user', text: 'Source prompt' }],
      asideSideChat: [{ role: 'assistant', text: 'Separate Aside advice' }],
    });

    expect(withoutSideChat.asideSideChat).toBeUndefined();
    expect(withSideChat.asideSideChat?.[0]?.text).toBe('Separate Aside advice');
  });

  it('redacts source IDs and every textual Git snapshot field before serialization', async () => {
    const workspace = makeTemp('aside-handoff-git-redaction-');
    const token = ['ghp', 'abcdefghijklmnopqrstuvwxyz'].join('_');
    const changedFilename = `notes/${token}.txt`;
    execFileSync('git', ['init', '-q', workspace]);
    execFileSync('git', ['-C', workspace, 'config', 'user.email', 'aside@example.test']);
    execFileSync('git', ['-C', workspace, 'config', 'user.name', 'Aside Tests']);
    execFileSync('git', ['-C', workspace, 'checkout', '-qb', `work/${token}`]);
    fs.mkdirSync(path.join(workspace, 'notes'));
    fs.writeFileSync(path.join(workspace, changedFilename), 'untracked\n');
    execFileSync('git', ['-C', workspace, 'add', changedFilename]);

    const bundle = await createHandoffBundle({
      source: {
        provider: 'codex',
        sessionId: `session-${token}`,
        parentSessionId: `parent-${token}`,
        isSubagent: true,
      },
      workspace: { cwd: workspace },
      recentTranscript: [{
        role: 'user',
        text: 'Continue safely.',
        timestamp: `event-${token}`,
      }],
    });

    expect(bundle.source.sessionId).toBe('session-[REDACTED]');
    expect(bundle.source.parentSessionId).toBe('parent-[REDACTED]');
    expect(bundle.workspace.git.branch).toBe('work/[REDACTED]');
    expect(bundle.workspace.git.changedFiles).toContain('notes/[REDACTED].txt');
    expect(bundle.recentTranscript[0]?.timestamp).toBe('event-[REDACTED]');
    expect(JSON.stringify(bundle.source)).not.toContain(token);
    expect(JSON.stringify(bundle.workspace.git)).not.toContain(token);
    expect(JSON.stringify(bundle.recentTranscript)).not.toContain(token);
    expect(bundle.redaction.fieldsChanged).toBeGreaterThanOrEqual(5);
  });

  it('writes random private capsules under an explicitly scoped directory', async () => {
    const workspace = makeTemp('aside-handoff-capsule-workspace-');
    const capsuleRoot = path.join(makeTemp('aside-handoff-root-'), 'handoffs');
    const bundle = await createHandoffBundle({
      source: { provider: 'codex', sessionId: 'codex-1' },
      workspace: { cwd: workspace },
      recentTranscript: [{ role: 'user', text: 'Continue this task' }],
    });

    const capsule = await writeHandoffCapsule(bundle, { rootDir: capsuleRoot });
    const directoryMode = fs.statSync(capsuleRoot).mode & 0o777;
    const fileMode = fs.statSync(capsule.path).mode & 0o777;

    expect(path.dirname(capsule.path)).toBe(capsuleRoot);
    expect(path.basename(capsule.path)).toMatch(/^handoff-[0-9a-f-]+\.json$/);
    expect(directoryMode).toBe(0o700);
    expect(fileMode).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(capsule.path, 'utf8'))).toMatchObject({
      schema: 'aside.agent-handoff',
      source: { provider: 'codex', sessionId: 'codex-1' },
    });
  });

  it('cleans up only expired real capsule files and rejects a symlinked root', async () => {
    const workspace = makeTemp('aside-handoff-cleanup-workspace-');
    const parent = makeTemp('aside-handoff-cleanup-parent-');
    const capsuleRoot = path.join(parent, 'handoffs');
    const missingRoot = path.join(parent, 'not-created');
    await expect(cleanupExpiredHandoffCapsules({ rootDir: missingRoot }))
      .resolves.toBe(0);
    expect(fs.existsSync(missingRoot)).toBe(false);

    const bundle = await createHandoffBundle({
      source: { provider: 'codex', sessionId: 'codex-cleanup' },
      workspace: { cwd: workspace },
    });
    const expired = await writeHandoffCapsule(bundle, { rootDir: capsuleRoot });
    const fresh = await writeHandoffCapsule(bundle, { rootDir: capsuleRoot });
    const unrelated = path.join(capsuleRoot, 'notes.json');
    fs.writeFileSync(unrelated, '{}\n');
    const old = new Date(Date.now() - 2 * 60_000);
    fs.utimesSync(expired.path, old, old);

    await expect(cleanupExpiredHandoffCapsules({
      rootDir: capsuleRoot,
      maxAgeMs: 60_000,
    })).resolves.toBe(1);
    expect(fs.existsSync(expired.path)).toBe(false);
    expect(fs.existsSync(fresh.path)).toBe(true);
    expect(fs.existsSync(unrelated)).toBe(true);

    const symlinkRoot = path.join(parent, 'linked-handoffs');
    fs.symlinkSync(capsuleRoot, symlinkRoot);
    await expect(cleanupExpiredHandoffCapsules({ rootDir: symlinkRoot }))
      .rejects.toThrow('not a symbolic link');
  });

  it('refuses a symlinked capsule directory', async () => {
    const workspace = makeTemp('aside-handoff-symlink-workspace-');
    const parent = makeTemp('aside-handoff-symlink-parent-');
    const target = path.join(parent, 'real');
    const symlink = path.join(parent, 'handoffs');
    fs.mkdirSync(target);
    fs.symlinkSync(target, symlink);
    const bundle = await createHandoffBundle({
      source: { provider: 'codex', sessionId: 'codex-1' },
      workspace: { cwd: workspace },
    });

    await expect(writeHandoffCapsule(bundle, { rootDir: symlink }))
      .rejects.toThrow('not a symbolic link');
  });
});
