/**
 * The only accounts Aside delegates to.
 *
 * There is deliberately no "Aside account". Vendor authentication remains
 * owned by the vendor CLI, while this module records only whether the user has
 * explicitly allowed Aside to use that already-authenticated client.
 */
export const PROVIDER_AUTH_IDS = ['codex-cli', 'claude-cli', 'ollama'] as const;

export type ProviderAuthId = (typeof PROVIDER_AUTH_IDS)[number];
export type VendorProviderAuthId = Exclude<ProviderAuthId, 'ollama'>;

export type ProviderProbeState =
  | 'missing'
  | 'signed_out'
  | 'signed_in'
  | 'local_ready'
  | 'error';

/**
 * Safe, presentation-oriented diagnostics. Raw CLI output is never part of the
 * renderer contract because vendor status responses may contain account or
 * organization metadata.
 */
export type ProviderAuthReason =
  | 'executable_missing'
  | 'local_unreachable'
  | 'no_models'
  | 'account_login_required'
  | 'probe_failed'
  | 'consent_unavailable';

/** The complete renderer-safe provider state. */
export interface ProviderAuthStatus {
  provider: ProviderAuthId;
  state: ProviderProbeState;
  /**
   * Aside consent, not vendor login state. A pre-existing vendor login never
   * flips this to true; only connect() does.
   */
  enabled: boolean;
  reason?: ProviderAuthReason;
}

export type ProviderAuthErrorCode =
  | 'invalid_provider'
  | 'provider_missing'
  | 'provider_unavailable'
  | 'login_failed'
  | 'login_timed_out'
  | 'consent_unavailable';

/** An IPC-safe error whose message never includes child-process output. */
export class ProviderAuthError extends Error {
  readonly name = 'ProviderAuthError';

  constructor(
    readonly code: ProviderAuthErrorCode,
    readonly provider?: ProviderAuthId,
  ) {
    super(messageFor(code, provider));
  }
}

function messageFor(code: ProviderAuthErrorCode, provider?: ProviderAuthId): string {
  const name =
    provider === 'codex-cli'
      ? 'ChatGPT'
      : provider === 'claude-cli'
        ? 'Claude'
        : provider === 'ollama'
          ? 'Ollama'
          : 'provider';
  switch (code) {
    case 'invalid_provider':
      return 'That provider is not supported.';
    case 'provider_missing':
      return `${name} is not installed or reachable.`;
    case 'provider_unavailable':
      return `${name} is not ready to use.`;
    case 'login_failed':
      return `Could not sign in to ${name}.`;
    case 'login_timed_out':
      return `Sign-in to ${name} timed out.`;
    case 'consent_unavailable':
      return 'Aside could not securely save provider access.';
  }
}

export function isProviderAuthId(value: string): value is ProviderAuthId {
  return (PROVIDER_AUTH_IDS as readonly string[]).includes(value);
}
