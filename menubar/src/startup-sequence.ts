export interface RendererLoadEmitter {
  once(event: 'did-finish-load', listener: () => void): unknown;
}

type Scheduler = (task: () => void) => unknown;

/**
 * Keep expensive local discovery behind the first renderer load. The deferred
 * scheduler gives Chromium a paint opportunity before vendor scans begin.
 */
export function startAfterRendererLoad(
  webContents: RendererLoadEmitter,
  start: () => void,
  schedule: Scheduler = setImmediate,
): void {
  webContents.once('did-finish-load', () => {
    schedule(start);
  });
}
