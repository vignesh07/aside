import { describe, expect, it, vi } from 'vitest';
import type { ProviderAuthStatus } from '../menubar/src/provider-auth.js';
import {
  grantTodayRecapPermission,
  runAuthorizedTodayRecap,
  type TodayRecapAuthorizationSource,
} from '../menubar/src/today-authorization.js';

const target = {
  threadId: 'fleet',
  provider: 'codex-cli',
  model: 'gpt-5.6-sol',
};

function authSource(
  status: ProviderAuthStatus = {
    provider: 'codex-cli',
    state: 'signed_in',
    enabled: true,
  },
  initiallyAllowed = false,
): TodayRecapAuthorizationSource & {
  probe: ReturnType<typeof vi.fn>;
  allowTodayRecaps: ReturnType<typeof vi.fn>;
} {
  let allowed = initiallyAllowed;
  return {
    probe: vi.fn(async () => status),
    todayRecapsEnabled: vi.fn(() => allowed),
    allowTodayRecaps: vi.fn(() => {
      allowed = true;
    }),
  };
}

describe('main-process Today authorization', () => {
  it('never reaches generation without separate Today permission', async () => {
    const source = authSource();
    const generate = vi.fn(async () => 'generated');

    await expect(
      runAuthorizedTodayRecap(target, source, generate),
    ).rejects.toThrow('Allow Today recaps before generating.');
    expect(source.probe).toHaveBeenCalledOnce();
    expect(generate).not.toHaveBeenCalled();
  });

  it('runs exactly the authorized target after readiness and consent checks', async () => {
    const source = authSource(undefined, true);
    const generate = vi.fn(async () => 'generated');

    await expect(
      runAuthorizedTodayRecap(target, source, generate),
    ).resolves.toBe('generated');
    expect(generate).toHaveBeenCalledOnce();
    expect(generate).toHaveBeenCalledWith(target);
  });

  it('rejects invalid or changed permission targets before saving', async () => {
    const source = authSource();
    await expect(
      grantTodayRecapPermission('../codex', target, source),
    ).rejects.toThrow('not supported');
    await expect(
      grantTodayRecapPermission(
        'claude-cli',
        target,
        source,
      ),
    ).rejects.toThrow('provider changed');
    expect(source.probe).not.toHaveBeenCalled();
    expect(source.allowTodayRecaps).not.toHaveBeenCalled();
  });

  it('persists permission only after the provider is ready and enabled', async () => {
    const source = authSource();
    await expect(
      grantTodayRecapPermission('codex-cli', target, source),
    ).resolves.toBe(true);
    expect(source.probe).toHaveBeenCalledOnce();
    expect(source.allowTodayRecaps).toHaveBeenCalledOnce();
    expect(source.todayRecapsEnabled('codex-cli')).toBe(true);
  });

  it('keeps Ollama local but still requires enabled, ready base access', async () => {
    const generate = vi.fn(async () => 'local');
    const disabled = authSource(
      { provider: 'ollama', state: 'local_ready', enabled: false },
      true,
    );
    await expect(
      runAuthorizedTodayRecap(
        { ...target, provider: 'ollama', model: 'qwen3:latest' },
        disabled,
        generate,
      ),
    ).rejects.toThrow('Connect the Today recap provider');
    expect(generate).not.toHaveBeenCalled();

    const enabled = authSource(
      { provider: 'ollama', state: 'local_ready', enabled: true },
      true,
    );
    await expect(
      runAuthorizedTodayRecap(
        { ...target, provider: 'ollama', model: 'qwen3:latest' },
        enabled,
        generate,
      ),
    ).resolves.toBe('local');
    expect(generate).toHaveBeenCalledOnce();
  });
});
