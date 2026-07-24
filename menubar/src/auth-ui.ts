import type {
  ProviderAuthStatus,
  ProviderAuthId,
} from './provider-auth.js';

export interface AuthModelOption {
  provider: string;
  model: string;
  recommended?: boolean;
  label?: string;
}

export interface ProviderHelpLink {
  label: string;
  title: string;
  url: string;
}

const PROVIDER_HELP_LINKS: Partial<Record<ProviderAuthId, ProviderHelpLink>> = {
  'codex-cli': {
    label: 'Setup Guide…',
    title: 'Open the official Codex CLI setup guide',
    url: 'https://learn.chatgpt.com/docs/codex/cli',
  },
  'claude-cli': {
    label: 'Setup Guide…',
    title: 'Open the official Claude Code setup guide',
    url: 'https://code.claude.com/docs/en/getting-started',
  },
};

export function providerHelpLink(
  provider: ProviderAuthId,
): ProviderHelpLink | undefined {
  return PROVIDER_HELP_LINKS[provider];
}

export function isProviderUsable(status: ProviderAuthStatus): boolean {
  return (
    status.enabled &&
    (status.state === 'signed_in' || status.state === 'local_ready')
  );
}

export function canDisconnectProvider(status: ProviderAuthStatus): boolean {
  return status.enabled;
}

export function usableProviderIds(
  statuses: readonly ProviderAuthStatus[],
): Set<ProviderAuthId> {
  return new Set(
    statuses.filter(isProviderUsable).map((status) => status.provider),
  );
}

export function canAskWithProvider(
  statuses: readonly ProviderAuthStatus[],
  provider: string,
): boolean {
  return statuses.some(
    (status) => status.provider === provider && isProviderUsable(status),
  );
}

export function visibleModels<T extends AuthModelOption>(
  models: readonly T[],
  statuses: readonly ProviderAuthStatus[],
): T[] {
  const usable = usableProviderIds(statuses);
  return models.filter((model) =>
    usable.has(model.provider as ProviderAuthId),
  );
}

export function shouldShowFirstRun(
  statuses: readonly ProviderAuthStatus[],
  onboardingCompleted: boolean,
): boolean {
  return !onboardingCompleted && !statuses.some(isProviderUsable);
}

export function recommendedModelForProvider<T extends AuthModelOption>(
  models: readonly T[],
  provider: ProviderAuthId,
): T | undefined {
  const matching = models.filter((model) => model.provider === provider);
  return matching.find((model) => model.recommended) ?? matching[0];
}

export function providerDisplayName(provider: ProviderAuthId): string {
  if (provider === 'codex-cli') return 'ChatGPT';
  if (provider === 'claude-cli') return 'Claude';
  return 'Ollama';
}

export function providerStatusText(status: ProviderAuthStatus): string {
  if (status.enabled && isProviderUsable(status)) return 'Available to Aside';
  if (status.reason === 'account_login_required') {
    return status.provider === 'codex-cli'
      ? 'ChatGPT sign-in required'
      : 'Claude account sign-in required';
  }
  if (status.state === 'signed_in') return 'Signed in on this Mac';
  if (status.state === 'local_ready') return 'Ready on this Mac';
  if (status.state === 'signed_out') return 'Not signed in';
  if (status.reason === 'local_unreachable') return 'Ollama is not running';
  if (status.reason === 'no_models') return 'No local models installed';
  if (status.state === 'missing') {
    if (status.provider === 'codex-cli') return 'Codex CLI was not found';
    if (status.provider === 'claude-cli') return 'Claude Code was not found';
    return 'Not installed';
  }
  return 'Could not check status';
}
