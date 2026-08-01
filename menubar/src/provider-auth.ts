import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveCodexBinary } from '../../dist/core/providers/codex-cli.js';
import { createVendorCliEnv } from '../../dist/core/providers/vendor-cli-env.js';
import {
  FileProviderConsentStore,
  type ProviderConsentSnapshot,
  type ProviderConsentStore,
} from './provider-auth-store.js';
import {
  PROVIDER_AUTH_IDS,
  ProviderAuthError,
  isProviderAuthId,
  type ProviderAuthId,
  type ProviderAuthReason,
  type ProviderAuthStatus,
  type VendorProviderAuthId,
} from './provider-auth-types.js';

export {
  PROVIDER_AUTH_IDS,
  ProviderAuthError,
  isProviderAuthId,
  type ProviderAuthErrorCode,
  type ProviderAuthId,
  type ProviderAuthReason,
  type ProviderAuthStatus,
  type ProviderProbeState,
  type VendorProviderAuthId,
} from './provider-auth-types.js';
export {
  FileProviderConsentStore,
  ProviderConsentStoreError,
  type ProviderConsentSnapshot,
  type ProviderConsentStore,
} from './provider-auth-store.js';

const PROBE_TIMEOUT_MS = 10_000;
const LOGIN_TIMEOUT_MS = 5 * 60_000;
const OLLAMA_TIMEOUT_MS = 5_000;
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_OLLAMA_HOST = 'http://127.0.0.1:11434';

const STATUS_ARGS: Record<VendorProviderAuthId, readonly string[]> = {
  'codex-cli': ['login', 'status'],
  'claude-cli': ['auth', 'status', '--json'],
};

const LOGIN_ARGS: Record<VendorProviderAuthId, readonly string[]> = {
  'codex-cli': ['login'],
  'claude-cli': ['auth', 'login', '--claudeai'],
};

export interface ProviderCommand {
  /** Must be an absolute executable path. Commands are never passed to a shell. */
  executable: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

export interface ProviderCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnFailed: boolean;
}

export type ProviderCommandRunner = (
  command: ProviderCommand,
) => Promise<ProviderCommandResult>;

export type ProviderBinaryResolver = (
  provider: VendorProviderAuthId,
  env: NodeJS.ProcessEnv,
) => string | null;

export interface ProviderAuthDeps {
  consentStore?: ProviderConsentStore;
  resolveBinary?: ProviderBinaryResolver;
  runCommand?: ProviderCommandRunner;
  buildEnvironment?: () => NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
  ollamaHost?: () => string;
  probeTimeoutMs?: number;
  loginTimeoutMs?: number;
  ollamaTimeoutMs?: number;
}

interface RawProbe {
  provider: ProviderAuthId;
  state: ProviderAuthStatus['state'];
  reason?: Exclude<ProviderAuthReason, 'consent_unavailable'>;
  /** Internal only; never included in ProviderAuthStatus. */
  binary?: string;
}

interface ConsentRead {
  snapshot: ProviderConsentSnapshot;
  available: boolean;
}

/**
 * Coordinates vendor-owned login state with Aside-owned consent.
 *
 * It never reads or stores a token. `connect()` either records consent for an
 * already-authenticated vendor client or asks that client to run its own
 * browser login. `disconnect()` revokes only Aside consent and deliberately
 * never invokes a vendor logout command.
 */
export class ProviderAuthCoordinator {
  private readonly consentStore: ProviderConsentStore;
  private readonly resolveBinary: ProviderBinaryResolver;
  private readonly runCommand: ProviderCommandRunner;
  private readonly buildEnvironment: () => NodeJS.ProcessEnv;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly ollamaHost: () => string;
  private readonly probeTimeoutMs: number;
  private readonly loginTimeoutMs: number;
  private readonly ollamaTimeoutMs: number;

  constructor(deps: ProviderAuthDeps = {}) {
    this.consentStore = deps.consentStore ?? new FileProviderConsentStore();
    this.resolveBinary = deps.resolveBinary ?? defaultProviderBinaryResolver;
    this.runCommand = deps.runCommand ?? runProviderCommand;
    this.buildEnvironment = deps.buildEnvironment ?? (() => createVendorCliEnv());
    this.fetchImpl = deps.fetch ?? globalThis.fetch;
    this.ollamaHost = deps.ollamaHost ?? defaultOllamaHost;
    this.probeTimeoutMs = deps.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
    this.loginTimeoutMs = deps.loginTimeoutMs ?? LOGIN_TIMEOUT_MS;
    this.ollamaTimeoutMs = deps.ollamaTimeoutMs ?? OLLAMA_TIMEOUT_MS;
  }

  async getStatuses(): Promise<ProviderAuthStatus[]> {
    const consent = this.readConsent();
    const probes = await Promise.all(
      PROVIDER_AUTH_IDS.map((provider) => this.probeRaw(provider)),
    );
    return probes.map((probe) => this.withConsent(probe, consent));
  }

  async probe(providerValue: string): Promise<ProviderAuthStatus> {
    const provider = requireProvider(providerValue);
    const [probe, consent] = await Promise.all([
      this.probeRaw(provider),
      Promise.resolve(this.readConsent()),
    ]);
    return this.withConsent(probe, consent);
  }

  /**
   * Separate, versioned permission for Today-triggered generation. Existing
   * side-chat consent never silently expands into automatic recap generation.
   * Ollama is exempt because its model context never leaves this Mac.
   */
  todayRecapsEnabled(providerValue: string): boolean {
    const provider = requireProvider(providerValue);
    if (provider === 'ollama') return true;
    const consent = this.readConsent();
    return (
      consent.available &&
      consent.snapshot.enabled.has(provider) &&
      consent.snapshot.todayRecaps.has(provider)
    );
  }

  allowTodayRecaps(providerValue: string): void {
    const provider = requireProvider(providerValue);
    if (provider === 'ollama') return;
    const consent = this.readConsent();
    if (!consent.available || !consent.snapshot.enabled.has(provider)) {
      throw new ProviderAuthError('consent_unavailable', provider);
    }
    try {
      this.consentStore.setTodayRecapsEnabled(provider, true);
    } catch {
      throw new ProviderAuthError('consent_unavailable', provider);
    }
  }

  async connect(providerValue: string): Promise<ProviderAuthStatus> {
    const provider = requireProvider(providerValue);
    const consent = this.readConsent();
    if (!consent.available) {
      throw new ProviderAuthError('consent_unavailable', provider);
    }

    let probe = await this.probeRaw(provider);
    if (provider === 'ollama') {
      if (probe.state === 'missing') {
        throw new ProviderAuthError('provider_missing', provider);
      }
      if (probe.state !== 'local_ready') {
        throw new ProviderAuthError('provider_unavailable', provider);
      }
      this.saveConsent(provider, true);
      return { ...withoutBinary(probe), enabled: true };
    }

    if (probe.state === 'missing') {
      throw new ProviderAuthError('provider_missing', provider);
    }
    if (probe.state === 'error') {
      throw new ProviderAuthError('provider_unavailable', provider);
    }

    if (probe.state === 'signed_out') {
      const binary = probe.binary;
      if (!binary) throw new ProviderAuthError('provider_missing', provider);

      const login = await this.runSafely({
        executable: binary,
        args: LOGIN_ARGS[provider],
        env: this.buildEnvironment(),
        timeoutMs: this.loginTimeoutMs,
      });
      if (login.timedOut) {
        throw new ProviderAuthError('login_timed_out', provider);
      }
      if (login.spawnFailed || login.exitCode !== 0) {
        throw new ProviderAuthError('login_failed', provider);
      }

      // A zero exit alone is not proof of a usable account. Re-probe the vendor
      // client and persist consent only after it independently reports signed in.
      probe = await this.probeRaw(provider);
      if (probe.state !== 'signed_in') {
        throw new ProviderAuthError('login_failed', provider);
      }
    }

    if (probe.state !== 'signed_in') {
      throw new ProviderAuthError('provider_unavailable', provider);
    }
    this.saveConsent(provider, true);
    return { ...withoutBinary(probe), enabled: true };
  }

  async disconnect(providerValue: string): Promise<ProviderAuthStatus> {
    const provider = requireProvider(providerValue);
    this.saveConsent(provider, false);
    const probe = await this.probeRaw(provider);
    return { ...withoutBinary(probe), enabled: false };
  }

  private async probeRaw(provider: ProviderAuthId): Promise<RawProbe> {
    if (provider === 'ollama') return this.probeOllama();

    let env: NodeJS.ProcessEnv;
    let binary: string | null;
    try {
      env = this.buildEnvironment();
      binary = this.resolveBinary(provider, env);
    } catch {
      return {
        provider,
        state: 'error',
        reason: 'probe_failed',
      };
    }

    if (!binary || !path.isAbsolute(binary)) {
      return {
        provider,
        state: 'missing',
        reason: 'executable_missing',
      };
    }

    const result = await this.runSafely({
      executable: binary,
      args: STATUS_ARGS[provider],
      env,
      timeoutMs: this.probeTimeoutMs,
    });
    if (result.spawnFailed || result.timedOut) {
      return {
        provider,
        state: 'error',
        reason: 'probe_failed',
        binary,
      };
    }

    if (provider === 'codex-cli') {
      const state = parseCodexStatus(result);
      if (state === 'account_login_required') {
        return {
          provider,
          state: 'signed_out',
          reason: 'account_login_required',
          binary,
        };
      }
      return state === 'error'
        ? { provider, state, reason: 'probe_failed', binary }
        : { provider, state, binary };
    }

    const state = parseClaudeStatus(result);
    if (state === 'account_login_required') {
      return {
        provider,
        state: 'signed_out',
        reason: 'account_login_required',
        binary,
      };
    }
    return state === 'error'
      ? { provider, state, reason: 'probe_failed', binary }
      : { provider, state, binary };
  }

  private async probeOllama(): Promise<RawProbe> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.ollamaTimeoutMs);
    try {
      const response = await this.fetchImpl(`${normaliseHost(this.ollamaHost())}/api/tags`, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) {
        return { provider: 'ollama', state: 'error', reason: 'probe_failed' };
      }

      const body = await response.json() as unknown;
      if (!hasInstalledOllamaModel(body)) {
        return { provider: 'ollama', state: 'error', reason: 'no_models' };
      }
      return { provider: 'ollama', state: 'local_ready' };
    } catch {
      return { provider: 'ollama', state: 'missing', reason: 'local_unreachable' };
    } finally {
      clearTimeout(timer);
    }
  }

  private async runSafely(command: ProviderCommand): Promise<ProviderCommandResult> {
    try {
      return await this.runCommand(command);
    } catch {
      return {
        exitCode: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        spawnFailed: true,
      };
    }
  }

  private readConsent(): ConsentRead {
    try {
      return { snapshot: this.consentStore.load(), available: true };
    } catch {
      return {
        snapshot: { enabled: new Set(), todayRecaps: new Set() },
        available: false,
      };
    }
  }

  private saveConsent(provider: ProviderAuthId, enabled: boolean): void {
    try {
      this.consentStore.setEnabled(provider, enabled);
    } catch {
      throw new ProviderAuthError('consent_unavailable', provider);
    }
  }

  private withConsent(probe: RawProbe, consent: ConsentRead): ProviderAuthStatus {
    return {
      ...withoutBinary(probe),
      enabled: consent.available && consent.snapshot.enabled.has(probe.provider),
      ...(!consent.available ? { reason: 'consent_unavailable' as const } : {}),
    };
  }
}

/**
 * Production command runner. `spawn` receives an absolute executable and an
 * argument vector directly; no string is interpreted by a shell.
 */
export function runProviderCommand(command: ProviderCommand): Promise<ProviderCommandResult> {
  if (!path.isAbsolute(command.executable)) {
    return Promise.resolve({
      exitCode: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      spawnFailed: true,
    });
  }

  return new Promise((resolve) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command.executable, [...command.args], {
        cwd: os.homedir(),
        env: command.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
      });
    } catch {
      resolve({
        exitCode: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        spawnFailed: true,
      });
      return;
    }
    child.stdin.end();

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result: ProviderCommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // The bounded result still wins if the process exited concurrently.
      }
      finish({
        exitCode: null,
        stdout,
        stderr,
        timedOut: true,
        spawnFailed: false,
      });
    }, command.timeoutMs);

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout = appendBounded(stdout, chunk.toString());
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr = appendBounded(stderr, chunk.toString());
    });
    child.on('error', () => {
      finish({
        exitCode: null,
        stdout,
        stderr,
        timedOut: false,
        spawnFailed: true,
      });
    });
    child.on('close', (code) => {
      finish({
        exitCode: code,
        stdout,
        stderr,
        timedOut: false,
        spawnFailed: false,
      });
    });
  });
}

/**
 * Resolve a vendor command to a real, executable, absolute path.
 *
 * PATH entries must themselves be absolute. Symlinks are resolved before the
 * result is returned, and the final target must be a regular executable file.
 */
export function resolveAbsoluteExecutable(
  command: string,
  env: NodeJS.ProcessEnv = createVendorCliEnv(),
): string | null {
  const candidates: string[] = [];
  if (path.isAbsolute(command)) {
    candidates.push(command);
  } else if (!command.includes('/') && !command.includes('\\')) {
    for (const dir of (env['PATH'] ?? '').split(path.delimiter)) {
      if (path.isAbsolute(dir)) candidates.push(path.join(dir, command));
    }
  } else {
    return null;
  }

  for (const candidate of candidates) {
    try {
      const absolute = fs.realpathSync(candidate);
      const stat = fs.statSync(absolute);
      if (!path.isAbsolute(absolute) || !stat.isFile()) continue;
      fs.accessSync(absolute, fs.constants.X_OK);
      return absolute;
    } catch {
      continue;
    }
  }
  return null;
}

export const defaultProviderBinaryResolver: ProviderBinaryResolver = (provider, env) => {
  const command = provider === 'codex-cli' ? resolveCodexBinary(env) : 'claude';
  if (!command) return null;
  return resolveAbsoluteExecutable(command, env);
};

function parseCodexStatus(
  result: Pick<ProviderCommandResult, 'exitCode' | 'stdout' | 'stderr'>,
): 'signed_in' | 'signed_out' | 'account_login_required' | 'error' {
  const output = `${result.stdout}\n${result.stderr}`;
  if (/\bnot (?:logged|signed) in\b/i.test(output)) return 'signed_out';
  if (/\b(?:using|with) an api key\b/i.test(output)) {
    return 'account_login_required';
  }
  if (
    result.exitCode === 0 &&
    /\b(?:logged|signed) in (?:using|with) chatgpt\b/i.test(output)
  ) {
    return 'signed_in';
  }
  return 'error';
}

function parseClaudeStatus(
  result: Pick<ProviderCommandResult, 'exitCode' | 'stdout'>,
): 'signed_in' | 'signed_out' | 'account_login_required' | 'error' {
  let value: unknown;
  try {
    value = JSON.parse(result.stdout.trim());
  } catch {
    return 'error';
  }
  if (!isRecord(value) || typeof value['loggedIn'] !== 'boolean') return 'error';
  if (value['loggedIn'] === false) return 'signed_out';
  if (
    result.exitCode === 0 &&
    typeof value['authMethod'] === 'string' &&
    value['authMethod'].toLowerCase() === 'claude.ai'
  ) {
    return 'signed_in';
  }
  return result.exitCode === 0 ? 'account_login_required' : 'error';
}

function hasInstalledOllamaModel(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value['models'])) return false;
  return value['models'].some(
    (model) =>
      isRecord(model) &&
      ((typeof model['name'] === 'string' && model['name'].trim().length > 0) ||
        (typeof model['model'] === 'string' && model['model'].trim().length > 0)),
  );
}

function defaultOllamaHost(): string {
  return process.env['OLLAMA_HOST']?.trim() || DEFAULT_OLLAMA_HOST;
}

function normaliseHost(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return DEFAULT_OLLAMA_HOST;
    return url.toString().replace(/\/+$/, '');
  } catch {
    return DEFAULT_OLLAMA_HOST;
  }
}

function requireProvider(value: string): ProviderAuthId {
  if (!isProviderAuthId(value)) throw new ProviderAuthError('invalid_provider');
  return value;
}

function withoutBinary(probe: RawProbe): Omit<RawProbe, 'binary'> {
  const { binary: _binary, ...safe } = probe;
  return safe;
}

function appendBounded(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length <= MAX_COMMAND_OUTPUT_BYTES
    ? next
    : next.slice(-MAX_COMMAND_OUTPUT_BYTES);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
