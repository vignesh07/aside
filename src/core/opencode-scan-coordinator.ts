import { Worker } from 'node:worker_threads';
import type {
  DiscoveredOpenCodeSession,
  OpenCodeScanStatus,
} from './opencode-scanner.js';

type WorkerRequest =
  | { type: 'scan'; requestId: number; includeInternal: boolean }
  | { type: 'dispose' };

type WorkerResponse =
  | {
      type: 'scan-result';
      requestId: number;
      result: OpenCodeScanStatus;
    }
  | { type: 'disposed' };

export interface OpenCodeScanWorkerLike {
  postMessage(message: WorkerRequest): void;
  on(event: 'message', listener: (message: WorkerResponse) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
  terminate(): Promise<number> | number;
}

type WorkerFactory = () => OpenCodeScanWorkerLike;

export interface OpenCodeScanCoordinatorOptions {
  includeInternal?: boolean;
  workerFactory?: WorkerFactory;
  retryDelayMs?: number;
  requestTimeoutMs?: number;
}

/**
 * Keeps OpenCode's synchronous SQLite catalog walk off the caller's UI loop.
 *
 * A scan call either consumes a completed worker result or starts one and
 * returns the last roster as non-authoritative. That lets both frontends retain
 * known threads while the worker is busy or the vendor database is contended.
 */
export class OpenCodeScanCoordinator {
  private worker: OpenCodeScanWorkerLike | null = null;
  private result: OpenCodeScanStatus = {
    sessions: [],
    authoritative: false,
  };
  private requestId = 0;
  private pending = false;
  private fresh = false;
  private disposed = false;
  private retryAfterMs = 0;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private readonly includeInternal: boolean;
  private readonly workerFactory: WorkerFactory;
  private readonly retryDelayMs: number;
  private readonly requestTimeoutMs: number;

  constructor(
    private readonly onUpdate: () => void,
    options: OpenCodeScanCoordinatorOptions = {},
  ) {
    this.includeInternal = options.includeInternal ?? false;
    this.workerFactory = options.workerFactory ?? defaultWorkerFactory;
    this.retryDelayMs = options.retryDelayMs ?? 1_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.startWorker();
  }

  scan(): OpenCodeScanStatus {
    if (this.disposed) {
      return { sessions: this.result.sessions, authoritative: false };
    }
    if (this.fresh) {
      this.fresh = false;
      return this.result;
    }
    if (!this.worker && Date.now() >= this.retryAfterMs) {
      try {
        this.startWorker();
      } catch {
        this.retryAfterMs = Date.now() + this.retryDelayMs;
      }
    }
    const worker = this.worker;
    if (!worker) {
      return { sessions: this.result.sessions, authoritative: false };
    }
    if (!this.pending) {
      this.pending = true;
      this.requestId += 1;
      try {
        worker.postMessage({
          type: 'scan',
          requestId: this.requestId,
          includeInternal: this.includeInternal,
        });
        this.watchdog = setTimeout(
          () => this.fail(worker, true),
          this.requestTimeoutMs,
        );
        this.watchdog.unref?.();
      } catch {
        this.fail(worker, false);
      }
    }
    return { sessions: this.result.sessions, authoritative: false };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pending = false;
    this.fresh = false;
    this.clearWatchdog();
    const worker = this.worker;
    this.worker = null;
    if (!worker) return;
    try { worker.postMessage({ type: 'dispose' }); } catch { /* exited */ }
    // Give the worker one short window to dispose an active projection. A
    // wedged SQLite call must never hold app shutdown indefinitely.
    const forced = setTimeout(() => void worker.terminate(), 250);
    forced.unref?.();
    worker.on('exit', () => clearTimeout(forced));
  }

  private startWorker(): void {
    const worker = this.workerFactory();
    this.worker = worker;
    worker.on('message', (message) => this.receive(worker, message));
    worker.on('error', () => this.fail(worker, true));
    worker.on('exit', () => {
      if (!this.disposed) this.fail(worker, true);
    });
  }

  private receive(
    worker: OpenCodeScanWorkerLike,
    message: WorkerResponse,
  ): void {
    if (
      this.disposed ||
      this.worker !== worker ||
      message.type !== 'scan-result' ||
      message.requestId !== this.requestId
    ) return;
    this.clearWatchdog();
    this.pending = false;
    this.result = normalizeResult(message.result, this.result.sessions);
    this.fresh = true;
    this.onUpdate();
  }

  private fail(worker: OpenCodeScanWorkerLike, notify: boolean): void {
    if (this.disposed || this.worker !== worker) return;
    this.worker = null;
    this.clearWatchdog();
    this.pending = false;
    this.retryAfterMs = Date.now() + this.retryDelayMs;
    this.result = { sessions: this.result.sessions, authoritative: false };
    this.fresh = true;
    void worker.terminate();
    if (notify) this.onUpdate();
  }

  private clearWatchdog(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
  }
}

function normalizeResult(
  result: OpenCodeScanStatus,
  previous: DiscoveredOpenCodeSession[],
): OpenCodeScanStatus {
  if (!result || !Array.isArray(result.sessions)) {
    return { sessions: previous, authoritative: false };
  }
  const sessions = result.sessions.flatMap((entry): DiscoveredOpenCodeSession[] => {
    if (
      !entry ||
      typeof entry.jsonlPath !== 'string' ||
      !entry.session ||
      entry.session.source !== 'opencode'
    ) return [];
    const rawTime = entry.session.lastEventTime;
    const lastEventTime = rawTime instanceof Date
      ? rawTime
      : new Date(rawTime as unknown as string | number);
    if (!Number.isFinite(lastEventTime.getTime())) return [];
    return [{
      jsonlPath: entry.jsonlPath,
      session: { ...entry.session, lastEventTime },
    }];
  });
  return result.authoritative === true
    ? { sessions, authoritative: true }
    : { sessions: previous, authoritative: false };
}

function defaultWorkerFactory(): OpenCodeScanWorkerLike {
  return new Worker(new URL('./opencode-scan-worker.js', import.meta.url), {
    execArgv: process.execArgv.filter(
      (argument) => !argument.startsWith('--input-type'),
    ),
  });
}
