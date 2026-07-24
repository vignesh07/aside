import { describe, expect, it } from 'vitest';
import {
  buildMacUpdateMetadata,
  parseUpdateArtifactPath,
  releaseDateFromBuilderMetadata,
} from '../distribution/update-metadata.mjs';
import { parse } from 'yaml';

const sha512 = Buffer.alloc(64, 7).toString('base64');

describe('macOS update metadata', () => {
  it('describes both architectures with ZIPs only', () => {
    const metadata = buildMacUpdateMetadata({
      version: '0.1.4',
      releaseDate: '2026-07-23T12:00:00.000Z',
      x64: {
        filename: 'Aside-0.1.4-mac.zip',
        sha512,
        size: 123,
      },
      arm64: {
        filename: 'Aside-0.1.4-arm64-mac.zip',
        sha512,
        size: 100,
      },
    });

    expect(parse(metadata)).toEqual({
      version: '0.1.4',
      files: [
        {
          url: 'Aside-0.1.4-mac.zip',
          sha512,
          size: 123,
        },
        {
          url: 'Aside-0.1.4-arm64-mac.zip',
          sha512,
          size: 100,
        },
      ],
      path: 'Aside-0.1.4-mac.zip',
      sha512,
      releaseDate: '2026-07-23T12:00:00.000Z',
    });
  });

  it('rejects mismatched versions and architectures', () => {
    expect(() =>
      buildMacUpdateMetadata({
        version: '0.1.4',
        releaseDate: '2026-07-23T12:00:00.000Z',
        x64: {
          filename: 'Aside-0.1.3-mac.zip',
          sha512,
          size: 123,
        },
        arm64: {
          filename: 'Aside-0.1.4-arm64-mac.zip',
          sha512,
          size: 100,
        },
      }),
    ).toThrow('Unexpected x64 update filename');
  });
});

describe('electron-builder release timestamp', () => {
  it('reuses the persisted timestamp for idempotent publication', () => {
    const metadata = [
      'version: 0.1.4',
      "releaseDate: '2026-07-23T12:00:00.000Z'",
      '',
    ].join('\n');

    expect(releaseDateFromBuilderMetadata(metadata, '0.1.4')).toBe(
      '2026-07-23T12:00:00.000Z',
    );
    expect(releaseDateFromBuilderMetadata(metadata, '0.1.4')).toBe(
      '2026-07-23T12:00:00.000Z',
    );
  });

  it('rejects stale or timestamp-free builder metadata', () => {
    expect(() =>
      releaseDateFromBuilderMetadata(
        "version: 0.1.3\nreleaseDate: '2026-07-23T12:00:00.000Z'\n",
        '0.1.4',
      ),
    ).toThrow('expected 0.1.4');
    expect(() =>
      releaseDateFromBuilderMetadata('version: 0.1.4\n', '0.1.4'),
    ).toThrow('no valid releaseDate');
  });
});

describe('update artifact routes', () => {
  it.each([
    [
      '/updates/Aside-0.1.4-mac.zip',
      {
        arch: 'x64',
        blockmap: false,
        key: 'releases/v0.1.4/Aside-0.1.4-mac.zip',
      },
    ],
    [
      '/updates/Aside-0.1.4-arm64-mac.zip.blockmap',
      {
        arch: 'arm64',
        blockmap: true,
        key: 'releases/v0.1.4/Aside-0.1.4-arm64-mac.zip.blockmap',
      },
    ],
  ])('maps %s to an immutable release object', (pathname, expected) => {
    expect(parseUpdateArtifactPath(pathname)).toMatchObject(expected);
  });

  it.each([
    '/updates/../../secret',
    '/updates/Aside-latest-mac.zip',
    '/updates/Aside-0.1.4-arm64.dmg',
    '/updates/v0.1.4/Aside-0.1.4-mac.zip',
    '/updates/Aside-0.1.4-mac.zip/extra',
  ])('rejects unsafe or unsupported path %s', (pathname) => {
    expect(parseUpdateArtifactPath(pathname)).toBeNull();
  });
});
