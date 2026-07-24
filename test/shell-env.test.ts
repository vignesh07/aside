import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { importShellEnv } from '../menubar/src/shell-env.js';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

const originalEnv = { ...process.env };

describe('importShellEnv', () => {
  beforeEach(() => {
    process.env = {
      ...originalEnv,
      SHELL: '/bin/zsh',
      PATH: '/usr/bin:/bin',
    };
    delete process.env['OPENAI_API_KEY'];
    delete process.env['CODEX_ACCESS_TOKEN'];
    delete process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_AUTH_TOKEN'];
    delete process.env['CLAUDE_CODE_OAUTH_TOKEN'];
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetAllMocks();
  });

  it('imports PATH and ignores every credential emitted by shell startup', () => {
    vi.mocked(execFileSync).mockReturnValue(
      [
        'startup banner',
        'OPENAI_API_KEY=openai-key',
        'CODEX_ACCESS_TOKEN=codex-token',
        'ANTHROPIC_API_KEY=anthropic-key',
        'ANTHROPIC_AUTH_TOKEN=anthropic-token',
        'CLAUDE_CODE_OAUTH_TOKEN=claude-token',
        'GITHUB_TOKEN=github-token',
        '__ASIDE_PATH__=/opt/homebrew/bin:/Users/me/.local/bin:/usr/bin',
      ].join('\n'),
    );

    expect(importShellEnv()).toEqual({ imported: ['PATH'] });
    expect(execFileSync).toHaveBeenCalledWith(
      '/bin/zsh',
      [
        '-l',
        '-i',
        '-c',
        `printf '__ASIDE_PATH__=%s\\n' "$PATH"`,
      ],
      expect.objectContaining({
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    );
    const command = vi.mocked(execFileSync).mock.calls[0]![1] as string[];
    expect(command.at(-1)).not.toContain('printenv');
    expect(process.env['PATH']).toBe('/opt/homebrew/bin:/Users/me/.local/bin:/usr/bin');
    expect(process.env['OPENAI_API_KEY']).toBeUndefined();
    expect(process.env['CODEX_ACCESS_TOKEN']).toBeUndefined();
    expect(process.env['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(process.env['ANTHROPIC_AUTH_TOKEN']).toBeUndefined();
    expect(process.env['CLAUDE_CODE_OAUTH_TOKEN']).toBeUndefined();
    expect(process.env['GITHUB_TOKEN']).toBeUndefined();
  });
});
