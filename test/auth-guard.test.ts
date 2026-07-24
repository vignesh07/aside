import { describe, expect, it, vi } from 'vitest';
import {
  requireUsableProvider,
  validatedProviderId,
} from '../menubar/src/auth-guard.js';
import type { ProviderAuthStatus } from '../menubar/src/provider-auth.js';

const status = (
  state: ProviderAuthStatus['state'],
  enabled: boolean,
): ProviderAuthStatus => ({
  provider: 'codex-cli',
  state,
  enabled,
});

describe('main-process provider guard', () => {
  it('rejects malformed, oversized, and unknown IDs before probing', async () => {
    const probe = vi.fn(async () => status('signed_in', true));
    const source = { probe };
    for (const value of [
      '../codex',
      'OPENAI',
      'x'.repeat(65),
      'openai',
      42,
      null,
    ]) {
      expect(validatedProviderId(value)).toBeNull();
      await expect(
        requireUsableProvider(value, source, 'Connect first.'),
      ).rejects.toThrow('Connect first.');
    }
    expect(probe).not.toHaveBeenCalled();
  });

  it('rejects signed-out, errored, or unconsented providers', async () => {
    for (const candidate of [
      status('signed_out', true),
      status('error', true),
      status('signed_in', false),
    ]) {
      await expect(
        requireUsableProvider(
          'codex-cli',
          { probe: vi.fn(async () => candidate) },
          'Connect first.',
        ),
      ).rejects.toThrow('Connect first.');
    }
  });

  it('allows only an enabled provider that is ready now', async () => {
    const probe = vi.fn(async () => status('signed_in', true));
    await expect(
      requireUsableProvider('codex-cli', { probe }, 'Connect first.'),
    ).resolves.toBe('codex-cli');
    expect(probe).toHaveBeenCalledOnce();
  });

  it('sanitizes unexpected probe failures', async () => {
    await expect(
      requireUsableProvider(
        'codex-cli',
        {
          probe: vi.fn(async () => {
            throw new Error('secret stderr and stack');
          }),
        },
        'Connect first.',
      ),
    ).rejects.toThrow(/^Connect first\.$/);
  });
});
