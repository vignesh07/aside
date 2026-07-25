import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DEFAULT_WINDOW_SIZE,
  parseWindowSize,
  type WindowSize,
} from './window-layout.js';

const STORE_VERSION = 1;
const MAX_STORE_BYTES = 4 * 1024;

interface StoredWindowSize extends WindowSize {
  version: number;
}

/**
 * Persists only the user's preferred dimensions. Position and display identity
 * are intentionally ephemeral because Aside must reopen beneath the status item
 * on the currently active Space and display.
 */
export class FileWindowSizeStore {
  readonly location: string;

  constructor(location = path.join(os.homedir(), '.aside', 'window.json')) {
    this.location = location;
  }

  load(): WindowSize {
    try {
      const stat = fs.lstatSync(this.location);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size > MAX_STORE_BYTES
      ) {
        return { ...DEFAULT_WINDOW_SIZE };
      }
      const parsed = JSON.parse(
        fs.readFileSync(this.location, 'utf8'),
      ) as unknown;
      if (
        !isRecord(parsed) ||
        parsed['version'] !== STORE_VERSION
      ) {
        return { ...DEFAULT_WINDOW_SIZE };
      }
      return parseWindowSize(parsed) ?? { ...DEFAULT_WINDOW_SIZE };
    } catch {
      return { ...DEFAULT_WINDOW_SIZE };
    }
  }

  save(size: WindowSize): void {
    const valid = parseWindowSize(size);
    if (!valid) return;

    const dir = path.dirname(this.location);
    const temp = path.join(
      dir,
      `.${path.basename(this.location)}.${process.pid}.${Date.now()}.tmp`,
    );
    let fd: number | null = null;
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.chmodSync(dir, 0o700);
      fd = fs.openSync(temp, 'wx', 0o600);
      const state: StoredWindowSize = {
        version: STORE_VERSION,
        width: valid.width,
        height: valid.height,
      };
      fs.writeFileSync(fd, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      fs.renameSync(temp, this.location);
      fs.chmodSync(this.location, 0o600);
    } catch {
      // A display preference must never prevent Aside from opening.
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          // Preserve the best-effort persistence behavior.
        }
      }
      try {
        fs.unlinkSync(temp);
      } catch {
        // Successful rename removes the temporary path.
      }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  );
}
