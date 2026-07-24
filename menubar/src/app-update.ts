export const RELEASE_MANIFEST_URL =
  'https://aside-production-fd82.up.railway.app/releases/latest.json';

const DOWNLOAD_ROUTES = {
  arm64: 'https://aside-production-fd82.up.railway.app/download/mac-arm64',
  x64: 'https://aside-production-fd82.up.railway.app/download/mac-intel',
} as const;

export function downloadUrlForArch(arch: 'arm64' | 'x64'): string {
  return DOWNLOAD_ROUTES[arch];
}

export interface AppUpdateStatus {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  downloadUrl: string;
}

export interface AppUpdateDeps {
  fetch?: typeof globalThis.fetch;
  manifestUrl?: string;
}

export class AppUpdateError extends Error {
  constructor() {
    super('Aside could not check for updates. Try again in a moment.');
    this.name = 'AppUpdateError';
  }
}

/**
 * Check the signed release manifest without trusting it to choose an arbitrary
 * navigation target. Downloads always use Aside's fixed HTTPS routes.
 */
export async function checkForAppUpdate(
  currentVersion: string,
  arch: 'arm64' | 'x64',
  deps: AppUpdateDeps = {},
): Promise<AppUpdateStatus> {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  try {
    const response = await fetchImpl(
      deps.manifestUrl ?? RELEASE_MANIFEST_URL,
      {
        headers: { accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) throw new AppUpdateError();
    const payload: unknown = await response.json();
    const latestVersion =
      isPlainObject(payload) &&
      payload['product'] === 'Aside' &&
      typeof payload['version'] === 'string'
        ? normalizedVersion(payload['version'])
        : null;
    const normalizedCurrent = normalizedVersion(currentVersion);
    if (!latestVersion || !normalizedCurrent) throw new AppUpdateError();

    return {
      currentVersion: normalizedCurrent,
      latestVersion,
      updateAvailable: compareVersions(latestVersion, normalizedCurrent) > 0,
      downloadUrl: downloadUrlForArch(arch),
    };
  } catch (error) {
    if (error instanceof AppUpdateError) throw error;
    throw new AppUpdateError();
  }
}

export function compareVersions(left: string, right: string): number {
  const a = normalizedVersion(left);
  const b = normalizedVersion(right);
  if (!a || !b) throw new AppUpdateError();
  const aParts = a.split('.').map(Number);
  const bParts = b.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = aParts[index]! - bParts[index]!;
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function normalizedVersion(value: string): string | null {
  const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return null;
  return `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
