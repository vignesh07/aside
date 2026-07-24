import { describe, expect, it, vi } from 'vitest';
import {
  makeAvailableOnCurrentSpace,
  WindowRecoveryController,
} from '../menubar/src/window-recovery.js';

describe('WindowRecoveryController', () => {
  it('defers a LaunchServices reopen until the window is ready', () => {
    let ready = false;
    const reveal = vi.fn(() => ready);
    const recovery = new WindowRecoveryController(reveal);

    expect(recovery.request()).toBe(false);
    expect(recovery.hasPendingRequest).toBe(true);

    ready = true;
    expect(recovery.flush()).toBe(true);
    expect(recovery.hasPendingRequest).toBe(false);
    expect(reveal).toHaveBeenCalledTimes(2);
  });

  it('does not toggle or replay an already satisfied reopen', () => {
    const reveal = vi.fn(() => true);
    const recovery = new WindowRecoveryController(reveal);

    expect(recovery.request()).toBe(true);
    expect(recovery.flush()).toBe(false);
    expect(reveal).toHaveBeenCalledTimes(1);
  });

  it('keeps an early reopen pending when setup is still incomplete', () => {
    const reveal = vi.fn(() => false);
    const recovery = new WindowRecoveryController(reveal);

    recovery.request();
    expect(recovery.flush()).toBe(false);
    expect(recovery.hasPendingRequest).toBe(true);
  });
});

describe('makeAvailableOnCurrentSpace', () => {
  it('lets the menu window follow the active Space, including fullscreen Spaces', () => {
    const setVisibleOnAllWorkspaces = vi.fn();

    makeAvailableOnCurrentSpace({ setVisibleOnAllWorkspaces });

    expect(setVisibleOnAllWorkspaces).toHaveBeenCalledOnce();
    expect(setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });
  });
});
