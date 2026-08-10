import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  FileProviderConsentStore,
  ProviderAuthCoordinator,
  ProviderAuthError,
  resolveAbsoluteExecutable,
  runProviderCommand,
  type ProviderCommand,
  type ProviderCommandResult,
  type ProviderConsentStore,
  type VendorProviderAuthId,
} from '../menubar/src/provider-auth.js';

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempStore(): FileProviderConsentStore {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aside-provider-auth-'));
  tempDirs.push(root);
  return new FileProviderConsentStore(path.join(root, 'private', 'providers.json'));
}

function result(overrides: Partial<ProviderCommandResult> = {}): ProviderCommandResult {
  return {
    exitCode: 0,
    stdout: '',
    stderr: '',
    timedOut: false,
    spawnFailed: false,
    ...overrides,
  };
}

function signedInResult(provider: VendorProviderAuthId): ProviderCommandResult {
  if (provider === 'codex-cli') {
    return result({ stdout: 'Logged in using ChatGPT\n' });
  }
  return result({
    stdout: JSON.stringify({
      loggedIn: true,
      authMethod: 'claude.ai',
      email: 'private@example.com',
      organization: 'Secret Org',
    }),
  });
}

function signedOutResult(provider: VendorProviderAuthId): ProviderCommandResult {
  if (provider === 'codex-cli') {
    return result({ exitCode: 1, stdout: 'Not logged in\n' });
  }
  return result({
    exitCode: 1,
    stdout: JSON.stringify({
      loggedIn: false,
      authMethod: 'none',
      subscriptionType: null,
    }),
  });
}

function commandProvider(command: ProviderCommand): VendorProviderAuthId {
  return command.executable.endsWith('/codex') ? 'codex-cli' : 'claude-cli';
}

function readyOllamaFetch(models: unknown[] = [{ name: 'llama3.2:latest' }]) {
  return vi.fn(async () =>
    new Response(JSON.stringify({ models }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  );
}

function coordinatorWith(
  store: ProviderConsentStore,
  runCommand: (command: ProviderCommand) => Promise<ProviderCommandResult>,
  extra: Partial<ConstructorParameters<typeof ProviderAuthCoordinator>[0]> = {},
): ProviderAuthCoordinator {
  return new ProviderAuthCoordinator({
    consentStore: store,
    resolveBinary: (provider) =>
      provider === 'codex-cli' ? '/test/bin/codex' : '/test/bin/claude',
    runCommand,
    inspectPi: async () => ({
      state: 'ready',
      models: [{ provider: 'openai-codex', id: 'gpt-5.4', name: 'GPT-5.4' }],
    }),
    inspectOpenCode: async (_env, options) =>
      options?.includeModels
        ? {
            state: 'ready' as const,
            models: [{ provider: 'openai', id: 'gpt-5.4', name: 'GPT-5.4' }],
          }
        : { state: 'ready' as const },
    buildEnvironment: () => ({ PATH: '/test/bin' }),
    fetch: readyOllamaFetch(),
    ollamaHost: () => 'http://127.0.0.1:11434',
    ...extra,
  });
}

describe('provider probe and Aside consent are separate', () => {
  it('does not auto-enable existing vendor login or broker configuration', async () => {
    const store = tempStore();
    const auth = coordinatorWith(store, async (command) =>
      signedInResult(commandProvider(command)),
    );

    const statuses = await auth.getStatuses();
    expect(statuses).toEqual([
      { provider: 'codex-cli', state: 'signed_in', enabled: false },
      { provider: 'claude-cli', state: 'signed_in', enabled: false },
      { provider: 'pi-cli', state: 'configured', enabled: false },
      {
        provider: 'opencode-cli',
        state: 'signed_out',
        enabled: false,
        reason: 'access_not_granted',
      },
      { provider: 'ollama', state: 'local_ready', enabled: false },
    ]);
  });

  it('returns only renderer-safe state even when Claude output has account metadata', async () => {
    const store = tempStore();
    const auth = coordinatorWith(store, async (command) => {
      if (commandProvider(command) === 'codex-cli') {
        return result({
          stdout: 'Logged in using ChatGPT for private@example.com in Secret Org',
        });
      }
      return signedInResult('claude-cli');
    });

    const serialized = JSON.stringify(await auth.getStatuses());
    expect(serialized).not.toContain('private@example.com');
    expect(serialized).not.toContain('Secret Org');
    expect(serialized).not.toContain('authMethod');
    expect(serialized).toContain('"state":"signed_in"');
  });

  it('distinguishes missing, signed-out, and signed-in vendor clients', async () => {
    const store = tempStore();
    const missing = coordinatorWith(store, async () => result(), {
      resolveBinary: () => null,
    });
    await expect(missing.probe('codex-cli')).resolves.toEqual({
      provider: 'codex-cli',
      state: 'missing',
      enabled: false,
      reason: 'executable_missing',
    });

    const signedOut = coordinatorWith(store, async (command) =>
      signedOutResult(commandProvider(command)),
    );
    await expect(signedOut.probe('codex-cli')).resolves.toMatchObject({
      state: 'signed_out',
      enabled: false,
    });
    await expect(signedOut.probe('claude-cli')).resolves.toMatchObject({
      state: 'signed_out',
      enabled: false,
    });

    const signedIn = coordinatorWith(store, async (command) =>
      signedInResult(commandProvider(command)),
    );
    await expect(signedIn.probe('codex-cli')).resolves.toMatchObject({
      state: 'signed_in',
      enabled: false,
    });
    await expect(signedIn.probe('claude-cli')).resolves.toMatchObject({
      state: 'signed_in',
      enabled: false,
    });
  });

  it('fails closed on unrecognised or unsuccessful status output', async () => {
    const store = tempStore();
    const auth = coordinatorWith(store, async () =>
      result({ exitCode: 0, stdout: 'private@example.com' }),
    );

    await expect(auth.probe('codex-cli')).resolves.toEqual({
      provider: 'codex-cli',
      state: 'error',
      enabled: false,
      reason: 'probe_failed',
    });
    await expect(auth.probe('claude-cli')).resolves.toEqual({
      provider: 'claude-cli',
      state: 'error',
      enabled: false,
      reason: 'probe_failed',
    });
  });

  it('does not treat API-key-backed vendor sessions as account login', async () => {
    const store = tempStore();
    const auth = coordinatorWith(store, async (command) => {
      if (commandProvider(command) === 'codex-cli') {
        return result({ stdout: 'Logged in using an API key\n' });
      }
      return result({
        stdout: JSON.stringify({
          loggedIn: true,
          authMethod: 'apiKey',
          apiKeySource: 'ANTHROPIC_API_KEY',
        }),
      });
    });

    await expect(auth.probe('codex-cli')).resolves.toEqual({
      provider: 'codex-cli',
      state: 'signed_out',
      enabled: false,
      reason: 'account_login_required',
    });
    await expect(auth.probe('claude-cli')).resolves.toEqual({
      provider: 'claude-cli',
      state: 'signed_out',
      enabled: false,
      reason: 'account_login_required',
    });
  });
});

describe('connect and disconnect', () => {
  it('enables an already signed-in provider without invoking login', async () => {
    const store = tempStore();
    const calls: ProviderCommand[] = [];
    const auth = coordinatorWith(store, async (command) => {
      calls.push(command);
      return signedInResult(commandProvider(command));
    });

    await expect(auth.connect('codex-cli')).resolves.toEqual({
      provider: 'codex-cli',
      state: 'signed_in',
      enabled: true,
    });
    expect(calls.map((call) => call.args)).toEqual([['login', 'status']]);
    expect(store.load().enabled.has('codex-cli')).toBe(true);
  });

  it('runs exact Codex login args, re-probes, then enables', async () => {
    const store = tempStore();
    const calls: ProviderCommand[] = [];
    let signedIn = false;
    const auth = coordinatorWith(store, async (command) => {
      calls.push(command);
      if (command.args.length === 1 && command.args[0] === 'login') {
        signedIn = true;
        return result();
      }
      return signedIn ? signedInResult('codex-cli') : signedOutResult('codex-cli');
    });

    await expect(auth.connect('codex-cli')).resolves.toMatchObject({
      state: 'signed_in',
      enabled: true,
    });
    expect(calls.map(({ executable, args }) => ({ executable, args }))).toEqual([
      { executable: '/test/bin/codex', args: ['login', 'status'] },
      { executable: '/test/bin/codex', args: ['login'] },
      { executable: '/test/bin/codex', args: ['login', 'status'] },
    ]);
  });

  it('runs exact Claude login args, re-probes, then enables', async () => {
    const store = tempStore();
    const calls: ProviderCommand[] = [];
    let signedIn = false;
    const auth = coordinatorWith(store, async (command) => {
      calls.push(command);
      if (command.args.join(' ') === 'auth login --claudeai') {
        signedIn = true;
        return result();
      }
      return signedIn ? signedInResult('claude-cli') : signedOutResult('claude-cli');
    });

    await expect(auth.connect('claude-cli')).resolves.toMatchObject({
      state: 'signed_in',
      enabled: true,
    });
    expect(calls.map(({ executable, args }) => ({ executable, args }))).toEqual([
      { executable: '/test/bin/claude', args: ['auth', 'status', '--json'] },
      { executable: '/test/bin/claude', args: ['auth', 'login', '--claudeai'] },
      { executable: '/test/bin/claude', args: ['auth', 'status', '--json'] },
    ]);
  });

  it('does not enable when login exits successfully but the re-probe stays signed out', async () => {
    const store = tempStore();
    const auth = coordinatorWith(store, async (command) =>
      command.args.length === 1 ? result() : signedOutResult('codex-cli'),
    );

    await expect(auth.connect('codex-cli')).rejects.toMatchObject({
      name: 'ProviderAuthError',
      code: 'login_failed',
    });
    expect(store.load().enabled.has('codex-cli')).toBe(false);
  });

  it('bounds login and leaves consent disabled after a timeout', async () => {
    const store = tempStore();
    const auth = coordinatorWith(store, async (command) =>
      command.args.length === 1
        ? result({ exitCode: null, timedOut: true })
        : signedOutResult('codex-cli'),
    );

    await expect(auth.connect('codex-cli')).rejects.toMatchObject({
      name: 'ProviderAuthError',
      code: 'login_timed_out',
    });
    expect(store.load().enabled.has('codex-cli')).toBe(false);
  });

  it('disconnects only Aside and never calls vendor logout', async () => {
    const store = tempStore();
    store.setEnabled('codex-cli', true);
    const calls: ProviderCommand[] = [];
    const auth = coordinatorWith(store, async (command) => {
      calls.push(command);
      return signedInResult('codex-cli');
    });

    await expect(auth.disconnect('codex-cli')).resolves.toEqual({
      provider: 'codex-cli',
      state: 'signed_in',
      enabled: false,
    });
    expect(store.load().enabled.has('codex-cli')).toBe(false);
    expect(calls.map((call) => call.args)).toEqual([['login', 'status']]);
    expect(calls.flatMap((call) => call.args)).not.toContain('logout');
  });

  it('requires separate durable consent before cloud Today recaps', async () => {
    const store = tempStore();
    const auth = coordinatorWith(store, async (command) =>
      signedInResult(commandProvider(command)),
    );

    await auth.connect('codex-cli');
    expect(auth.todayRecapsEnabled('codex-cli')).toBe(false);
    auth.allowTodayRecaps('codex-cli');
    expect(auth.todayRecapsEnabled('codex-cli')).toBe(true);
    expect(store.load().todayRecaps).toEqual(new Set(['codex-cli']));

    await auth.disconnect('codex-cli');
    expect(auth.todayRecapsEnabled('codex-cli')).toBe(false);
    expect(store.load().todayRecaps.size).toBe(0);
    expect(auth.todayRecapsEnabled('ollama')).toBe(true);
  });

  it('records Pi consent only when Pi reports a configured model', async () => {
    const store = tempStore();
    const runCommand = vi.fn(async () => result());
    const inspectPi = vi.fn(async (env?: NodeJS.ProcessEnv) => {
      expect(env).toEqual({ PATH: '/test/bin' });
      return { state: 'ready' } as const;
    });
    const auth = coordinatorWith(store, runCommand, { inspectPi });

    await expect(auth.connect('pi-cli')).resolves.toEqual({
      provider: 'pi-cli',
      state: 'configured',
      enabled: true,
    });
    expect(inspectPi).toHaveBeenCalledOnce();
    expect(runCommand).not.toHaveBeenCalled();
    expect(store.load().enabled).toContain('pi-cli');
    expect(auth.todayRecapsEnabled('pi-cli')).toBe(false);

    auth.allowTodayRecaps('pi-cli');
    expect(auth.todayRecapsEnabled('pi-cli')).toBe(true);
    expect(store.load().todayRecaps).toContain('pi-cli');
  });

  it('records OpenCode consent only when OpenCode reports configured models', async () => {
    const store = tempStore();
    const runCommand = vi.fn(async () => result());
    const inspectOpenCode = vi.fn(async (
      env?: NodeJS.ProcessEnv,
      options?: { includeModels?: boolean },
    ) => {
      expect(env).toEqual({ PATH: '/test/bin' });
      expect(options).toEqual({ includeModels: true });
      return {
        state: 'ready',
        models: [{ provider: 'openai', id: 'gpt-5.4', name: 'GPT-5.4' }],
      } as const;
    });
    const auth = coordinatorWith(store, runCommand, { inspectOpenCode });

    await expect(auth.connect('opencode-cli')).resolves.toEqual({
      provider: 'opencode-cli',
      state: 'configured',
      enabled: true,
    });
    expect(inspectOpenCode).toHaveBeenCalledOnce();
    expect(runCommand).not.toHaveBeenCalled();
    expect(store.load().enabled).toContain('opencode-cli');
  });

  it('keeps authenticated OpenCode discovery enabled after explicit consent', async () => {
    const store = tempStore();
    const inspectOpenCode = vi.fn(async (
      _env?: NodeJS.ProcessEnv,
      options?: { includeModels?: boolean },
    ) => options?.includeModels
      ? {
          state: 'ready' as const,
          models: [{ provider: 'openai', id: 'gpt-5.4', name: 'GPT-5.4' }],
        }
      : { state: 'ready' as const });
    const auth = coordinatorWith(store, async () => result(), { inspectOpenCode });

    await auth.connect('opencode-cli');
    await expect(auth.getStatuses()).resolves.toContainEqual({
      provider: 'opencode-cli',
      state: 'configured',
      enabled: true,
    });
    expect(inspectOpenCode).toHaveBeenNthCalledWith(
      1,
      { PATH: '/test/bin' },
      { includeModels: true },
    );
    expect(inspectOpenCode).toHaveBeenNthCalledWith(
      2,
      { PATH: '/test/bin' },
      { includeModels: true },
    );
  });

  it.each([
    [
      'unconfigured',
      'signed_out',
      'no_models',
      'OpenCode has no available models. Configure a provider in OpenCode and try again.',
    ],
    [
      'unsupported',
      'error',
      'client_unsupported',
      'This Aside release supports only the audited OpenCode 1.18.15 build.',
    ],
    [
      'auth_unsupported',
      'error',
      'auth_configuration_unsupported',
      'OAuth and well-known OpenCode routes are not supported in this release. Use Zen or a provider API-key route configured in OpenCode.',
    ],
    [
      'routes_unsupported',
      'error',
      'no_audited_models',
      'Aside found OpenCode models, but none use a source-audited route.',
    ],
    [
      'error',
      'error',
      'probe_failed',
      'Aside could not inspect OpenCode safely. Try again.',
    ],
  ] as const)(
    'does not enable OpenCode when inspection reports %s and preserves its safe diagnostic',
    async (inspectionState, state, reason, message) => {
      const store = tempStore();
      const runCommand = vi.fn(async () => result());
      const auth = coordinatorWith(store, runCommand, {
        inspectOpenCode: async (_env, options) =>
          options?.includeModels
            ? { state: inspectionState }
            : { state: 'ready' },
      });

      await expect(auth.probe('opencode-cli')).resolves.toEqual({
        provider: 'opencode-cli',
        state: 'signed_out',
        enabled: false,
        reason: 'access_not_granted',
      });
      await expect(auth.connect('opencode-cli')).rejects.toMatchObject({
        code: 'provider_unavailable',
        message,
        status: {
          provider: 'opencode-cli',
          state,
          enabled: false,
          reason,
        },
      });
      expect(store.load().enabled).not.toContain('opencode-cli');
      expect(runCommand).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['unconfigured', 'signed_out', 'no_models'],
    ['unsupported', 'error', 'client_too_old'],
    ['error', 'error', 'probe_failed'],
  ] as const)(
    'does not enable Pi when inspection reports %s',
    async (inspectionState, state, reason) => {
      const store = tempStore();
      const runCommand = vi.fn(async () => result());
      const auth = coordinatorWith(store, runCommand, {
        inspectPi: async () => ({ state: inspectionState }),
      });

      await expect(auth.probe('pi-cli')).resolves.toEqual({
        provider: 'pi-cli',
        state,
        enabled: false,
        reason,
      });
      await expect(auth.connect('pi-cli')).rejects.toMatchObject({
        code: 'provider_unavailable',
      });
      expect(store.load().enabled).not.toContain('pi-cli');
      expect(runCommand).not.toHaveBeenCalled();
    },
  );

  it('reports missing Pi separately and never tries to install or log in', async () => {
    const runCommand = vi.fn(async () => result());
    const auth = coordinatorWith(tempStore(), runCommand, {
      inspectPi: async () => ({ state: 'missing' }),
    });

    await expect(auth.probe('pi-cli')).resolves.toEqual({
      provider: 'pi-cli',
      state: 'missing',
      enabled: false,
      reason: 'executable_missing',
    });
    await expect(auth.connect('pi-cli')).rejects.toMatchObject({
      code: 'provider_missing',
    });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('reports missing OpenCode separately and never tries to install or log in', async () => {
    const runCommand = vi.fn(async () => result());
    const auth = coordinatorWith(tempStore(), runCommand, {
      inspectOpenCode: async () => ({ state: 'missing' }),
    });

    await expect(auth.probe('opencode-cli')).resolves.toEqual({
      provider: 'opencode-cli',
      state: 'missing',
      enabled: false,
      reason: 'executable_missing',
    });
    await expect(auth.connect('opencode-cli')).rejects.toMatchObject({
      code: 'provider_missing',
      message: 'OpenCode is not installed or reachable.',
      status: {
        provider: 'opencode-cli',
        state: 'missing',
        enabled: false,
        reason: 'executable_missing',
      },
    });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('disconnects Pi from Aside without invoking Pi logout', async () => {
    const store = tempStore();
    store.setEnabled('pi-cli', true);
    store.setTodayRecapsEnabled('pi-cli', true);
    const runCommand = vi.fn(async () => result());
    const inspectPi = vi.fn(async () => ({ state: 'ready' }) as const);
    const auth = coordinatorWith(store, runCommand, { inspectPi });

    await expect(auth.disconnect('pi-cli')).resolves.toEqual({
      provider: 'pi-cli',
      state: 'configured',
      enabled: false,
    });
    expect(store.load()).toEqual({
      enabled: new Set(),
      todayRecaps: new Set(),
    });
    expect(inspectPi).toHaveBeenCalledOnce();
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('disconnects OpenCode from Aside without invoking OpenCode logout', async () => {
    const store = tempStore();
    store.setEnabled('opencode-cli', true);
    store.setTodayRecapsEnabled('opencode-cli', true);
    const runCommand = vi.fn(async () => result());
    const inspectOpenCode = vi.fn(async (
      _env?: NodeJS.ProcessEnv,
      options?: { includeModels?: boolean },
    ) => {
      expect(options).toEqual({ includeModels: false });
      return { state: 'ready' } as const;
    });
    const auth = coordinatorWith(store, runCommand, { inspectOpenCode });

    await expect(auth.disconnect('opencode-cli')).resolves.toEqual({
      provider: 'opencode-cli',
      state: 'signed_out',
      enabled: false,
      reason: 'access_not_granted',
    });
    expect(store.load()).toEqual({
      enabled: new Set(),
      todayRecaps: new Set(),
    });
    expect(inspectOpenCode).toHaveBeenCalledOnce();
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('cannot grant Today consent before the provider is enabled', () => {
    const auth = coordinatorWith(tempStore(), async () =>
      signedInResult('codex-cli'),
    );

    expect(() => auth.allowTodayRecaps('codex-cli')).toThrow(
      ProviderAuthError,
    );
    expect(auth.todayRecapsEnabled('codex-cli')).toBe(false);
  });

  it('rejects provider names outside the fixed IPC allowlist', async () => {
    const auth = coordinatorWith(tempStore(), async () => result());
    await expect(auth.connect('openai')).rejects.toBeInstanceOf(ProviderAuthError);
    await expect(auth.disconnect('../claude')).rejects.toMatchObject({
      code: 'invalid_provider',
    });
  });
});

describe('Ollama readiness', () => {
  it('enables only after a reachable local runtime reports an installed model', async () => {
    const store = tempStore();
    const runCommand = vi.fn(async () => result());
    const fetchMock = readyOllamaFetch([{ model: 'qwen3:latest' }]);
    const auth = coordinatorWith(store, runCommand, { fetch: fetchMock });

    await expect(auth.connect('ollama')).resolves.toEqual({
      provider: 'ollama',
      state: 'local_ready',
      enabled: true,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:11434/api/tags',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('does not enable a reachable runtime with no installed models', async () => {
    const store = tempStore();
    const auth = coordinatorWith(store, async () => result(), {
      fetch: readyOllamaFetch([]),
    });

    await expect(auth.probe('ollama')).resolves.toEqual({
      provider: 'ollama',
      state: 'error',
      enabled: false,
      reason: 'no_models',
    });
    await expect(auth.connect('ollama')).rejects.toMatchObject({
      code: 'provider_unavailable',
    });
    expect(store.load().enabled.has('ollama')).toBe(false);
  });

  it('reports an unreachable local runtime as missing', async () => {
    const auth = coordinatorWith(tempStore(), async () => result(), {
      fetch: vi.fn(async () => {
        throw new TypeError('connection refused');
      }),
    });

    await expect(auth.probe('ollama')).resolves.toEqual({
      provider: 'ollama',
      state: 'missing',
      enabled: false,
      reason: 'local_unreachable',
    });
  });
});

describe('private atomic consent storage', () => {
  it('writes only consent with 0700/0600 permissions and no temporary debris', () => {
    const store = tempStore();
    store.setEnabled('codex-cli', true);
    store.setEnabled('ollama', true);

    const directory = path.dirname(store.location);
    expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    expect(fs.statSync(store.location).mode & 0o777).toBe(0o600);
    expect(store.load().enabled).toEqual(new Set(['codex-cli', 'ollama']));
    expect(fs.readdirSync(directory)).toEqual(['providers.json']);

    const raw = fs.readFileSync(store.location, 'utf8');
    expect(raw).not.toMatch(/token|email|org|credential/i);
    expect(JSON.parse(raw)).toEqual({
      version: 1,
      enabled: {
        'codex-cli': true,
        'claude-cli': false,
        'pi-cli': false,
        'opencode-cli': false,
        ollama: true,
      },
      todayRecaps: {
        'codex-cli': false,
        'claude-cli': false,
        'pi-cli': false,
        'opencode-cli': false,
        ollama: false,
      },
    });
  });

  it('loads provider access without expanding it to Today recaps', () => {
    const store = tempStore();
    fs.mkdirSync(path.dirname(store.location), {
      recursive: true,
      mode: 0o700,
    });
    fs.writeFileSync(
      store.location,
      JSON.stringify({
        version: 1,
        enabled: { 'codex-cli': true, 'claude-cli': false, ollama: false },
      }),
      { mode: 0o600 },
    );

    expect(store.load()).toEqual({
      enabled: new Set(['codex-cli']),
      todayRecaps: new Set(),
    });
    store.setTodayRecapsEnabled('codex-cli', true);
    expect(JSON.parse(fs.readFileSync(store.location, 'utf8'))).toMatchObject({
      version: 1,
      enabled: { 'codex-cli': true },
      todayRecaps: { 'codex-cli': true },
    });
  });

  it('never resurrects Today permission from an inconsistent disabled entry', () => {
    const store = tempStore();
    fs.mkdirSync(path.dirname(store.location), {
      recursive: true,
      mode: 0o700,
    });
    fs.writeFileSync(
      store.location,
      JSON.stringify({
        version: 1,
        enabled: { 'codex-cli': false },
        todayRecaps: { 'codex-cli': true },
      }),
      { mode: 0o600 },
    );

    expect(store.load().todayRecaps).toEqual(new Set());
    store.setEnabled('codex-cli', true);
    expect(store.load()).toEqual({
      enabled: new Set(['codex-cli']),
      todayRecaps: new Set(),
    });
  });

  it('fails closed on corrupt JSON and refuses to overwrite it', async () => {
    const store = tempStore();
    fs.mkdirSync(path.dirname(store.location), { recursive: true, mode: 0o700 });
    fs.writeFileSync(store.location, '{ definitely not json', { mode: 0o600 });
    const original = fs.readFileSync(store.location, 'utf8');
    const auth = coordinatorWith(store, async () => signedInResult('codex-cli'));

    await expect(auth.probe('codex-cli')).resolves.toEqual({
      provider: 'codex-cli',
      state: 'signed_in',
      enabled: false,
      reason: 'consent_unavailable',
    });
    await expect(auth.connect('codex-cli')).rejects.toMatchObject({
      code: 'consent_unavailable',
    });
    expect(fs.readFileSync(store.location, 'utf8')).toBe(original);
  });

  it('fails closed on group/world-readable consent', async () => {
    const store = tempStore();
    fs.mkdirSync(path.dirname(store.location), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      store.location,
      JSON.stringify({ version: 1, enabled: { 'codex-cli': true } }),
      { mode: 0o644 },
    );
    fs.chmodSync(store.location, 0o644);
    const auth = coordinatorWith(store, async () => signedInResult('codex-cli'));

    await expect(auth.probe('codex-cli')).resolves.toEqual({
      provider: 'codex-cli',
      state: 'signed_in',
      enabled: false,
      reason: 'consent_unavailable',
    });
    await expect(auth.disconnect('codex-cli')).rejects.toMatchObject({
      code: 'consent_unavailable',
    });
    expect(fs.statSync(store.location).mode & 0o777).toBe(0o644);
  });
});

describe('executable validation', () => {
  it('resolves a PATH command to its real absolute executable', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aside-provider-bin-'));
    tempDirs.push(root);
    const real = path.join(root, 'real-client');
    const link = path.join(root, 'codex');
    fs.writeFileSync(real, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    fs.symlinkSync(real, link);

    expect(resolveAbsoluteExecutable('codex', { PATH: root })).toBe(fs.realpathSync(real));
    expect(resolveAbsoluteExecutable('codex', { PATH: 'relative/path' })).toBeNull();
    expect(resolveAbsoluteExecutable('./codex', { PATH: root })).toBeNull();
  });

  it('refuses relative commands and enforces the command timeout', async () => {
    await expect(
      runProviderCommand({
        executable: 'codex',
        args: ['login'],
        env: {},
        timeoutMs: 10,
      }),
    ).resolves.toMatchObject({ spawnFailed: true });

    const startedAt = Date.now();
    await expect(
      runProviderCommand({
        executable: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        env: {},
        timeoutMs: 25,
      }),
    ).resolves.toMatchObject({ timedOut: true, spawnFailed: false });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});
