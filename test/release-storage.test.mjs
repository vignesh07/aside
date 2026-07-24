import { describe, expect, it } from 'vitest';
import { validateReleaseManifest } from '../distribution/release-storage.mjs';

function storedFile({ filename, version, size, sha256, arch }) {
  return {
    ...(arch ? { platform: 'darwin', arch } : {}),
    filename,
    key: `releases/v${version}/${filename}`,
    size,
    sha256,
  };
}

function releaseManifest({ schemaVersion = 2, version = '0.1.4' } = {}) {
  const manifest = {
    schemaVersion,
    product: 'Aside',
    version,
    publishedAt: '2026-07-23T12:00:00.000Z',
    artifacts: {
      'mac-arm64': storedFile({
        filename: `Aside-${version}-arm64.dmg`,
        version,
        size: 11,
        sha256: 'a'.repeat(64),
        arch: 'arm64',
      }),
      'mac-intel': storedFile({
        filename: `Aside-${version}.dmg`,
        version,
        size: 12,
        sha256: 'b'.repeat(64),
        arch: 'x64',
      }),
    },
  };
  if (schemaVersion === 1) return manifest;

  const arm64Filename = `Aside-${version}-arm64-mac.zip`;
  const intelFilename = `Aside-${version}-mac.zip`;
  manifest.updater = {
    metadata: storedFile({
      filename: 'latest-mac.yml',
      version,
      size: 13,
      sha256: 'c'.repeat(64),
    }),
    artifacts: {
      'mac-arm64': {
        ...storedFile({
          filename: arm64Filename,
          version,
          size: 21,
          sha256: 'd'.repeat(64),
          arch: 'arm64',
        }),
        sha512: Buffer.alloc(64, 1).toString('base64'),
        blockmap: storedFile({
          filename: `${arm64Filename}.blockmap`,
          version,
          size: 5,
          sha256: 'e'.repeat(64),
        }),
      },
      'mac-intel': {
        ...storedFile({
          filename: intelFilename,
          version,
          size: 22,
          sha256: 'f'.repeat(64),
          arch: 'x64',
        }),
        sha512: Buffer.alloc(64, 2).toString('base64'),
        blockmap: storedFile({
          filename: `${intelFilename}.blockmap`,
          version,
          size: 6,
          sha256: '0'.repeat(64),
        }),
      },
    },
  };
  return manifest;
}

describe('release manifest validation', () => {
  it('retains schema 1 compatibility during the server rollout', () => {
    expect(() =>
      validateReleaseManifest(
        releaseManifest({ schemaVersion: 1, version: '0.1.3' }),
      ),
    ).not.toThrow();
  });

  it('accepts a complete atomic auto-update release', () => {
    expect(() => validateReleaseManifest(releaseManifest())).not.toThrow();
  });

  it('rejects schema 2 before every update artifact is present', () => {
    const manifest = releaseManifest();
    delete manifest.updater.artifacts['mac-intel'];

    expect(() => validateReleaseManifest(manifest)).toThrow(
      'missing updater mac-intel',
    );
  });

  it.each([
    [
      'Apple silicon DMG',
      (manifest) => {
        const artifact = manifest.artifacts['mac-arm64'];
        artifact.filename = 'Aside-0.1.4.dmg';
        artifact.key = 'releases/v0.1.4/Aside-0.1.4.dmg';
      },
    ],
    [
      'Intel DMG',
      (manifest) => {
        const artifact = manifest.artifacts['mac-intel'];
        artifact.filename = 'Aside-0.1.4-arm64.dmg';
        artifact.key = 'releases/v0.1.4/Aside-0.1.4-arm64.dmg';
      },
    ],
    [
      'Apple silicon ZIP',
      (manifest) => {
        const artifact = manifest.updater.artifacts['mac-arm64'];
        artifact.filename = 'Aside-0.1.4-mac.zip';
        artifact.key = 'releases/v0.1.4/Aside-0.1.4-mac.zip';
      },
    ],
    [
      'Intel blockmap',
      (manifest) => {
        const blockmap =
          manifest.updater.artifacts['mac-intel'].blockmap;
        blockmap.filename = 'Aside-0.1.4-arm64-mac.zip.blockmap';
        blockmap.key =
          'releases/v0.1.4/Aside-0.1.4-arm64-mac.zip.blockmap';
      },
    ],
    [
      'path traversal',
      (manifest) => {
        const artifact = manifest.artifacts['mac-arm64'];
        artifact.filename = '../Aside-0.1.4-arm64.dmg';
        artifact.key = 'releases/v0.1.4/../Aside-0.1.4-arm64.dmg';
      },
    ],
  ])('rejects an unexpected %s filename', (_label, mutate) => {
    const manifest = releaseManifest();
    mutate(manifest);
    expect(() => validateReleaseManifest(manifest)).toThrow(/filename/);
  });

  it.each([
    ['manual artifact', (manifest) => manifest.artifacts['mac-arm64']],
    ['updater metadata', (manifest) => manifest.updater.metadata],
    [
      'update ZIP',
      (manifest) => manifest.updater.artifacts['mac-intel'],
    ],
    [
      'update blockmap',
      (manifest) => manifest.updater.artifacts['mac-arm64'].blockmap,
    ],
  ])('rejects a non-positive %s size', (_label, select) => {
    for (const invalidSize of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const manifest = releaseManifest();
      select(manifest).size = invalidSize;
      expect(() => validateReleaseManifest(manifest)).toThrow(/size/);
    }
  });

  it.each([
    ['uppercase', 'A'.repeat(64)],
    ['too short', 'a'.repeat(63)],
    ['non-hexadecimal', `${'a'.repeat(63)}z`],
  ])('rejects a %s SHA-256 digest', (_label, sha256) => {
    const manifest = releaseManifest();
    manifest.updater.artifacts['mac-intel'].blockmap.sha256 = sha256;
    expect(() => validateReleaseManifest(manifest)).toThrow(/SHA-256/);
  });

  it.each([
    ['missing padding', 'a'.repeat(88)],
    ['wrong decoded length', Buffer.alloc(63, 1).toString('base64')],
    [
      'non-canonical padding bits',
      (() => {
        const digest = Buffer.alloc(64, 1).toString('base64');
        return `${digest.slice(0, -3)}R==`;
      })(),
    ],
    [
      'URL-safe alphabet',
      `${Buffer.alloc(64, 255).toString('base64').slice(0, -4)}__==`,
    ],
  ])('rejects a %s SHA-512 digest', (_label, sha512) => {
    const manifest = releaseManifest();
    manifest.updater.artifacts['mac-arm64'].sha512 = sha512;
    expect(() => validateReleaseManifest(manifest)).toThrow(/SHA-512/);
  });

  it.each([
    [
      'manual artifact',
      (manifest) => {
        manifest.artifacts['mac-arm64'].key =
          'releases/v0.1.3/Aside-0.1.4-arm64.dmg';
      },
    ],
    [
      'updater metadata',
      (manifest) => {
        manifest.updater.metadata.key = 'releases/latest-mac.yml';
      },
    ],
    [
      'update blockmap',
      (manifest) => {
        manifest.updater.artifacts['mac-intel'].blockmap.key =
          'releases/v0.1.4/../Aside-0.1.4-mac.zip.blockmap';
      },
    ],
  ])('rejects an unsafe %s key', (_label, mutate) => {
    const manifest = releaseManifest();
    mutate(manifest);
    expect(() => validateReleaseManifest(manifest)).toThrow(/key/);
  });

  it.each([
    ['manual artifact', (manifest) => manifest.artifacts['mac-arm64']],
    [
      'update ZIP',
      (manifest) => manifest.updater.artifacts['mac-intel'],
    ],
  ])('rejects a mislabeled %s architecture', (_label, select) => {
    const manifest = releaseManifest();
    select(manifest).arch = 'x86';
    expect(() => validateReleaseManifest(manifest)).toThrow(/architecture/);
  });
});
