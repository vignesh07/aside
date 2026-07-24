/**
 * Coordinates macOS reopen events with Electron's asynchronous window setup.
 *
 * LaunchServices can activate the app before its tray and BrowserWindow exist.
 * Keep that request pending and satisfy it once the window can be revealed.
 */
export class WindowRecoveryController {
  private pending = false;

  constructor(private readonly reveal: () => boolean) {}

  request(): boolean {
    const revealed = this.reveal();
    this.pending = !revealed;
    return revealed;
  }

  flush(): boolean {
    if (!this.pending) return false;
    return this.request();
  }

  get hasPendingRequest(): boolean {
    return this.pending;
  }
}

export interface WorkspaceAwareWindow {
  setVisibleOnAllWorkspaces(
    visible: boolean,
    options?: {
      visibleOnFullScreen?: boolean;
      skipTransformProcessType?: boolean;
    },
  ): void;
}

/**
 * Give a status-item window native menu-bar semantics across macOS Spaces.
 *
 * A normal BrowserWindow belongs to the Space where it was first shown, so
 * focusing it from another Space makes macOS navigate back to that old Space.
 * Joining all Spaces lets the hidden dropdown be revealed beside the status
 * item on whichever Space is active instead.
 */
export function makeAvailableOnCurrentSpace(window: WorkspaceAwareWindow): void {
  window.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    // Aside has already hidden its Dock icon and is a UIElement application.
    // Avoid Electron briefly changing the process type on every configuration.
    skipTransformProcessType: true,
  });
}
