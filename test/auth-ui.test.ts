import { describe, expect, it } from 'vitest';
import {
  canDisconnectProvider,
  canAskWithModel,
  canAskWithProvider,
  isProviderUsable,
  providerDisplayName,
  providerHelpLink,
  providerStatusText,
  recommendedModelForProvider,
  shouldShowFirstRun,
  visibleModels,
} from '../menubar/src/auth-ui.js';
import type { ProviderAuthStatus } from '../menubar/src/provider-auth.js';

const auth = (
  provider: ProviderAuthStatus['provider'],
  state: ProviderAuthStatus['state'],
  enabled = false,
): ProviderAuthStatus => ({ provider, state, enabled });

const models = [
  { provider: 'codex-cli', model: 'codex-fast', recommended: true },
  { provider: 'codex-cli', model: 'codex-deep' },
  { provider: 'claude-cli', model: 'claude-fast', recommended: true },
  {
    provider: 'pi-cli',
    model: 'openai-codex/gpt-5.4',
    recommended: true,
  },
  { provider: 'openai', model: 'direct-api' },
];

describe('auth UI state', () => {
  it('requires explicit consent even when the vendor is signed in', () => {
    const status = auth('codex-cli', 'signed_in');
    expect(isProviderUsable(status)).toBe(false);
    expect(canAskWithProvider([status], 'codex-cli')).toBe(false);
  });

  it('allows only enabled and ready providers', () => {
    expect(isProviderUsable(auth('codex-cli', 'signed_in', true))).toBe(true);
    expect(isProviderUsable(auth('pi-cli', 'configured', true))).toBe(true);
    expect(isProviderUsable(auth('ollama', 'local_ready', true))).toBe(true);
    expect(isProviderUsable(auth('pi-cli', 'configured'))).toBe(false);
    expect(isProviderUsable(auth('claude-cli', 'signed_out', true))).toBe(false);
    expect(isProviderUsable(auth('claude-cli', 'error', true))).toBe(false);
  });

  it('always allows Aside consent to be revoked, even when a provider is offline', () => {
    expect(canDisconnectProvider(auth('codex-cli', 'signed_out', true))).toBe(true);
    expect(canDisconnectProvider(auth('claude-cli', 'error', true))).toBe(true);
    expect(canDisconnectProvider(auth('ollama', 'missing', true))).toBe(true);
    expect(canDisconnectProvider(auth('codex-cli', 'signed_in'))).toBe(false);
  });

  it('shows first run only before onboarding and without a usable provider', () => {
    expect(
      shouldShowFirstRun([auth('codex-cli', 'signed_in')], false),
    ).toBe(true);
    expect(
      shouldShowFirstRun([auth('codex-cli', 'signed_in', true)], false),
    ).toBe(false);
    expect(shouldShowFirstRun([], true)).toBe(false);
  });

  it('filters the catalog to explicitly enabled providers', () => {
    expect(
      visibleModels(models, [
        auth('codex-cli', 'signed_in', true),
        auth('claude-cli', 'signed_in'),
      ]),
    ).toEqual(models.slice(0, 2));
  });

  it('fails closed for unknown and disconnected active providers', () => {
    const statuses = [auth('codex-cli', 'signed_in', true)];
    expect(canAskWithProvider(statuses, 'openai')).toBe(false);
    expect(canAskWithProvider(statuses, 'claude-cli')).toBe(false);
  });

  it('requires an enabled Pi thread\'s exact upstream model to remain available', () => {
    const statuses = [auth('pi-cli', 'configured', true)];

    expect(
      canAskWithModel(
        statuses,
        models,
        'pi-cli',
        'openai-codex/gpt-5.4',
      ),
    ).toBe(true);
    expect(
      canAskWithModel(
        statuses,
        models,
        'pi-cli',
        'anthropic/claude-sonnet-4-6',
      ),
    ).toBe(false);
    expect(
      canAskWithModel(
        [auth('pi-cli', 'configured')],
        models,
        'pi-cli',
        'openai-codex/gpt-5.4',
      ),
    ).toBe(false);

    // Static vendor clients keep their existing provider-level auth contract.
    expect(
      canAskWithModel(
        [auth('codex-cli', 'signed_in', true)],
        [],
        'codex-cli',
        'codex-fast',
      ),
    ).toBe(true);
  });

  it('names account routes after the clients Aside delegates through', () => {
    expect(providerDisplayName('codex-cli')).toBe('Codex');
    expect(providerDisplayName('claude-cli')).toBe('Claude Code');
    expect(providerDisplayName('pi-cli')).toBe('Pi');
  });

  it('chooses a provider recommendation without crossing providers', () => {
    expect(
      recommendedModelForProvider(models, 'codex-cli')?.model,
    ).toBe('codex-fast');
    expect(
      recommendedModelForProvider(models, 'claude-cli')?.model,
    ).toBe('claude-fast');
    expect(
      recommendedModelForProvider(models, 'pi-cli')?.model,
    ).toBe('openai-codex/gpt-5.4');
    expect(recommendedModelForProvider(models, 'ollama')).toBeUndefined();
  });

  it('offers official recovery guides when a vendor client is missing', () => {
    expect(providerStatusText(auth('codex-cli', 'missing'))).toBe(
      'Codex CLI was not found',
    );
    expect(providerHelpLink('codex-cli')).toEqual({
      label: 'Setup Guide…',
      title: 'Open the official Codex CLI setup guide',
      url: 'https://learn.chatgpt.com/docs/codex/cli',
    });

    expect(providerStatusText(auth('claude-cli', 'missing'))).toBe(
      'Claude Code was not found',
    );
    expect(providerHelpLink('claude-cli')).toEqual({
      label: 'Setup Guide…',
      title: 'Open the official Claude Code setup guide',
      url: 'https://code.claude.com/docs/en/getting-started',
    });
    expect(providerStatusText(auth('pi-cli', 'missing'))).toBe(
      'Pi was not found',
    );
    expect(
      providerStatusText({
        provider: 'pi-cli',
        state: 'signed_out',
        enabled: false,
        reason: 'no_models',
      }),
    ).toBe('No authenticated models in Pi');
    expect(
      providerStatusText({
        provider: 'pi-cli',
        state: 'error',
        enabled: false,
        reason: 'client_too_old',
      }),
    ).toBe('Pi needs to be updated');
    expect(providerHelpLink('pi-cli')).toEqual({
      label: 'Setup Guide…',
      title: 'Open the official Pi provider setup guide',
      url: 'https://pi.dev/docs/latest/providers',
    });
    expect(providerHelpLink('ollama')).toBeUndefined();
  });

  it('shows models delegated through an explicitly enabled Pi client', () => {
    expect(
      visibleModels(models, [auth('pi-cli', 'configured', true)]),
    ).toEqual([
      {
        provider: 'pi-cli',
        model: 'openai-codex/gpt-5.4',
        recommended: true,
      },
    ]);
    expect(providerStatusText(auth('pi-cli', 'configured'))).toBe(
      'Models available through Pi',
    );
  });

  it('surfaces unreadable Aside consent instead of blaming vendor sign-in', () => {
    expect(
      providerStatusText({
        provider: 'codex-cli',
        state: 'signed_in',
        enabled: false,
        reason: 'consent_unavailable',
      }),
    ).toBe('Aside could not read saved access');
  });
});
