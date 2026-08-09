import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  inspectPi,
  listConfiguredPiModels,
  piCli,
  piObserverArgs,
  resolvePiBinary,
} from '../src/core/providers/pi-cli.js';
import { OBSERVER_CWD } from '../src/core/providers/claude-session.js';

const HELP_FLAGS = [
  '--mode',
  '--offline',
  '--no-session',
  '--no-tools',
  '--no-extensions',
  '--no-skills',
  '--no-prompt-templates',
  '--no-themes',
  '--no-context-files',
];

interface FakePiOptions {
  version?: string;
  versionToStderr?: boolean;
  supported?: boolean;
  helpToStderr?: boolean;
  unconfigured?: boolean;
  model?: { provider: string; id: string; name: string } | null;
  availableModels?: Array<{ provider: string; id: string; name: string }>;
  bytewiseUnicode?: boolean;
  exitOnRpc?: boolean;
  ignoreSigterm?: boolean;
  hangHelp?: boolean;
  versionDelayMs?: number;
  helpDelayMs?: number;
  rpcDelayMs?: number;
}

const temporaryRoots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe.sequential('Pi CLI observer provider', () => {
  it('pins an exact upstream provider/model and enables every isolation flag', () => {
    const args = piObserverArgs('openrouter/anthropic/claude-sonnet', 'Observer role');

    expect(args).toEqual([
      '--mode',
      'rpc',
      '--offline',
      '--no-session',
      '--no-tools',
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--no-themes',
      '--no-context-files',
      '--provider',
      'openrouter',
      '--model',
      'anthropic/claude-sonnet',
      '--system-prompt',
      'Observer role',
    ]);
    expect(() => piObserverArgs('claude-sonnet', 'Observer role')).toThrow(
      /exact provider\/model id/,
    );
  });

  it('chooses the newest working Pi when its version and help are emitted on stderr', async () => {
    const root = tempRoot();
    const oldBinary = createFakePi(path.join(root, 'old-bin'), path.join(root, 'old.log'), {
      version: '0.50.0',
    });
    const newBinary = createFakePi(
      path.join(root, '.local', 'bin'),
      path.join(root, 'new.log'),
      { version: '0.61.2', versionToStderr: true, helpToStderr: true },
    );
    const env = providerEnv(root, path.dirname(oldBinary));

    await expect(resolvePiBinary(env)).resolves.toBe(newBinary);

    for (const entry of [...readLog(path.join(root, 'old.log')), ...readLog(path.join(root, 'new.log'))]) {
      const args = entry['args'] as string[];
      expect(args).toContain('--no-extensions');
      expect(args).toContain('--no-context-files');
      expect(entry['cwd']).toBe(fs.realpathSync(OBSERVER_CWD));
    }
  });

  it('does not let a newer incompatible Pi shadow an older isolated Pi', async () => {
    const root = tempRoot();
    const incompatible = createFakePi(
      path.join(root, 'newer-bin'),
      path.join(root, 'newer.log'),
      { version: '9.0.0', supported: false },
    );
    const compatible = createFakePi(
      path.join(root, '.local', 'bin'),
      path.join(root, 'compatible.log'),
      {
        version: '0.61.2',
        model: { provider: 'openai-codex', id: 'gpt-5.4', name: 'GPT-5.4' },
      },
    );
    const env = providerEnv(root, path.dirname(incompatible));

    await expect(resolvePiBinary(env)).resolves.toBe(compatible);
    await expect(inspectPi(env)).resolves.toEqual({
      state: 'ready',
      model: { provider: 'openai-codex', id: 'gpt-5.4', name: 'GPT-5.4' },
    });
    expect(
      readLog(path.join(root, 'newer.log')).some(
        (entry) =>
          entry['kind'] === 'command' &&
          (entry['command'] as Record<string, unknown>)['type'] === 'get_state',
      ),
    ).toBe(false);
  });

  it('hard-kills a probe that ignores SIGTERM instead of hanging resolution', async () => {
    const root = tempRoot();
    const hanging = createFakePi(
      path.join(root, 'newer-bin'),
      path.join(root, 'hanging.log'),
      { version: '9.0.0', ignoreSigterm: true, hangHelp: true },
    );
    const compatible = createFakePi(
      path.join(root, '.local', 'bin'),
      path.join(root, 'compatible.log'),
      { version: '0.61.2' },
    );
    const env = providerEnv(root, path.dirname(hanging));
    const startedAt = Date.now();

    await expect(resolvePiBinary(env)).resolves.toBe(compatible);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  }, 7_000);

  it('distinguishes missing, unsupported, and unconfigured Pi installations', async () => {
    const missingRoot = tempRoot();
    expect(await inspectPi(providerEnv(missingRoot, path.join(missingRoot, 'empty')))).toEqual({
      state: 'missing',
    });

    const unsupportedRoot = tempRoot();
    const unsupported = createFakePi(
      path.join(unsupportedRoot, 'bin'),
      path.join(unsupportedRoot, 'pi.log'),
      { supported: false },
    );
    expect(await inspectPi(providerEnv(unsupportedRoot, path.dirname(unsupported)))).toEqual({
      state: 'unsupported',
    });

    const unconfiguredRoot = tempRoot();
    const unconfigured = createFakePi(
      path.join(unconfiguredRoot, 'bin'),
      path.join(unconfiguredRoot, 'pi.log'),
      { unconfigured: true },
    );
    expect(await inspectPi(providerEnv(unconfiguredRoot, path.dirname(unconfigured)))).toEqual({
      state: 'unconfigured',
    });

    const sentinelRoot = tempRoot();
    const sentinel = createFakePi(
      path.join(sentinelRoot, 'bin'),
      path.join(sentinelRoot, 'pi.log'),
      { model: { provider: 'unknown', id: 'unknown', name: 'Unknown' } },
    );
    expect(await inspectPi(providerEnv(sentinelRoot, path.dirname(sentinel)))).toEqual({
      state: 'unconfigured',
    });
  });

  it('projects the current model immediately and exposes only that model', async () => {
    const root = tempRoot();
    const log = path.join(root, 'pi.log');
    const binary = createFakePi(path.join(root, 'bin'), log, {
      model: { provider: 'openai-codex', id: 'gpt-5.4', name: 'GPT-5.4' },
    });
    const env = providerEnv(root, path.dirname(binary));

    await expect(inspectPi(env)).resolves.toEqual({
      state: 'ready',
      model: { provider: 'openai-codex', id: 'gpt-5.4', name: 'GPT-5.4' },
    });
    await expect(listConfiguredPiModels(env)).resolves.toEqual([
      { provider: 'openai-codex', id: 'gpt-5.4', name: 'GPT-5.4' },
    ]);

    const commands = readLog(log)
      .filter((entry) => entry['kind'] === 'command')
      .map((entry) => (entry['command'] as Record<string, unknown>)['type']);
    // Model discovery and auth status share the same short-lived safe probe.
    expect(commands).toEqual(['get_state', 'get_available_models']);
    expect(JSON.stringify(await inspectPi(env))).not.toContain('do-not-leak');
  });

  it('treats a selected model without configured auth as unconfigured', async () => {
    const root = tempRoot();
    const log = path.join(root, 'pi.log');
    const binary = createFakePi(path.join(root, 'bin'), log, {
      model: { provider: 'openai-codex', id: 'gpt-5.4', name: 'GPT-5.4' },
      availableModels: [
        { provider: 'anthropic', id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
      ],
    });
    const env = providerEnv(root, path.dirname(binary));

    await expect(inspectPi(env)).resolves.toEqual({ state: 'unconfigured' });
    await expect(listConfiguredPiModels(env)).resolves.toEqual([]);
    expect(JSON.stringify(await inspectPi(env))).not.toContain('do-not-leak');

    const commands = readLog(log)
      .filter((entry) => entry['kind'] === 'command')
      .map((entry) => (entry['command'] as Record<string, unknown>)['type']);
    expect(commands).toEqual(['get_state', 'get_available_models']);
  });

  it('coalesces staggered preparation and inspection while each probe is pending', async () => {
    const root = tempRoot();
    const log = path.join(root, 'pi.log');
    const binary = createFakePi(path.join(root, 'bin'), log, {
      // Keep each probe comfortably below its own 2.5s timeout while the
      // combined preparation still remains pending beyond the 2s cache TTL.
      versionDelayMs: 1_200,
      helpDelayMs: 1_200,
      rpcDelayMs: 1_600,
      model: { provider: 'openai-codex', id: 'gpt-5.4', name: 'GPT-5.4' },
    });
    const env = providerEnv(root, path.dirname(binary));

    const first = inspectPi(env);
    await delay(2_100); // Past prepare TTL, while the delayed help probe is pending.
    const second = inspectPi(env);
    await delay(1_450); // Past inspection TTL, while get_state is still pending.
    const third = inspectPi(env);

    const results = await Promise.all([first, second, third]);
    expect(results).toEqual([
      { state: 'ready', model: { provider: 'openai-codex', id: 'gpt-5.4', name: 'GPT-5.4' } },
      { state: 'ready', model: { provider: 'openai-codex', id: 'gpt-5.4', name: 'GPT-5.4' } },
      { state: 'ready', model: { provider: 'openai-codex', id: 'gpt-5.4', name: 'GPT-5.4' } },
    ]);

    const entries = readLog(log);
    const starts = entries.filter((entry) => entry['kind'] === 'start');
    expect(starts.filter((entry) => (entry['args'] as string[]).includes('--version'))).toHaveLength(1);
    expect(starts.filter((entry) => (entry['args'] as string[]).includes('--help'))).toHaveLength(1);
    expect(starts.filter((entry) => (entry['args'] as string[]).includes('rpc'))).toHaveLength(1);
    expect(
      entries.filter(
        (entry) =>
          entry['kind'] === 'command' &&
          (entry['command'] as Record<string, unknown>)['type'] === 'get_state',
      ),
    ).toHaveLength(1);
    expect(
      entries.filter(
        (entry) =>
          entry['kind'] === 'command' &&
          (entry['command'] as Record<string, unknown>)['type'] === 'get_available_models',
      ),
    ).toHaveLength(1);
  }, 8_000);

  it('sends scoped chat context over RPC stdin without passing credentials or prompt text in argv', async () => {
    const root = tempRoot();
    const log = path.join(root, 'pi.log');
    const binary = createFakePi(path.join(root, 'bin'), log, {
      model: { provider: 'openai-codex', id: 'gpt-5.4', name: 'GPT-5.4' },
    });
    const env = providerEnv(root, path.dirname(binary));
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value ?? '');
    vi.stubEnv('OPENAI_API_KEY', 'must-not-reach-pi');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'must-not-reach-pi');

    await expect(
      piCli.complete({
        model: 'openai-codex/gpt-5.4',
        systemPrompt: 'You are Aside.',
        context: 'Scoped transcript context',
        history: 'User: earlier\nAside: response',
        question: 'What needs me?',
      }),
    ).resolves.toBe('Everything is ready.');

    const entries = readLog(log);
    const rpcStart = entries.find(
      (entry) =>
        entry['kind'] === 'start' &&
        Array.isArray(entry['args']) &&
        (entry['args'] as string[]).includes('rpc'),
    );
    const command = entries.find(
      (entry) =>
        entry['kind'] === 'command' &&
        (entry['command'] as Record<string, unknown>)['type'] === 'prompt',
    );
    const argv = (rpcStart?.['args'] ?? []) as string[];
    expect(argv.join(' ')).not.toContain('Scoped transcript context');
    expect(argv.join(' ')).not.toContain('What needs me?');
    expect(rpcStart?.['secretNames']).toEqual([]);
    expect(rpcStart?.['offline']).toBe('1');
    expect(rpcStart?.['agentDir']).toBe(path.join(root, '.pi-agent'));
    expect(command?.['command']).toMatchObject({
      id: 'aside-prompt',
      type: 'prompt',
      message:
        'Scoped transcript context\n\nUser: earlier\nAside: response\n\nQuestion: What needs me?',
    });
  });

  it('refuses to route a saved thread after Pi changes its selected model', async () => {
    const root = tempRoot();
    const log = path.join(root, 'pi.log');
    const binary = createFakePi(path.join(root, 'bin'), log, {
      model: { provider: 'openai-codex', id: 'gpt-5.4', name: 'GPT-5.4' },
    });
    const env = providerEnv(root, path.dirname(binary));
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value ?? '');

    await expect(
      piCli.complete({
        model: 'anthropic/claude-opus-4-6',
        systemPrompt: 'You are Aside.',
        context: 'Scoped transcript context',
        history: '',
        question: 'What changed?',
      }),
    ).rejects.toThrow(/pinned to anthropic\/claude-opus-4-6.*Pi is now set to openai-codex\/gpt-5\.4/s);

    expect(
      readLog(log).some(
        (entry) =>
          entry['kind'] === 'command' &&
          (entry['command'] as Record<string, unknown>)['type'] === 'prompt',
      ),
    ).toBe(false);
  });

  it('parses byte-split Unicode RPC output and handles an early RPC exit safely', async () => {
    const unicodeRoot = tempRoot();
    const unicodeBinary = createFakePi(
      path.join(unicodeRoot, 'bin'),
      path.join(unicodeRoot, 'pi.log'),
      {
        model: { provider: 'openai-codex', id: 'gpt-5.4', name: 'GPT-5.4' },
        bytewiseUnicode: true,
      },
    );
    const unicodeEnv = providerEnv(unicodeRoot, path.dirname(unicodeBinary));
    for (const [name, value] of Object.entries(unicodeEnv)) vi.stubEnv(name, value ?? '');
    await expect(
      piCli.complete({
        model: 'openai-codex/gpt-5.4',
        systemPrompt: 'You are Aside.',
        context: '',
        history: '',
        question: 'Unicode?',
      }),
    ).resolves.toBe('Everything is 🐈 ready.');

    const exitRoot = tempRoot();
    const exitBinary = createFakePi(
      path.join(exitRoot, 'bin'),
      path.join(exitRoot, 'pi.log'),
      { exitOnRpc: true },
    );
    const exitEnv = providerEnv(exitRoot, path.dirname(exitBinary));
    for (const [name, value] of Object.entries(exitEnv)) vi.stubEnv(name, value ?? '');
    await expect(
      piCli.complete({
        model: 'anthropic/claude-opus-4-6',
        systemPrompt: 'You are Aside.',
        context: '',
        history: '',
        question: 'Will this exit?',
      }),
    ).rejects.toThrow(/could not verify Pi’s selected model safely/);
  });
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aside-pi-test-'));
  temporaryRoots.push(root);
  return root;
}

function providerEnv(home: string, piDirectory: string): NodeJS.ProcessEnv {
  return {
    HOME: home,
    USER: 'tester',
    PATH: [piDirectory, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter),
    PI_CODING_AGENT_DIR: path.join(home, '.pi-agent'),
    OPENAI_API_KEY: 'ambient-key-must-be-stripped',
  };
}

function createFakePi(directory: string, log: string, options: FakePiOptions = {}): string {
  fs.mkdirSync(directory, { recursive: true });
  const binary = path.join(directory, 'pi');
  const selectedModel = options.model === undefined
    ? { provider: 'anthropic', id: 'claude-opus-4-6', name: 'Claude Opus 4.6' }
    : options.model;
  const behavior = {
    version: options.version ?? '0.60.0',
    versionToStderr: options.versionToStderr ?? false,
    help: options.supported === false ? HELP_FLAGS.slice(0, -1).join('\n') : HELP_FLAGS.join('\n'),
    helpToStderr: options.helpToStderr ?? false,
    unconfigured: options.unconfigured ?? false,
    model: selectedModel,
    availableModels: options.availableModels ?? (selectedModel ? [selectedModel] : []),
    bytewiseUnicode: options.bytewiseUnicode ?? false,
    exitOnRpc: options.exitOnRpc ?? false,
    ignoreSigterm: options.ignoreSigterm ?? false,
    hangHelp: options.hangHelp ?? false,
    versionDelayMs: options.versionDelayMs ?? 0,
    helpDelayMs: options.helpDelayMs ?? 0,
    rpcDelayMs: options.rpcDelayMs ?? 0,
  };
  const source = `#!/usr/bin/env node
const fs = require('node:fs');
const log = ${JSON.stringify(log)};
const behavior = ${JSON.stringify(behavior)};
const args = process.argv.slice(2);
function record(value) { fs.appendFileSync(log, JSON.stringify(value) + '\\n'); }
if (behavior.ignoreSigterm) {
  process.on('SIGTERM', () => record({ kind: 'signal', signal: 'SIGTERM' }));
}
record({
  kind: 'start',
  args,
  cwd: process.cwd(),
  secretNames: Object.keys(process.env).filter((name) => /(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET|PASSWORD|TOKEN)$/i.test(name)),
  offline: process.env.PI_OFFLINE,
  agentDir: process.env.PI_CODING_AGENT_DIR,
});
if (args.includes('--version')) {
  const writeVersion = () => (behavior.versionToStderr ? console.error : console.log)(behavior.version);
  if (behavior.versionDelayMs > 0) {
    setTimeout(() => { writeVersion(); process.exit(0); }, behavior.versionDelayMs);
  } else {
    writeVersion();
    process.exit(0);
  }
}
if (args.includes('--help')) {
  const writeHelp = () => (behavior.helpToStderr ? console.error : console.log)(behavior.help);
  if (behavior.hangHelp) {
    setInterval(() => {}, 1_000);
  } else if (behavior.helpDelayMs > 0) {
    setTimeout(() => { writeHelp(); process.exit(0); }, behavior.helpDelayMs);
  } else {
    writeHelp();
    process.exit(0);
  }
}
if (behavior.exitOnRpc && args.includes('rpc')) { process.exit(1); }
if (behavior.unconfigured) {
  console.error('No models available. Open Pi and run /login.');
  process.exit(1);
}
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString();
  let newline = buffer.indexOf('\\n');
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line) handle(JSON.parse(line));
    newline = buffer.indexOf('\\n');
  }
});
function handle(command) {
  record({ kind: 'command', command });
  const withPrivateFields = (model) => ({
    ...model,
    headers: { Authorization: 'Bearer do-not-leak' },
    baseUrl: 'https://secret.invalid',
  });
  if (command.type === 'get_state') {
    const respond = () => console.log(JSON.stringify({
        id: command.id,
        type: 'response',
        command: 'get_state',
        success: true,
        data: {
          model: behavior.model ? withPrivateFields(behavior.model) : null,
          sessionFile: null,
          messageCount: 0,
        },
      }));
    if (behavior.rpcDelayMs > 0) setTimeout(respond, behavior.rpcDelayMs);
    else respond();
    return;
  }
  if (command.type === 'get_available_models') {
    console.log(JSON.stringify({
      id: command.id,
      type: 'response',
      command: 'get_available_models',
      success: true,
      data: { models: behavior.availableModels.map(withPrivateFields) },
    }));
    return;
  }
  if (command.type === 'prompt') {
    const events = [
      { id: command.id, type: 'response', command: 'prompt', success: true },
      {
      type: 'message_update',
      assistantMessageEvent: {
        type: 'text_delta',
        delta: behavior.bytewiseUnicode ? 'Everything is 🐈 ' : 'Everything is ',
      },
      },
      {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{
          type: 'text',
          text: behavior.bytewiseUnicode ? 'Everything is 🐈 ready.' : 'Everything is ready.',
        }],
        stopReason: 'stop',
      },
      },
      { type: 'agent_end', messages: [] },
    ];
    const output = Buffer.from(events.map((event) => JSON.stringify(event)).join('\\n') + '\\n');
    if (!behavior.bytewiseUnicode) {
      process.stdout.write(output);
      return;
    }
    let offset = 0;
    const writeByte = () => {
      if (offset >= output.length) return;
      process.stdout.write(output.subarray(offset, offset + 1));
      offset += 1;
      setTimeout(writeByte, 1);
    };
    writeByte();
  }
}
`;
  fs.writeFileSync(binary, source, { mode: 0o755 });
  return binary;
}

function readLog(log: string): Array<Record<string, unknown>> {
  return fs
    .readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
