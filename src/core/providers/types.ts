/**
 * The provider layer.
 *
 * aside sends one shaped request — a system prompt plus a single user question —
 * and wants one string back. That's the entire surface. It does not need
 * streaming, tool calls, images, or a dozen vendor SDKs; a provider here is
 * roughly forty lines around `fetch`.
 *
 * This replaced a general-purpose multi-provider SDK that cost ~26MB of
 * transitive AWS/Google/Mistral clients for breadth aside never used. Being
 * cross-provider about the *agents it watches* is the product; the observer
 * talking to twelve vendors was never the point.
 */

export interface ModelSpec {
  /** Vendor model id, sent verbatim on the wire. */
  id: string;
  /** Human label for pickers. */
  label: string;
  /** Cheap/fast enough to be a sensible default for a side panel. */
  recommended?: boolean;
}

export interface CompletionRequest {
  model: string;
  systemPrompt: string;
  /** The user's question. History is folded into systemPrompt by the caller. */
  question: string;
  /** Omitted for providers that need no credential (e.g. a local runtime). */
  apiKey?: string;
  signal?: AbortSignal;
}

export interface Provider {
  id: string;
  label: string;
  /**
   * Environment variables consulted for a key, in order.
   * Empty for providers that need no credential.
   */
  apiKeyEnv: readonly string[];
  /**
   * False for local providers. This is what lets aside run with no credential
   * at all, which matters: asking someone who already pays for Claude to also
   * supply a separately-billed API key is a poor trade.
   */
  requiresApiKey: boolean;
  /** Curated, not exhaustive. Any model id may still be passed explicitly. */
  models: readonly ModelSpec[];
  complete(req: CompletionRequest): Promise<string>;
}

/** A provider call failed in a way worth showing the user verbatim. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

/**
 * Turn a failed HTTP response into a message that says what to do about it.
 *
 * Vendor error bodies are JSON of wildly different shapes, and a bare "401" in
 * a side panel tells the user nothing actionable.
 */
export async function errorFromResponse(
  provider: string,
  response: Response,
): Promise<ProviderError> {
  let detail = '';
  try {
    const body = await response.text();
    try {
      const parsed = JSON.parse(body);
      detail = parsed?.error?.message ?? parsed?.error?.type ?? parsed?.message ?? body;
    } catch {
      detail = body;
    }
  } catch {
    // Body already consumed or unreadable; the status still carries meaning.
  }
  detail = String(detail).trim().slice(0, 300);

  if (response.status === 401 || response.status === 403) {
    return new ProviderError(
      `${provider}: credentials rejected (${response.status}). ${detail}`,
      provider,
      response.status,
    );
  }
  if (response.status === 429) {
    return new ProviderError(`${provider}: rate limited. ${detail}`, provider, 429);
  }
  return new ProviderError(
    `${provider}: request failed (${response.status}). ${detail}`,
    provider,
    response.status,
  );
}
