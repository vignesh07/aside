import { describe, expect, it, vi } from 'vitest';
import {
  AppUpdateError,
  checkForAppUpdate,
  compareVersions,
  downloadUrlForArch,
} from '../menubar/src/app-update.js';

function manifest(version: string): Response {
  return new Response(
    JSON.stringify({
      product: 'Aside',
      version,
      downloads: {
        macArm64: 'https://attacker.invalid/not-trusted.dmg',
      },
    }),
    {
      status: 200,
      headers: { 'content-type': 'application/json' },
    },
  );
}

describe('app update checks', () => {
  it('keeps downloads on Aside-owned fixed routes', () => {
    expect(downloadUrlForArch('arm64')).toBe(
      'https://aside-production-fd82.up.railway.app/download/mac-arm64',
    );
    expect(downloadUrlForArch('x64')).toBe(
      'https://aside-production-fd82.up.railway.app/download/mac-intel',
    );
  });

  it('recognizes a newer release and keeps the download route fixed', async () => {
    const fetch = vi.fn(async () => manifest('0.1.2'));

    await expect(
      checkForAppUpdate('0.1.1', 'arm64', { fetch }),
    ).resolves.toEqual({
      currentVersion: '0.1.1',
      latestVersion: '0.1.2',
      updateAvailable: true,
      downloadUrl:
        'https://aside-production-fd82.up.railway.app/download/mac-arm64',
    });
  });

  it('reports the installed build as current when versions match', async () => {
    await expect(
      checkForAppUpdate('v1.4.0', 'x64', {
        fetch: async () => manifest('1.4.0'),
      }),
    ).resolves.toMatchObject({
      currentVersion: '1.4.0',
      latestVersion: '1.4.0',
      updateAvailable: false,
      downloadUrl:
        'https://aside-production-fd82.up.railway.app/download/mac-intel',
    });
  });

  it('fails closed on an invalid product or version', async () => {
    const fetch = async () =>
      new Response(JSON.stringify({ product: 'Something Else', version: 'latest' }));

    await expect(
      checkForAppUpdate('0.1.1', 'arm64', { fetch }),
    ).rejects.toBeInstanceOf(AppUpdateError);
  });

  it('wraps network failures in a safe message', async () => {
    const fetch = async () => {
      throw new Error('internal proxy details');
    };

    await expect(
      checkForAppUpdate('0.1.1', 'arm64', { fetch }),
    ).rejects.toThrow('Aside could not check for updates');
  });
});

describe('compareVersions', () => {
  it.each([
    ['0.1.2', '0.1.1', 1],
    ['0.2.0', '0.10.0', -1],
    ['2.0.0', '1.99.99', 1],
    ['1.0.0', '1.0.0', 0],
  ])('compares %s with %s', (left, right, expected) => {
    expect(compareVersions(left, right)).toBe(expected);
  });
});
