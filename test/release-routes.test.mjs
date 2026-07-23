import { describe, expect, it } from 'vitest';
import {
  releaseLinks,
  releasePlatformForPath,
} from '../distribution/release-routes.mjs';

describe('release download routes', () => {
  it('keeps stable links independent of the release version', () => {
    expect(releasePlatformForPath('/download/mac-arm64')).toBe('mac-arm64');
    expect(releasePlatformForPath('/download/mac-intel')).toBe('mac-intel');
    expect(releasePlatformForPath('/download/mac-x64')).toBe('mac-intel');
  });

  it('does not map arbitrary bucket keys', () => {
    expect(releasePlatformForPath('/download/../../secret')).toBeNull();
  });

  it('builds absolute links for the release response', () => {
    expect(releaseLinks('https://aside.example')).toEqual({
      macArm64: 'https://aside.example/download/mac-arm64',
      macIntel: 'https://aside.example/download/mac-intel',
    });
  });
});
