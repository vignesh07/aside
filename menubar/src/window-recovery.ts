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
