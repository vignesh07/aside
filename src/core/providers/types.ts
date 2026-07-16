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

/**
 * One question, in the pieces a provider needs to assemble it.
 *
 * The split matters because providers fall into two kinds. Stateless ones (a
 * plain HTTP API) get every piece on every call. A session provider keeps one
 * live conversation: its system prompt is fixed when the process starts, and it
 * remembers its own history — so only the parts that actually change per turn
 * can be sent per turn.
 */
export interface CompletionRequest {
  model: string;
  /** The observer's role. Static — safe to fix for a whole conversation. */
  systemPrompt: string;
  /** What the agents are doing right now. Changes every turn. */
  context: string;
  /** Prior turns, pre-rendered. Session providers ignore it: they have their own. */
  history: string;
  question: string;
  /** Omitted for providers that need no credential (e.g. a local runtime). */
  apiKey?: string;
  signal?: AbortSignal;
}

/**
 * Everything a stateless provider sends as its system prompt.
 *
 * Role, world, and history collapse into one block because an HTTP API has no
 * memory between calls — there's nowhere else to put them.
 */
export function assembleSystemPrompt(req: CompletionRequest): string {
  return [req.systemPrompt, req.context, req.history].filter(Boolean).join('\n\n');
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
