import { assembleSystemPrompt, errorFromResponse, ProviderError } from './types.js';
import type { CompletionRequest, Provider } from './types.js';

const API_URL = 'https://api.anthropic.com/v1/messages';

/** Pinned: Anthropic requires this header and treats it as an API contract. */
const API_VERSION = '2023-06-01';

/** The observer answers in a side panel. Long replies get clipped anyway. */
const MAX_TOKENS = 1_500;

export const anthropic: Provider = {
  id: 'anthropic',
  label: 'Anthropic',
  apiKeyEnv: ['ANTHROPIC_API_KEY'],
  requiresApiKey: true,
  models: [
    { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', recommended: true },
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
    { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
  ],

  async complete(req: CompletionRequest) {
    const { model, question, apiKey, signal } = req;
    const systemPrompt = assembleSystemPrompt(req);
    if (!apiKey) throw new ProviderError('anthropic: no API key', 'anthropic');

    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': API_VERSION,
      },
      body: JSON.stringify({
        model,
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        messages: [{ role: 'user', content: question }],
      }),
      ...(signal ? { signal } : {}),
    });

    if (!response.ok) throw await errorFromResponse('anthropic', response);

    const data = (await response.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    // Concatenate text blocks; non-text blocks (none expected without tools)
    // are ignored rather than stringified into the panel.
    const text = (data.content ?? [])
      .filter((b) => b.type === 'text' && b.text)
      .map((b) => b.text)
      .join('')
      .trim();
    return text || '(no response)';
  },
};
