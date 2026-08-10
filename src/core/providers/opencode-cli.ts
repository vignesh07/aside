import { execFile, spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { OBSERVER_CWD } from './claude-session.js';
import type { CompletionRequest, Provider } from './types.js';
import { createVendorCliEnv } from './vendor-cli-env.js';

// OpenCode's isolation switches are not yet a versioned public API. Keep this
// list explicit: a future CLI must be source-audited before Aside is willing to
// send it transcript context.
const AUDITED_VERSION = '1.18.15';
const AUDITED_VERSION_LABEL = AUDITED_VERSION;
// Source-audited from BUNDLED_PROVIDERS plus the embedded model/plugin data in
// OpenCode v1.18.15. Package pinning alone is insufficient: a generic SDK can
// send to any URL. Every route must match this provider/package/route-metadata
// matrix, together with exact-version built-in behavior. Empty URLs mean the
// audited bundled SDK's fixed default route. OAuth and well-known credentials
// are excluded in this release. Providers whose built-ins can derive an
// endpoint from mutable auth metadata (for example Copilot Enterprise) are
// deliberately excluded because verbose model metadata cannot attest the actual
// destination.
const AUDITED_ROUTE_MATRIX: Readonly<
  Record<string, readonly { npm: string; urls: readonly string[] }[]>
> = {
  openai: [{ npm: '@ai-sdk/openai', urls: ['', 'https://api.openai.com/v1'] }],
  anthropic: [{ npm: '@ai-sdk/anthropic', urls: ['', 'https://api.anthropic.com/v1'] }],
  openrouter: [{ npm: '@openrouter/ai-sdk-provider', urls: ['https://openrouter.ai/api/v1'] }],
  opencode: [
    { npm: '@ai-sdk/openai-compatible', urls: ['https://opencode.ai/zen/v1'] },
    { npm: '@ai-sdk/openai', urls: ['https://opencode.ai/zen/v1'] },
    { npm: '@ai-sdk/anthropic', urls: ['https://opencode.ai/zen/v1'] },
    { npm: '@ai-sdk/google', urls: ['https://opencode.ai/zen/v1'] },
  ],
};
const OBSERVER_AGENT = 'aside-observer';
const OBSERVER_TITLE = 'Aside observer';
const PROBE_TIMEOUT_MS = 2_500;
const INSPECTION_TIMEOUT_MS = 15_000;
const ANSWER_TIMEOUT_MS = 180_000;
const TERMINATION_GRACE_MS = 1_000;
const PREPARE_CACHE_MS = 2_000;
const INSPECTION_CACHE_MS = 1_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_INSPECTION_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_AUTH_BYTES = 4 * 1024 * 1024;
const MAX_ERROR_LENGTH = 400;
const RUNTIME_MARKER = '.aside-runtime.json';
const RUNTIME_NAME_PATTERN = /^(?:\.aside-runtime-|aside-opencode-)[A-Za-z0-9]{6}$/;
const QUARANTINE_NAME_PATTERN = /^\.aside-quarantine-[a-f0-9]{24}$/;
const OPENCODE_GITIGNORE = [
  'node_modules',
  'package.json',
  'package-lock.json',
  'bun.lock',
  '.gitignore',
].join('\n');

const DEFAULT_OBSERVER_PROMPT =
  'You are Aside, a read-only observer. Answer only from the supplied context. ' +
  'You have no tools and cannot act on the user’s machine.';

export interface OpenCodeConfiguredModel {
  provider: string;
  id: string;
  name: string;
}

export interface OpenCodeInspection {
  state:
    | 'missing'
    | 'unsupported'
    | 'auth_unsupported'
    | 'unconfigured'
    | 'routes_unsupported'
    | 'ready'
    | 'error';
  models?: OpenCodeConfiguredModel[];
}

export interface OpenCodeInspectionOptions {
  /** Credential-backed model discovery is allowed only after explicit consent. */
  includeModels?: boolean;
}

interface PromiseCacheEntry<T> {
  pending: boolean;
  expiresAt: number;
  value: Promise<T>;
}

interface RankedCandidate {
  binary: string;
  version: readonly [number, number, number] | null;
  identity: FileIdentity;
  digest: string;
  staged: StagedExecutable;
  order: number;
}

interface CandidateScan {
  candidates: RankedCandidate[];
  compatible?: RankedCandidate;
}

type PreparedOpenCode =
  | { state: 'missing' | 'unsupported' | 'error' }
  | {
      state: 'ready';
      binary: string;
      binaryIdentity: FileIdentity;
      binaryDigest: string;
      staged: StagedExecutable;
      sourceEnv: NodeJS.ProcessEnv;
    };

interface FileIdentity {
  path: string;
  dev: number;
  ino: number;
  size: number;
  mode: number;
  uid: number;
  mtimeMs: number;
  ctimeMs: number;
}

interface ExecutionBoundary {
  binary: FileIdentity;
  binaryDigest: string;
  staged: StagedExecutable;
  auth: FileIdentity | null;
  authDigest: string | null;
  authPath: string;
}

type OpenCodeAuthKind = 'oauth' | 'api' | 'wellknown';

interface OpenCodeAuthPolicy {
  allowed: Set<string>;
  unsafe: Set<string>;
}

interface StagedExecutable {
  digest: string;
  identity: FileIdentity;
  directory: RuntimeNodeIdentity;
}

interface RuntimeNodeIdentity {
  dev: number;
  ino: number;
  uid: number;
}

interface RuntimeCleanupIdentity {
  root: RuntimeNodeIdentity;
  config?: RuntimeNodeIdentity;
  xdgConfig?: RuntimeNodeIdentity;
  globalConfig?: RuntimeNodeIdentity;
  data?: RuntimeNodeIdentity;
  authDirectory?: RuntimeNodeIdentity;
  authBridge?: RuntimeNodeIdentity;
}

interface IsolatedRuntime {
  root: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  authIdentity: FileIdentity | null;
  authBridgePath?: string;
  binary?: string;
  binaryIdentity?: FileIdentity;
  cleanup: RuntimeCleanupIdentity;
}

interface CommandResult {
  stdout: string;
  stderr: string;
  error?: Error;
}

const preparedCache = new Map<string, PromiseCacheEntry<PreparedOpenCode>>();
const inspectionCache = new Map<string, PromiseCacheEntry<OpenCodeInspection>>();
const sweptRuntimeParents = new Set<string>();
const liveRuntimeRoots = new Set<string>();
const stagedExecutableCache = new Map<string, StagedExecutable>();

/** Locate a compatible OpenCode executable without importing shell credentials. */
export async function resolveOpenCodeBinary(
  sourceEnv: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const env = createVendorCliEnv(sourceEnv);
  const scan = await scanCandidates(env);
  return scan.compatible?.binary ?? null;
}

/**
 * Ask the audited OpenCode client which exact provider/model routes are
 * available. Credential-backed discovery must be explicitly enabled by the
 * caller after user consent.
 */
export async function inspectOpenCode(
  sourceEnv: NodeJS.ProcessEnv = process.env,
  options: OpenCodeInspectionOptions = {},
): Promise<OpenCodeInspection> {
  const prepared = await prepareOpenCode(sourceEnv);
  if (prepared.state !== 'ready') return { state: prepared.state };
  if (options.includeModels !== true) {
    return (await isStillAuditedBinary(prepared))
      ? { state: 'ready' }
      : { state: 'unsupported' };
  }
  const key = `${openCodeCacheKey(prepared.sourceEnv)}\u0000${prepared.binary}`;
  return cachedPromise(
    inspectionCache,
    key,
    INSPECTION_CACHE_MS,
    async () => {
      const boundary = await createExecutionBoundary(prepared);
      return boundary
        ? inspectPreparedOpenCode(prepared, boundary)
        : { state: 'error' };
    },
  );
}

/** Return the exact model routes OpenCode says are currently available. */
export async function listConfiguredOpenCodeModels(
  sourceEnv: NodeJS.ProcessEnv = process.env,
): Promise<OpenCodeConfiguredModel[]> {
  const inspection = await inspectOpenCode(sourceEnv, { includeModels: true });
  return inspection.state === 'ready' ? [...(inspection.models ?? [])] : [];
}

/**
 * Build the fixed, non-interactive OpenCode command for one exact model route.
 * The role, transcript, history, and question are deliberately absent from
 * argv; the audited OpenCode 1.18.15 release reads scoped user content from
 * stdin and the observer role from its isolated config.
 */
export function openCodeObserverArgs(model: string): string[] {
  const selected = splitConfiguredModel(model);
  return [
    'run',
    '--format',
    'json',
    '--model',
    `${selected.provider}/${selected.id}`,
    '--agent',
    OBSERVER_AGENT,
    '--title',
    OBSERVER_TITLE,
    '--pure',
  ];
}

export const openCodeCli: Provider = {
  id: 'opencode-cli',
  label: 'OpenCode (available models)',
  apiKeyEnv: [],
  requiresApiKey: false,
  // OpenCode owns this dynamic catalog. listConfiguredOpenCodeModels() supplies
  // only routes that pass Aside's static route-metadata matrix plus the
  // exact-version built-in behavior audit.
  models: [],
  complete: askOpenCode,
};

async function askOpenCode(req: CompletionRequest): Promise<string> {
  const prepared = await prepareOpenCode(process.env);
  if (prepared.state === 'missing') {
    throw new Error('opencode-cli: OpenCode was not found. Install OpenCode first.');
  }
  if (prepared.state === 'unsupported') {
    throw new Error(
      `opencode-cli: Aside currently supports the audited OpenCode release ${AUDITED_VERSION_LABEL}.`,
    );
  }
  if (prepared.state !== 'ready') {
    throw new Error('opencode-cli: Aside could not inspect OpenCode safely.');
  }

  const boundary = await createExecutionBoundary(prepared);
  if (!boundary) {
    throw new Error(
      'opencode-cli: OpenCode changed while Aside was preparing the request. Refresh Accounts and try again.',
    );
  }

  // The target saved on an Aside thread is a routing and privacy boundary. Do
  // one uncached inspection immediately before sending transcript context so a
  // stale picker entry can never silently fall back to another provider.
  const expected = splitConfiguredModel(req.model);
  const selectedAuth = selectedOpenCodeAuthKind(boundary, expected.provider);
  if (selectedAuth === 'oauth' || selectedAuth === 'wellknown') {
    throw new Error(
      `opencode-cli: ${expected.provider} uses ${selectedAuth === 'oauth' ? 'OAuth' : 'remotely discovered'} ` +
        'OpenCode credentials, which are not supported by this safety contract.',
    );
  }
  if (selectedAuth === null && expected.provider !== 'opencode') {
    throw new Error(
      `opencode-cli: ${expected.provider} does not have an API credential available to Aside through OpenCode.`,
    );
  }
  const inspection = await inspectPreparedOpenCode(prepared, boundary);
  if (inspection.state === 'unconfigured') {
    throw new Error(
      'opencode-cli: OpenCode reports no available models. Configure a model provider in OpenCode first.',
    );
  }
  if (inspection.state === 'auth_unsupported') {
    throw new Error(
      'opencode-cli: OAuth and remotely discovered OpenCode credentials are not supported by this safety contract.',
    );
  }
  if (inspection.state !== 'ready' || !inspection.models) {
    throw new Error('opencode-cli: Aside could not verify OpenCode’s available models safely.');
  }
  if (!inspection.models.some((model) => modelKey(model) === modelKey(expected))) {
    throw new Error(
      `opencode-cli: this thread is pinned to ${expected.provider}/${expected.id}, but that model ` +
        'is no longer available through OpenCode. Refresh Accounts and choose another OpenCode model.',
    );
  }
  if (!(await isStillAuditedBinary(prepared)) || !executionBoundaryMatches(boundary)) {
    throw new Error(
      'opencode-cli: OpenCode changed while Aside was preparing the request. Refresh Accounts and try again.',
    );
  }

  const prompt = [req.context, req.history, `Question: ${req.question}`]
    .filter(Boolean)
    .join('\n\n');
  return runPrompt(
    prepared.binary,
    openCodeObserverArgs(req.model),
    prepared.sourceEnv,
    prompt,
    req.systemPrompt,
    req.signal,
    boundary,
    expected.provider,
  );
}

async function isStillAuditedBinary(
  prepared: Extract<PreparedOpenCode, { state: 'ready' }>,
): Promise<boolean> {
  if (
    !fileIdentityMatches(prepared.binaryIdentity) ||
    !stagedExecutableMatches(prepared.staged)
  ) return false;
  const output = await runProbe(
    prepared.staged.identity.path,
    ['--version'],
    prepared.sourceEnv,
    prepared.staged.identity,
  );
  return output !== null && isAuditedVersion(parseVersion(output));
}

async function createExecutionBoundary(
  prepared: Extract<PreparedOpenCode, { state: 'ready' }>,
): Promise<ExecutionBoundary | null> {
  if (!(await isStillAuditedBinary(prepared))) return null;
  try {
    const auth = captureOpenCodeAuthIdentity(prepared.sourceEnv);
    const authDigest = auth ? digestVerifiedFile(auth) : null;
    if (auth && !authDigest) return null;
    if (
      !fileIdentityMatches(prepared.binaryIdentity) ||
      !stagedExecutableMatches(prepared.staged)
    ) return null;
    return {
      binary: prepared.binaryIdentity,
      binaryDigest: prepared.binaryDigest,
      staged: prepared.staged,
      auth,
      authDigest,
      authPath: openCodeAuthPath(prepared.sourceEnv),
    };
  } catch {
    return null;
  }
}

async function prepareOpenCode(sourceEnv: NodeJS.ProcessEnv): Promise<PreparedOpenCode> {
  const env = createVendorCliEnv(sourceEnv);
  try {
    sweepStaleOpenCodeRuntimes(env);
  } catch {
    return { state: 'error' };
  }
  const key = openCodeCacheKey(env);
  return cachedPromise(
    preparedCache,
    key,
    PREPARE_CACHE_MS,
    () => prepareOpenCodeUncached(env),
  );
}

async function prepareOpenCodeUncached(
  sourceEnv: NodeJS.ProcessEnv,
): Promise<PreparedOpenCode> {
  try {
    const scan = await scanCandidates(sourceEnv);
    if (scan.compatible) {
      return {
        state: 'ready',
        binary: scan.compatible.binary,
        binaryIdentity: scan.compatible.identity,
        binaryDigest: scan.compatible.digest,
        staged: scan.compatible.staged,
        sourceEnv,
      };
    }
    return scan.candidates.length === 0 ? { state: 'missing' } : { state: 'unsupported' };
  } catch {
    return { state: 'error' };
  }
}

async function scanCandidates(sourceEnv: NodeJS.ProcessEnv): Promise<CandidateScan> {
  const candidates = new Set<string>();
  for (const directory of (sourceEnv['PATH'] ?? '').split(path.delimiter)) {
    if (path.isAbsolute(directory)) candidates.add(path.join(directory, 'opencode'));
  }

  candidates.add('/opt/homebrew/bin/opencode');
  candidates.add('/usr/local/bin/opencode');
  const home = sourceEnv['HOME'] || sourceEnv['USERPROFILE'] || os.homedir();
  candidates.add(path.join(home, '.opencode', 'bin', 'opencode'));
  candidates.add(path.join(home, '.local', 'bin', 'opencode'));
  candidates.add(path.join(home, '.npm-global', 'bin', 'opencode'));
  candidates.add(path.join(home, '.bun', 'bin', 'opencode'));

  const versions = await Promise.all(
    [...candidates].map(async (binary, order): Promise<RankedCandidate | null> => {
      try {
        fs.accessSync(binary, fs.constants.X_OK);
        const identity = captureBinaryIdentity(binary);
        if (!identity) return null;
        const digest = digestVerifiedFile(identity);
        if (!digest) return null;
        const staged = stageCandidateExecutable(identity, digest, sourceEnv);
        const output = await runProbe(
          staged.identity.path,
          ['--version'],
          sourceEnv,
          staged.identity,
        );
        return {
          binary: identity.path,
          version: output === null ? null : parseVersion(output),
          identity,
          digest,
          staged,
          order,
        };
      } catch {
        return null;
      }
    }),
  );
  const seenBinaries = new Set<string>();
  const ranked = versions
    .filter((candidate): candidate is RankedCandidate => {
      if (candidate === null) return false;
      if (seenBinaries.has(candidate.binary)) {
        discardCandidateExecutable(candidate.staged);
        return false;
      }
      seenBinaries.add(candidate.binary);
      return true;
    })
    .sort((a, b) => compareVersions(b.version, a.version) || a.order - b.order);

  for (const candidate of ranked) {
    if (!isAuditedVersion(candidate.version)) continue;
    const [globalHelp, runHelp, modelsHelp] = await Promise.all([
      runProbe(candidate.staged.identity.path, ['--help'], sourceEnv, candidate.staged.identity),
      runProbe(candidate.staged.identity.path, ['run', '--help'], sourceEnv, candidate.staged.identity),
      runProbe(candidate.staged.identity.path, ['models', '--help'], sourceEnv, candidate.staged.identity),
    ]);
    if (
      globalHelp?.includes('--pure') &&
      runHelp?.includes('--format') &&
      runHelp.includes('--model') &&
      runHelp.includes('--agent') &&
      runHelp.includes('--title') &&
      modelsHelp?.includes('--verbose') &&
      fileIdentityMatches(candidate.identity) &&
      stagedExecutableMatches(candidate.staged)
    ) {
      const staged = publishStagedExecutable(candidate.staged, candidate.identity.size);
      for (const other of ranked) {
        if (other !== candidate) discardCandidateExecutable(other.staged);
      }
      return { candidates: ranked, compatible: { ...candidate, staged } };
    }
  }
  for (const candidate of ranked) discardCandidateExecutable(candidate.staged);
  return { candidates: ranked };
}

async function inspectPreparedOpenCode(
  prepared: Extract<PreparedOpenCode, { state: 'ready' }>,
  boundary: ExecutionBoundary,
): Promise<OpenCodeInspection> {
  if (!executionBoundaryMatches(boundary)) return { state: 'error' };
  const result = await runCommand(
    prepared.binary,
    ['models', '--verbose', '--pure'],
    prepared.sourceEnv,
    INSPECTION_TIMEOUT_MS,
    true,
    boundary,
    MAX_INSPECTION_OUTPUT_BYTES,
  );
  if (result.error) {
    const output = `${result.stderr}\n${result.stdout}`;
    if (/no (?:configured )?providers?|no models?|not (?:logged|signed) in|authenticate|login/i.test(output)) {
      return { state: 'unconfigured' };
    }
    return { state: 'error' };
  }

  const projected = projectModels(result.stdout);
  if (!projected) return { state: 'error' };
  let policy: OpenCodeAuthPolicy;
  try {
    policy = openCodeAuthPolicy(boundary);
  } catch {
    return { state: 'error' };
  }
  const models = projected.models.filter((model) => policy.allowed.has(model.provider));
  if (models.length > 0) return { state: 'ready', models };
  if (projected.models.some((model) => policy.unsafe.has(model.provider))) {
    return { state: 'auth_unsupported' };
  }
  return projected.total > 0
    ? { state: 'routes_unsupported' }
    : { state: 'unconfigured' };
}

function projectModels(
  output: string,
): { models: OpenCodeConfiguredModel[]; total: number } | null {
  const models: OpenCodeConfiguredModel[] = [];
  const keys = new Set<string>();
  const records = parseVerboseModelRecords(output);
  if (!records) return null;
  for (const record of records) {
    const line = record.route;
    let selected: { provider: string; id: string };
    try {
      selected = splitConfiguredModel(line);
    } catch {
      return null;
    }
    const metadata = asRecord(record.metadata);
    const api = asRecord(metadata?.['api']);
    if (
      metadata?.['providerID'] !== selected.provider ||
      metadata?.['id'] !== selected.id ||
      typeof api?.['npm'] !== 'string' ||
      typeof api['url'] !== 'string'
    ) return null;
    if (!isAuditedRoute(selected.provider, api['npm'], api['url'])) continue;
    const key = modelKey(selected);
    if (keys.has(key)) continue;
    keys.add(key);
    models.push({
      ...selected,
      name: boundedText(metadata?.['name'], 300) ?? selected.id,
    });
  }
  return { models, total: records.length };
}

function isAuditedRoute(provider: string, npm: string, url: string): boolean {
  return (AUDITED_ROUTE_MATRIX[provider] ?? []).some(
    (route) => route.npm === npm && route.urls.includes(url),
  );
}

interface VerboseModelRecord {
  route: string;
  metadata: unknown;
}

/** Parse the exact route + pretty-printed JSON record contract of v1.18.15. */
function parseVerboseModelRecords(output: string): VerboseModelRecord[] | null {
  const records: VerboseModelRecord[] = [];
  let index = 0;
  while (index < output.length) {
    while (index < output.length && /\s/.test(output[index]!)) index += 1;
    if (index >= output.length) break;
    const routeEnd = output.indexOf('\n', index);
    if (routeEnd < 0) return null;
    const route = output.slice(index, routeEnd).replace(/\r$/, '').trim();
    if (!route || route.startsWith('{')) return null;
    index = routeEnd + 1;
    while (index < output.length && /[\r\n]/.test(output[index]!)) index += 1;
    if (output[index] !== '{') return null;
    const jsonEnd = findJsonObjectEnd(output, index);
    if (jsonEnd < 0) return null;
    try {
      records.push({ route, metadata: JSON.parse(output.slice(index, jsonEnd)) });
    } catch {
      return null;
    }
    index = jsonEnd;
  }
  return records;
}

function findJsonObjectEnd(value: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const character = value[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '{') depth += 1;
    if (character === '}') {
      depth -= 1;
      if (depth === 0) return index + 1;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

function runProbe(
  binary: string,
  args: string[],
  sourceEnv: NodeJS.ProcessEnv,
  binaryIdentity?: FileIdentity,
): Promise<string | null> {
  if (binaryIdentity && !fileIdentityMatches(binaryIdentity)) {
    return Promise.resolve(null);
  }
  return runCommand(
    binary,
    args,
    sourceEnv,
    PROBE_TIMEOUT_MS,
    false,
    undefined,
  )
    .then((result) => {
      if (binaryIdentity && !fileIdentityMatches(binaryIdentity)) return null;
      return result.error ? null : combineOutput(result.stdout, result.stderr);
    })
    .catch(() => null);
}

function runCommand(
  binary: string,
  args: string[],
  sourceEnv: NodeJS.ProcessEnv,
  timeout: number,
  allowAuthentication: boolean,
  boundary?: ExecutionBoundary,
  maxOutputBytes = MAX_OUTPUT_BYTES,
): Promise<CommandResult> {
  let runtime: IsolatedRuntime | undefined;
  try {
    if (boundary && !fileIdentityMatches(boundary.binary)) {
      throw new Error('opencode-cli: OpenCode changed before the command started.');
    }
    runtime = createIsolatedRuntime(
      sourceEnv,
      allowAuthentication,
      DEFAULT_OBSERVER_PROMPT,
      boundary,
    );
    if (boundary && !executionBoundaryMatches(boundary, runtime)) {
      throw new Error('opencode-cli: OpenCode changed before the command started.');
    }
  } catch (error) {
    const cleanupError = runtime ? removeRuntime(runtime.root, runtime.cleanup) : undefined;
    return Promise.resolve({ stdout: '', stderr: '', error: cleanupError ?? asError(error) });
  }
  const activeRuntime = runtime;
  return new Promise((resolve) => {
    execFile(
      activeRuntime.binary ?? binary,
      args,
      {
        cwd: activeRuntime.cwd,
        env: activeRuntime.env,
        encoding: 'utf8',
        timeout,
        // A CLI that ignores SIGTERM must not hold startup or account refresh
        // open forever.
        killSignal: 'SIGKILL',
        maxBuffer: maxOutputBytes,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const boundaryChanged = boundary && !executionBoundaryMatches(
          boundary,
          activeRuntime,
        );
        const cleanupError = removeRuntime(activeRuntime.root, activeRuntime.cleanup);
        resolve({
          stdout,
          stderr,
          ...(cleanupError
            ? { error: cleanupError }
            : boundaryChanged
            ? { error: new Error('opencode-cli: OpenCode changed while the command was running.') }
            : error
              ? { error }
              : {}),
        });
      },
    );
  });
}

function runPrompt(
  binary: string,
  args: string[],
  sourceEnv: NodeJS.ProcessEnv,
  prompt: string,
  systemPrompt: string,
  signal?: AbortSignal,
  boundary?: ExecutionBoundary,
  selectedProvider?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('opencode-cli: request aborted.'));
      return;
    }

    if (!boundary || !executionBoundaryMatches(boundary)) {
      reject(new Error('opencode-cli: OpenCode changed before the request started.'));
      return;
    }
    let runtime: IsolatedRuntime | undefined;
    try {
      runtime = createIsolatedRuntime(
        sourceEnv,
        true,
        systemPrompt,
        boundary,
        selectedProvider,
      );
      if (!executionBoundaryMatches(boundary, runtime)) {
        throw new Error('opencode-cli: OpenCode changed before the request started.');
      }
    } catch (error) {
      const cleanupError = runtime ? removeRuntime(runtime.root, runtime.cleanup) : undefined;
      reject(cleanupError ?? asError(error));
      return;
    }
    const activeRuntime = runtime;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(activeRuntime.binary ?? binary, args, {
        cwd: activeRuntime.cwd,
        env: activeRuntime.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      const cleanupError = removeRuntime(activeRuntime.root, activeRuntime.cleanup);
      reject(cleanupError ?? explainProcessFailure(asError(error), ''));
      return;
    }

    const decoder = new StringDecoder('utf8');
    let buffer = '';
    let stderr = '';
    let outputBytes = 0;
    const textParts: string[] = [];
    let terminalError: Error | undefined;
    let settled = false;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      const cleanupError = removeRuntime(activeRuntime.root, activeRuntime.cleanup);
      if (cleanupError) error = cleanupError;
      if (error) {
        reject(error);
        return;
      }
      const answer = textParts.join('\n').trim();
      if (!answer) {
        reject(new Error('opencode-cli: OpenCode returned no text response.'));
        return;
      }
      resolve(answer);
    };
    const stop = (error: Error) => {
      terminalError ??= error;
      if (!child.stdin.destroyed) child.stdin.destroy();
      terminateWithEscalation(child);
    };
    const consumeEvent = (value: unknown) => {
      const event = asRecord(value);
      if (!event) {
        stop(new Error('opencode-cli: OpenCode returned an invalid observer event.'));
        return;
      }
      if (event['type'] === 'text') {
        const part = asRecord(event['part']);
        if (part?.['type'] === 'text' && typeof part['text'] === 'string') {
          textParts.push(part['text']);
          return;
        }
        stop(new Error('opencode-cli: OpenCode returned an invalid text event.'));
        return;
      }
      if (event['type'] === 'tool_use') {
        stop(new Error('opencode-cli: OpenCode attempted a tool in read-only observer mode.'));
        return;
      }
      if (event['type'] === 'error') {
        stop(new Error(`opencode-cli: ${safeEventError(event['error'])}`));
        return;
      }
      if (event['type'] === 'step_start' || event['type'] === 'step_finish') return;
      stop(new Error('opencode-cli: OpenCode returned an unknown observer event.'));
    };
    const abort = () => stop(new Error('opencode-cli: request aborted.'));
    const timer = setTimeout(() => {
      stop(new Error(`opencode-cli: timed out after ${ANSWER_TIMEOUT_MS / 1000}s.`));
    }, ANSWER_TIMEOUT_MS);

    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        stop(new Error('opencode-cli: response exceeded the safe output limit.'));
        return;
      }
      buffer += decoder.write(chunk);
      buffer = consumeJsonLines(buffer, consumeEvent, stop);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      stderr = (stderr + chunk.toString()).slice(-8_000);
      if (outputBytes > MAX_OUTPUT_BYTES) {
        stop(new Error('opencode-cli: response exceeded the safe output limit.'));
      }
    });
    child.on('error', (error) => finish(explainProcessFailure(error, stderr)));
    child.on('close', (code) => {
      buffer += decoder.end();
      if (buffer) consumeJsonLines(`${buffer}\n`, consumeEvent, stop);
      if (terminalError) {
        finish(terminalError);
        return;
      }
      if (!executionBoundaryMatches(boundary, activeRuntime)) {
        finish(new Error('opencode-cli: OpenCode changed while the request was running.'));
        return;
      }
      if (code !== 0) {
        finish(new Error(`opencode-cli: ${safeError(stderr || `provider stopped with exit ${code ?? 'unknown'}`)}`));
        return;
      }
      finish();
    });
    child.stdin.on('error', (error) => {
      if (!terminalError) stop(explainProcessFailure(error, stderr));
    });

    // end(), rather than write(), is important: OpenCode waits for EOF before
    // resolving piped input. No transcript, history, or question is ever
    // placed in argv or env; only the static observer role enters config.
    child.stdin.end(prompt);
  });
}

function createIsolatedRuntime(
  sourceEnv: NodeJS.ProcessEnv,
  allowAuthentication: boolean,
  systemPrompt = DEFAULT_OBSERVER_PROMPT,
  boundary?: ExecutionBoundary,
  selectedProvider?: string,
): IsolatedRuntime {
  assertNoManagedOpenCodeConfig(sourceEnv);
  fs.mkdirSync(OBSERVER_CWD, { recursive: true });
  const authIdentity = allowAuthentication
    ? captureOpenCodeAuthIdentity(sourceEnv)
    : null;
  if (boundary && !sameAuthState(authIdentity, boundary.auth)) {
    throw new Error('opencode-cli: OpenCode authentication changed before the command started.');
  }
  const rootParent = authIdentity ? path.dirname(authIdentity.path) : os.tmpdir();
  const rootPrefix = authIdentity ? '.aside-runtime-' : 'aside-opencode-';
  const root = fs.mkdtempSync(path.join(rootParent, rootPrefix));
  const cleanup: RuntimeCleanupIdentity = {
    root: captureRuntimeDirectoryIdentity(root),
  };
  try {
    liveRuntimeRoots.add(root);
    const cwd = path.join(root, 'cwd');
    const config = path.join(root, 'config');
    const xdgConfig = path.join(root, 'xdg-config');
    const globalConfig = path.join(xdgConfig, 'opencode');
    const cache = path.join(root, 'cache');
    const state = path.join(root, 'state');
    const temporary = path.join(root, 'tmp');
    const home = path.join(root, 'home');
    const appData = path.join(root, 'app-data');
    const localAppData = path.join(root, 'local-app-data');
    const data = path.join(root, 'data');
    const managed = path.join(root, 'managed');
    for (const directory of [
      cwd,
      config,
      xdgConfig,
      globalConfig,
      cache,
      state,
      temporary,
      home,
      appData,
      localAppData,
      data,
      managed,
    ]) {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    cleanup.config = captureRuntimeDirectoryIdentity(config);
    cleanup.xdgConfig = captureRuntimeDirectoryIdentity(xdgConfig);
    cleanup.globalConfig = captureRuntimeDirectoryIdentity(globalConfig);
    cleanup.data = captureRuntimeDirectoryIdentity(data);
    const authBridgePath = authIdentity
      ? path.join(data, 'opencode', 'auth.json')
      : undefined;
    if (authIdentity) {
      const authDirectory = path.dirname(authBridgePath!);
      fs.mkdirSync(authDirectory, { mode: 0o700 });
      cleanup.authDirectory = captureRuntimeDirectoryIdentity(authDirectory);
      const descriptor = fs.openSync(
        authBridgePath!,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
        0o600,
      );
      fs.closeSync(descriptor);
      const emptySnapshot = captureRegularFileIdentity(authBridgePath!);
      if (!emptySnapshot) throw new Error('opencode-cli: could not create private auth snapshot.');
      cleanup.authBridge = runtimeIdentityFromFile(emptySnapshot);
    }

    // Persist creation-time provenance before any directory is sealed or any
    // credential snapshot is populated. A later process can therefore verify the
    // exact runtime inode and every sensitive cleanup target before mutation.
    fs.writeFileSync(
      path.join(root, RUNTIME_MARKER),
      JSON.stringify({ version: 2, pid: process.pid, cleanup }),
      { encoding: 'utf8', mode: 0o600 },
    );
    // v1.18.15 still walks upward for Git metadata even when project config is
    // disabled. A nearest invalid repository sentinel prevents an unusual
    // TMPDIR nested under a real repository from escaping the sterile cwd.
    fs.mkdirSync(path.join(cwd, '.git'), { mode: 0o500 });
    sealOpenCodeConfigDirectory(config);
    sealOpenCodeConfigDirectory(globalConfig);

    if (allowAuthentication && authIdentity && authBridgePath) {
      if (!boundary?.authDigest) {
        throw new Error('opencode-cli: auth snapshot boundary is missing.');
      }
      snapshotOpenCodeAuth(
        sourceEnv,
        authBridgePath,
        authIdentity,
        boundary.authDigest,
        cleanup.authBridge!,
        selectedProvider,
      );
    }
    const stagedBinary = boundary?.staged;
    if (stagedBinary && !stagedExecutableMatches(stagedBinary)) {
      throw new Error('opencode-cli: staged OpenCode executable changed.');
    }

    const env: NodeJS.ProcessEnv = {
      ...createVendorCliEnv(sourceEnv),
      // OpenCode also searches ~/.opencode independently of project config.
      // A sterile home closes that ambient prompt/plugin/skill path.
      HOME: home,
      USERPROFILE: home,
      APPDATA: appData,
      LOCALAPPDATA: localAppData,
      XDG_CONFIG_HOME: xdgConfig,
      XDG_CACHE_HOME: cache,
      XDG_DATA_HOME: data,
      XDG_STATE_HOME: state,
      TMPDIR: temporary,
      TMP: temporary,
      TEMP: temporary,
      OPENCODE_CONFIG_DIR: config,
      OPENCODE_CONFIG_CONTENT: observerConfig(systemPrompt),
      // Exact v1.18.15 supports this test hook. Redirecting it is defense in
      // depth after assertNoManagedOpenCodeConfig() has already failed closed on
      // any actual machine policy.
      OPENCODE_TEST_MANAGED_CONFIG_DIR: managed,
      OPENCODE_PERMISSION: JSON.stringify({ '*': 'deny' }),
      OPENCODE_DB: ':memory:',
      OPENCODE_PURE: '1',
      // Keep exact-1.18.15 built-ins available for fixed API credentials.
      // Refreshable OAuth/well-known credentials are rejected before this
      // runtime is used. User/external plugins remain disabled by --pure.
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      OPENCODE_DISABLE_CLAUDE_CODE: '1',
      OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
      OPENCODE_DISABLE_EMBEDDED_WEB_UI: '1',
      OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_DISABLE_SHARE: '1',
      OPENCODE_DISABLE_MODELS_FETCH: '1',
      OPENCODE_DISABLE_TERMINAL_TITLE: '1',
      OPENCODE_DISABLE_PRUNE: '1',
      OPENCODE_DISABLE_AUTOCOMPACT: '1',
      OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: '1',
      OPENCODE_LOG_LEVEL: 'ERROR',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      TERM: 'dumb',
      CI: '1',
    };
    return {
      root,
      cwd,
      env,
      authIdentity,
      authBridgePath,
      binary: stagedBinary?.identity.path,
      binaryIdentity: stagedBinary?.identity,
      cleanup,
    };
  } catch (error) {
    throw removeRuntime(root, cleanup) ?? error;
  }
}

function sealOpenCodeConfigDirectory(directory: string): void {
  // Audited v1.18.15 otherwise starts a detached package installation for
  // every config directory even under --pure. Its own expected .gitignore
  // prevents a setup write, and a read-only directory makes npm.install exit
  // before package-registry traffic or dependency mutation.
  fs.writeFileSync(path.join(directory, '.gitignore'), OPENCODE_GITIGNORE, {
    encoding: 'utf8',
    mode: 0o400,
  });
  fs.chmodSync(directory, 0o500);
}

function observerConfig(systemPrompt: string): string {
  return JSON.stringify({
    share: 'disabled',
    autoupdate: false,
    snapshot: false,
    mcp: {},
    plugin: [],
    instructions: [],
    permission: { '*': 'deny' },
    tools: { skill: false },
    default_agent: OBSERVER_AGENT,
    agent: {
      [OBSERVER_AGENT]: {
        mode: 'primary',
        prompt: systemPrompt || DEFAULT_OBSERVER_PROMPT,
        permission: { '*': 'deny' },
      },
    },
  });
}

function snapshotOpenCodeAuth(
  sourceEnv: NodeJS.ProcessEnv,
  snapshot: string,
  expectedAuth: FileIdentity | null,
  expectedDigest: string,
  snapshotIdentity: RuntimeNodeIdentity,
  selectedProvider?: string,
): void {
  const current = captureOpenCodeAuthIdentity(sourceEnv);
  if (!sameAuthState(current, expectedAuth)) {
    throw new Error('opencode-cli: OpenCode authentication changed before the command started.');
  }
  if (!current) return;
  const auth = readVerifiedOpenCodeAuth(current, expectedDigest);
  const projected: Record<string, unknown> = {};
  if (selectedProvider) {
    const selected = asRecord(auth[selectedProvider]);
    const kind = openCodeAuthKind(selected);
    if (kind === 'oauth' || kind === 'wellknown') {
      throw new Error('opencode-cli: selected OpenCode credential is not safe to snapshot.');
    }
    if (kind === 'api') projected[selectedProvider] = selected;
    else if (selectedProvider !== 'opencode') {
      throw new Error('opencode-cli: selected OpenCode provider has no API credential.');
    }
  } else {
    for (const [provider, value] of Object.entries(auth)) {
      const entry = asRecord(value);
      if (openCodeAuthKind(entry) === 'api') projected[provider] = entry;
    }
  }
  writePrivateAuthSnapshot(snapshot, snapshotIdentity, Buffer.from(JSON.stringify(projected)));
  const sourceAfter = captureOpenCodeAuthIdentity(sourceEnv);
  if (
    !sameAuthState(sourceAfter, current) ||
    digestVerifiedFile(sourceAfter!) !== expectedDigest ||
    !runtimeRegularFileMatches(snapshot, snapshotIdentity)
  ) {
    throw new Error('opencode-cli: Aside could not isolate OpenCode authentication safely.');
  }
}

function writePrivateAuthSnapshot(
  snapshot: string,
  expected: RuntimeNodeIdentity,
  bytes: Buffer,
): void {
  const descriptor = fs.openSync(
    snapshot,
    fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const metadata = fs.fstatSync(descriptor);
    if (
      !metadata.isFile() ||
      metadata.dev !== expected.dev ||
      metadata.ino !== expected.ino ||
      metadata.uid !== expected.uid
    ) throw new Error('private auth snapshot identity changed');
    fs.ftruncateSync(descriptor, 0);
    let offset = 0;
    while (offset < bytes.length) {
      offset += fs.writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
    }
    if (process.platform !== 'win32') fs.fchmodSync(descriptor, 0o600);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function selectedOpenCodeAuthKind(
  boundary: ExecutionBoundary,
  provider: string,
): OpenCodeAuthKind | null {
  if (!boundary.auth || !boundary.authDigest) return null;
  const auth = readVerifiedOpenCodeAuth(boundary.auth, boundary.authDigest);
  return openCodeAuthKind(asRecord(auth[provider]));
}

function openCodeAuthPolicy(boundary: ExecutionBoundary): OpenCodeAuthPolicy {
  const allowed = new Set(Object.keys(AUDITED_ROUTE_MATRIX));
  const unsafe = new Set<string>();
  if (!boundary.auth || !boundary.authDigest) return { allowed, unsafe };
  const auth = readVerifiedOpenCodeAuth(boundary.auth, boundary.authDigest);
  for (const [provider, value] of Object.entries(auth)) {
    const kind = openCodeAuthKind(asRecord(value));
    if (kind === 'oauth' || kind === 'wellknown') {
      allowed.delete(provider);
      unsafe.add(provider);
    }
  }
  return { allowed, unsafe };
}

function openCodeAuthKind(
  entry: Record<string, unknown> | null | undefined,
): OpenCodeAuthKind | null {
  if (!entry) return null;
  const kind = entry['type'];
  if (kind === 'oauth' || kind === 'api' || kind === 'wellknown') return kind;
  throw new Error('opencode-cli: OpenCode auth entry has an unsupported shape.');
}

function readVerifiedOpenCodeAuth(
  expected: FileIdentity,
  expectedDigest: string,
): Record<string, unknown> {
  const descriptor = fs.openSync(
    expected.path,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    if (!metadataMatchesFileIdentity(fs.fstatSync(descriptor), expected)) {
      throw new Error('opencode-cli: OpenCode authentication changed before projection.');
    }
    const metadata = fs.fstatSync(descriptor);
    if (metadata.size > MAX_AUTH_BYTES) {
      throw new Error('opencode-cli: OpenCode authentication exceeds the safe size limit.');
    }
    const bytes = Buffer.alloc(metadata.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw new Error('opencode-cli: OpenCode authentication ended during projection.');
      offset += count;
    }
    if (
      createHash('sha256').update(bytes).digest('hex') !== expectedDigest ||
      !metadataMatchesFileIdentity(fs.fstatSync(descriptor), expected) ||
      !fileIdentityMatches(expected)
    ) throw new Error('opencode-cli: OpenCode authentication changed during projection.');
    const parsed = asRecord(JSON.parse(bytes.toString('utf8')));
    if (!parsed) throw new Error('opencode-cli: OpenCode authentication is malformed.');
    for (const value of Object.values(parsed)) openCodeAuthKind(asRecord(value));
    return parsed;
  } finally {
    fs.closeSync(descriptor);
  }
}

function captureOpenCodeAuthIdentity(sourceEnv: NodeJS.ProcessEnv): FileIdentity | null {
  return captureOpenCodeAuthIdentityFromPath(openCodeAuthPath(sourceEnv));
}

function captureOpenCodeAuthIdentityFromPath(source: string): FileIdentity | null {
  let identity: FileIdentity | null;
  try {
    identity = captureRegularFileIdentity(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!identity) {
    throw new Error('opencode-cli: OpenCode’s auth file is not a regular file.');
  }
  const getuid = process.getuid;
  if (getuid && identity.uid !== getuid()) {
    throw new Error('opencode-cli: OpenCode’s auth file is owned by another user.');
  }
  const metadata = fs.lstatSync(source);
  if (identity.size > MAX_AUTH_BYTES || metadata.nlink !== 1) {
    throw new Error('opencode-cli: OpenCode’s auth file is not safely isolated.');
  }
  if (process.platform !== 'win32' && (identity.mode & 0o077) !== 0) {
    throw new Error('opencode-cli: OpenCode’s auth file permissions are too broad.');
  }
  return identity;
}

function openCodeAuthPath(sourceEnv: NodeJS.ProcessEnv): string {
  const sourceHome = sourceEnv['HOME'] || sourceEnv['USERPROFILE'] || os.homedir();
  const credentialData = sourceEnv['XDG_DATA_HOME'] || (
    process.platform === 'win32'
      ? sourceEnv['LOCALAPPDATA'] || path.join(sourceHome, 'AppData', 'Local')
      : path.join(sourceHome, '.local', 'share')
  );
  if (!path.isAbsolute(credentialData)) {
    throw new Error('opencode-cli: OpenCode’s credential data path is not absolute.');
  }
  return path.join(credentialData, 'opencode', 'auth.json');
}

function captureBinaryIdentity(binary: string): FileIdentity | null {
  try {
    const resolved = fs.realpathSync(binary);
    const metadata = fs.statSync(resolved);
    if (!metadata.isFile()) return null;
    fs.accessSync(resolved, fs.constants.X_OK);
    return fileIdentity(resolved, metadata);
  } catch {
    return null;
  }
}

function captureRegularFileIdentity(file: string): FileIdentity | null {
  const metadata = fs.lstatSync(file);
  if (!metadata.isFile() || metadata.isSymbolicLink()) return null;
  return fileIdentity(file, metadata);
}

function fileIdentity(file: string, metadata: fs.Stats): FileIdentity {
  return {
    path: file,
    dev: metadata.dev,
    ino: metadata.ino,
    size: metadata.size,
    mode: metadata.mode,
    uid: metadata.uid,
    mtimeMs: metadata.mtimeMs,
    ctimeMs: metadata.ctimeMs,
  };
}

function metadataMatchesFileIdentity(
  metadata: fs.Stats,
  expected: FileIdentity,
): boolean {
  return (
    metadata.isFile() &&
    metadata.dev === expected.dev &&
    metadata.ino === expected.ino &&
    metadata.size === expected.size &&
    metadata.mode === expected.mode &&
    metadata.uid === expected.uid &&
    metadata.mtimeMs === expected.mtimeMs &&
    metadata.ctimeMs === expected.ctimeMs
  );
}

function digestDescriptor(descriptor: number): string {
  const digest = createHash('sha256');
  const buffer = Buffer.allocUnsafe(256 * 1024);
  let offset = 0;
  while (true) {
    const count = fs.readSync(descriptor, buffer, 0, buffer.length, offset);
    if (count === 0) break;
    digest.update(buffer.subarray(0, count));
    offset += count;
  }
  return digest.digest('hex');
}

function digestVerifiedFile(expected: FileIdentity): string | null {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      expected.path,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    if (!metadataMatchesFileIdentity(fs.fstatSync(descriptor), expected)) return null;
    const digest = digestDescriptor(descriptor);
    if (
      !metadataMatchesFileIdentity(fs.fstatSync(descriptor), expected) ||
      !fileIdentityMatches(expected)
    ) return null;
    return digest;
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function copyVerifiedFile(
  expected: FileIdentity,
  expectedDigest: string,
  destination: string,
  destinationIdentity?: RuntimeNodeIdentity,
): RuntimeNodeIdentity {
  let sourceDescriptor: number | undefined;
  let destinationDescriptor: number | undefined;
  try {
    sourceDescriptor = fs.openSync(
      expected.path,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    if (!metadataMatchesFileIdentity(fs.fstatSync(sourceDescriptor), expected)) {
      throw new Error('source identity changed before private copy');
    }
    destinationDescriptor = fs.openSync(
      destination,
      destinationIdentity
        ? fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0)
        : fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      0o600,
    );
    const destinationBefore = fs.fstatSync(destinationDescriptor);
    if (
      destinationIdentity &&
      (destinationBefore.dev !== destinationIdentity.dev ||
        destinationBefore.ino !== destinationIdentity.ino ||
        destinationBefore.uid !== destinationIdentity.uid ||
        !destinationBefore.isFile())
    ) {
      throw new Error('private copy destination identity changed');
    }
    fs.ftruncateSync(destinationDescriptor, 0);
    const digest = createHash('sha256');
    const buffer = Buffer.allocUnsafe(256 * 1024);
    let offset = 0;
    while (true) {
      const count = fs.readSync(sourceDescriptor, buffer, 0, buffer.length, offset);
      if (count === 0) break;
      digest.update(buffer.subarray(0, count));
      let written = 0;
      while (written < count) {
        written += fs.writeSync(
          destinationDescriptor,
          buffer,
          written,
          count - written,
          offset + written,
        );
      }
      offset += count;
    }
    if (
      digest.digest('hex') !== expectedDigest ||
      !metadataMatchesFileIdentity(fs.fstatSync(sourceDescriptor), expected) ||
      !fileIdentityMatches(expected)
    ) {
      throw new Error('source changed while creating private copy');
    }
    fs.fchmodSync(destinationDescriptor, destinationIdentity ? 0o600 : 0o500);
    fs.fsyncSync(destinationDescriptor);
    const copied = fs.fstatSync(destinationDescriptor);
    return { dev: copied.dev, ino: copied.ino, uid: copied.uid };
  } finally {
    if (destinationDescriptor !== undefined) fs.closeSync(destinationDescriptor);
    if (sourceDescriptor !== undefined) fs.closeSync(sourceDescriptor);
  }
}

function executableCache(
  sourceEnv: NodeJS.ProcessEnv,
): { directory: string; identity: RuntimeNodeIdentity } {
  const home = sourceEnv['HOME'] || sourceEnv['USERPROFILE'] || os.homedir();
  if (!path.isAbsolute(home)) {
    throw new Error('opencode-cli: user home path is not absolute.');
  }
  const asideDirectory = path.join(home, '.aside');
  const directory = path.join(asideDirectory, 'opencode-executables');
  ensurePrivateOwnedDirectory(asideDirectory);
  const identity = ensurePrivateOwnedDirectory(directory);
  pruneStagedExecutableDebris(directory, identity);
  return { directory, identity };
}

function stageCandidateExecutable(
  source: FileIdentity,
  digest: string,
  sourceEnv: NodeJS.ProcessEnv,
): StagedExecutable {
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error('opencode-cli: invalid executable digest.');
  }
  const cache = executableCache(sourceEnv);
  const destination = path.join(cache.directory, `${digest}.bin`);
  const key = `${destination}\u0000${digest}`;
  const inMemory = stagedExecutableCache.get(key);
  if (inMemory && stagedExecutableMatches(inMemory)) return inMemory;

  recoverInterruptedExecutablePublication(destination, cache.identity);
  const existing = validateStagedExecutable(
    destination,
    digest,
    source.size,
    cache.identity,
  );
  if (existing) {
    stagedExecutableCache.set(key, existing);
    return existing;
  }

  const temporary = path.join(
    cache.directory,
    `.aside-stage-${process.pid}-${randomBytes(12).toString('hex')}`,
  );
  copyVerifiedFile(source, digest, temporary);
  if (!runtimeDirectoryMatches(cache.directory, cache.identity)) {
    discardCandidateExecutable({
      digest,
      identity: fileIdentity(temporary, fs.lstatSync(temporary)),
      directory: cache.identity,
    });
    throw new Error('opencode-cli: executable cache directory changed during staging.');
  }
  const identity = captureRegularFileIdentity(temporary);
  if (!identity) throw new Error('opencode-cli: private staged executable is invalid.');
  const staged = { digest, identity, directory: cache.identity };
  if (!stagedExecutableMatches(staged)) {
    discardCandidateExecutable(staged);
    throw new Error('opencode-cli: private staged executable changed.');
  }
  return staged;
}

function publishStagedExecutable(
  candidate: StagedExecutable,
  sourceSize: number,
): StagedExecutable {
  if (!stagedExecutableMatches(candidate)) {
    throw new Error('opencode-cli: candidate executable changed before publication.');
  }
  const directory = path.dirname(candidate.identity.path);
  const destination = path.join(directory, `${candidate.digest}.bin`);
  const key = `${destination}\u0000${candidate.digest}`;
  recoverInterruptedExecutablePublication(destination, candidate.directory);
  let existing = validateStagedExecutable(
    destination,
    candidate.digest,
    sourceSize,
    candidate.directory,
  );
  if (!existing) {
    try {
      // link(), unlike rename(), never replaces an executable another Aside
      // process has already published under this digest.
      fs.linkSync(candidate.identity.path, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    discardCandidateExecutable(candidate);
    recoverInterruptedExecutablePublication(destination, candidate.directory);
    existing = validateStagedExecutable(
      destination,
      candidate.digest,
      sourceSize,
      candidate.directory,
    );
  } else {
    discardCandidateExecutable(candidate);
  }
  if (!existing) {
    throw new Error('opencode-cli: could not validate the staged OpenCode executable.');
  }
  stagedExecutableCache.set(key, existing);
  prunePersistentExecutableCache(directory, candidate.directory, destination);
  return existing;
}

function discardCandidateExecutable(candidate: StagedExecutable): void {
  if (!path.basename(candidate.identity.path).startsWith('.aside-stage-')) return;
  if (!runtimeDirectoryMatches(path.dirname(candidate.identity.path), candidate.directory)) return;
  try {
    const metadata = fs.lstatSync(candidate.identity.path);
    if (
      metadata.isFile() &&
      !metadata.isSymbolicLink() &&
      metadata.dev === candidate.identity.dev &&
      metadata.ino === candidate.identity.ino &&
      metadata.uid === candidate.identity.uid
    ) fs.unlinkSync(candidate.identity.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function ensurePrivateOwnedDirectory(directory: string): RuntimeNodeIdentity {
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const metadata = fs.lstatSync(directory);
  const getuid = process.getuid;
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (getuid && metadata.uid !== getuid()) ||
    (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0)
  ) {
    throw new Error('opencode-cli: executable cache directory is not private.');
  }
  return { dev: metadata.dev, ino: metadata.ino, uid: metadata.uid };
}

function recoverInterruptedExecutablePublication(
  destination: string,
  directory: RuntimeNodeIdentity,
): void {
  if (!runtimeDirectoryMatches(path.dirname(destination), directory)) {
    throw new Error('opencode-cli: executable cache directory changed.');
  }
  const published = lstatOptional(destination);
  if (!published || published.nlink === 1) return;
  if (
    !published.isFile() ||
    published.isSymbolicLink() ||
    (process.getuid && published.uid !== process.getuid())
  ) return;
  for (const entry of fs.readdirSync(path.dirname(destination), { withFileTypes: true })) {
    if (!/^\.aside-stage-\d+-[a-f0-9]{24}$/.test(entry.name) || !entry.isFile()) continue;
    const temporary = path.join(path.dirname(destination), entry.name);
    const metadata = fs.lstatSync(temporary);
    if (
      metadata.dev === published.dev &&
      metadata.ino === published.ino &&
      metadata.uid === published.uid
    ) fs.unlinkSync(temporary);
  }
}

function pruneStagedExecutableDebris(
  directory: string,
  identity: RuntimeNodeIdentity,
): void {
  if (!runtimeDirectoryMatches(directory, identity)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const match = /^\.aside-stage-(\d+)-[a-f0-9]{24}$/.exec(entry.name);
    if (!match || !entry.isFile()) continue;
    const pid = Number(match[1]);
    if (Number.isSafeInteger(pid) && pid > 0 && isProcessRunning(pid)) continue;
    const temporary = path.join(directory, entry.name);
    const metadata = fs.lstatSync(temporary);
    if (
      metadata.isFile() &&
      !metadata.isSymbolicLink() &&
      (!process.getuid || metadata.uid === process.getuid())
    ) fs.unlinkSync(temporary);
  }
}

function prunePersistentExecutableCache(
  directory: string,
  identity: RuntimeNodeIdentity,
  current: string,
): void {
  if (!runtimeDirectoryMatches(directory, identity)) return;
  const entries = fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^[a-f0-9]{64}\.bin$/.test(entry.name))
    .map((entry) => {
      const file = path.join(directory, entry.name);
      return { file, metadata: fs.lstatSync(file) };
    })
    .filter(({ metadata }) =>
      metadata.isFile() &&
      !metadata.isSymbolicLink() &&
      (!process.getuid || metadata.uid === process.getuid()))
    .sort((left, right) => right.metadata.ctimeMs - left.metadata.ctimeMs);
  const keep = new Set([current]);
  for (const entry of entries) {
    if (keep.size >= 3) break;
    keep.add(entry.file);
  }
  for (const { file, metadata } of entries) {
    if (keep.has(file) || metadata.nlink !== 1) continue;
    fs.unlinkSync(file);
    for (const [key, staged] of stagedExecutableCache) {
      if (staged.identity.path === file) stagedExecutableCache.delete(key);
    }
  }
}

function validateStagedExecutable(
  file: string,
  digest: string,
  size: number,
  directory: RuntimeNodeIdentity,
): StagedExecutable | null {
  let metadata: fs.Stats;
  try {
    metadata = fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const getuid = process.getuid;
  if (
    !runtimeDirectoryMatches(path.dirname(file), directory) ||
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size !== size ||
    metadata.nlink !== 1 ||
    (getuid && metadata.uid !== getuid()) ||
    (process.platform !== 'win32' && (metadata.mode & 0o777) !== 0o500)
  ) {
    throw new Error('opencode-cli: staged OpenCode executable is not private and immutable.');
  }
  const identity = fileIdentity(file, metadata);
  if (digestVerifiedFile(identity) !== digest) {
    throw new Error('opencode-cli: staged OpenCode executable failed integrity validation.');
  }
  fs.accessSync(file, fs.constants.X_OK);
  return { digest, identity, directory };
}

function stagedExecutableMatches(staged: StagedExecutable): boolean {
  if (!runtimeDirectoryMatches(path.dirname(staged.identity.path), staged.directory)) {
    return false;
  }
  try {
    const metadata = fs.lstatSync(staged.identity.path);
    return (
      metadata.isFile() &&
      !metadata.isSymbolicLink() &&
      metadata.nlink === 1 &&
      (!process.getuid || metadata.uid === process.getuid()) &&
      (process.platform === 'win32' || (metadata.mode & 0o777) === 0o500) &&
      sameFileIdentity(fileIdentity(staged.identity.path, metadata), staged.identity)
    );
  } catch {
    return false;
  }
}

function runtimeIdentityFromFile(identity: FileIdentity): RuntimeNodeIdentity {
  return { dev: identity.dev, ino: identity.ino, uid: identity.uid };
}

function captureRuntimeDirectoryIdentity(directory: string): RuntimeNodeIdentity {
  const metadata = fs.lstatSync(directory);
  const getuid = process.getuid;
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (getuid && metadata.uid !== getuid())
  ) {
    throw new Error('opencode-cli: private observer runtime provenance is invalid.');
  }
  return { dev: metadata.dev, ino: metadata.ino, uid: metadata.uid };
}

function runtimeDirectoryMatches(
  directory: string,
  expected: RuntimeNodeIdentity | undefined,
): boolean {
  if (!expected) return false;
  try {
    const metadata = fs.lstatSync(directory);
    return (
      metadata.isDirectory() &&
      !metadata.isSymbolicLink() &&
      metadata.dev === expected.dev &&
      metadata.ino === expected.ino &&
      metadata.uid === expected.uid &&
      (!process.getuid || metadata.uid === process.getuid())
    );
  } catch {
    return false;
  }
}

function runtimeRegularFileMatches(
  file: string,
  expected: RuntimeNodeIdentity | undefined,
): boolean {
  if (!expected) return false;
  try {
    const metadata = fs.lstatSync(file);
    return (
      metadata.isFile() &&
      !metadata.isSymbolicLink() &&
      metadata.dev === expected.dev &&
      metadata.ino === expected.ino &&
      metadata.uid === expected.uid &&
      (!process.getuid || metadata.uid === process.getuid())
    );
  } catch {
    return false;
  }
}

function runtimeStructureMatches(runtime: IsolatedRuntime): boolean {
  if (!runtimeDirectoryMatches(runtime.root, runtime.cleanup.root)) return false;
  if (runtime.binaryIdentity && !fileIdentityMatches(runtime.binaryIdentity)) return false;
  if (runtime.cleanup.data && !runtimeDirectoryMatches(
    path.join(runtime.root, 'data'),
    runtime.cleanup.data,
  )) return false;
  if (runtime.cleanup.authDirectory && !runtimeDirectoryMatches(
    path.join(runtime.root, 'data', 'opencode'),
    runtime.cleanup.authDirectory,
  )) return false;
  if (runtime.cleanup.authBridge && !runtimeRegularFileMatches(
    path.join(runtime.root, 'data', 'opencode', 'auth.json'),
    runtime.cleanup.authBridge,
  )) return false;
  return true;
}

function fileIdentityMatches(expected: FileIdentity): boolean {
  try {
    const metadata = fs.lstatSync(expected.path);
    return metadata.isFile() && sameFileIdentity(fileIdentity(expected.path, metadata), expected);
  } catch {
    return false;
  }
}

function sameFileIdentity(
  current: FileIdentity | null,
  expected: FileIdentity | null,
): boolean {
  if (!current || !expected) return current === expected;
  return (
    current.path === expected.path &&
    current.dev === expected.dev &&
    current.ino === expected.ino &&
    current.size === expected.size &&
    current.mode === expected.mode &&
    current.uid === expected.uid &&
    current.mtimeMs === expected.mtimeMs &&
    current.ctimeMs === expected.ctimeMs
  );
}

function sameAuthState(
  current: FileIdentity | null,
  expected: FileIdentity | null,
): boolean {
  if (!current || !expected) return current === expected;
  return (
    current.path === expected.path &&
    current.dev === expected.dev &&
    current.ino === expected.ino &&
    current.size === expected.size &&
    current.mode === expected.mode &&
    current.uid === expected.uid &&
    current.mtimeMs === expected.mtimeMs
  );
}

function executionBoundaryMatches(
  boundary: ExecutionBoundary,
  runtime?: IsolatedRuntime,
): boolean {
  if (
    !fileIdentityMatches(boundary.binary) ||
    !stagedExecutableMatches(boundary.staged)
  ) return false;
  if (runtime && !runtimeStructureMatches(runtime)) return false;
  try {
    if (!boundary.auth) {
      return (
        (!boundary.authPath || !fs.existsSync(boundary.authPath)) &&
        !runtime?.authBridgePath
      );
    }
    const source = captureRegularFileIdentity(boundary.authPath);
    if (
      !source ||
      source.dev !== boundary.auth.dev ||
      source.ino !== boundary.auth.ino ||
      source.uid !== boundary.auth.uid ||
      (process.platform !== 'win32' && (source.mode & 0o077) !== 0)
    ) return false;
    if (
      !sameAuthState(source, boundary.auth) ||
      digestVerifiedFile(source) !== boundary.authDigest
    ) return false;
    return true;
  } catch {
    return false;
  }
}

function assertNoManagedOpenCodeConfig(sourceEnv: NodeJS.ProcessEnv): void {
  const files: string[] = [];
  if (process.platform === 'darwin') {
    files.push(
      '/Library/Application Support/opencode/opencode.json',
      '/Library/Application Support/opencode/opencode.jsonc',
    );
    let user = sourceEnv['USER'] || sourceEnv['LOGNAME'] || '';
    try {
      user = os.userInfo().username || user;
    } catch {
      // The source environment remains a safe fallback for the exact plist.
    }
    if (user && !user.includes(path.sep)) {
      files.push(`/Library/Managed Preferences/${user}/ai.opencode.managed.plist`);
    }
    files.push('/Library/Managed Preferences/ai.opencode.managed.plist');
  } else if (process.platform === 'win32') {
    const programData = sourceEnv['PROGRAMDATA'] || 'C:\\ProgramData';
    files.push(
      path.join(programData, 'opencode', 'opencode.json'),
      path.join(programData, 'opencode', 'opencode.jsonc'),
    );
  } else {
    files.push('/etc/opencode/opencode.json', '/etc/opencode/opencode.jsonc');
  }
  if (files.some((file) => fs.existsSync(file))) {
    throw new Error(
      'opencode-cli: managed OpenCode configuration is present, so Aside will not send transcript context.',
    );
  }
}

function sweepStaleOpenCodeRuntimes(sourceEnv: NodeJS.ProcessEnv): void {
  const parents = new Set([
    os.tmpdir(),
    path.dirname(openCodeAuthPath(sourceEnv)),
  ]);
  for (const parent of parents) {
    if (sweptRuntimeParents.has(parent)) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(parent, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        sweptRuntimeParents.add(parent);
        continue;
      }
      throw error;
    }
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        !isRuntimeRootName(entry.name)
      ) continue;
      const root = path.join(parent, entry.name);
      if (liveRuntimeRoots.has(root)) continue;
      const marker = readRuntimeMarker(root);
      if (!marker || isProcessRunning(marker.pid)) continue;
      const cleanupError = removeRuntime(root, marker.cleanup);
      if (cleanupError) throw cleanupError;
    }
    // Mark a parent swept only after every candidate was inspected and every
    // stale marked runtime was removed. A transient read/cleanup failure must
    // not turn subsequent calls into an unchecked bypass.
    sweptRuntimeParents.add(parent);
  }
}

function isRuntimeRootName(name: string): boolean {
  return RUNTIME_NAME_PATTERN.test(name) || QUARANTINE_NAME_PATTERN.test(name);
}

function parseRuntimeNodeIdentity(value: unknown): RuntimeNodeIdentity | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const dev = record['dev'];
  const ino = record['ino'];
  const uid = record['uid'];
  return Number.isSafeInteger(dev) && Number(dev) >= 0 &&
    Number.isSafeInteger(ino) && Number(ino) > 0 &&
    Number.isSafeInteger(uid) && Number(uid) >= 0
    ? { dev: Number(dev), ino: Number(ino), uid: Number(uid) }
    : undefined;
}

function parseRuntimeCleanupIdentity(value: unknown): RuntimeCleanupIdentity | undefined {
  const record = asRecord(value);
  const root = parseRuntimeNodeIdentity(record?.['root']);
  if (!record || !root) return undefined;
  const cleanup: RuntimeCleanupIdentity = { root };
  for (const key of [
    'config',
    'xdgConfig',
    'globalConfig',
    'data',
    'authDirectory',
    'authBridge',
  ] as const) {
    if (record[key] === undefined) continue;
    const identity = parseRuntimeNodeIdentity(record[key]);
    if (!identity) return undefined;
    cleanup[key] = identity;
  }
  return cleanup;
}

function readRuntimeMarker(
  root: string,
): { pid: number; cleanup: RuntimeCleanupIdentity } | null {
  try {
    if (!isRuntimeRootName(path.basename(root))) return null;
    const rootMetadata = fs.lstatSync(root);
    const getuid = process.getuid;
    if (
      !rootMetadata.isDirectory() ||
      rootMetadata.isSymbolicLink() ||
      (getuid && rootMetadata.uid !== getuid())
    ) return null;

    const markerPath = path.join(root, RUNTIME_MARKER);
    const markerMetadata = fs.lstatSync(markerPath);
    if (
      !markerMetadata.isFile() ||
      markerMetadata.isSymbolicLink() ||
      markerMetadata.size > 2_048 ||
      (getuid && markerMetadata.uid !== getuid()) ||
      (process.platform !== 'win32' && (markerMetadata.mode & 0o077) !== 0)
    ) return null;
    const parsed = asRecord(JSON.parse(fs.readFileSync(markerPath, 'utf8')));
    const cleanup = parseRuntimeCleanupIdentity(parsed?.['cleanup']);
    return parsed?.['version'] === 2 &&
      Number.isSafeInteger(parsed['pid']) &&
      Number(parsed['pid']) > 0 &&
      cleanup &&
      cleanup.root.dev === rootMetadata.dev &&
      cleanup.root.ino === rootMetadata.ino &&
      cleanup.root.uid === rootMetadata.uid
      ? {
          pid: Number(parsed['pid']),
          cleanup,
        }
      : null;
  } catch {
    return null;
  }
}

function isProcessRunning(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function quarantineRuntimeRoot(
  root: string,
  expected: RuntimeNodeIdentity,
): string {
  if (!isRuntimeRootName(path.basename(root)) || !runtimeDirectoryMatches(root, expected)) {
    throw new Error('private runtime root identity changed before cleanup');
  }
  if (process.platform !== 'win32') {
    // This is safe only because live cleanup carries the creation-time inode,
    // while stale cleanup first validates that same provenance from the private
    // marker. Never chmod a merely name-matching directory.
    fs.chmodSync(root, 0o700);
    if (!runtimeDirectoryMatches(root, expected)) {
      throw new Error('private runtime root changed during permission repair');
    }
  }
  const parent = path.dirname(root);
  let quarantine = '';
  for (let attempt = 0; attempt < 5; attempt += 1) {
    quarantine = path.join(parent, `.aside-quarantine-${randomBytes(12).toString('hex')}`);
    if (!fs.existsSync(quarantine)) break;
    quarantine = '';
  }
  if (!quarantine) throw new Error('could not reserve a private cleanup quarantine');
  fs.renameSync(root, quarantine);
  liveRuntimeRoots.delete(root);
  if (!runtimeDirectoryMatches(quarantine, expected)) {
    throw new Error('private runtime root changed during quarantine');
  }
  if (process.platform !== 'win32') {
    // The exact creation-time inode is now at an unpredictable same-parent
    // path. Repair its owner permissions only after that provenance check.
    fs.chmodSync(quarantine, 0o700);
    if (!runtimeDirectoryMatches(quarantine, expected)) {
      throw new Error('private runtime root changed during permission repair');
    }
  }
  return quarantine;
}

function fchmodExpectedDirectory(
  directory: string,
  expected: RuntimeNodeIdentity | undefined,
): void {
  if (!expected) return;
  if (!runtimeDirectoryMatches(directory, expected)) {
    throw new Error('private runtime directory identity changed before cleanup');
  }
  if (process.platform === 'win32') return;
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | noFollow);
  try {
    const metadata = fs.fstatSync(descriptor);
    if (
      !metadata.isDirectory() ||
      metadata.dev !== expected.dev ||
      metadata.ino !== expected.ino ||
      metadata.uid !== expected.uid
    ) {
      throw new Error('private runtime directory changed while opening cleanup handle');
    }
    fs.fchmodSync(descriptor, 0o700);
  } finally {
    fs.closeSync(descriptor);
  }
}

function unlinkExpectedAuthBridge(
  root: string,
  cleanup: RuntimeCleanupIdentity,
): void {
  const expected = cleanup.authBridge;
  if (!expected) return;
  const source = path.join(root, 'data', 'opencode', 'auth.json');
  const detached = path.join(root, '.aside-auth-bridge');
  const detachedMetadata = lstatOptional(detached);
  const sensitiveParentsMatch = () =>
    runtimeDirectoryMatches(root, cleanup.root) &&
    runtimeDirectoryMatches(path.join(root, 'data'), cleanup.data) &&
    runtimeDirectoryMatches(
      path.join(root, 'data', 'opencode'),
      cleanup.authDirectory,
    );

  if (detachedMetadata) {
    if (!runtimeRegularFileMatches(detached, expected)) {
      throw new Error('private auth bridge identity changed before cleanup');
    }
    if (sensitiveParentsMatch() && lstatOptional(source)) {
      throw new Error('private auth bridge appeared twice during cleanup');
    }
  } else {
    // Validate every intermediate directory before even resolving the
    // credential filename. A symlinked child can never redirect rename/unlink
    // into a victim directory.
    if (!sensitiveParentsMatch()) {
      throw new Error('private auth bridge path changed before cleanup');
    }
    const sourceMetadata = lstatOptional(source);
    if (!sourceMetadata) return;
    if (!runtimeRegularFileMatches(source, expected)) {
      throw new Error('private auth bridge identity changed before cleanup');
    }
    fs.renameSync(source, detached);
    if (!runtimeRegularFileMatches(detached, expected)) {
      throw new Error('private auth bridge changed during cleanup quarantine');
    }
  }

  if (!runtimeDirectoryMatches(root, cleanup.root) ||
      !runtimeRegularFileMatches(detached, expected)) {
    throw new Error('private auth bridge changed before unlink');
  }
  fs.unlinkSync(detached);
}

function lstatOptional(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function removeRuntime(
  root: string,
  cleanup: RuntimeCleanupIdentity,
): Error | undefined {
  let quarantine = root;
  try {
    quarantine = quarantineRuntimeRoot(root, cleanup.root);
    unlinkExpectedAuthBridge(quarantine, cleanup);
    fchmodExpectedDirectory(path.join(quarantine, 'config'), cleanup.config);
    if (cleanup.xdgConfig && !runtimeDirectoryMatches(
      path.join(quarantine, 'xdg-config'),
      cleanup.xdgConfig,
    )) {
      throw new Error('private config parent identity changed before cleanup');
    }
    fchmodExpectedDirectory(
      path.join(quarantine, 'xdg-config', 'opencode'),
      cleanup.globalConfig,
    );
    fchmodExpectedDirectory(path.join(quarantine, 'xdg-config'), cleanup.xdgConfig);
    if (!runtimeDirectoryMatches(quarantine, cleanup.root)) {
      throw new Error('private runtime root changed before recursive cleanup');
    }
    fs.rmSync(quarantine, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 25,
    });
  } catch (error) {
    return new Error(
      `opencode-cli: could not remove the private observer runtime (${safeError(asError(error).message)}).`,
    );
  }
  try {
    fs.lstatSync(quarantine);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      liveRuntimeRoots.delete(root);
      liveRuntimeRoots.delete(quarantine);
      return undefined;
    }
  }
  return new Error(
    'opencode-cli: could not remove the private observer runtime (cleanup evidence remains).',
  );
}

function cachedPromise<T>(
  cache: Map<string, PromiseCacheEntry<T>>,
  key: string,
  ttlMs: number,
  create: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  const existing = cache.get(key);
  if (existing && (existing.pending || existing.expiresAt > now)) return existing.value;

  const value = create();
  const entry: PromiseCacheEntry<T> = { pending: true, expiresAt: 0, value };
  cache.set(key, entry);
  const settled = () => {
    if (cache.get(key) !== entry) return;
    entry.pending = false;
    entry.expiresAt = Date.now() + ttlMs;
  };
  void value.then(settled, settled);
  return value;
}

function openCodeCacheKey(env: NodeJS.ProcessEnv): string {
  return [
    'PATH',
    'HOME',
    'USERPROFILE',
    'XDG_DATA_HOME',
  ].map((name) => `${name}=${env[name] ?? ''}`).join('\u0000');
}

function splitConfiguredModel(value: string): { provider: string; id: string } {
  const separator = value.indexOf('/');
  const provider = safeProvider(separator > 0 ? value.slice(0, separator) : '');
  const id = safeModelId(separator > 0 ? value.slice(separator + 1) : '');
  if (!provider || !id) {
    throw new Error(
      'opencode-cli: model must be an exact provider/model id reported by OpenCode.',
    );
  }
  return { provider, id };
}

function modelKey(model: Pick<OpenCodeConfiguredModel, 'provider' | 'id'>): string {
  return `${model.provider}\u0000${model.id}`;
}

function consumeJsonLines(
  buffer: string,
  onValue: (value: unknown) => void,
  onMalformed: (error: Error) => void,
): string {
  let newline = buffer.indexOf('\n');
  while (newline >= 0) {
    const line = buffer.slice(0, newline).replace(/\r$/, '');
    buffer = buffer.slice(newline + 1);
    if (line) {
      try {
        onValue(JSON.parse(line));
      } catch {
        onMalformed(new Error('opencode-cli: OpenCode broke its JSON observer contract.'));
      }
    }
    newline = buffer.indexOf('\n');
  }
  return buffer;
}

function safeEventError(value: unknown): string {
  const error = asRecord(value);
  const data = asRecord(error?.['data']);
  return safeError(data?.['message'] ?? error?.['message'] ?? error?.['name'] ?? value);
}

function explainProcessFailure(error: Error, output: string): Error {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return new Error('opencode-cli: OpenCode was not found.');
  return new Error(`opencode-cli: ${safeError(output || error.message)}`);
}

function terminateWithEscalation(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const killTimer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }, TERMINATION_GRACE_MS);
  killTimer.unref?.();
  child.once('close', () => clearTimeout(killTimer));
}

function safeError(value: unknown): string {
  return cleanText(value, MAX_ERROR_LENGTH) || 'request failed';
}

function safeProvider(value: unknown): string | undefined {
  const text = boundedText(value, 100);
  return text && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(text) ? text : undefined;
}

function safeModelId(value: unknown): string | undefined {
  const text = boundedText(value, 300);
  return text && !/[\u0000-\u001f\u007f]/.test(text) ? text : undefined;
}

function boundedText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text.length > 0 && text.length <= maxLength ? text : undefined;
}

function cleanText(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function combineOutput(stdout: string, stderr: string): string {
  return stdout && stderr ? `${stdout}\n${stderr}` : stdout || stderr;
}

function stripAnsi(value: string): string {
  // Fixed to the CSI/OSC sequences emitted by the audited CLI's prompt UI.
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
}

function parseVersion(output: string): readonly [number, number, number] | null {
  const normalized = stripAnsi(output).trim();
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(normalized);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(
  left: readonly [number, number, number] | null,
  right: readonly [number, number, number] | null,
): number {
  if (!left) return right ? -1 : 0;
  if (!right) return 1;
  for (let index = 0; index < 3; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

function isAuditedVersion(version: readonly [number, number, number] | null): boolean {
  return version !== null && version.join('.') === AUDITED_VERSION;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
