import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import {
  inspectOpenCode,
  listConfiguredOpenCodeModels,
  openCodeCli,
  openCodeObserverArgs,
  resolveOpenCodeBinary,
} from '../src/core/providers/opencode-cli.js';

interface FakeOpenCodeOptions {
  version?: string;
  versionsByProbe?: string[];
  compatibleHelp?: boolean;
  models?: FakeOpenCodeModel[];
  modelsByInspection?: FakeOpenCodeModel[][];
  unconfigured?: boolean;
  answer?: string;
  emitTool?: boolean;
  hangRun?: boolean;
  ignoreSigterm?: boolean;
  malformedOutput?: boolean;
  unknownEvent?: boolean;
  fallbackWarning?: boolean;
  blockCleanup?: boolean;
  swapAuthDirectoryWith?: string;
  replaceInstalledAfterModels?: boolean;
  replacementLog?: string;
  refreshedAuth?: string;
  generatedModelCount?: number;
  authTypes?: Array<'oauth' | 'api' | 'wellknown'>;
}

type FakeOpenCodeModel = string | {
  route: string;
  name?: string;
  npm?: string;
  url?: string;
};

const temporaryRoots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe.sequential('OpenCode CLI observer provider', () => {
  it('pins one exact provider/model and keeps scoped text out of argv', () => {
    expect(openCodeObserverArgs('openrouter/anthropic/claude-sonnet')).toEqual([
      'run',
      '--format',
      'json',
      '--model',
      'openrouter/anthropic/claude-sonnet',
      '--agent',
      'aside-observer',
      '--title',
      'Aside observer',
      '--pure',
    ]);
    expect(() => openCodeObserverArgs('claude-sonnet')).toThrow(
      /exact provider\/model id reported by OpenCode/,
    );
    expect(() => openCodeObserverArgs('bad provider/model')).toThrow(
      /exact provider\/model id reported by OpenCode/,
    );
    expect(() => openCodeObserverArgs(`openai/${'m'.repeat(301)}`)).toThrow(
      /exact provider\/model id reported by OpenCode/,
    );
  });

  it('accepts only the source-audited release and required command capabilities', async () => {
    const oldRoot = tempRoot();
    const old = createFakeOpenCode(
      path.join(oldRoot, 'bin'),
      path.join(oldRoot, 'old.log'),
      { version: '1.18.14' },
    );
    await expect(resolveOpenCodeBinary(providerEnv(oldRoot, path.dirname(old)))).resolves.toBeNull();
    await expect(inspectOpenCode(providerEnv(oldRoot, path.dirname(old)))).resolves.toEqual({
      state: 'unsupported',
    });

    const helpRoot = tempRoot();
    const incompatible = createFakeOpenCode(
      path.join(helpRoot, 'bin'),
      path.join(helpRoot, 'bad-help.log'),
      { version: '1.18.15', compatibleHelp: false },
    );
    await expect(
      inspectOpenCode(providerEnv(helpRoot, path.dirname(incompatible))),
    ).resolves.toEqual({ state: 'unsupported' });

    const futureRoot = tempRoot();
    const future = createFakeOpenCode(
      path.join(futureRoot, 'bin'),
      path.join(futureRoot, 'future.log'),
      { version: '1.18.16' },
    );
    await expect(
      inspectOpenCode(providerEnv(futureRoot, path.dirname(future))),
    ).resolves.toEqual({ state: 'unsupported' });

    for (const version of ['1.18.15-beta.1', '01.18.15', 'v1.18.15']) {
      const root = tempRoot();
      const binary = createFakeOpenCode(
        path.join(root, 'bin'),
        path.join(root, 'noncanonical.log'),
        { version },
      );
      await expect(
        inspectOpenCode(providerEnv(root, path.dirname(binary))),
      ).resolves.toEqual({ state: 'unsupported' });
    }

    const currentRoot = tempRoot();
    const current = createFakeOpenCode(
      path.join(currentRoot, 'bin'),
      path.join(currentRoot, 'current.log'),
      { version: '1.18.15' },
    );
    await expect(
      resolveOpenCodeBinary(providerEnv(currentRoot, path.dirname(current))),
    ).resolves.toBe(fs.realpathSync(current));

    const missingRoot = tempRoot();
    await expect(
      inspectOpenCode(providerEnv(missingRoot, path.join(missingRoot, 'empty'))),
    ).resolves.toEqual({ state: 'missing' });
  });

  it('keeps routine availability checks metadata-only until explicit consent', async () => {
    const root = tempRoot();
    const log = path.join(root, 'opencode.log');
    const binary = createFakeOpenCode(path.join(root, 'bin'), log, {
      models: ['openai/gpt-5.4'],
      authTypes: ['api'],
    });
    const env = providerEnv(root, path.dirname(binary));
    const authFile = path.join(env['XDG_DATA_HOME']!, 'opencode', 'auth.json');
    fs.mkdirSync(path.dirname(authFile), { recursive: true });
    fs.writeFileSync(authFile, apiAuth(), { mode: 0o600 });

    await expect(inspectOpenCode(env)).resolves.toEqual({ state: 'ready' });
    const commands = readLog(log).map((entry) => entry['args'] as string[]);
    expect(commands.some((args) => args[0] === 'auth')).toBe(false);
    expect(commands.some((args) => args[0] === 'models' && !args.includes('--help'))).toBe(false);
    expect(fs.readFileSync(authFile, 'utf8')).toBe(apiAuth());
  });

  it('reuses one validated staged executable instead of copying the binary per command', async () => {
    const root = tempRoot();
    const log = path.join(root, 'opencode.log');
    const binary = createFakeOpenCode(path.join(root, 'bin'), log, {
      models: ['openai/gpt-5.4'],
      authTypes: ['api'],
    });
    const env = providerEnv(root, path.dirname(binary));
    const authFile = path.join(env['XDG_DATA_HOME']!, 'opencode', 'auth.json');
    fs.mkdirSync(path.dirname(authFile), { recursive: true });
    fs.writeFileSync(authFile, apiAuth(), { mode: 0o600 });
    stubProviderEnv(env);
    const request = {
      model: 'openai/gpt-5.4',
      systemPrompt: 'Role',
      context: 'Context',
      history: '',
      question: 'Question',
    };

    await expect(openCodeCli.complete(request)).resolves.toBe('Everything is ready.');
    const firstSensitiveStarts = promptBearingPreparationStarts(readLog(log));
    const stagedPaths = new Set(firstSensitiveStarts.map((entry) => String(entry['executable'])));
    expect(stagedPaths.size).toBe(1);
    const stagedPath = [...stagedPaths][0]!;
    expect(path.dirname(stagedPath)).toBe(
      fs.realpathSync(path.join(root, '.aside', 'opencode-executables')),
    );
    expect(path.basename(stagedPath)).toMatch(/^[a-f0-9]{64}\.bin$/);
    expect(fs.lstatSync(stagedPath).mode & 0o777).toBe(0o500);
    const stagedBefore = fs.lstatSync(stagedPath);

    await expect(openCodeCli.complete(request)).resolves.toBe('Everything is ready.');
    const secondSensitiveStarts = promptBearingPreparationStarts(readLog(log));
    expect(new Set(secondSensitiveStarts.map((entry) => String(entry['executable'])))).toEqual(
      new Set([stagedPath]),
    );
    const stagedAfter = fs.lstatSync(stagedPath);
    expect(stagedAfter.ino).toBe(stagedBefore.ino);
    expect(stagedAfter.mtimeMs).toBe(stagedBefore.mtimeMs);
    expect(findFiles(path.dirname(stagedPath))).toEqual([stagedPath]);
  });

  it('removes incompatible candidate staging and bounds the persistent executable cache', async () => {
    const unsupportedRoot = tempRoot();
    const unsupported = createFakeOpenCode(
      path.join(unsupportedRoot, 'bin'),
      path.join(unsupportedRoot, 'unsupported.log'),
      { version: '1.18.14' },
    );
    const unsupportedEnv = providerEnv(unsupportedRoot, path.dirname(unsupported));
    await expect(inspectOpenCode(unsupportedEnv)).resolves.toEqual({ state: 'unsupported' });
    expect(findFiles(path.join(unsupportedRoot, '.aside', 'opencode-executables'))).toEqual([]);

    const root = tempRoot();
    const cache = path.join(root, '.aside', 'opencode-executables');
    fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
    for (let index = 0; index < 4; index += 1) {
      fs.writeFileSync(path.join(cache, `${String(index + 1).repeat(64)}.bin`), `old-${index}`, {
        mode: 0o500,
      });
    }
    const binary = createFakeOpenCode(
      path.join(root, 'bin'),
      path.join(root, 'opencode.log'),
    );
    await expect(inspectOpenCode(providerEnv(root, path.dirname(binary)))).resolves.toEqual({
      state: 'ready',
    });
    expect(findFiles(cache)).toHaveLength(3);
  });

  it('recovers a crash between executable publication and staging-link cleanup', async () => {
    const root = tempRoot();
    const binary = createFakeOpenCode(
      path.join(root, 'bin'),
      path.join(root, 'opencode.log'),
    );
    const bytes = fs.readFileSync(binary);
    const digest = createHash('sha256').update(bytes).digest('hex');
    const cache = path.join(root, '.aside', 'opencode-executables');
    fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
    const published = path.join(cache, `${digest}.bin`);
    const interrupted = path.join(cache, '.aside-stage-2147483647-0123456789abcdef01234567');
    fs.copyFileSync(binary, published);
    fs.chmodSync(published, 0o500);
    fs.linkSync(published, interrupted);
    expect(fs.lstatSync(published).nlink).toBe(2);

    await expect(inspectOpenCode(providerEnv(root, path.dirname(binary)))).resolves.toEqual({
      state: 'ready',
    });
    expect(fs.existsSync(interrupted)).toBe(false);
    expect(fs.lstatSync(published).nlink).toBe(1);
  });

  it('sweeps only marked stale auth bridges and restores the source link count', async () => {
    const root = tempRoot();
    const binary = createFakeOpenCode(
      path.join(root, 'bin'),
      path.join(root, 'opencode.log'),
      { models: ['openai/gpt-5.4'] },
    );
    const env = providerEnv(root, path.dirname(binary));
    const authFile = path.join(env['XDG_DATA_HOME']!, 'opencode', 'auth.json');
    fs.mkdirSync(path.dirname(authFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(authFile, apiAuth(), { mode: 0o600 });
    const staleRoot = path.join(path.dirname(authFile), '.aside-runtime-Ab12Cd');
    const staleBridge = path.join(staleRoot, 'data', 'opencode', 'auth.json');
    fs.mkdirSync(path.dirname(staleBridge), { recursive: true, mode: 0o700 });
    fs.linkSync(authFile, staleBridge);
    const cleanup = {
      root: testRuntimeIdentity(staleRoot),
      data: testRuntimeIdentity(path.join(staleRoot, 'data')),
      authDirectory: testRuntimeIdentity(path.dirname(staleBridge)),
      authBridge: testRuntimeIdentity(staleBridge),
    };
    fs.writeFileSync(
      path.join(staleRoot, '.aside-runtime.json'),
      JSON.stringify({ version: 2, pid: 2_147_483_647, cleanup }),
      { mode: 0o600 },
    );
    expect(fs.lstatSync(authFile).nlink).toBe(2);

    await expect(inspectOpenCode(env)).resolves.toEqual({ state: 'ready' });
    expect(fs.existsSync(staleRoot)).toBe(false);
    expect(fs.lstatSync(authFile).nlink).toBe(1);
  });

  it('projects only source-audited routes and rejects dynamic SDK downloads', async () => {
    const root = tempRoot();
    const log = path.join(root, 'opencode.log');
    const binary = createFakeOpenCode(path.join(root, 'bin'), log, {
      models: [
        'openai/gpt-5.4',
        'openrouter/anthropic/claude-sonnet',
        'openai/gpt-5.4',
        {
          route: 'aihubmix/alicloud-deepseek-v4-flash',
          npm: '@aihubmix/ai-sdk-provider',
          url: '',
        },
        {
          route: 'openai/custom-endpoint-model',
          npm: '@ai-sdk/openai',
          url: 'https://models.example.test/v1',
        },
      ],
    });
    const env = providerEnv(root, path.dirname(binary));

    await expect(inspectOpenCode(env, { includeModels: true })).resolves.toEqual({
      state: 'ready',
      models: [
        { provider: 'openai', id: 'gpt-5.4', name: 'gpt-5.4' },
        {
          provider: 'openrouter',
          id: 'anthropic/claude-sonnet',
          name: 'anthropic/claude-sonnet',
        },
      ],
    });
    await expect(listConfiguredOpenCodeModels(env)).resolves.toEqual([
      { provider: 'openai', id: 'gpt-5.4', name: 'gpt-5.4' },
      {
        provider: 'openrouter',
        id: 'anthropic/claude-sonnet',
        name: 'anthropic/claude-sonnet',
      },
    ]);

    const starts = readLog(log).filter((entry) => entry['kind'] === 'start');
    const probes = starts.filter((entry) => !(entry['args'] as string[]).includes('models'));
    const models = starts.find(
      (entry) =>
        (entry['args'] as string[])[0] === 'models' &&
        !(entry['args'] as string[]).includes('--help'),
    );
    expect(probes.every((entry) => entry['xdgData'] !== env['XDG_DATA_HOME'])).toBe(true);
    expect(models?.['xdgData']).not.toBe(env['XDG_DATA_HOME']);
    expect(String(models?.['xdgData'])).toContain(String(models?.['runtimeRoot']));
    expect(models?.['secretNames']).toEqual([]);
    expect(starts.every((entry) => !fs.existsSync(String(entry['runtimeRoot'])))).toBe(true);
  });

  it('reports catalogs with only unaudited routes separately', async () => {
    const root = tempRoot();
    const binary = createFakeOpenCode(
      path.join(root, 'bin'),
      path.join(root, 'opencode.log'),
      {
        models: [{
          route: 'aihubmix/alicloud-deepseek-v4-flash',
          npm: '@aihubmix/ai-sdk-provider',
          url: '',
        }],
      },
    );
    await expect(
      inspectOpenCode(providerEnv(root, path.dirname(binary)), { includeModels: true }),
    ).resolves.toEqual({ state: 'routes_unsupported' });
  });

  it('rejects Copilot routes whose actual endpoint can come from auth metadata', async () => {
    const root = tempRoot();
    const binary = createFakeOpenCode(
      path.join(root, 'bin'),
      path.join(root, 'opencode.log'),
      {
        models: [
          {
            route: 'github-copilot/gpt-5.4',
            npm: '@ai-sdk/github-copilot',
            url: 'https://api.githubcopilot.com',
          },
          {
            route: 'github-copilot/claude-sonnet-4.5',
            npm: '@ai-sdk/anthropic',
            url: 'https://api.githubcopilot.com/v1',
          },
        ],
      },
    );

    await expect(
      inspectOpenCode(providerEnv(root, path.dirname(binary)), { includeModels: true }),
    ).resolves.toEqual({ state: 'routes_unsupported' });
  });

  it('accepts a large verbose catalog without falling back to the answer output limit', async () => {
    const root = tempRoot();
    const binary = createFakeOpenCode(
      path.join(root, 'bin'),
      path.join(root, 'large.log'),
      { generatedModelCount: 9_000 },
    );
    const inspection = await inspectOpenCode(
      providerEnv(root, path.dirname(binary)),
      { includeModels: true },
    );
    expect(inspection.state).toBe('ready');
    expect(inspection.models).toHaveLength(9_000);
  }, 20_000);

  it('distinguishes an installed client with no configured model', async () => {
    const root = tempRoot();
    const binary = createFakeOpenCode(
      path.join(root, 'bin'),
      path.join(root, 'opencode.log'),
      { unconfigured: true },
    );
    await expect(
      inspectOpenCode(providerEnv(root, path.dirname(binary)), { includeModels: true }),
    ).resolves.toEqual({ state: 'unconfigured' });
  });

  it('sends all scoped context over stdin with a sterile, deny-all, in-memory runtime', async () => {
    const root = tempRoot();
    const log = path.join(root, 'opencode.log');
    const binary = createFakeOpenCode(path.join(root, 'bin'), log, {
      models: ['openai/gpt-5.4'],
      answer: 'Everything is 🐈 ready.',
      authTypes: ['api'],
    });
    const env = providerEnv(root, path.dirname(binary));
    const authFile = path.join(env['XDG_DATA_HOME']!, 'opencode', 'auth.json');
    fs.mkdirSync(path.dirname(authFile), { recursive: true });
    fs.writeFileSync(authFile, apiAuth(), { mode: 0o600 });
    stubProviderEnv(env);
    vi.stubEnv('OPENAI_API_KEY', 'must-not-reach-opencode');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'must-not-reach-opencode');
    vi.stubEnv('OPENCODE_AUTH_CONTENT', 'must-not-reach-opencode');

    await expect(
      openCodeCli.complete({
        model: 'openai/gpt-5.4',
        systemPrompt: 'You are Aside.',
        context: 'Scoped transcript context',
        history: 'User: earlier\nAside: response',
        question: 'What needs me?',
      }),
    ).resolves.toBe('Everything is 🐈 ready.');

    const entries = readLog(log);
    const run = entries.find(
      (entry) =>
        entry['kind'] === 'start' &&
        (entry['args'] as string[])[0] === 'run' &&
        !(entry['args'] as string[]).includes('--help'),
    );
    const input = entries.find((entry) => entry['kind'] === 'run-input');
    const argv = (run?.['args'] ?? []) as string[];
    expect(argv).toEqual(openCodeObserverArgs('openai/gpt-5.4'));
    expect(argv.join(' ')).not.toContain('Scoped transcript context');
    expect(argv.join(' ')).not.toContain('What needs me?');
    expect(input?.['stdin']).toBe(
      'Scoped transcript context\n\n' +
        'User: earlier\nAside: response\n\nQuestion: What needs me?',
    );
    expect(run?.['secretNames']).toEqual([]);
    expect(run?.['home']).not.toBe(env['HOME']);
    expect(String(run?.['home'])).toContain(String(run?.['runtimeRoot']));
    expect(run?.['gitSentinel']).toBe(true);
    expect(run).toMatchObject({
      db: ':memory:',
      permission: '{"*":"deny"}',
      pure: '1',
      disableProject: '1',
      disableClaude: '1',
      disableExternalSkills: '1',
      disableUpdate: '1',
      disableShare: '1',
    });
    expect(run?.['disableDefaultPlugins']).toBeUndefined();
    expect(run?.['configMode']).toBe(0o500);
    expect(run?.['globalConfigMode']).toBe(0o500);
    expect(run?.['configGitignore']).toBe(
      'node_modules\npackage.json\npackage-lock.json\nbun.lock\n.gitignore',
    );
    expect(run?.['globalConfigGitignore']).toBe(run?.['configGitignore']);
    expect(run?.['xdgData']).not.toBe(env['XDG_DATA_HOME']);
    expect(String(run?.['xdgData'])).toContain(String(run?.['runtimeRoot']));
    expect(run?.['authExists']).toBe(true);
    expect(run?.['authIsSymlink']).toBe(false);
    expect(run?.['authTarget']).toBeUndefined();
    expect(run?.['authNlink']).toBe(1);
    expect(run?.['authMode']).toBe(0o600);
    const config = JSON.parse(String(run?.['config']));
    expect(config).toMatchObject({
      share: 'disabled',
      autoupdate: false,
      snapshot: false,
      mcp: {},
      plugin: [],
      instructions: [],
      permission: { '*': 'deny' },
      default_agent: 'aside-observer',
      agent: {
        'aside-observer': {
          prompt: 'You are Aside.',
          permission: { '*': 'deny' },
        },
      },
    });
    // OpenCode Zen rejects custom display metadata for an otherwise valid
    // custom agent. The stable key is enough; keep the wire-facing agent bare.
    expect(config.agent['aside-observer']).not.toHaveProperty('name');
    expect(config.agent['aside-observer']).not.toHaveProperty('description');
    expect(fs.readFileSync(authFile, 'utf8')).toBe(apiAuth());
    expect(fs.lstatSync(authFile).nlink).toBe(1);
    expect(entries.every((entry) => !fs.existsSync(String(entry['runtimeRoot'])))).toBe(true);
    expect(findFiles(env['XDG_DATA_HOME']!)).toEqual([authFile]);
  });

  it('rejects refreshable OAuth before any prompt-bearing child runs', async () => {
    const root = tempRoot();
    const log = path.join(root, 'opencode.log');
    const initialAuth = JSON.stringify({
      openai: {
        type: 'oauth',
        refresh: 'old-refresh',
        access: 'old-access',
        expires: 1,
      },
    });
    const refreshedAuth = JSON.stringify({
      openai: {
        type: 'oauth',
        refresh: 'new-refresh',
        access: 'new-access',
        expires: 2,
      },
    });
    const binary = createFakeOpenCode(path.join(root, 'bin'), log, {
      models: ['openai/gpt-5.4'],
      answer: 'Refreshed safely.',
      authTypes: ['oauth'],
      refreshedAuth,
    });
    const env = providerEnv(root, path.dirname(binary));
    const authFile = path.join(env['XDG_DATA_HOME']!, 'opencode', 'auth.json');
    fs.mkdirSync(path.dirname(authFile), { recursive: true });
    fs.writeFileSync(authFile, initialAuth, { mode: 0o600 });
    const original = fs.lstatSync(authFile);
    stubProviderEnv(env);

    await expect(openCodeCli.complete({
      model: 'openai/gpt-5.4',
      systemPrompt: 'Role',
      context: 'Context',
      history: '',
      question: 'Question',
    })).rejects.toThrow(/openai uses OAuth OpenCode credentials/);

    const updated = fs.lstatSync(authFile);
    expect(fs.readFileSync(authFile, 'utf8')).toBe(initialAuth);
    expect(updated.ino).toBe(original.ino);
    expect(updated.size).toBe(original.size);
    expect(updated.mtimeMs).toBe(original.mtimeMs);
    expect(updated.mode & 0o777).toBe(0o600);
    expect(updated.nlink).toBe(1);
    expect(
      readLog(log).some(
        (entry) => entry['kind'] === 'run-input',
      ),
    ).toBe(false);
    expect(readLog(log).every((entry) => !fs.existsSync(String(entry['runtimeRoot'])))).toBe(true);
  });

  it('keeps unrelated OAuth out of safe Zen and API routes', async () => {
    const root = tempRoot();
    const log = path.join(root, 'opencode.log');
    const binary = createFakeOpenCode(path.join(root, 'bin'), log, {
      models: [
        'openai/gpt-5.4',
        'anthropic/claude-opus-4-6',
        'opencode/claude-sonnet-4-5',
      ],
    });
    const env = providerEnv(root, path.dirname(binary));
    const authFile = path.join(env['XDG_DATA_HOME']!, 'opencode', 'auth.json');
    fs.mkdirSync(path.dirname(authFile), { recursive: true });
    const canonical = JSON.stringify({
      openai: {
        type: 'oauth',
        refresh: 'private-refresh',
        access: 'private-access',
        expires: 1,
      },
      anthropic: { type: 'api', key: 'anthropic-api-key' },
    });
    fs.writeFileSync(authFile, canonical, { mode: 0o600 });

    await expect(inspectOpenCode(env, { includeModels: true })).resolves.toEqual({
      state: 'ready',
      models: [
        { provider: 'anthropic', id: 'claude-opus-4-6', name: 'claude-opus-4-6' },
        { provider: 'opencode', id: 'claude-sonnet-4-5', name: 'claude-sonnet-4-5' },
      ],
    });
    stubProviderEnv(env);
    await expect(openCodeCli.complete({
      model: 'opencode/claude-sonnet-4-5',
      systemPrompt: 'Role',
      context: 'Zen context',
      history: '',
      question: 'Zen question',
    })).resolves.toBe('Everything is ready.');
    await expect(openCodeCli.complete({
      model: 'anthropic/claude-opus-4-6',
      systemPrompt: 'Role',
      context: 'API context',
      history: '',
      question: 'API question',
    })).resolves.toBe('Everything is ready.');

    const runs = readLog(log).filter(
      (entry) =>
        entry['kind'] === 'start' &&
        (entry['args'] as string[])[0] === 'run' &&
        !(entry['args'] as string[]).includes('--help'),
    );
    expect(runs).toHaveLength(2);
    expect(runs[0]?.['authText']).toBe('{}');
    expect(JSON.parse(String(runs[1]?.['authText']))).toEqual({
      anthropic: { type: 'api', key: 'anthropic-api-key' },
    });
    expect(String(runs[0]?.['authText'])).not.toContain('private-access');
    expect(String(runs[1]?.['authText'])).not.toContain('private-access');
    expect(fs.readFileSync(authFile, 'utf8')).toBe(canonical);
  });

  it.each([
    ['malformed JSON', { malformedOutput: true }, /broke its JSON observer contract/],
    ['an unknown event', { unknownEvent: true }, /unknown observer event/],
    ['an agent fallback warning', { fallbackWarning: true }, /broke its JSON observer contract/],
  ] as const)('fails closed on %s and removes the auth bridge', async (_label, output, message) => {
    const root = tempRoot();
    const log = path.join(root, 'opencode.log');
    const binary = createFakeOpenCode(path.join(root, 'bin'), log, {
      models: ['openai/gpt-5.4'],
      authTypes: ['api'],
      ...output,
    });
    const env = providerEnv(root, path.dirname(binary));
    const authFile = path.join(env['XDG_DATA_HOME']!, 'opencode', 'auth.json');
    fs.mkdirSync(path.dirname(authFile), { recursive: true });
    fs.writeFileSync(authFile, apiAuth(), { mode: 0o600 });
    stubProviderEnv(env);

    await expect(openCodeCli.complete({
      model: 'openai/gpt-5.4',
      systemPrompt: 'Role',
      context: 'Context',
      history: '',
      question: 'Question',
    })).rejects.toThrow(message);
    expect(fs.lstatSync(authFile).nlink).toBe(1);
    expect(readLog(log).every((entry) => !fs.existsSync(String(entry['runtimeRoot'])))).toBe(true);
  });

  it('revalidates a pinned route immediately before send and never falls back', async () => {
    const root = tempRoot();
    const log = path.join(root, 'opencode.log');
    const binary = createFakeOpenCode(path.join(root, 'bin'), log, {
      modelsByInspection: [
        ['openai/gpt-5.4'],
        ['anthropic/claude-opus-4-6'],
      ],
    });
    const env = providerEnv(root, path.dirname(binary));
    const authFile = path.join(env['XDG_DATA_HOME']!, 'opencode', 'auth.json');
    fs.mkdirSync(path.dirname(authFile), { recursive: true });
    fs.writeFileSync(authFile, apiAuth(), { mode: 0o600 });

    await expect(inspectOpenCode(env, { includeModels: true })).resolves.toMatchObject({
      state: 'ready',
      models: [{ provider: 'openai', id: 'gpt-5.4' }],
    });
    stubProviderEnv(env);
    await expect(
      openCodeCli.complete({
        model: 'openai/gpt-5.4',
        systemPrompt: 'Role',
        context: 'Must not leave Aside',
        history: '',
        question: 'What changed?',
      }),
    ).rejects.toThrow(/pinned to openai\/gpt-5\.4.*no longer available through OpenCode/s);

    expect(
      readLog(log).some(
        (entry) =>
          entry['kind'] === 'start' &&
          (entry['args'] as string[])[0] === 'run' &&
          !(entry['args'] as string[]).includes('--help'),
      ),
    ).toBe(false);
  });

  it('refuses to send context when the executable changes after inspection', async () => {
    const root = tempRoot();
    const log = path.join(root, 'opencode.log');
    const binary = createFakeOpenCode(path.join(root, 'bin'), log, {
      versionsByProbe: ['1.18.15', '1.18.16'],
      models: ['openai/gpt-5.4'],
    });
    const env = providerEnv(root, path.dirname(binary));
    const authFile = path.join(env['XDG_DATA_HOME']!, 'opencode', 'auth.json');
    fs.mkdirSync(path.dirname(authFile), { recursive: true });
    fs.writeFileSync(authFile, apiAuth(), { mode: 0o600 });
    stubProviderEnv(env);

    await expect(
      openCodeCli.complete({
        model: 'openai/gpt-5.4',
        systemPrompt: 'Role',
        context: 'Must not leave Aside',
        history: '',
        question: 'What changed?',
      }),
    ).rejects.toThrow(/changed while Aside was preparing/);
    expect(
      readLog(log).some(
        (entry) =>
          entry['kind'] === 'start' &&
          (entry['args'] as string[])[0] === 'run' &&
          !(entry['args'] as string[]).includes('--help'),
      ),
    ).toBe(false);
  });

  it('never gives prompt bytes to an installed executable swapped after model inspection', async () => {
    const root = tempRoot();
    const log = path.join(root, 'opencode.log');
    const replacementLog = path.join(root, 'replacement.log');
    const binary = createFakeOpenCode(path.join(root, 'bin'), log, {
      models: ['openai/gpt-5.4'],
      replaceInstalledAfterModels: true,
      replacementLog,
    });
    const env = providerEnv(root, path.dirname(binary));
    const authFile = path.join(env['XDG_DATA_HOME']!, 'opencode', 'auth.json');
    fs.mkdirSync(path.dirname(authFile), { recursive: true });
    fs.writeFileSync(authFile, apiAuth(), { mode: 0o600 });
    stubProviderEnv(env);

    await expect(openCodeCli.complete({
      model: 'openai/gpt-5.4',
      systemPrompt: 'Role',
      context: 'Must never reach a swapped executable',
      history: '',
      question: 'Still private?',
    })).rejects.toThrow(/could not verify OpenCode’s available models safely|changed while/);
    expect(fs.existsSync(replacementLog)).toBe(false);
    expect(readLog(log).some((entry) => entry['kind'] === 'run-input')).toBe(false);
    expect(fs.existsSync(`${binary}.audited-original`)).toBe(true);
  });

  it('reports well-known credentials as unsupported before loading remote configuration', async () => {
    const root = tempRoot();
    const log = path.join(root, 'opencode.log');
    const binary = createFakeOpenCode(path.join(root, 'bin'), log, {
      authTypes: ['wellknown'],
      models: ['openai/gpt-5.4'],
    });
    const env = providerEnv(root, path.dirname(binary));
    const authFile = path.join(env['XDG_DATA_HOME']!, 'opencode', 'auth.json');
    fs.mkdirSync(path.dirname(authFile), { recursive: true });
    const wellKnownAuth = JSON.stringify({
      openai: { type: 'wellknown', key: 'discovery-key', token: 'discovery-token' },
    });
    fs.writeFileSync(authFile, wellKnownAuth, { mode: 0o600 });

    await expect(inspectOpenCode(env, { includeModels: true })).resolves.toEqual({
      state: 'auth_unsupported',
    });
    const models = readLog(log).find(
      (entry) =>
        entry['kind'] === 'start' &&
        (entry['args'] as string[])[0] === 'models' &&
        !(entry['args'] as string[]).includes('--help'),
    );
    expect(models?.['authText']).toBe('{}');
    expect(fs.readFileSync(authFile, 'utf8')).toBe(wellKnownAuth);
  });

  it('treats a completed tool event as a safety violation and terminates a lingering provider', async () => {
    const root = tempRoot();
    const log = path.join(root, 'opencode.log');
    const binary = createFakeOpenCode(path.join(root, 'bin'), log, {
      models: ['openai/gpt-5.4'],
      emitTool: true,
      hangRun: true,
      ignoreSigterm: true,
    });
    const env = providerEnv(root, path.dirname(binary));
    const authFile = path.join(env['XDG_DATA_HOME']!, 'opencode', 'auth.json');
    fs.mkdirSync(path.dirname(authFile), { recursive: true });
    fs.writeFileSync(authFile, apiAuth(), { mode: 0o600 });
    stubProviderEnv(env);

    await expect(
      openCodeCli.complete({
        model: 'openai/gpt-5.4',
        systemPrompt: 'Role',
        context: 'Context',
        history: '',
        question: 'Question',
      }),
    ).rejects.toThrow(/attempted a tool in read-only observer mode/);
    expect(readLog(log)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'signal', signal: 'SIGTERM' }),
      ]),
    );
    expect(fs.lstatSync(authFile).nlink).toBe(1);
    expect(readLog(log).every((entry) => !fs.existsSync(String(entry['runtimeRoot'])))).toBe(true);
  });

  it('honors cancellation and escalates when OpenCode ignores SIGTERM', async () => {
    const root = tempRoot();
    const log = path.join(root, 'opencode.log');
    const binary = createFakeOpenCode(path.join(root, 'bin'), log, {
      models: ['openai/gpt-5.4'],
      hangRun: true,
      ignoreSigterm: true,
    });
    const env = providerEnv(root, path.dirname(binary));
    const authFile = path.join(env['XDG_DATA_HOME']!, 'opencode', 'auth.json');
    fs.mkdirSync(path.dirname(authFile), { recursive: true });
    fs.writeFileSync(authFile, apiAuth(), { mode: 0o600 });
    stubProviderEnv(env);
    const controller = new AbortController();
    const pending = openCodeCli.complete({
      model: 'openai/gpt-5.4',
      systemPrompt: 'Role',
      context: 'Context',
      history: '',
      question: 'Question',
      signal: controller.signal,
    });
    await waitForLog(log, 'run-input');
    const startedAt = Date.now();
    controller.abort();

    await expect(pending).rejects.toThrow(/request aborted/);
    expect(Date.now() - startedAt).toBeLessThan(3_000);
    expect(readLog(log)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'signal', signal: 'SIGTERM' }),
      ]),
    );
    expect(fs.lstatSync(authFile).nlink).toBe(1);
    expect(readLog(log).every((entry) => !fs.existsSync(String(entry['runtimeRoot'])))).toBe(true);
  }, 5_000);

  it('fails the request but repairs cleanup after the provider removes root permissions', async () => {
    if (process.platform === 'win32') return;
    const root = tempRoot();
    const log = path.join(root, 'opencode.log');
    const binary = createFakeOpenCode(path.join(root, 'bin'), log, {
      models: ['openai/gpt-5.4'],
      blockCleanup: true,
    });
    const env = providerEnv(root, path.dirname(binary));
    const authFile = path.join(env['XDG_DATA_HOME']!, 'opencode', 'auth.json');
    fs.mkdirSync(path.dirname(authFile), { recursive: true });
    fs.writeFileSync(authFile, apiAuth(), { mode: 0o600 });
    stubProviderEnv(env);

    await expect(
      openCodeCli.complete({
        model: 'openai/gpt-5.4',
        systemPrompt: 'Role',
        context: 'Context',
        history: '',
        question: 'Question',
      }),
    ).rejects.toThrow(/OpenCode changed while the request was running/);

    const runtimeRoot = String(
      readLog(log).find(
        (entry) =>
          entry['kind'] === 'start' &&
          (entry['args'] as string[])[0] === 'run' &&
          !(entry['args'] as string[]).includes('--help'),
      )?.['runtimeRoot'],
    );
    expect(fs.existsSync(runtimeRoot)).toBe(false);
    expect(
      fs.readdirSync(path.dirname(authFile)).some((entry) =>
        entry.startsWith('.aside-quarantine-')),
    ).toBe(false);
    expect(fs.lstatSync(authFile).nlink).toBe(1);
  });

  it('never follows a swapped auth-directory symlink into victim data', async () => {
    const root = tempRoot();
    const victim = path.join(root, 'victim');
    const victimAuth = path.join(victim, 'auth.json');
    fs.mkdirSync(victim, { mode: 0o700 });
    fs.writeFileSync(victimAuth, 'victim-must-survive', { mode: 0o640 });
    const victimMode = fs.lstatSync(victim).mode & 0o777;
    const victimAuthMode = fs.lstatSync(victimAuth).mode & 0o777;
    const log = path.join(root, 'opencode.log');
    const binary = createFakeOpenCode(path.join(root, 'bin'), log, {
      models: ['openai/gpt-5.4'],
      authTypes: ['api'],
      swapAuthDirectoryWith: victim,
    });
    const env = providerEnv(root, path.dirname(binary));
    const authFile = path.join(env['XDG_DATA_HOME']!, 'opencode', 'auth.json');
    fs.mkdirSync(path.dirname(authFile), { recursive: true });
    fs.writeFileSync(authFile, apiAuth(), { mode: 0o600 });
    stubProviderEnv(env);

    await expect(openCodeCli.complete({
      model: 'openai/gpt-5.4',
      systemPrompt: 'Role',
      context: 'Context',
      history: '',
      question: 'Question',
    })).rejects.toThrow(/could not remove the private observer runtime/);

    expect(fs.readFileSync(victimAuth, 'utf8')).toBe('victim-must-survive');
    expect(fs.lstatSync(victim).mode & 0o777).toBe(victimMode);
    expect(fs.lstatSync(victimAuth).mode & 0o777).toBe(victimAuthMode);
    expect(fs.readFileSync(authFile, 'utf8')).toBe(apiAuth());
    expect(fs.lstatSync(authFile).nlink).toBe(1);

    const authParent = path.dirname(authFile);
    const quarantine = fs.readdirSync(authParent)
      .find((entry) => entry.startsWith('.aside-quarantine-'));
    expect(quarantine).toBeDefined();
    const evidence = path.join(authParent, quarantine!);
    expect(fs.lstatSync(evidence).isDirectory()).toBe(true);
    expect(fs.lstatSync(path.join(evidence, 'data', 'opencode')).isSymbolicLink()).toBe(true);

    fs.chmodSync(path.join(evidence, 'config'), 0o700);
    fs.chmodSync(path.join(evidence, 'xdg-config', 'opencode'), 0o700);
    fs.rmSync(evidence, { recursive: true, force: true });
    expect(fs.readFileSync(victimAuth, 'utf8')).toBe('victim-must-survive');
  });
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aside-opencode-test-'));
  temporaryRoots.push(root);
  return root;
}

function providerEnv(home: string, binaryDirectory: string): NodeJS.ProcessEnv {
  return {
    HOME: home,
    USER: 'tester',
    PATH: [binaryDirectory, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter),
    XDG_DATA_HOME: path.join(home, '.local-data'),
    OPENAI_API_KEY: 'ambient-key-must-be-stripped',
  };
}

function apiAuth(provider = 'openai'): string {
  return JSON.stringify({
    [provider]: { type: 'api', key: 'test-key-owned-by-opencode' },
  });
}

function stubProviderEnv(env: NodeJS.ProcessEnv): void {
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value ?? '');
}

function testRuntimeIdentity(target: string): { dev: number; ino: number; uid: number } {
  const metadata = fs.lstatSync(target);
  return { dev: metadata.dev, ino: metadata.ino, uid: metadata.uid };
}

function createFakeOpenCode(
  directory: string,
  log: string,
  options: FakeOpenCodeOptions = {},
): string {
  fs.mkdirSync(directory, { recursive: true });
  const binary = path.join(directory, 'opencode');
  const behavior = {
    version: options.version ?? '1.18.15',
    versionsByProbe: options.versionsByProbe ?? null,
    compatibleHelp: options.compatibleHelp ?? true,
    models: options.models ?? ['openai/gpt-5.4'],
    modelsByInspection: options.modelsByInspection ?? null,
    unconfigured: options.unconfigured ?? false,
    answer: options.answer ?? 'Everything is ready.',
    emitTool: options.emitTool ?? false,
    hangRun: options.hangRun ?? false,
    ignoreSigterm: options.ignoreSigterm ?? false,
    malformedOutput: options.malformedOutput ?? false,
    unknownEvent: options.unknownEvent ?? false,
    fallbackWarning: options.fallbackWarning ?? false,
    blockCleanup: options.blockCleanup ?? false,
    swapAuthDirectoryWith: options.swapAuthDirectoryWith ?? null,
    replaceInstalledAfterModels: options.replaceInstalledAfterModels ?? false,
    replacementLog: options.replacementLog ?? null,
    refreshedAuth: options.refreshedAuth ?? null,
    generatedModelCount: options.generatedModelCount ?? 0,
    authTypes: options.authTypes ?? [],
  };
  const source = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const log = ${JSON.stringify(log)};
const installedBinary = ${JSON.stringify(binary)};
const behavior = ${JSON.stringify(behavior)};
const args = process.argv.slice(2);
function record(value) { fs.appendFileSync(log, JSON.stringify(value) + '\\n'); }
const runtimeRoot = path.dirname(process.env.OPENCODE_CONFIG_DIR || '');
const authPath = path.join(process.env.XDG_DATA_HOME || '', 'opencode', 'auth.json');
const globalConfig = path.join(process.env.XDG_CONFIG_HOME || '', 'opencode');
function mode(target) {
  try { return fs.statSync(target).mode & 0o777; } catch { return undefined; }
}
function fileText(target) {
  try { return fs.readFileSync(target, 'utf8'); } catch { return undefined; }
}
let authIsSymlink = false;
let authTarget;
let authNlink;
let authMode;
try {
  const authStat = fs.lstatSync(authPath);
  authIsSymlink = authStat.isSymbolicLink();
  authNlink = authStat.nlink;
  authMode = authStat.mode & 0o777;
  if (authIsSymlink) authTarget = fs.readlinkSync(authPath);
} catch {}
record({
  kind: 'start',
  executable: __filename,
  args,
  cwd: process.cwd(),
  gitSentinel: fs.existsSync(path.join(process.cwd(), '.git')),
  runtimeRoot,
  home: process.env.HOME,
  xdgData: process.env.XDG_DATA_HOME,
  xdgConfig: process.env.XDG_CONFIG_HOME,
  xdgCache: process.env.XDG_CACHE_HOME,
  xdgState: process.env.XDG_STATE_HOME,
  configMode: mode(process.env.OPENCODE_CONFIG_DIR || ''),
  globalConfigMode: mode(globalConfig),
  configGitignore: fileText(path.join(process.env.OPENCODE_CONFIG_DIR || '', '.gitignore')),
  globalConfigGitignore: fileText(path.join(globalConfig, '.gitignore')),
  db: process.env.OPENCODE_DB,
  permission: process.env.OPENCODE_PERMISSION,
  config: process.env.OPENCODE_CONFIG_CONTENT,
  pure: process.env.OPENCODE_PURE,
  disableProject: process.env.OPENCODE_DISABLE_PROJECT_CONFIG,
  disableClaude: process.env.OPENCODE_DISABLE_CLAUDE_CODE,
  disableExternalSkills: process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS,
  disableDefaultPlugins: process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS,
  disableUpdate: process.env.OPENCODE_DISABLE_AUTOUPDATE,
  disableShare: process.env.OPENCODE_DISABLE_SHARE,
  authExists: fs.existsSync(authPath),
  authText: fileText(authPath),
  authIsSymlink,
  authTarget,
  authNlink,
  authMode,
  secretNames: Object.keys(process.env).filter((name) =>
    /(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET|PASSWORD|TOKEN|AUTH_CONTENT)$/i.test(name)),
});
if (behavior.ignoreSigterm) {
  process.on('SIGTERM', () => record({ kind: 'signal', signal: 'SIGTERM' }));
}
if (args.includes('--version')) {
  const probes = fs.readFileSync(log, 'utf8')
    .trim()
    .split('\\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.kind === 'start' && entry.args?.includes('--version'))
    .length;
  const versions = behavior.versionsByProbe;
  console.log(versions
    ? versions[Math.min(Math.max(0, probes - 1), versions.length - 1)]
    : behavior.version);
  process.exit(0);
}
if (args.length === 1 && args[0] === '--help') {
  console.log(behavior.compatibleHelp ? '--pure' : '--help');
  process.exit(0);
}
if (args[0] === 'run' && args.includes('--help')) {
  console.log(behavior.compatibleHelp ? '--format --model --agent --title' : '--format');
  process.exit(0);
}
if (args[0] === 'models' && args.includes('--help')) {
  console.log('models [provider] --verbose');
  process.exit(0);
}
if (args[0] === 'models') {
  if (behavior.unconfigured) {
    console.error('No configured providers; login first');
    process.exit(1);
  }
  const inspections = fs.readFileSync(log, 'utf8')
    .trim()
    .split('\\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.kind === 'start' && entry.args?.[0] === 'models' && !entry.args.includes('--help'))
    .length;
  const sequence = behavior.modelsByInspection;
  let models = sequence
    ? sequence[Math.min(Math.max(0, inspections - 1), sequence.length - 1)]
    : behavior.models;
  if (behavior.generatedModelCount > 0) {
    models = Array.from(
      { length: behavior.generatedModelCount },
      (_, index) => 'openai/gpt-audited-' + String(index).padStart(5, '0'),
    );
  }
  function routeRecord(value) {
    const input = typeof value === 'string' ? { route: value } : value;
    const split = input.route.indexOf('/');
    const provider = split > 0 ? input.route.slice(0, split) : '';
    const id = split > 0 ? input.route.slice(split + 1) : '';
    const defaults = provider === 'openrouter'
      ? { npm: '@openrouter/ai-sdk-provider', url: 'https://openrouter.ai/api/v1' }
      : provider === 'opencode'
        ? { npm: '@ai-sdk/openai-compatible', url: 'https://opencode.ai/zen/v1' }
        : provider === 'anthropic'
          ? { npm: '@ai-sdk/anthropic', url: '' }
          : { npm: '@ai-sdk/openai', url: '' };
    return {
      route: input.route,
      metadata: {
        id,
        providerID: provider,
        name: input.name || id,
        api: {
          id,
          npm: input.npm || defaults.npm,
          url: input.url === undefined ? defaults.url : input.url,
        },
      },
    };
  }
  let serialized = '';
  for (const value of models) {
    const record = routeRecord(value);
    serialized += record.route + '\\n' + JSON.stringify(record.metadata, null, 2) + '\\n';
  }
  process.stdout.write(serialized, () => process.exit(0));
  if (behavior.replaceInstalledAfterModels) {
    const replaced = installedBinary + '.audited-original';
    fs.renameSync(installedBinary, replaced);
    fs.writeFileSync(installedBinary, '#!/usr/bin/env node\\n' +
      'require("node:fs").appendFileSync(' + JSON.stringify(behavior.replacementLog) +
      ', JSON.stringify({ args: process.argv.slice(2) }) + "\\\\n");\\n', { mode: 0o755 });
  }
  return;
}
if (args[0] === 'auth' && args[1] === 'list') {
  console.log('┌  Credentials');
  behavior.authTypes.forEach((type, index) =>
    console.log('●  Provider ' + index + ' \\u001b[90m' + type + '\\u001b[0m'));
  console.log('└  ' + behavior.authTypes.length + ' credentials');
  process.exit(0);
}
if (args[0] === 'run') {
  let input = '';
  process.stdin.on('data', (chunk) => { input += chunk.toString(); });
  process.stdin.on('end', () => {
    record({ kind: 'run-input', stdin: input });
    if (behavior.refreshedAuth !== null) fs.writeFileSync(authPath, behavior.refreshedAuth);
    if (behavior.emitTool) {
      console.log(JSON.stringify({
        type: 'tool_use',
        part: { type: 'tool', tool: 'read', state: { status: 'error' } },
      }));
    } else if (!behavior.hangRun) {
      if (behavior.fallbackWarning) console.log('agent "aside-observer" not found. Falling back to default agent');
      if (behavior.malformedOutput) console.log('{malformed json');
      if (behavior.unknownEvent) console.log(JSON.stringify({ type: 'surprise' }));
      console.log(JSON.stringify({
        type: 'text',
        part: { type: 'text', text: behavior.answer },
      }));
      if (behavior.swapAuthDirectoryWith) {
        const authDirectory = path.dirname(authPath);
        fs.renameSync(authDirectory, authDirectory + '.moved');
        fs.symlinkSync(behavior.swapAuthDirectoryWith, authDirectory, 'dir');
      }
      if (behavior.blockCleanup) fs.chmodSync(runtimeRoot, 0);
    }
    if (behavior.hangRun) setInterval(() => {}, 1_000);
    else process.exit(0);
  });
  return;
}
console.error('unknown command');
process.exit(2);
`;
  fs.writeFileSync(binary, source, { mode: 0o755 });
  return binary;
}

function readLog(log: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(log)) return [];
  return fs.readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function promptBearingPreparationStarts(
  entries: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return entries.filter((entry) => {
    if (entry['kind'] !== 'start') return false;
    const args = entry['args'] as string[];
    return (args[0] === 'models' || args[0] === 'run') && !args.includes('--help');
  });
}

function findFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
}

async function waitForLog(log: string, kind: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (readLog(log).some((entry) => entry['kind'] === kind)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${kind}`);
}
