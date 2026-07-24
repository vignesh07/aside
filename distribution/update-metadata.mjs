const VERSION = /^\d+\.\d+\.\d+$/;
const UPDATE_FILE =
  /^Aside-(\d+\.\d+\.\d+)(-arm64)?-mac\.zip(\.blockmap)?$/;

export const UPDATE_METADATA_PATH = '/updates/latest-mac.yml';

export function releaseDateFromBuilderMetadata(metadata, version) {
  if (typeof metadata !== 'string') {
    throw new Error('electron-builder metadata is not text');
  }
  assertVersion(version);
  const metadataVersion = metadata.match(
    /^version:\s*['"]?([^'"\s]+)['"]?\s*$/m,
  )?.[1];
  if (metadataVersion !== version) {
    throw new Error(
      `electron-builder metadata is for ${metadataVersion ?? 'an unknown version'}, expected ${version}`,
    );
  }
  const dateMatch = metadata.match(
    /^releaseDate:\s*(?:'([^']+)'|"([^"]+)"|(\S+))\s*$/m,
  );
  const value = dateMatch?.[1] ?? dateMatch?.[2] ?? dateMatch?.[3];
  if (!value || !Number.isFinite(Date.parse(value))) {
    throw new Error('electron-builder metadata has no valid releaseDate');
  }
  return new Date(value).toISOString();
}

export function buildMacUpdateMetadata({
  version,
  releaseDate,
  x64,
  arm64,
}) {
  assertVersion(version);
  assertUpdateFile(x64, version, 'x64');
  assertUpdateFile(arm64, version, 'arm64');
  if (!Number.isFinite(Date.parse(releaseDate))) {
    throw new Error('Update metadata requires an ISO release date');
  }

  // JSON strings are valid YAML scalars and safely quote every filename/hash.
  // Keep x64 as the legacy top-level path; >=2.16 clients select the correct
  // architecture from the authoritative files array.
  return [
    `version: ${JSON.stringify(version)}`,
    'files:',
    ...[x64, arm64].flatMap((file) => [
      `  - url: ${JSON.stringify(file.filename)}`,
      `    sha512: ${JSON.stringify(file.sha512)}`,
      `    size: ${file.size}`,
    ]),
    `path: ${JSON.stringify(x64.filename)}`,
    `sha512: ${JSON.stringify(x64.sha512)}`,
    `releaseDate: ${JSON.stringify(new Date(releaseDate).toISOString())}`,
    '',
  ].join('\n');
}

export function parseUpdateArtifactPath(pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith('/updates/')) {
    return null;
  }
  const filename = pathname.slice('/updates/'.length);
  const match = filename.match(UPDATE_FILE);
  if (!match) return null;

  const version = match[1];
  const arch = match[2] ? 'arm64' : 'x64';
  const blockmap = Boolean(match[3]);
  return {
    version,
    arch,
    blockmap,
    filename,
    key: `releases/v${version}/${filename}`,
    contentType: blockmap ? 'application/octet-stream' : 'application/zip',
  };
}

function assertUpdateFile(file, version, arch) {
  if (
    !file ||
    typeof file.filename !== 'string' ||
    typeof file.sha512 !== 'string' ||
    !Number.isSafeInteger(file.size) ||
    file.size <= 0
  ) {
    throw new Error(`Update metadata is missing ${arch}`);
  }
  const expected =
    arch === 'arm64'
      ? `Aside-${version}-arm64-mac.zip`
      : `Aside-${version}-mac.zip`;
  if (file.filename !== expected) {
    throw new Error(`Unexpected ${arch} update filename`);
  }
  if (!/^[A-Za-z0-9+/]{86}==$/.test(file.sha512)) {
    throw new Error(`Invalid ${arch} SHA-512`);
  }
}

function assertVersion(version) {
  if (typeof version !== 'string' || !VERSION.test(version)) {
    throw new Error('Invalid update version');
  }
}
