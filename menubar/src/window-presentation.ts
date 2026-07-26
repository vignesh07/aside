export function shouldHideOnBlur(options: {
  authFlowActive: boolean;
  keepOpen: boolean;
  developmentShow: boolean;
}): boolean {
  return (
    !options.developmentShow &&
    !options.authFlowActive &&
    !options.keepOpen
  );
}

export function shouldRestoreDetachedPosition(
  keepOpen: boolean,
  hasRememberedPosition: boolean,
): boolean {
  return keepOpen && hasRememberedPosition;
}
