import { errorFromResponse } from './types.js';
import type { CompletionRequest, ModelSpec, Provider } from './types.js';

/**
 * A local model runtime — the provider that needs no credential.
 *
 * This matters more than "one more provider". aside reads every agent
 * transcript on the machine; pointing it at a local model means none of that
 * leaves the machine, and there's no key to obtain, bill, or leak. Someone
 * already paying for Claude shouldn't have to buy a second, separately-billed
 * credential just to ask what their agents are doing.
 *
 * Summarising a transcript and reasoning about what an agent is doing is well
 * within a small local model's range — this isn't a token gesture.
 */
const DEFAULT_HOST = 'http://127.0.0.1:11434';

function host(): string {
  const configured = process.env['OLLAMA_HOST']?.trim();
  if (!configured) return DEFAULT_HOST;
  // OLLAMA_HOST is conventionally bare "host:port"; tolerate both forms.
  return /^https?:\/\//.test(configured) ? configured : `http://${configured}`;
}

export const ollama: Provider = {
  id: 'ollama',
  label: 'Ollama (local)',
  apiKeyEnv: [],
  requiresApiKey: false,
  // Suggestions only — what's actually available is whatever the user pulled,
  // which `listInstalledModels` reports. Any id may be passed explicitly.
  models: [
    { id: 'llama3.2', label: 'Llama 3.2 (local)', recommended: true },
    { id: 'qwen2.5', label: 'Qwen 2.5 (local)' },
  ],

  async complete({ model, systemPrompt, question, signal }: CompletionRequest) {
    let response: Response;
    try {
      response = await fetch(`${host()}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          stream: false,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: question },
          ],
        }),
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      // Connection refused is the overwhelmingly common case and "fetch failed"
      // explains nothing. Say what's wrong and what to do.
      throw new Error(
        `ollama: can't reach a local model runtime at ${host()}. ` +
          `Is Ollama running? Start it with \`ollama serve\`, or set OLLAMA_HOST. ` +
          `(${err instanceof Error ? err.message : String(err)})`,
      );
    }

    if (!response.ok) throw await errorFromResponse('ollama', response);

    const data = (await response.json()) as { message?: { content?: string } };
    return (data.message?.content ?? '').trim() || '(no response)';
  },
};

/**
 * Models actually pulled on this machine.
 *
 * Best-effort: returns [] when Ollama isn't running, so a picker can simply
 * omit local models rather than fail.
 */
export async function listInstalledModels(): Promise<ModelSpec[]> {
  try {
    const response = await fetch(`${host()}/api/tags`, {
      signal: AbortSignal.timeout(1_500),
    });
    if (!response.ok) return [];
    const data = (await response.json()) as { models?: Array<{ name?: string }> };
    return (data.models ?? [])
      .map((m) => m.name)
      .filter((n): n is string => Boolean(n))
      .map((name) => ({ id: name, label: `${name} (local)` }));
  } catch {
    return [];
  }
}
