import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const STORE_VERSION = 1;
const MAX_STORE_BYTES = 4 * 1024;
const MAX_ABS_POSITION = 100_000;

export interface WindowPosition {
  x: number;
  y: number;
}

export interface WindowMode {
  keepOpen: boolean;
  position: WindowPosition | null;
}

const DEFAULT_WINDOW_MODE: Readonly<WindowMode> = {
  keepOpen: false,
  position: null,
};

/**
 * Persists the explicit detached-window choice separately from the dropdown
 * dimensions. A normal tray popover remains positionless and always follows
 * the menu item; only Keep Open mode remembers where the user placed it.
 */
export class FileWindowModeStore {
  readonly location: string;

  constructor(location = path.join(os.homedir(), '.aside', 'window-mode.json')) {
    this.location = location;
  }

  load(): WindowMode {
    try {
      const stat = fs.lstatSync(this.location);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size > MAX_STORE_BYTES
      ) {
        return { ...DEFAULT_WINDOW_MODE };
      }
      const parsed = JSON.parse(fs.readFileSync(this.location, 'utf8')) as unknown;
      if (
        !isRecord(parsed) ||
        parsed['version'] !== STORE_VERSION ||
        typeof parsed['keepOpen'] !== 'boolean'
      ) {
        return { ...DEFAULT_WINDOW_MODE };
      }
      const position = parseWindowPosition(parsed['position']);
      if (parsed['position'] !== null && !position) {
        return { ...DEFAULT_WINDOW_MODE };
      }
      return {
        keepOpen: parsed['keepOpen'],
        position,
      };
    } catch {
      return { ...DEFAULT_WINDOW_MODE };
    }
  }

  save(mode: WindowMode): void {
    if (typeof mode.keepOpen !== 'boolean') return;
    const position = mode.position === null
      ? null
      : parseWindowPosition(mode.position);
    if (mode.position !== null && !position) return;

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
      fs.writeFileSync(
        fd,
        `${JSON.stringify({
          version: STORE_VERSION,
          keepOpen: mode.keepOpen,
          position,
        }, null, 2)}\n`,
        'utf8',
      );
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      fs.renameSync(temp, this.location);
      fs.chmodSync(this.location, 0o600);
    } catch {
      // A presentation preference must never prevent Aside from opening.
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          // Preserve best-effort persistence.
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

export function parseWindowPosition(value: unknown): WindowPosition | null {
  if (!isRecord(value)) return null;
  const x = value['x'];
  const y = value['y'];
  if (
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    Math.abs(x as number) > MAX_ABS_POSITION ||
    Math.abs(y as number) > MAX_ABS_POSITION
  ) {
    return null;
  }
  return { x: x as number, y: y as number };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  );
}
