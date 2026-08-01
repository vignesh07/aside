import { describe, expect, it } from 'vitest';
import {
  canDisconnectProvider,
  canAskWithProvider,
  isProviderUsable,
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
    expect(isProviderUsable(auth('ollama', 'local_ready', true))).toBe(true);
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

  it('chooses a provider recommendation without crossing providers', () => {
    expect(
      recommendedModelForProvider(models, 'codex-cli')?.model,
    ).toBe('codex-fast');
    expect(
      recommendedModelForProvider(models, 'claude-cli')?.model,
    ).toBe('claude-fast');
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
    expect(providerHelpLink('ollama')).toBeUndefined();
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
