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
  type ProviderAuthId,
  type ProviderCommand,
  type ProviderCommandResult,
  type ProviderConsentStore,
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

function signedInResult(provider: ProviderAuthId): ProviderCommandResult {
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

function signedOutResult(provider: ProviderAuthId): ProviderCommandResult {
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

function commandProvider(command: ProviderCommand): ProviderAuthId {
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
    buildEnvironment: () => ({ PATH: '/test/bin' }),
    fetch: readyOllamaFetch(),
    ollamaHost: () => 'http://127.0.0.1:11434',
    ...extra,
  });
}

describe('provider probe and Aside consent are separate', () => {
  it('does not auto-enable an existing Codex or Claude login', async () => {
    const store = tempStore();
    const auth = coordinatorWith(store, async (command) =>
      signedInResult(commandProvider(command)),
    );

    const statuses = await auth.getStatuses();
    expect(statuses).toEqual([
      { provider: 'codex-cli', state: 'signed_in', enabled: false },
      { provider: 'claude-cli', state: 'signed_in', enabled: false },
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
        ollama: true,
      },
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
