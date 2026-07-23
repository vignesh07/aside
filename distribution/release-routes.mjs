const ROUTES = new Map([
  ['/download/mac-arm64', 'mac-arm64'],
  ['/download/mac-intel', 'mac-intel'],
  ['/download/mac-x64', 'mac-intel'],
  ['/download/aside-mac-arm64.dmg', 'mac-arm64'],
  ['/download/aside-mac-intel.dmg', 'mac-intel'],
]);

export function releasePlatformForPath(pathname) {
  return ROUTES.get(pathname.toLowerCase()) ?? null;
}

export function releaseLinks(origin) {
  return {
    macArm64: new URL('/download/mac-arm64', origin).href,
    macIntel: new URL('/download/mac-intel', origin).href,
  };
}
