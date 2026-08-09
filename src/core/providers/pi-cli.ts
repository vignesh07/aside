import { execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { CompletionRequest, Provider } from './types.js';
import { OBSERVER_CWD } from './claude-session.js';
import { createVendorCliEnv } from './vendor-cli-env.js';

const INSPECTION_TIMEOUT_MS = 10_000;
const PROBE_TIMEOUT_MS = 2_500;
const PROBE_MAX_STREAM_BYTES = 128 * 1024;
const ANSWER_TIMEOUT_MS = 180_000;
const TERMINATION_GRACE_MS = 1_000;
const PREPARE_CACHE_MS = 2_000;
const INSPECTION_CACHE_MS = 1_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_ERROR_LENGTH = 400;

const REQUIRED_HELP_FLAGS = [
  '--mode',
  '--offline',
  '--no-session',
  '--no-tools',
  '--no-extensions',
  '--no-skills',
  '--no-prompt-templates',
  '--no-themes',
  '--no-context-files',
] as const;

const RESOURCE_ISOLATION_ARGS = [
  '--offline',
  '--no-session',
  '--no-tools',
  '--no-extensions',
  '--no-skills',
  '--no-prompt-templates',
  '--no-themes',
  '--no-context-files',
] as const;

const SAFE_RPC_ARGS = [
  '--mode',
  'rpc',
  ...RESOURCE_ISOLATION_ARGS,
] as const;

export interface PiConfiguredModel {
  provider: string;
  id: string;
  name: string;
}

export interface PiInspection {
  state: 'missing' | 'unsupported' | 'unconfigured' | 'ready' | 'error';
  model?: PiConfiguredModel;
}

interface RpcResult<T> {
  value?: T;
  exitCode: number | null;
  stderr: string;
  error?: Error;
}

interface PiInspectionProjection {
  stateSeen: boolean;
  selectedModel: PiConfiguredModel | null;
  availableModelsSeen: boolean;
  availableModelKeys: Set<string>;
}

interface PromiseCacheEntry<T> {
  pending: boolean;
  expiresAt: number;
  value: Promise<T>;
}

interface RankedPiCandidate {
  binary: string;
  version: number;
  order: number;
}

interface PiCandidateScan {
  candidates: RankedPiCandidate[];
  compatible?: RankedPiCandidate;
}

type PreparedPi =
  | { state: 'missing' | 'unsupported' | 'error' }
  | { state: 'ready'; binary: string; env: NodeJS.ProcessEnv };

const preparedCache = new Map<string, PromiseCacheEntry<PreparedPi>>();
const inspectionCache = new Map<string, PromiseCacheEntry<PiInspection>>();

/** Locate a working Pi executable without importing shell credentials. */
export async function resolvePiBinary(
  sourceEnv: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const env = piEnvironment(sourceEnv);
  const scan = await scanPiCandidates(env);
  return scan.compatible?.binary ?? null;
}

async function scanPiCandidates(env: NodeJS.ProcessEnv): Promise<PiCandidateScan> {
  fs.mkdirSync(OBSERVER_CWD, { recursive: true });
  const candidates = new Set<string>();
  for (const directory of (env['PATH'] ?? '').split(path.delimiter)) {
    if (path.isAbsolute(directory)) candidates.add(path.join(directory, 'pi'));
  }

  candidates.add('/opt/homebrew/bin/pi');
  candidates.add('/usr/local/bin/pi');
  const home = env['HOME'] || env['USERPROFILE'] || os.homedir();
  candidates.add(path.join(home, '.local', 'bin', 'pi'));
  candidates.add(path.join(home, '.npm-global', 'bin', 'pi'));

  const versionProbes = await Promise.all(
    [...candidates].map(async (candidate, order) => {
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
      } catch {
        return null;
      }
      const output = await runProbe(
        candidate,
        [...RESOURCE_ISOLATION_ARGS, '--version'],
        env,
      );
      // Older or unrelated executables may reject the isolation flags before
      // printing a version. They are still real candidates and must classify as
      // unsupported—not missing—if none of the installed candidates is safe.
      return { binary: candidate, version: output === null ? 0 : versionRank(output), order };
    }),
  );
  const ranked = versionProbes
    .filter((probe): probe is NonNullable<typeof probe> => probe !== null)
    .sort((a, b) => b.version - a.version || a.order - b.order);
  if (ranked.length === 0) return { candidates: [] };

  // Capability belongs to an executable, not a version number. Probe every
  // ranked candidate so an unrelated/newer `pi` cannot hide an older Pi that
  // actually has the privacy controls Aside requires.
  const helpProbes = await Promise.all(
    ranked.map(async (candidate) => ({
      candidate,
      help: await runProbe(
        candidate.binary,
        [...RESOURCE_ISOLATION_ARGS, '--help'],
        env,
      ),
    })),
  );
  const compatible = helpProbes.find(
    ({ help }) => help !== null && REQUIRED_HELP_FLAGS.every((flag) => help.includes(flag)),
  )?.candidate;
  return {
    candidates: ranked,
    ...(compatible ? { compatible } : {}),
  };
}

/**
 * Check that Pi exposes the isolation controls Aside requires, then inspect its
 * selected model through the documented in-memory RPC protocol.
 */
export async function inspectPi(
  sourceEnv: NodeJS.ProcessEnv = process.env,
): Promise<PiInspection> {
  const prepared = await preparePi(sourceEnv);
  if (prepared.state !== 'ready') return { state: prepared.state };
  const key = `${piCacheKey(prepared.env)}\u0000${prepared.binary}`;
  return cachedPromise(
    inspectionCache,
    key,
    INSPECTION_CACHE_MS,
    () => inspectPreparedPi(prepared),
  );
}

/** Return only Pi's current exact model, projecting away every other field. */
export async function listConfiguredPiModels(
  sourceEnv: NodeJS.ProcessEnv = process.env,
): Promise<PiConfiguredModel[]> {
  const inspection = await inspectPi(sourceEnv);
  return inspection.state === 'ready' && inspection.model ? [inspection.model] : [];
}

/**
 * Build a fully isolated Pi command for one exact upstream provider/model.
 * Transcript context and the user's question are deliberately absent: they are
 * sent over RPC stdin so they never appear in the process list.
 */
export function piObserverArgs(model: string, systemPrompt: string): string[] {
  const selected = splitConfiguredModel(model);
  return [
    ...SAFE_RPC_ARGS,
    '--provider',
    selected.provider,
    '--model',
    selected.id,
    '--system-prompt',
    systemPrompt,
  ];
}

export const piCli: Provider = {
  id: 'pi-cli',
  label: 'Pi (your configured model account)',
  apiKeyEnv: [],
  requiresApiKey: false,
  // Pi owns this dynamic catalog. listConfiguredPiModels() supplies the picker.
  models: [],
  complete: askPi,
};

async function askPi(req: CompletionRequest): Promise<string> {
  const prepared = await preparePi(process.env);
  if (prepared.state === 'missing') {
    throw new Error('pi-cli: Pi was not found. Install Pi, open it, and run `/login`.');
  }
  if (prepared.state === 'unsupported') {
    throw new Error(
      'pi-cli: this Pi version cannot disable context files. Update Pi before using it with Aside.',
    );
  }
  if (prepared.state !== 'ready') {
    throw new Error('pi-cli: Aside could not inspect Pi safely.');
  }

  // The model named in Aside is a routing/privacy boundary, not a suggestion.
  // If Pi changed since this side thread was configured, do not silently send
  // the transcript to either the stale target or Pi's new default.
  const expected = splitConfiguredModel(req.model);
  const inspection = await inspectPreparedPi(prepared);
  if (inspection.state === 'unconfigured') {
    throw new Error('pi-cli: Pi has no configured model. Open Pi, run `/login`, and select a model.');
  }
  if (inspection.state !== 'ready' || !inspection.model) {
    throw new Error('pi-cli: Aside could not verify Pi’s selected model safely.');
  }
  if (
    inspection.model.provider !== expected.provider ||
    inspection.model.id !== expected.id
  ) {
    throw new Error(
      `pi-cli: this thread is pinned to ${expected.provider}/${expected.id}, but Pi is now ` +
        `set to ${inspection.model.provider}/${inspection.model.id}. Refresh Accounts and choose ` +
        'the current Pi model for this thread.',
    );
  }

  fs.mkdirSync(OBSERVER_CWD, { recursive: true });
  const prompt = [req.context, req.history, `Question: ${req.question}`]
    .filter(Boolean)
    .join('\n\n');
  return runPromptRpc(
    prepared.binary,
    piObserverArgs(req.model, req.systemPrompt),
    prepared.env,
    prompt,
    req.signal,
  );
}

async function preparePi(sourceEnv: NodeJS.ProcessEnv): Promise<PreparedPi> {
  const env = piEnvironment(sourceEnv);
  const key = piCacheKey(env);
  return cachedPromise(
    preparedCache,
    key,
    PREPARE_CACHE_MS,
    () => preparePiUncached(env),
  );
}

async function preparePiUncached(env: NodeJS.ProcessEnv): Promise<PreparedPi> {
  const scan = await scanPiCandidates(env);
  if (scan.compatible) return { state: 'ready', binary: scan.compatible.binary, env };
  if (scan.candidates.length === 0) return { state: 'missing' };
  return { state: 'unsupported' };
}

function cachedPromise<T>(
  cache: Map<string, PromiseCacheEntry<T>>,
  key: string,
  ttlMs: number,
  create: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  const existing = cache.get(key);
  if (existing && (existing.pending || existing.expiresAt > now)) {
    return existing.value;
  }

  const value = create();
  const entry: PromiseCacheEntry<T> = { pending: true, expiresAt: 0, value };
  cache.set(key, entry);
  const settled = () => {
    // A newer entry for the same key wins; an older completion must not extend it.
    if (cache.get(key) !== entry) return;
    entry.pending = false;
    entry.expiresAt = Date.now() + ttlMs;
  };
  void value.then(settled, settled);
  return value;
}

async function inspectPreparedPi(
  prepared: Extract<PreparedPi, { state: 'ready' }>,
): Promise<PiInspection> {
  const result = await runInspectionRpc(prepared.binary, prepared.env);
  if (!result.error && result.exitCode === 0 && result.value) {
    const projection = result.value;
    if (!projection.stateSeen || !projection.availableModelsSeen) {
      return { state: 'error' };
    }
    if (
      projection.selectedModel &&
      projection.availableModelKeys.has(modelKey(projection.selectedModel))
    ) {
      return { state: 'ready', model: projection.selectedModel };
    }
    return { state: 'unconfigured' };
  }
  if (isUnconfigured(result)) return { state: 'unconfigured' };
  return { state: 'error' };
}

function piEnvironment(sourceEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...createVendorCliEnv(sourceEnv),
    PI_OFFLINE: '1',
    NO_COLOR: '1',
  };
}

function piCacheKey(env: NodeJS.ProcessEnv): string {
  return [
    'PATH',
    'HOME',
    'USERPROFILE',
    'PI_CODING_AGENT_DIR',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
  ].map((name) => `${name}=${env[name] ?? ''}`).join('\u0000');
}

function runProbe(
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      binary,
      args,
      {
        cwd: OBSERVER_CWD,
        env,
        encoding: 'utf8',
        timeout: PROBE_TIMEOUT_MS,
        // execFile applies maxBuffer independently to stdout and stderr. Keep
        // each half-sized so the combined capability text remains bounded.
        maxBuffer: PROBE_MAX_STREAM_BYTES,
        // Node's default is SIGTERM. A broken or hostile executable can ignore
        // it forever and prevent the callback (and Aside startup) from settling.
        killSignal: 'SIGKILL',
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          resolve(null);
          return;
        }
        // Pi writes help to stderr in some releases. Probe output is consumed
        // only for version/flag detection and is never logged or exposed.
        resolve(stdout && stderr ? `${stdout}\n${stderr}` : stdout || stderr);
      },
    );
  });
}

function runInspectionRpc(
  binary: string,
  env: NodeJS.ProcessEnv,
): Promise<RpcResult<PiInspectionProjection>> {
  fs.mkdirSync(OBSERVER_CWD, { recursive: true });
  return new Promise((resolve) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(binary, [...SAFE_RPC_ARGS], {
        cwd: OBSERVER_CWD,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({
        exitCode: null,
        stderr: '',
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return;
    }

    const decoder = new StringDecoder('utf8');
    let buffer = '';
    let stderr = '';
    const projected: PiInspectionProjection = {
      stateSeen: false,
      selectedModel: null,
      availableModelsSeen: false,
      availableModelKeys: new Set(),
    };
    let totalBytes = 0;
    let terminalError: Error | undefined;
    let settled = false;
    const finish = (result: RpcResult<PiInspectionProjection>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      terminalError = new Error('Pi inspection timed out.');
      child.kill('SIGKILL');
    }, INSPECTION_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => {
      totalBytes += chunk.byteLength;
      if (totalBytes > MAX_OUTPUT_BYTES) {
        terminalError = new Error('Pi inspection exceeded the safe output limit.');
        child.kill('SIGKILL');
        return;
      }
      buffer += decoder.write(chunk);
      buffer = consumeJsonLines(buffer, (value) => {
        projectInspectionResponse(projected, value);
      });
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-8_000);
    });
    child.on('error', (error) => {
      finish({ exitCode: null, stderr, error });
    });
    child.on('close', (exitCode) => {
      buffer += decoder.end();
      if (buffer) consumeJsonLines(`${buffer}\n`, (value) => {
        projectInspectionResponse(projected, value);
      });
      finish({
        value: projected,
        exitCode,
        stderr,
        ...(terminalError ? { error: terminalError } : {}),
      });
    });
    child.stdin.on('error', (error) => {
      child.kill('SIGKILL');
      finish({ exitCode: null, stderr, error });
    });

    child.stdin.end(
      [
        { id: 'aside-state', type: 'get_state' },
        { id: 'aside-models', type: 'get_available_models' },
      ].map((command) => JSON.stringify(command)).join('\n') + '\n',
    );
  });
}

function runPromptRpc(
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  prompt: string,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('pi-cli: request aborted.'));
      return;
    }

    const child = spawn(binary, args, {
      cwd: OBSERVER_CWD,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let settled = false;
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    let stderr = '';
    let streamedText = '';
    let finalText = '';
    let totalBytes = 0;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      child.stdin.end();
      terminateWithEscalation(child);
      if (error) reject(error);
      else resolve((finalText || streamedText).trim() || '(no response)');
    };
    const abort = () => {
      if (!child.stdin.destroyed) {
        child.stdin.write(`${JSON.stringify({ type: 'abort' })}\n`);
      }
      finish(new Error('pi-cli: request aborted.'));
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error(`pi-cli: timed out after ${ANSWER_TIMEOUT_MS / 1000}s.`));
    }, ANSWER_TIMEOUT_MS);

    signal?.addEventListener('abort', abort, { once: true });
    const consumeEvent = (value: unknown) => {
      const event = asRecord(value);
      if (!event) return;
      if (event['type'] === 'response' && event['id'] === 'aside-prompt') {
        if (event['success'] === false) {
          finish(new Error(`pi-cli: ${safeError(event['error'])}`));
        }
        return;
      }
      if (event['type'] === 'message_update') {
        const update = asRecord(event['assistantMessageEvent']);
        if (update?.['type'] === 'text_delta' && typeof update['delta'] === 'string') {
          streamedText += update['delta'];
        }
        return;
      }
      if (event['type'] === 'message_end') {
        const message = asRecord(event['message']);
        if (message?.['role'] !== 'assistant') return;
        const stopReason = message['stopReason'];
        if (stopReason === 'error' || stopReason === 'aborted') {
          finish(new Error(`pi-cli: ${safeError(message['errorMessage'] ?? stopReason)}`));
          return;
        }
        finalText = assistantText(message);
        return;
      }
      if (event['type'] === 'agent_end') finish();
    };

    child.stdout.on('data', (chunk: Buffer) => {
      totalBytes += chunk.byteLength;
      if (totalBytes > MAX_OUTPUT_BYTES) {
        finish(new Error('pi-cli: response exceeded the safe output limit.'));
        return;
      }
      buffer += decoder.write(chunk);
      buffer = consumeJsonLines(buffer, consumeEvent);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-8_000);
    });
    child.on('error', (error) => finish(explainProcessFailure(error, stderr)));
    child.on('close', (code) => {
      buffer += decoder.end();
      if (buffer) consumeJsonLines(`${buffer}\n`, consumeEvent);
      if (!settled) {
        finish(
          new Error(
            `pi-cli: ${safeError(stderr || `provider stopped before answering (exit ${code ?? 'unknown'})`)}`,
          ),
        );
      }
    });
    child.stdin.on('error', (error) => {
      if (!settled) finish(explainProcessFailure(error, stderr));
    });

    child.stdin.write(`${JSON.stringify({ id: 'aside-prompt', type: 'prompt', message: prompt })}\n`);
  });
}

function projectStateModel(response: unknown): PiConfiguredModel | null | undefined {
  const record = successfulResponse(response, 'aside-state');
  if (!record) return undefined;
  const data = asRecord(record?.['data']);
  return projectModel(data?.['model']) ?? null;
}

function projectInspectionResponse(
  projection: PiInspectionProjection,
  response: unknown,
): void {
  const selectedModel = projectStateModel(response);
  if (selectedModel !== undefined) {
    projection.stateSeen = true;
    projection.selectedModel = selectedModel;
    return;
  }

  const availableModelKeys = projectAvailableModelKeys(response);
  if (availableModelKeys !== undefined) {
    projection.availableModelsSeen = true;
    projection.availableModelKeys = availableModelKeys;
  }
}

function projectAvailableModelKeys(response: unknown): Set<string> | undefined {
  const record = successfulResponse(response, 'aside-models');
  if (!record) return undefined;
  const data = asRecord(record['data']);
  if (!Array.isArray(data?.['models'])) return undefined;

  const keys = new Set<string>();
  for (const rawModel of data['models']) {
    const model = projectModel(rawModel);
    if (model) keys.add(modelKey(model));
  }
  return keys;
}

function modelKey(model: Pick<PiConfiguredModel, 'provider' | 'id'>): string {
  return `${model.provider}\u0000${model.id}`;
}

function successfulResponse(response: unknown, id: string): Record<string, unknown> | undefined {
  const record = asRecord(response);
  return record?.['type'] === 'response' && record['id'] === id && record['success'] === true
    ? record
    : undefined;
}

function projectModel(value: unknown): PiConfiguredModel | undefined {
  const model = asRecord(value);
  if (!model) return undefined;
  const provider = safeProvider(model['provider']);
  const id = safeModelId(model['id']);
  if (!provider || !id) return undefined;
  // Current Pi uses this sentinel when it has no usable model. Treating it as
  // configured would unlock consent and advertise a route that cannot answer.
  if (provider.toLowerCase() === 'unknown' || id.toLowerCase() === 'unknown') {
    return undefined;
  }
  const suppliedName = cleanText(model['name'], 300);
  return { provider, id, name: suppliedName || id };
}

function splitConfiguredModel(value: string): { provider: string; id: string } {
  const separator = value.indexOf('/');
  const provider = safeProvider(separator > 0 ? value.slice(0, separator) : '');
  const id = safeModelId(separator > 0 ? value.slice(separator + 1) : '');
  if (!provider || !id) {
    throw new Error('pi-cli: model must be an exact provider/model id reported by Pi.');
  }
  return { provider, id };
}

function consumeJsonLines(buffer: string, onValue: (value: unknown) => void): string {
  let newline = buffer.indexOf('\n');
  while (newline >= 0) {
    const line = buffer.slice(0, newline).replace(/\r$/, '');
    buffer = buffer.slice(newline + 1);
    if (line) {
      try {
        onValue(JSON.parse(line));
      } catch {
        // RPC stdout is JSONL. Ignore a malformed record and keep the boundary.
      }
    }
    newline = buffer.indexOf('\n');
  }
  return buffer;
}

function assistantText(message: Record<string, unknown>): string {
  const content = message['content'];
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => asRecord(part))
    .filter((part): part is Record<string, unknown> => Boolean(part))
    .filter((part) => part['type'] === 'text' && typeof part['text'] === 'string')
    .map((part) => part['text'] as string)
    .join('');
}

function isUnconfigured(result: RpcResult<unknown>): boolean {
  return /no models available|set an api key|run .*\/login/i.test(result.stderr);
}

function explainProcessFailure(error: Error, output: string): Error {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return new Error('pi-cli: Pi was not found.');
  return new Error(`pi-cli: ${safeError(output || error.message)}`);
}

function terminateWithEscalation(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const killTimer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  }, TERMINATION_GRACE_MS);
  killTimer.unref?.();
  child.once('close', () => clearTimeout(killTimer));
}

function safeError(value: unknown): string {
  return cleanText(value, MAX_ERROR_LENGTH) || 'request failed';
}

function safeProvider(value: unknown): string | undefined {
  const text = cleanText(value, 100);
  return text && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(text) ? text : undefined;
}

function safeModelId(value: unknown): string | undefined {
  const text = cleanText(value, 300);
  return text && !/[\u0000-\u001f\u007f]/.test(text) ? text : undefined;
}

function cleanText(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function versionRank(output: string): number {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(output);
  if (!match) return 0;
  return Number(match[1]) * 1_000_000 + Number(match[2]) * 1_000 + Number(match[3]);
}
