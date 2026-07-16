import { assembleSystemPrompt, errorFromResponse, ProviderError } from './types.js';
import type { CompletionRequest, Provider } from './types.js';

const API_URL = 'https://api.openai.com/v1/chat/completions';
const MAX_TOKENS = 1_500;

export const openai: Provider = {
  id: 'openai',
  label: 'OpenAI',
  apiKeyEnv: ['OPENAI_API_KEY'],
  requiresApiKey: true,
  models: [
    { id: 'gpt-4o-mini', label: 'GPT-4o mini', recommended: true },
    { id: 'gpt-4o', label: 'GPT-4o' },
  ],

  async complete(req: CompletionRequest) {
    const { model, question, apiKey, signal } = req;
    const systemPrompt = assembleSystemPrompt(req);
    if (!apiKey) throw new ProviderError('openai: no API key', 'openai');

    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_completion_tokens: MAX_TOKENS,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: question },
        ],
      }),
      ...(signal ? { signal } : {}),
    });

    if (!response.ok) throw await errorFromResponse('openai', response);

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = (data.choices?.[0]?.message?.content ?? '').trim();
    return text || '(no response)';
  },
};
