import { claudeCli } from './claude-cli.js';
import { codexCli } from './codex-cli.js';
import { anthropic } from './anthropic.js';
import { openai } from './openai.js';
import { ollama } from './ollama.js';
import { ProviderError } from './types.js';
import type { CompletionRequest, Provider } from './types.js';

export { ProviderError } from './types.js';
export type { CompletionRequest, ModelSpec, Provider } from './types.js';
export { listInstalledModels } from './ollama.js';
export { createVendorCliEnv } from './vendor-cli-env.js';
export {
  OBSERVER_CWD,
  OBSERVER_PROJECT_MARKER,
  disposeClaudeSession,
  isClaudeSessionRunning,
} from './claude-cli.js';

/**
 * Registration order is picker order, and the first entry is the default.
 *
 * The two login-backed providers lead deliberately. Anyone watching Claude Code
 * or Codex sessions already has that CLI and is already signed in — so the
 * out-of-the-box path should cost them nothing. Making someone fetch a second,
 * separately-billed API key to ask questions about the subscription they already
 * pay for is a bad trade, and an API key default quietly imposes exactly that.
 *
 * Both work by delegation: aside runs the vendor's own client and never touches
 * a credential. Keys remain available; they're just not the toll.
 */
const PROVIDERS: readonly Provider[] = [claudeCli, codexCli, anthropic, openai, ollama];

export function getProviders(): Provider[] {
  return [...PROVIDERS];
}

export function getProvider(id: string): Provider | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/**
 * Resolve a provider's key from the environment.
 *
 * Returns null for providers that need none. Note the environment is the only
 * source: aside does not read credentials belonging to other applications.
 * The tokens Claude Code and Codex hold are issued to *those* clients; reusing
 * them would mean impersonating them to the vendor, which puts the user's own
 * account at risk. Bring a key, or use a local model.
 */
export function resolveApiKey(provider: Provider): string | null {
  if (!provider.requiresApiKey) return null;
  for (const name of provider.apiKeyEnv) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return null;
}

/** True when this provider is usable right now. */
export function isConfigured(provider: Provider): boolean {
  return !provider.requiresApiKey || resolveApiKey(provider) !== null;
}

/** Send one completion, resolving credentials from the environment. */
export async function complete(
  providerId: string,
  req: Omit<CompletionRequest, 'apiKey'>,
): Promise<string> {
  const provider = getProvider(providerId);
  if (!provider) {
    const known = PROVIDERS.map((p) => p.id).join(', ');
    throw new ProviderError(`Unknown provider "${providerId}". Known: ${known}`, providerId);
  }

  const apiKey = resolveApiKey(provider);
  if (provider.requiresApiKey && !apiKey) {
    throw new ProviderError(
      `No API key for ${provider.label}. Set ${provider.apiKeyEnv.join(' or ')}, ` +
        `or switch to a local model (--provider ollama) which needs no key.`,
      providerId,
    );
  }

  return provider.complete({ ...req, ...(apiKey ? { apiKey } : {}) });
}
