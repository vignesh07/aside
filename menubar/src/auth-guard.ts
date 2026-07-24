import {
  isProviderAuthId,
  type ProviderAuthId,
  type ProviderAuthStatus,
} from './provider-auth.js';
import { isProviderUsable } from './auth-ui.js';

export interface ProviderStatusProbe {
  probe(provider: string): Promise<ProviderAuthStatus>;
}

export function validatedProviderId(value: unknown): ProviderAuthId | null {
  return (
    typeof value === 'string' &&
    value.length <= 64 &&
    /^[a-z0-9][a-z0-9-]{0,63}$/.test(value) &&
    isProviderAuthId(value)
  )
    ? value
    : null;
}

/**
 * Main-process authorization guard.
 *
 * Renderer controls are only presentation. Every provider-affecting IPC path
 * re-probes the one requested provider and fails closed before the backend can
 * send transcript context or change a thread's model.
 */
export async function requireUsableProvider(
  value: unknown,
  source: ProviderStatusProbe | null,
  message: string,
): Promise<ProviderAuthId> {
  const provider = validatedProviderId(value);
  if (!provider || !source) throw new Error(message);

  let status: ProviderAuthStatus;
  try {
    status = await source.probe(provider);
  } catch {
    throw new Error(message);
  }
  if (!isProviderUsable(status)) throw new Error(message);
  return provider;
}
