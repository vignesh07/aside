import { describe, expect, it } from 'vitest';
import {
  shouldHideOnBlur,
  shouldRestoreDetachedPosition,
} from '../menubar/src/window-presentation.js';

describe('window presentation policy', () => {
  it('keeps the transient popover behavior as the default', () => {
    expect(
      shouldHideOnBlur({
        authFlowActive: false,
        keepOpen: false,
        developmentShow: false,
      }),
    ).toBe(true);
  });

  it('does not disappear during Keep Open or an account flow', () => {
    expect(
      shouldHideOnBlur({
        authFlowActive: false,
        keepOpen: true,
        developmentShow: false,
      }),
    ).toBe(false);
    expect(
      shouldHideOnBlur({
        authFlowActive: true,
        keepOpen: false,
        developmentShow: false,
      }),
    ).toBe(false);
  });

  it('restores a position only for an explicitly detached window', () => {
    expect(shouldRestoreDetachedPosition(true, true)).toBe(true);
    expect(shouldRestoreDetachedPosition(false, true)).toBe(false);
    expect(shouldRestoreDetachedPosition(true, false)).toBe(false);
  });
});
