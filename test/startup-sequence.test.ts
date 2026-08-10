import { describe, expect, it, vi } from 'vitest';
import {
  startAfterRendererLoad,
  type RendererLoadEmitter,
} from '../menubar/src/startup-sequence.js';

describe('packaged app startup sequencing', () => {
  it('defers discovery until after renderer load and a scheduler turn', () => {
    let didFinishLoad: (() => void) | undefined;
    const webContents: RendererLoadEmitter = {
      once(event, listener) {
        expect(event).toBe('did-finish-load');
        didFinishLoad = listener;
      },
    };
    const scheduled: Array<() => void> = [];
    const start = vi.fn();

    startAfterRendererLoad(webContents, start, (task) => scheduled.push(task));

    expect(start).not.toHaveBeenCalled();
    didFinishLoad?.();
    expect(start).not.toHaveBeenCalled();
    expect(scheduled).toHaveLength(1);

    scheduled[0]?.();
    expect(start).toHaveBeenCalledOnce();
  });
});
