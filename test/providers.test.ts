// The provider layer that replaced the multi-provider SDK.
//
// These use a stubbed fetch: the point is the request we construct and the
// response we parse, not the vendor's uptime.

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  getProvider,
  getProviders,
  resolveApiKey,
  isConfigured,
  complete,
  ProviderError,
  OBSERVER_PROJECT_MARKER,
} from '../src/core/providers/index.js';
import { isObserverSession } from '../src/core/session-scanner.js';
import { DEFAULT_PROVIDER } from '../src/config/defaults.js';
import type { TrackedSession } from '../src/types/session.js';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

function stubFetch(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  const fn = vi.fn(async () =>
    ({
      ok: init.ok ?? true,
      status: init.status ?? 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    }) as unknown as Response,
  );
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

/** The JSON body of the most recent stubbed request. */
function bodyOf(fn: ReturnType<typeof stubFetch>) {
  return JSON.parse((fn.mock.calls[0]![1] as RequestInit).body as string);
}

describe('registry', () => {
  it('leads with the no-key login path, then keys, then local', () => {
    expect(getProviders().map((p) => p.id)).toEqual(['claude-cli', 'anthropic', 'openai', 'ollama']);
  });

  it('defaults to a provider that needs no API key', () => {
    // The premise is that the user already runs these agents, so the CLI is
    // installed and logged in. Demanding a second, separately-billed key to ask
    // about the subscription they already pay for is the thing to avoid.
    expect(DEFAULT_PROVIDER).toBe('claude-cli');
    expect(getProvider(DEFAULT_PROVIDER)!.requiresApiKey).toBe(false);
  });

  it('needs no credential for the delegating provider', () => {
    const cli = getProvider('claude-cli')!;
    expect(cli.apiKeyEnv).toEqual([]);
    expect(resolveApiKey(cli)).toBeNull();
    expect(isConfigured(cli)).toBe(true);
  });

  it('rejects an unknown provider by name, listing what exists', async () => {
    await expect(
      complete('gemini', { model: 'x', systemPrompt: 's', question: 'q' }),
    ).rejects.toThrow(/Unknown provider "gemini".*anthropic/s);
  });
});

describe('resolveApiKey', () => {
  it('reads the provider env var', () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-test';
    expect(resolveApiKey(getProvider('anthropic')!)).toBe('sk-test');
  });

  it('ignores an empty or whitespace-only env var', () => {
    process.env['ANTHROPIC_API_KEY'] = '   ';
    expect(resolveApiKey(getProvider('anthropic')!)).toBeNull();
  });

  it('needs no key for the local runtime — the whole point of having one', () => {
    delete process.env['OLLAMA_HOST'];
    const ollama = getProvider('ollama')!;
    expect(ollama.requiresApiKey).toBe(false);
    expect(resolveApiKey(ollama)).toBeNull();
    expect(isConfigured(ollama)).toBe(true);
  });

  it('reports a cloud provider unconfigured when its key is absent', () => {
    delete process.env['ANTHROPIC_API_KEY'];
    expect(isConfigured(getProvider('anthropic')!)).toBe(false);
  });
});

describe('observer session filtering', () => {
  // The claude-cli provider answers by running `claude -p`, which writes a
  // transcript exactly like any other session. Unfiltered, aside discovers its
  // own answers and reports itself as one of the user's agents — and each
  // question spawns another session to find next time.
  function session(over: Partial<TrackedSession>): TrackedSession {
    return {
      id: 'x',
      source: 'claude',
      projectName: 'proj',
      projectDir: '/Users/me/proj',
      jsonlPath: '',
      cwd: '/Users/me/proj',
      slug: '',
      gitBranch: '',
      model: '',
      version: '',
      usedPercent: 0,
      contextStatus: 'safe',
      status: 'active',
      lastEventTime: new Date(0),
      eventCount: 0,
      currentActivity: '',
      ...over,
    };
  }

  it('recognises the observer by project dir', () => {
    expect(
      isObserverSession(session({ projectDir: `/tmp/${OBSERVER_PROJECT_MARKER}` })),
    ).toBe(true);
  });

  it('recognises the observer by cwd', () => {
    expect(isObserverSession(session({ cwd: `/private/tmp/${OBSERVER_PROJECT_MARKER}` }))).toBe(
      true,
    );
  });

  it('leaves the user\'s real sessions alone', () => {
    expect(isObserverSession(session({}))).toBe(false);
    expect(isObserverSession(session({ projectName: 'aside' }))).toBe(false);
  });
});

describe('complete', () => {
  it('points at a local model when a cloud key is missing', async () => {
    delete process.env['ANTHROPIC_API_KEY'];
    await expect(
      complete('anthropic', { model: 'claude-haiku-4-5-20251001', systemPrompt: 's', question: 'q' }),
    ).rejects.toThrow(/ollama.*no key/s);
  });

  it('sends the anthropic shape and reads its text blocks', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-test';
    const fetchMock = stubFetch({ content: [{ type: 'text', text: 'hello' }] });

    const out = await complete('anthropic', {
      model: 'claude-haiku-4-5-20251001',
      systemPrompt: 'sys',
      question: 'q',
    });

    expect(out).toBe('hello');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-test');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    const body = bodyOf(fetchMock);
    expect(body.system).toBe('sys');
    expect(body.messages).toEqual([{ role: 'user', content: 'q' }]);
  });

  it('joins multiple anthropic text blocks and ignores non-text', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-test';
    stubFetch({
      content: [
        { type: 'text', text: 'a' },
        { type: 'thinking', thinking: 'ignored' },
        { type: 'text', text: 'b' },
      ],
    });
    expect(
      await complete('anthropic', { model: 'm', systemPrompt: 's', question: 'q' }),
    ).toBe('ab');
  });

  it('sends the openai shape, with the system prompt as a system message', async () => {
    process.env['OPENAI_API_KEY'] = 'sk-oai';
    const fetchMock = stubFetch({ choices: [{ message: { content: 'hi' } }] });

    const out = await complete('openai', { model: 'gpt-4o-mini', systemPrompt: 'sys', question: 'q' });

    expect(out).toBe('hi');
    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer sk-oai');
    expect(bodyOf(fetchMock).messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'q' },
    ]);
  });

  it('sends the ollama shape with no credential and streaming off', async () => {
    const fetchMock = stubFetch({ message: { content: 'local answer' } });

    const out = await complete('ollama', { model: 'llama3.2', systemPrompt: 'sys', question: 'q' });

    expect(out).toBe('local answer');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('/api/chat');
    expect((init as RequestInit).headers).not.toHaveProperty('authorization');
    expect(bodyOf(fetchMock).stream).toBe(false);
  });

  it('honours OLLAMA_HOST, tolerating a bare host:port', async () => {
    process.env['OLLAMA_HOST'] = 'box:1234';
    const fetchMock = stubFetch({ message: { content: 'x' } });
    await complete('ollama', { model: 'm', systemPrompt: 's', question: 'q' });
    expect(String(fetchMock.mock.calls[0]![0])).toBe('http://box:1234/api/chat');
  });

  it('explains a refused local connection instead of surfacing "fetch failed"', async () => {
    delete process.env['OLLAMA_HOST'];
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    await expect(
      complete('ollama', { model: 'm', systemPrompt: 's', question: 'q' }),
    ).rejects.toThrow(/Is Ollama running\?/);
  });

  it('surfaces rejected credentials as such, not as a bare status code', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'bad';
    stubFetch({ error: { message: 'invalid x-api-key' } }, { ok: false, status: 401 });

    await expect(
      complete('anthropic', { model: 'm', systemPrompt: 's', question: 'q' }),
    ).rejects.toThrow(/credentials rejected \(401\).*invalid x-api-key/s);
  });

  it('names rate limiting explicitly', async () => {
    process.env['OPENAI_API_KEY'] = 'sk';
    stubFetch({ error: { message: 'slow down' } }, { ok: false, status: 429 });
    await expect(
      complete('openai', { model: 'm', systemPrompt: 's', question: 'q' }),
    ).rejects.toThrow(/rate limited/);
  });

  it('reports an empty response rather than returning an empty string', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk';
    stubFetch({ content: [] });
    expect(await complete('anthropic', { model: 'm', systemPrompt: 's', question: 'q' })).toBe(
      '(no response)',
    );
  });

  it('raises ProviderError carrying the provider and status', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk';
    stubFetch({}, { ok: false, status: 500 });
    const err = await complete('anthropic', { model: 'm', systemPrompt: 's', question: 'q' }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.provider).toBe('anthropic');
    expect(err.status).toBe(500);
  });
});
