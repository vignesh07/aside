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
  'pi-cli': {
    label: 'Setup Guide…',
    title: 'Open the official Pi provider setup guide',
    url: 'https://pi.dev/docs/latest/providers',
  },
  'opencode-cli': {
    label: 'Setup Guide…',
    title: 'Open the official OpenCode provider setup guide',
    url: 'https://opencode.ai/docs/providers/',
  },
};

const OPENCODE_AUDITED_RELEASE_HELP: ProviderHelpLink = {
  label: 'Install 1.18.15…',
  title: 'Install the audited OpenCode 1.18.15 release',
  url: 'https://github.com/anomalyco/opencode/releases/tag/v1.18.15',
};

export function providerHelpLink(
  provider: ProviderAuthId,
  reason?: ProviderAuthStatus['reason'],
): ProviderHelpLink | undefined {
  if (
    provider === 'opencode-cli' &&
    (reason === 'executable_missing' || reason === 'client_unsupported')
  ) {
    return OPENCODE_AUDITED_RELEASE_HELP;
  }
  return PROVIDER_HELP_LINKS[provider];
}

export function isProviderUsable(status: ProviderAuthStatus): boolean {
  return (
    status.enabled &&
    (status.state === 'signed_in' ||
      status.state === 'configured' ||
      status.state === 'local_ready')
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

/**
 * Provider consent alone is not enough for a brokered-model thread. Pi and
 * OpenCode can each expose many credential-backed upstream models, and an
 * existing thread remains pinned to one exact provider/model pair. Fail closed
 * when that route disappears rather than silently sending the thread to a
 * client's current default.
 */
export function canAskWithModel<T extends AuthModelOption>(
  statuses: readonly ProviderAuthStatus[],
  models: readonly T[],
  provider: string,
  model: string,
): boolean {
  if (!canAskWithProvider(statuses, provider)) return false;
  if (provider !== 'pi-cli' && provider !== 'opencode-cli') return true;
  return models.some(
    (option) => option.provider === provider && option.model === model,
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
  // OpenCode's catalog is a sorted set of exact upstream routes, not a user
  // preference. Connecting it must never silently pick the first (and
  // potentially paid) route; the user chooses the exact provider/model pair.
  if (provider === 'opencode-cli') return undefined;
  const matching = models.filter((model) => model.provider === provider);
  return matching.find((model) => model.recommended) ?? matching[0];
}

export function providerDisplayName(provider: ProviderAuthId): string {
  if (provider === 'codex-cli') return 'Codex';
  if (provider === 'claude-cli') return 'Claude Code';
  if (provider === 'pi-cli') return 'Pi';
  if (provider === 'opencode-cli') return 'OpenCode';
  return 'Ollama';
}

export function providerStatusText(status: ProviderAuthStatus): string {
  if (status.enabled && isProviderUsable(status)) return 'Available to Aside';
  if (status.reason === 'consent_unavailable') {
    return 'Aside could not read saved access';
  }
  if (status.reason === 'account_login_required') {
    return status.provider === 'codex-cli'
      ? 'Codex sign-in required'
      : 'Claude Code sign-in required';
  }
  if (status.reason === 'access_not_granted') {
    return 'Audited OpenCode 1.18.15 routes';
  }
  if (status.reason === 'no_models') {
    if (status.provider === 'pi-cli') return 'No authenticated models in Pi';
    if (status.provider === 'opencode-cli') {
      return 'No models available through OpenCode';
    }
    return 'No local models installed';
  }
  if (status.reason === 'client_too_old') {
    return `${providerDisplayName(status.provider)} needs to be updated`;
  }
  if (status.reason === 'client_unsupported') {
    return 'This OpenCode version is not supported by this Aside release';
  }
  if (status.reason === 'auth_configuration_unsupported') {
    return 'OAuth/well-known unavailable · use Zen or a provider API key';
  }
  if (status.reason === 'no_audited_models') {
    return 'No source-audited OpenCode routes are available';
  }
  if (status.state === 'signed_in') return 'Signed in on this Mac';
  if (status.state === 'configured') {
    return `Models available through ${providerDisplayName(status.provider)}`;
  }
  if (status.state === 'local_ready') return 'Ready on this Mac';
  if (status.state === 'signed_out') return 'Not signed in';
  if (status.reason === 'local_unreachable') return 'Ollama is not running';
  if (status.state === 'missing') {
    if (status.provider === 'codex-cli') return 'Codex CLI was not found';
    if (status.provider === 'claude-cli') return 'Claude Code was not found';
    if (status.provider === 'pi-cli') return 'Pi was not found';
    if (status.provider === 'opencode-cli') return 'Install OpenCode 1.18.15';
    return 'Not installed';
  }
  return 'Could not check status';
}
