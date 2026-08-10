import { parentPort } from 'node:worker_threads';
import {
  disposeOpenCodeScanner,
  scanOpenCodeSessionsWithStatus,
} from './opencode-scanner.js';

type WorkerRequest =
  | { type: 'scan'; requestId: number; includeInternal: boolean }
  | { type: 'dispose' };

if (!parentPort) throw new Error('OpenCode scan worker requires a parent port.');
const port = parentPort;
let disposed = false;

port.on('message', (message: WorkerRequest) => {
  if (disposed) return;
  if (message.type === 'dispose') {
    disposed = true;
    disposeOpenCodeScanner();
    port.postMessage({ type: 'disposed' });
    port.close();
    return;
  }
  let result;
  try {
    result = scanOpenCodeSessionsWithStatus({
      includeInternal: message.includeInternal,
    });
  } catch {
    result = { sessions: [], authoritative: false };
  }
  port.postMessage({
    type: 'scan-result',
    requestId: message.requestId,
    result,
  });
});
