import { describe, expect, it } from 'vitest';
import { createVendorCliEnv } from '../src/core/providers/vendor-cli-env.js';

describe('createVendorCliEnv', () => {
  it('preserves executable, login-cache, network, locale, and trust-store paths', () => {
    const result = createVendorCliEnv({
      HOME: '/Users/me',
      USER: 'me',
      PATH: '/opt/homebrew/bin:/usr/bin',
      TMPDIR: '/private/tmp/me',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'C',
      https_proxy: 'http://proxy.example:8080',
      NO_PROXY: 'localhost',
      NODE_EXTRA_CA_CERTS: '/etc/company.pem',
      XDG_CONFIG_HOME: '/Users/me/.config',
      CODEX_HOME: '/Users/me/.codex-work',
      CLAUDE_CONFIG_DIR: '/Users/me/.claude-work',
    });

    expect(result).toEqual({
      HOME: '/Users/me',
      USER: 'me',
      PATH: '/opt/homebrew/bin:/usr/bin',
      TMPDIR: '/private/tmp/me',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'C',
      https_proxy: 'http://proxy.example:8080',
      NO_PROXY: 'localhost',
      NODE_EXTRA_CA_CERTS: '/etc/company.pem',
      XDG_CONFIG_HOME: '/Users/me/.config',
      CODEX_HOME: '/Users/me/.codex-work',
      CLAUDE_CONFIG_DIR: '/Users/me/.claude-work',
    });
  });

  it('strips API keys, auth tokens, and unrelated process hooks', () => {
    const result = createVendorCliEnv({
      HOME: '/Users/me',
      PATH: '/usr/bin',
      OPENAI_API_KEY: 'openai-key',
      CODEX_API_KEY: 'codex-key',
      CODEX_ACCESS_TOKEN: 'codex-token',
      ANTHROPIC_API_KEY: 'anthropic-key',
      ANTHROPIC_AUTH_TOKEN: 'anthropic-token',
      CLAUDE_CODE_OAUTH_TOKEN: 'claude-token',
      SOME_API_KEY: 'other-key',
      GITHUB_TOKEN: 'github-token',
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
      NODE_OPTIONS: '--require /tmp/hook.cjs',
    });

    expect(result).toEqual({
      HOME: '/Users/me',
      PATH: '/usr/bin',
    });
  });
});
