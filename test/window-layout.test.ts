import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WINDOW_SIZE,
  MIN_WINDOW_SIZE,
  parseWindowSize,
  windowBoundsAtPosition,
  windowBoundsBelowTray,
  windowSizeForWorkArea,
} from '../menubar/src/window-layout.js';

describe('windowBoundsBelowTray', () => {
  it('centers the actual preferred width beneath the tray item', () => {
    expect(
      windowBoundsBelowTray(
        { width: 900, height: 700 },
        { x: 900, y: 0, width: 24, height: 24 },
        { x: 0, y: 25, width: 1440, height: 875 },
      ),
    ).toEqual({ x: 462, y: 28, width: 900, height: 700 });
  });

  it('keeps a wide window inside the right edge of the work area', () => {
    expect(
      windowBoundsBelowTray(
        { width: 1100, height: 700 },
        { x: 1410, y: 0, width: 22, height: 24 },
        { x: 0, y: 25, width: 1440, height: 875 },
      ),
    ).toEqual({ x: 332, y: 28, width: 1100, height: 700 });
  });

  it('keeps a window inside a display with negative coordinates', () => {
    expect(
      windowBoundsBelowTray(
        { width: 900, height: 700 },
        { x: -1430, y: 0, width: 22, height: 24 },
        { x: -1440, y: 25, width: 1440, height: 875 },
      ),
    ).toEqual({ x: -1432, y: 28, width: 900, height: 700 });
  });

  it('temporarily fits an oversized preference without changing it', () => {
    const preferred = { width: 1800, height: 1200 };
    const bounds = windowBoundsBelowTray(
      preferred,
      { x: 720, y: 0, width: 24, height: 24 },
      { x: 0, y: 25, width: 1440, height: 875 },
    );

    expect(bounds).toEqual({ x: 8, y: 28, width: 1424, height: 864 });
    expect(preferred).toEqual({ width: 1800, height: 1200 });
  });

  it('falls back to the work area when tray geometry is unusable', () => {
    expect(
      windowBoundsBelowTray(
        DEFAULT_WINDOW_SIZE,
        { x: 600, y: 880, width: 20, height: 20 },
        { x: 0, y: 25, width: 1440, height: 875 },
      ),
    ).toEqual({ x: 230, y: 33, width: 760, height: 620 });
  });

  it('matches native minimum constraints on an unusually small work area', () => {
    expect(
      windowBoundsBelowTray(
        MIN_WINDOW_SIZE,
        { x: 240, y: 0, width: 20, height: 24 },
        { x: 0, y: 0, width: 500, height: 400 },
      ),
    ).toEqual({ x: 0, y: 8, width: 600, height: 480 });
  });
});

describe('windowSizeForWorkArea', () => {
  it('caps the initial backing surface without changing the preference', () => {
    const preferred = { width: 8192, height: 8192 };

    expect(
      windowSizeForWorkArea(
        preferred,
        { x: 0, y: 25, width: 1440, height: 875 },
      ),
    ).toEqual({ width: 1424, height: 859 });
    expect(preferred).toEqual({ width: 8192, height: 8192 });
  });

  it('retains native minimum dimensions on a tiny work area', () => {
    expect(
      windowSizeForWorkArea(
        MIN_WINDOW_SIZE,
        { x: 0, y: 0, width: 500, height: 400 },
      ),
    ).toEqual(MIN_WINDOW_SIZE);
  });
});

describe('windowBoundsAtPosition', () => {
  it('restores a detached window at its remembered point', () => {
    expect(
      windowBoundsAtPosition(
        { width: 900, height: 700 },
        { x: 240, y: 90 },
        { x: 0, y: 25, width: 1440, height: 875 },
      ),
    ).toEqual({ x: 240, y: 90, width: 900, height: 700 });
  });

  it('clamps a stale point to the nearest usable display area', () => {
    expect(
      windowBoundsAtPosition(
        { width: 900, height: 700 },
        { x: 9000, y: -9000 },
        { x: -1440, y: 25, width: 1440, height: 875 },
      ),
    ).toEqual({ x: -908, y: 33, width: 900, height: 700 });
  });
});

describe('parseWindowSize', () => {
  it('accepts minimum and large valid integer dimensions', () => {
    expect(parseWindowSize(MIN_WINDOW_SIZE)).toEqual(MIN_WINDOW_SIZE);
    expect(parseWindowSize({ width: 4096, height: 2160 })).toEqual({
      width: 4096,
      height: 2160,
    });
  });

  it.each([
    null,
    {},
    { width: 599, height: 620 },
    { width: 760, height: 479 },
    { width: 760.5, height: 620 },
    { width: 9000, height: 620 },
    { width: '760', height: 620 },
  ])('rejects an invalid remembered size: %j', (value) => {
    expect(parseWindowSize(value)).toBeNull();
  });
});
