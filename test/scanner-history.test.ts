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
