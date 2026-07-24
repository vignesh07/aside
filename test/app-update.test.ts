import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  AppUpdateController,
  AppUpdateError,
  type AutoUpdaterLike,
  downloadUrlForArch,
} from '../menubar/src/app-update.js';

class FakeUpdater extends EventEmitter {
  autoDownload = false;
  autoInstallOnAppQuit = false;
  autoRunAppAfterInstall = false;
  allowDowngrade = true;
  allowPrerelease = true;
  checks = 0;
  readonly quitAndInstall = vi.fn();
  check = async (): Promise<unknown> => null;

  async checkForUpdates(): Promise<{
    downloadPromise?: Promise<unknown> | null;
  } | null> {
    this.checks += 1;
    return this.check() as Promise<{
      downloadPromise?: Promise<unknown> | null;
    } | null>;
  }
}

function controller(
  updater: FakeUpdater,
  enabled = true,
  onStatus?: (phase: string) => void,
): AppUpdateController {
  return new AppUpdateController({
    updater: updater as unknown as AutoUpdaterLike,
    currentVersion: '0.1.3',
    arch: 'arm64',
    enabled,
    onStatus: (status) => onStatus?.(status.phase),
  });
}

describe('app update routes', () => {
  it('keeps the manual recovery download on Aside-owned fixed routes', () => {
    expect(downloadUrlForArch('arm64')).toBe(
      'https://aside.vgnsh.xyz/download/mac-arm64',
    );
    expect(downloadUrlForArch('x64')).toBe(
      'https://aside.vgnsh.xyz/download/mac-intel',
    );
  });
});

describe('AppUpdateController', () => {
  it('configures safe automatic update defaults', () => {
    const updater = new FakeUpdater();
    controller(updater);

    expect(updater.autoDownload).toBe(true);
    expect(updater.autoInstallOnAppQuit).toBe(true);
    expect(updater.autoRunAppAfterInstall).toBe(true);
    expect(updater.allowDowngrade).toBe(false);
    expect(updater.allowPrerelease).toBe(false);
  });

  it('downloads in the background and becomes restart-ready', async () => {
    const updater = new FakeUpdater();
    const phases: string[] = [];
    updater.check = async () => {
      updater.emit('checking-for-update');
      updater.emit('update-available', { version: '0.1.4' });
      updater.emit('download-progress', { percent: 42.4 });
      updater.emit('update-downloaded', { version: '0.1.4' });
      return null;
    };
    const updates = controller(updater, true, (phase) => phases.push(phase));

    await expect(updates.checkForUpdates()).resolves.toMatchObject({
      phase: 'ready',
      currentVersion: '0.1.3',
      latestVersion: '0.1.4',
      percent: 100,
    });
    expect(phases).toEqual([
      'checking',
      'checking',
      'downloading',
      'downloading',
      'ready',
    ]);

    updates.restartToInstall();
    expect(updater.quitAndInstall).toHaveBeenCalledOnce();
  });

  it('does not start a second download while a check is in flight', async () => {
    const updater = new FakeUpdater();
    let finish: (() => void) | undefined;
    updater.check = () =>
      new Promise((resolve) => {
        finish = () => resolve(null);
      });
    const updates = controller(updater);

    const first = updates.checkForUpdates();
    const second = updates.checkForUpdates();
    await Promise.resolve();
    expect(updater.checks).toBe(1);
    finish?.();
    await Promise.all([first, second]);
  });

  it('reports installed builds as current when no update exists', async () => {
    const updater = new FakeUpdater();
    updater.check = async () => {
      updater.emit('update-not-available', { version: '0.1.3' });
      return null;
    };
    const updates = controller(updater);

    await expect(updates.checkForUpdates()).resolves.toMatchObject({
      phase: 'current',
      latestVersion: '0.1.3',
    });
  });

  it('recovers cleanly when a background download is interrupted', () => {
    const updater = new FakeUpdater();
    const updates = controller(updater);

    updater.emit('update-available', { version: '0.1.4' });
    updater.emit('update-cancelled', { version: '0.1.4' });

    expect(updates.getStatus()).toMatchObject({
      phase: 'error',
      latestVersion: '0.1.4',
      error: 'The update download was interrupted. Aside will try again.',
    });
  });

  it('consumes a failed automatic download promise', async () => {
    const updater = new FakeUpdater();
    updater.check = async () => {
      updater.emit('update-available', { version: '0.1.4' });
      return {
        downloadPromise: Promise.reject(new Error('private signed URL')),
      };
    };
    const updates = controller(updater);

    await expect(updates.checkForUpdates()).resolves.toMatchObject({
      phase: 'downloading',
    });
    await Promise.resolve();
    expect(updates.getStatus()).toMatchObject({
      phase: 'error',
      latestVersion: '0.1.4',
      error: 'Automatic update failed. Try again, or use the signed installer.',
    });
  });

  it('fails closed with a safe error and retains the signed fallback', async () => {
    const updater = new FakeUpdater();
    updater.check = async () => {
      throw new Error('https://private-bucket.invalid/secret?token=oops');
    };
    const updates = controller(updater);

    await expect(updates.checkForUpdates()).rejects.toThrow(
      'Automatic update failed',
    );
    expect(updates.getStatus()).toMatchObject({
      phase: 'error',
      error: 'Automatic update failed. Try again, or use the signed installer.',
      manualDownloadUrl:
        'https://aside.vgnsh.xyz/download/mac-arm64',
    });
  });

  it('normalizes a synchronous updater failure', async () => {
    const updater = new FakeUpdater();
    updater.checkForUpdates = (() => {
      throw new Error('unsafe implementation detail');
    }) as FakeUpdater['checkForUpdates'];
    const updates = controller(updater);

    await expect(updates.checkForUpdates()).rejects.toThrow(
      'Automatic update failed',
    );
    expect(updates.getStatus()).toMatchObject({
      phase: 'error',
      error: 'Automatic update failed. Try again, or use the signed installer.',
    });
  });

  it('does not contact the update service from an unpackaged build', async () => {
    const updater = new FakeUpdater();
    const updates = controller(updater, false);

    await expect(updates.checkForUpdates()).resolves.toMatchObject({
      phase: 'unsupported',
    });
    expect(updater.checks).toBe(0);
  });

  it('only restarts after a verified download event', () => {
    const updater = new FakeUpdater();
    const updates = controller(updater);

    expect(() => updates.restartToInstall()).toThrow(AppUpdateError);
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });
});
