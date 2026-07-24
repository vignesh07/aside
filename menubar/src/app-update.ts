export const RELEASE_ORIGIN = 'https://aside.vgnsh.xyz';

const DOWNLOAD_ROUTES = {
  arm64: `${RELEASE_ORIGIN}/download/mac-arm64`,
  x64: `${RELEASE_ORIGIN}/download/mac-intel`,
} as const;

export type ReleaseArch = keyof typeof DOWNLOAD_ROUTES;

export function downloadUrlForArch(arch: ReleaseArch): string {
  return DOWNLOAD_ROUTES[arch];
}

export type AppUpdatePhase =
  | 'idle'
  | 'checking'
  | 'downloading'
  | 'ready'
  | 'current'
  | 'error'
  | 'unsupported';

export interface AppUpdateStatus {
  phase: AppUpdatePhase;
  currentVersion: string;
  latestVersion?: string;
  percent?: number;
  error?: string;
  manualDownloadUrl: string;
}

export interface UpdateInfoLike {
  version?: string;
}

export interface UpdateProgressLike {
  percent?: number;
}

export interface UpdateCheckResultLike {
  downloadPromise?: Promise<unknown> | null;
}

/**
 * The deliberately small slice of electron-updater used by Aside. Keeping the
 * coordinator behind this interface makes the event flow independently
 * testable without loading Electron or contacting the release service.
 */
export interface AutoUpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  autoRunAppAfterInstall: boolean;
  allowDowngrade: boolean;
  allowPrerelease: boolean;
  on(event: 'checking-for-update', listener: () => void): unknown;
  on(
    event:
      | 'update-available'
      | 'update-not-available'
      | 'update-downloaded'
      | 'update-cancelled',
    listener: (info: UpdateInfoLike) => void,
  ): unknown;
  on(event: 'download-progress', listener: (progress: UpdateProgressLike) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  checkForUpdates(): Promise<UpdateCheckResultLike | null>;
  quitAndInstall(): void;
}

export interface AppUpdateControllerOptions {
  updater: AutoUpdaterLike;
  currentVersion: string;
  arch: ReleaseArch;
  enabled: boolean;
  onStatus?: (status: AppUpdateStatus) => void;
}

export class AppUpdateError extends Error {
  constructor(message = 'Aside could not check for updates. Try again in a moment.') {
    super(message);
    this.name = 'AppUpdateError';
  }
}

export class AppUpdateController {
  readonly #updater: AutoUpdaterLike;
  readonly #currentVersion: string;
  readonly #manualDownloadUrl: string;
  readonly #enabled: boolean;
  readonly #onStatus?: (status: AppUpdateStatus) => void;
  #status: AppUpdateStatus;
  #checkInFlight: Promise<AppUpdateStatus> | null = null;

  constructor(options: AppUpdateControllerOptions) {
    this.#updater = options.updater;
    this.#currentVersion = normalizedVersion(options.currentVersion);
    this.#manualDownloadUrl = downloadUrlForArch(options.arch);
    this.#enabled = options.enabled;
    this.#onStatus = options.onStatus;
    this.#status = this.#makeStatus(options.enabled ? 'idle' : 'unsupported');

    this.#updater.autoDownload = true;
    this.#updater.autoInstallOnAppQuit = true;
    this.#updater.autoRunAppAfterInstall = true;
    this.#updater.allowDowngrade = false;
    this.#updater.allowPrerelease = false;
    this.#bindEvents();
  }

  getStatus(): AppUpdateStatus {
    return { ...this.#status };
  }

  async checkForUpdates(): Promise<AppUpdateStatus> {
    if (!this.#enabled) return this.getStatus();
    if (this.#status.phase === 'downloading' || this.#status.phase === 'ready') {
      return this.getStatus();
    }
    if (this.#checkInFlight) return this.#checkInFlight;

    this.#setStatus(this.#makeStatus('checking', {
      latestVersion: this.#status.latestVersion,
    }));
    // Enter the promise chain before calling the updater so even an unusual
    // synchronous provider/configuration failure is normalized for the UI.
    const check = Promise.resolve()
      .then(() => this.#updater.checkForUpdates())
      .then((result) => {
        // With autoDownload enabled, electron-updater returns the active
        // download promise without awaiting it. Consume its rejection so a
        // transient network/hash failure cannot become an unhandled rejection
        // in Electron's main process.
        void result?.downloadPromise?.catch((error: unknown) => {
          if (this.#status.phase !== 'error') {
            const safe = safeUpdateError(error);
            this.#setStatus(this.#makeStatus('error', {
              latestVersion: this.#status.latestVersion,
              error: safe.message,
            }));
          }
        });
        return this.getStatus();
      })
      .catch((error: unknown) => {
        const safe = safeUpdateError(error);
        this.#setStatus(this.#makeStatus('error', { error: safe.message }));
        throw safe;
      })
      .finally(() => {
        this.#checkInFlight = null;
      });
    this.#checkInFlight = check;
    return check;
  }

  restartToInstall(): void {
    if (this.#status.phase !== 'ready') {
      throw new AppUpdateError('The update has not finished downloading yet.');
    }
    this.#updater.quitAndInstall();
  }

  #bindEvents(): void {
    this.#updater.on('checking-for-update', () => {
      this.#setStatus(this.#makeStatus('checking', {
        latestVersion: this.#status.latestVersion,
      }));
    });
    this.#updater.on('update-available', (info) => {
      this.#setStatus(this.#makeStatus('downloading', {
        latestVersion: safeVersion(info.version),
        percent: 0,
      }));
    });
    this.#updater.on('download-progress', (progress) => {
      this.#setStatus(this.#makeStatus('downloading', {
        latestVersion: this.#status.latestVersion,
        percent: normalizedPercent(progress.percent),
      }));
    });
    this.#updater.on('update-downloaded', (info) => {
      this.#setStatus(this.#makeStatus('ready', {
        latestVersion: safeVersion(info.version) ?? this.#status.latestVersion,
        percent: 100,
      }));
    });
    this.#updater.on('update-not-available', (info) => {
      this.#setStatus(this.#makeStatus('current', {
        latestVersion: safeVersion(info.version) ?? this.#currentVersion,
      }));
    });
    this.#updater.on('update-cancelled', (info) => {
      this.#setStatus(this.#makeStatus('error', {
        latestVersion: safeVersion(info.version) ?? this.#status.latestVersion,
        error: 'The update download was interrupted. Aside will try again.',
      }));
    });
    this.#updater.on('error', (error) => {
      this.#setStatus(this.#makeStatus('error', {
        latestVersion: this.#status.latestVersion,
        error: safeUpdateError(error).message,
      }));
    });
  }

  #makeStatus(
    phase: AppUpdatePhase,
    extra: Partial<AppUpdateStatus> = {},
  ): AppUpdateStatus {
    return {
      phase,
      currentVersion: this.#currentVersion,
      manualDownloadUrl: this.#manualDownloadUrl,
      ...extra,
    };
  }

  #setStatus(status: AppUpdateStatus): void {
    this.#status = status;
    this.#onStatus?.(this.getStatus());
  }
}

function normalizedVersion(value: string): string {
  return safeVersion(value) ?? '0.0.0';
}

function safeVersion(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/);
  if (!match) return undefined;
  return `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`;
}

function normalizedPercent(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.round(Math.min(100, Math.max(0, value)));
}

function safeUpdateError(error: unknown): AppUpdateError {
  if (error instanceof AppUpdateError) return error;
  return new AppUpdateError(
    'Automatic update failed. Try again, or use the signed installer.',
  );
}
