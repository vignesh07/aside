import { describe, expect, it } from 'vitest';
import {
  OpenCodeScanCoordinator,
} from '../src/core/opencode-scan-coordinator.js';
import type {
  OpenCodeScanWorkerLike,
} from '../src/core/opencode-scan-coordinator.js';
import type {
  DiscoveredOpenCodeSession,
  OpenCodeScanStatus,
} from '../src/core/opencode-scanner.js';

type WorkerResponse = {
  type: 'scan-result';
  requestId: number;
  result: OpenCodeScanStatus;
};

class FakeWorker implements OpenCodeScanWorkerLike {
  readonly posted: unknown[] = [];
  terminated = false;
  private readonly listeners = new Map<string, Array<(value: unknown) => void>>();

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  on(event: 'message' | 'error' | 'exit', listener: (value: never) => void): this {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener as (value: unknown) => void);
    this.listeners.set(event, listeners);
    return this;
  }

  terminate(): number {
    this.terminated = true;
    return 0;
  }

  emit(event: 'message' | 'error' | 'exit', value: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }
}

function discovered(id = 'ses_worker'): DiscoveredOpenCodeSession {
  const jsonlPath = `/tmp/${id}.jsonl`;
  return {
    jsonlPath,
    session: {
      id,
      source: 'opencode',
      projectName: 'aside',
      projectDir: '/Users/test/aside',
      jsonlPath,
      cwd: '/Users/test/aside',
      gitBranch: 'main',
      slug: id.slice(0, 8),
      model: 'openai/gpt-5.4',
      version: '1.18.15',
      usedPercent: 0,
      contextStatus: 'safe',
      status: 'active',
      lastEventTime: new Date('2026-08-09T12:00:00.000Z'),
      eventCount: 2,
      currentActivity: '',
    },
  };
}

describe('OpenCodeScanCoordinator', () => {
  it('returns cached non-authoritative state while SQLite runs in a worker', () => {
    const worker = new FakeWorker();
    let updates = 0;
    const coordinator = new OpenCodeScanCoordinator(
      () => { updates += 1; },
      { workerFactory: () => worker },
    );

    expect(coordinator.scan()).toEqual({ sessions: [], authoritative: false });
    expect(worker.posted).toEqual([
      { type: 'scan', requestId: 1, includeInternal: false },
    ]);
    expect(coordinator.scan()).toEqual({ sessions: [], authoritative: false });
    expect(worker.posted).toHaveLength(1);

    const session = discovered();
    worker.emit('message', {
      type: 'scan-result',
      requestId: 1,
      result: { sessions: [session], authoritative: true },
    } satisfies WorkerResponse);
    expect(updates).toBe(1);
    expect(coordinator.scan()).toEqual({
      sessions: [session],
      authoritative: true,
    });

    // The next caller starts a new worker pass but retains the last roster
    // non-authoritatively until its result arrives.
    expect(coordinator.scan()).toEqual({
      sessions: [session],
      authoritative: false,
    });
    expect(worker.posted.at(-1)).toEqual({
      type: 'scan',
      requestId: 2,
      includeInternal: false,
    });

    worker.emit('message', {
      type: 'scan-result',
      requestId: 2,
      result: { sessions: [], authoritative: false },
    } satisfies WorkerResponse);
    expect(coordinator.scan()).toEqual({
      sessions: [session],
      authoritative: false,
    });

    coordinator.dispose();
    expect(worker.posted.at(-1)).toEqual({ type: 'dispose' });
    worker.emit('exit', 0);
    expect(worker.terminated).toBe(false);
  });

  it('ignores stale worker responses and preserves the last good roster on failure', () => {
    const worker = new FakeWorker();
    const coordinator = new OpenCodeScanCoordinator(
      () => {},
      { workerFactory: () => worker },
    );
    coordinator.scan();
    worker.emit('message', {
      type: 'scan-result',
      requestId: 0,
      result: { sessions: [discovered('ses_stale')], authoritative: true },
    } satisfies WorkerResponse);
    expect(coordinator.scan()).toEqual({ sessions: [], authoritative: false });
    worker.emit('error', new Error('worker stopped'));
    expect(coordinator.scan()).toEqual({ sessions: [], authoritative: false });
    coordinator.dispose();
  });

  it('replaces a stopped worker and resumes scanning without losing the roster', () => {
    const first = new FakeWorker();
    const second = new FakeWorker();
    const workers = [first, second];
    const coordinator = new OpenCodeScanCoordinator(
      () => {},
      { workerFactory: () => workers.shift()!, retryDelayMs: 0 },
    );
    coordinator.scan();
    const session = discovered('ses_recovered');
    first.emit('message', {
      type: 'scan-result',
      requestId: 1,
      result: { sessions: [session], authoritative: true },
    } satisfies WorkerResponse);
    expect(coordinator.scan().authoritative).toBe(true);

    first.emit('exit', 1);
    expect(coordinator.scan()).toEqual({
      sessions: [session],
      authoritative: false,
    });
    expect(coordinator.scan()).toEqual({
      sessions: [session],
      authoritative: false,
    });
    expect(second.posted).toEqual([
      { type: 'scan', requestId: 2, includeInternal: false },
    ]);

    second.emit('message', {
      type: 'scan-result',
      requestId: 2,
      result: { sessions: [session], authoritative: true },
    } satisfies WorkerResponse);
    expect(coordinator.scan().authoritative).toBe(true);
    coordinator.dispose();
    second.emit('exit', 0);
  });
});
