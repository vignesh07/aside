import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanClaudeSessions } from '../src/core/claude-scanner.js';
import { scanCodexSessions } from '../src/core/codex-scanner.js';
import { scanPiSessions } from '../src/core/pi-scanner.js';

const roots: string[] = [];
const NOW = Date.parse('2026-07-23T12:00:00.000Z');
const OLD = new Date(NOW - 30 * 86_400_000);

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aside-scanner-'));
  roots.push(root);
  return root;
}

function writeOld(file: string, lines: unknown[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  fs.utimesSync(file, OLD, OLD);
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('historical session discovery', () => {
  it('recurses through every Codex date directory and keeps old threads', () => {
    const sessionsDir = path.join(tempRoot(), 'sessions');
    writeOld(path.join(sessionsDir, '2025', '01', '02', 'rollout-old.jsonl'), [
      {
        type: 'session_meta',
        payload: {
          id: 'codex-old',
          cwd: '/Users/test/archive-project',
          cli_version: '1.0',
          git: { branch: 'main' },
        },
      },
      { type: 'turn_context', payload: { model: 'gpt-test' } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'Ship archive mode' } },
    ]);

    const result = scanCodexSessions({ sessionsDir, nowMs: NOW });
    expect(result).toHaveLength(1);
    expect(result[0]!.session).toMatchObject({
      id: 'codex-old',
      projectName: 'archive-project',
      title: 'Ship archive mode',
      status: 'history',
    });
  });

  it('keeps Codex archived sessions in machine-wide history', () => {
    const root = tempRoot();
    const sessionsDir = path.join(root, 'sessions');
    const archivedSessionsDir = path.join(root, 'archived_sessions');
    writeOld(path.join(archivedSessionsDir, 'rollout-archived.jsonl'), [
      {
        type: 'session_meta',
        payload: {
          id: 'codex-archived',
          cwd: '/Users/test/archived-project',
          git: { branch: 'main' },
        },
      },
      {
        type: 'event_msg',
        payload: { type: 'user_message', message: 'Remember this work' },
      },
    ]);

    const result = scanCodexSessions({
      sessionsDir,
      archivedSessionsDir,
      nowMs: NOW,
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.session).toMatchObject({
      id: 'codex-archived',
      projectName: 'archived-project',
      title: 'Remember this work',
      status: 'history',
    });
  });

  it('uses the rollout UUID when a fork copied its ancestor session id', () => {
    const sessionsDir = path.join(tempRoot(), 'sessions');
    const rolloutId = '019f793d-837d-78b3-bde0-cd5de6cb80d4';
    writeOld(
      path.join(
        sessionsDir,
        '2026',
        '07',
        '19',
        `rollout-2026-07-19T00-18-22-${rolloutId}.jsonl`,
      ),
      [
        {
          type: 'session_meta',
          payload: {
            id: '019f6c46-2c06-7982-a85a-cbf8bdadfb67',
            cwd: '/Users/test/fork',
          },
        },
      ],
    );

    const [result] = scanCodexSessions({ sessionsDir, nowMs: NOW });
    expect(result?.session.id).toBe(rolloutId);
  });

  it('excludes internal Codex subagent rollouts from top-level threads', () => {
    const sessionsDir = path.join(tempRoot(), 'sessions');
    writeOld(path.join(sessionsDir, '2026', '07', '23', 'rollout-user.jsonl'), [
      {
        type: 'session_meta',
        payload: {
          id: 'user-thread',
          cwd: '/Users/test/project',
          source: 'vscode',
          thread_source: 'user',
        },
      },
      {
        type: 'event_msg',
        payload: { type: 'user_message', message: 'Build the feature' },
      },
    ]);
    writeOld(path.join(sessionsDir, '2026', '07', '23', 'rollout-subagent.jsonl'), [
      {
        type: 'session_meta',
        payload: {
          id: 'subagent-thread',
          cwd: '/Users/test/project',
          source: 'vscode',
          thread_source: 'subagent',
        },
      },
      {
        type: 'event_msg',
        payload: { type: 'user_message', message: 'Build the feature' },
      },
    ]);
    writeOld(path.join(sessionsDir, '2026', '04', '28', 'rollout-legacy-subagent.jsonl'), [
      {
        type: 'session_meta',
        payload: {
          id: 'legacy-subagent-thread',
          cwd: '/Users/test/project',
          source: {
            subagent: {
              thread_spawn: {
                parent_thread_id: 'user-thread',
                depth: 1,
              },
            },
          },
        },
      },
      {
        type: 'event_msg',
        payload: { type: 'user_message', message: 'Build the feature' },
      },
    ]);

    const result = scanCodexSessions({ sessionsDir, nowMs: NOW });
    expect(result.map(({ session }) => session.id)).toEqual(['user-thread']);

    const withInternal = scanCodexSessions({
      sessionsDir,
      nowMs: NOW,
      includeInternal: true,
    });
    expect(
      withInternal
        .filter(({ session }) => session.isInternal)
        .map(({ session }) => [session.id, session.parentSessionId])
        .sort(),
    ).toEqual([
      ['legacy-subagent-thread', 'user-thread'],
      ['subagent-thread', undefined],
    ]);
  });

  it('keeps old Claude Code project transcripts searchable', () => {
    const claudeDir = tempRoot();
    writeOld(path.join(claudeDir, 'projects', '-Users-test-claude-project', 'claude-old.jsonl'), [
      {
        cwd: '/Users/test/claude-project',
        gitBranch: 'feature/history',
        slug: 'old-work',
        version: '1.0',
        message: { model: 'claude-test' },
      },
      { type: 'ai-title', aiTitle: 'Research the old launch' },
    ]);

    const result = scanClaudeSessions({ claudeDir, nowMs: NOW });
    expect(result).toHaveLength(1);
    expect(result[0]!.session).toMatchObject({
      id: 'claude-old',
      projectName: 'claude-project',
      title: 'Research the old launch',
      status: 'history',
    });
  });

  it('discovers Claude Code subagents beneath their parent task on demand', () => {
    const claudeDir = tempRoot();
    const projectDir = path.join(
      claudeDir,
      'projects',
      '-Users-test-claude-workers',
    );
    const parentId = '20fab568-29de-49ba-a286-11f20382993e';
    writeOld(path.join(projectDir, `${parentId}.jsonl`), [
      {
        type: 'user',
        sessionId: parentId,
        cwd: '/Users/test/claude-workers',
        gitBranch: 'feature/workers',
        slug: 'parent-task',
        version: '2.1',
        message: {
          role: 'user',
          content: 'Coordinate the launch review',
        },
      },
    ]);
    writeOld(
      path.join(
        projectDir,
        parentId,
        'subagents',
        'agent-a192d43b1fa2ed258.jsonl',
      ),
      [
        {
          type: 'user',
          // Claude records the owning task here, not the worker identity.
          sessionId: parentId,
          agentId: 'a192d43b1fa2ed258',
          isSidechain: true,
          cwd: '/Users/test/claude-workers',
          gitBranch: 'feature/workers',
          slug: 'worker-task',
          version: '2.1',
          message: {
            role: 'user',
            content: 'Review the release pipeline for hidden blockers',
          },
        },
        {
          type: 'assistant',
          sessionId: parentId,
          agentId: 'a192d43b1fa2ed258',
          isSidechain: true,
          cwd: '/Users/test/claude-workers',
          message: {
            role: 'assistant',
            model: 'claude-test',
            content: [{ type: 'text', text: 'Review complete' }],
          },
        },
      ],
    );

    expect(
      scanClaudeSessions({ claudeDir, nowMs: NOW })
        .map(({ session }) => session.id),
    ).toEqual([parentId]);

    const withInternal = scanClaudeSessions({
      claudeDir,
      nowMs: NOW,
      includeInternal: true,
    });
    expect(withInternal.map(({ session }) => session.id).sort()).toEqual([
      parentId,
      'agent-a192d43b1fa2ed258',
    ].sort());
    expect(
      withInternal.find(
        ({ session }) => session.id === 'agent-a192d43b1fa2ed258',
      )?.session,
    ).toMatchObject({
      source: 'claude',
      isInternal: true,
      parentSessionId: parentId,
      projectName: 'claude-workers',
      title: 'Review the release pipeline for hidden blockers',
      model: 'claude-test',
      status: 'history',
    });
  });

  it('keeps orphaned Claude subagents selectable without inventing a parent', () => {
    const claudeDir = tempRoot();
    const projectDir = path.join(
      claudeDir,
      'projects',
      '-Users-test-claude-orphan',
    );
    const missingParentId = '44261e97-a180-43eb-bcf3-c039b09f0b0d';
    writeOld(
      path.join(
        projectDir,
        missingParentId,
        'subagents',
        'agent-af4516532454cb45f.jsonl',
      ),
      [{
        type: 'user',
        sessionId: missingParentId,
        agentId: 'af4516532454cb45f',
        isSidechain: true,
        cwd: '/Users/test/claude-orphan',
        message: {
          role: 'user',
          content: 'Recover an old worker result',
        },
      }],
    );

    const [result] = scanClaudeSessions({
      claudeDir,
      nowMs: NOW,
      includeInternal: true,
    });
    expect(result?.session).toMatchObject({
      id: 'agent-af4516532454cb45f',
      isInternal: true,
      parentSessionId: missingParentId,
      title: 'Recover an old worker result',
    });
  });

  it('keeps old Pi transcripts searchable', () => {
    const sessionsDir = tempRoot();
    writeOld(path.join(sessionsDir, '--Users-test-pi-project--', 'session_pi-old.jsonl'), [
      {
        type: 'session',
        id: 'pi-old',
        cwd: '/Users/test/pi-project',
        version: '1.0',
      },
      { type: 'model_change', modelId: 'pi-test' },
    ]);

    const result = scanPiSessions({ sessionsDir, nowMs: NOW });
    expect(result).toHaveLength(1);
    expect(result[0]!.session).toMatchObject({
      id: 'pi-old',
      projectName: 'pi-project',
      status: 'history',
    });
  });
});
