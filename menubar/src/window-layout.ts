export interface WindowSize {
  width: number;
  height: number;
}

export interface WindowRect extends WindowSize {
  x: number;
  y: number;
}

export const DEFAULT_WINDOW_SIZE: Readonly<WindowSize> = {
  width: 760,
  height: 620,
};

export const MIN_WINDOW_SIZE: Readonly<WindowSize> = {
  width: 600,
  height: 480,
};

export const MAX_REMEMBERED_WINDOW_DIMENSION = 8192;
export const WINDOW_SCREEN_MARGIN = 8;
export const WINDOW_TRAY_GAP = 4;

export function parseWindowSize(value: unknown): WindowSize | null {
  if (!isRecord(value)) return null;
  const width = value['width'];
  const height = value['height'];
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    (width as number) < MIN_WINDOW_SIZE.width ||
    (height as number) < MIN_WINDOW_SIZE.height ||
    (width as number) > MAX_REMEMBERED_WINDOW_DIMENSION ||
    (height as number) > MAX_REMEMBERED_WINDOW_DIMENSION
  ) {
    return null;
  }
  return { width: width as number, height: height as number };
}

/**
 * Fit a preferred menu window beneath the status item on the display where it
 * was invoked. The preferred size remains separate from these fitted bounds so
 * a window temporarily constrained by a laptop display can expand again on a
 * larger monitor.
 */
export function windowBoundsBelowTray(
  preferred: WindowSize,
  tray: WindowRect,
  workArea: WindowRect,
): WindowRect {
  const workRight = workArea.x + workArea.width;
  const workBottom = workArea.y + workArea.height;
  const maxWidth = Math.max(
    MIN_WINDOW_SIZE.width,
    workArea.width - WINDOW_SCREEN_MARGIN * 2,
  );

  let y = Math.round(
    Math.max(
      workArea.y,
      tray.y + tray.height + WINDOW_TRAY_GAP,
    ),
  );
  let maxHeight = workBottom - WINDOW_SCREEN_MARGIN - y;

  // Defensive fallback for unusual display geometry. macOS normally places the
  // menu bar above workArea, but a stale/empty tray rect must not make the app
  // disappear or force an unusably short window.
  if (maxHeight < Math.min(MIN_WINDOW_SIZE.height, workArea.height)) {
    y = Math.round(workArea.y + WINDOW_SCREEN_MARGIN);
    maxHeight = workArea.height - WINDOW_SCREEN_MARGIN * 2;
  }

  const width = Math.round(
    clamp(
      preferred.width,
      MIN_WINDOW_SIZE.width,
      maxWidth,
    ),
  );
  const fittedMaxHeight = Math.max(MIN_WINDOW_SIZE.height, maxHeight);
  const height = Math.round(
    clamp(
      preferred.height,
      MIN_WINDOW_SIZE.height,
      fittedMaxHeight,
    ),
  );
  const minX = workArea.x + WINDOW_SCREEN_MARGIN;
  const maxX = workRight - width - WINDOW_SCREEN_MARGIN;
  const x = Math.round(
    maxX < minX
      ? workArea.x
      : clamp(
          tray.x + tray.width / 2 - width / 2,
          minX,
          maxX,
        ),
  );

  return { x, y, width, height };
}

/** Keep the first hidden Chromium surface no larger than the current display. */
export function windowSizeForWorkArea(
  preferred: WindowSize,
  workArea: WindowRect,
): WindowSize {
  return {
    width: Math.round(
      clamp(
        preferred.width,
        MIN_WINDOW_SIZE.width,
        Math.max(
          MIN_WINDOW_SIZE.width,
          workArea.width - WINDOW_SCREEN_MARGIN * 2,
        ),
      ),
    ),
    height: Math.round(
      clamp(
        preferred.height,
        MIN_WINDOW_SIZE.height,
        Math.max(
          MIN_WINDOW_SIZE.height,
          workArea.height - WINDOW_SCREEN_MARGIN * 2,
        ),
      ),
    ),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  );
}
