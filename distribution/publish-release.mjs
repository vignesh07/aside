import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import {
  createReleaseStorage,
  loadReleaseObjectMetadata,
  RELEASE_MANIFEST_KEY,
} from './release-storage.mjs';
import {
  buildMacUpdateMetadata,
  releaseDateFromBuilderMetadata,
} from './update-metadata.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const releaseDir = path.join(root, 'menubar', 'release');
const dryRun = process.argv.includes('--dry-run');
const versionOverride = process.argv.find((argument) =>
  argument.startsWith('--version='),
);
if (versionOverride) {
  throw new Error(
    'Release version overrides are disabled; bump every package before building',
  );
}

const packagePaths = [
  path.join(root, 'package.json'),
  path.join(root, 'menubar', 'package.json'),
  path.join(root, 'distribution', 'package.json'),
];
const packageVersions = packagePaths.map((filePath) =>
  JSON.parse(fs.readFileSync(filePath, 'utf8')).version,
);
const version = packageVersions[0];
if (!version || packageVersions.some((candidate) => candidate !== version)) {
  throw new Error(`Package versions do not match: ${packageVersions.join(', ')}`);
}

const dmgDefinitions = [
  {
    platform: 'mac-arm64',
    arch: 'arm64',
    filename: `Aside-${version}-arm64.dmg`,
  },
  {
    platform: 'mac-intel',
    arch: 'x64',
    filename: `Aside-${version}.dmg`,
  },
];
const updateDefinitions = [
  {
    platform: 'mac-arm64',
    arch: 'arm64',
    filename: `Aside-${version}-arm64-mac.zip`,
  },
  {
    platform: 'mac-intel',
    arch: 'x64',
    filename: `Aside-${version}-mac.zip`,
  },
];

function verifyDmg(filePath) {
  for (const [command, args] of [
    ['xcrun', ['stapler', 'validate', filePath]],
    [
      'spctl',
      [
        '--assess',
        '--type',
        'open',
        '--context',
        'context:primary-signature',
        '--verbose=2',
        filePath,
      ],
    ],
  ]) {
    execFileSync(command, args, { stdio: 'pipe' });
  }
}

function verifyZip(filePath, expectedArch) {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'aside-update-verify-'),
  );
  try {
    execFileSync('ditto', ['-x', '-k', filePath, temporaryDirectory], {
      stdio: 'pipe',
    });
    const appPath = path.join(temporaryDirectory, 'Aside.app');
    if (!fs.existsSync(appPath)) {
      throw new Error(`${path.basename(filePath)} does not contain Aside.app`);
    }
    const embeddedVersion = execFileSync(
      '/usr/libexec/PlistBuddy',
      ['-c', 'Print :CFBundleShortVersionString', path.join(appPath, 'Contents', 'Info.plist')],
      { encoding: 'utf8' },
    ).trim();
    if (embeddedVersion !== version) {
      throw new Error(
        `${path.basename(filePath)} contains Aside ${embeddedVersion}, expected ${version}`,
      );
    }
    const binaryPath = path.join(appPath, 'Contents', 'MacOS', 'Aside');
    const architectures = execFileSync('lipo', ['-archs', binaryPath], {
      encoding: 'utf8',
    })
      .trim()
      .split(/\s+/);
    const expectedMachArch = expectedArch === 'x64' ? 'x86_64' : 'arm64';
    if (
      architectures.length !== 1 ||
      architectures[0] !== expectedMachArch
    ) {
      throw new Error(
        `${path.basename(filePath)} contains ${architectures.join(', ') || 'no'} architecture, expected ${expectedMachArch}`,
      );
    }
    const updateConfigPath = path.join(
      appPath,
      'Contents',
      'Resources',
      'app-update.yml',
    );
    const updateConfig = fs.readFileSync(updateConfigPath, 'utf8');
    for (const required of [
      'provider: generic',
      'url: https://aside-production-fd82.up.railway.app/updates',
      'channel: latest',
      'useMultipleRangeRequest: false',
    ]) {
      if (!updateConfig.includes(required)) {
        throw new Error(
          `${path.basename(filePath)} has an invalid app-update.yml`,
        );
      }
    }
    execFileSync(
      process.execPath,
      [path.join(root, 'menubar', 'scripts', 'verify-signing.mjs'), appPath],
      { stdio: 'pipe' },
    );
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function builderReleaseDate() {
  const metadataPath = path.join(releaseDir, 'latest-mac.yml');
  if (!fs.existsSync(metadataPath)) {
    throw new Error(
      `Missing electron-builder update metadata: ${metadataPath}`,
    );
  }
  const metadata = fs.readFileSync(metadataPath, 'utf8');
  // This timestamp was persisted alongside the exact ZIP artifacts. Reusing it
  // keeps immutable metadata and the final manifest byte-stable across retries.
  return releaseDateFromBuilderMetadata(metadata, version);
}

function hashFile(filePath, algorithm, encoding) {
  const hash = crypto.createHash(algorithm);
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    for (;;) {
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest(encoding);
}

function localFileArtifact({
  filename,
  arch,
  contentType,
  contentDisposition,
}) {
  const filePath = path.join(releaseDir, filename);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing release artifact: ${filePath}`);
  }
  const stat = fs.statSync(filePath);
  return {
    filename,
    arch,
    filePath,
    key: `releases/v${version}/${filename}`,
    size: stat.size,
    sha256: hashFile(filePath, 'sha256', 'hex'),
    contentType,
    contentDisposition,
  };
}

function objectMatchesArtifact(metadata, artifact) {
  return (
    metadata?.size === artifact.size &&
    metadata?.sha256 === artifact.sha256
  );
}

async function uploadImmutableFile(client, bucket, artifact) {
  const existing = await loadReleaseObjectMetadata(
    client,
    bucket,
    artifact.key,
  );
  if (existing) {
    if (!objectMatchesArtifact(existing, artifact)) {
      throw new Error(
        `${artifact.key} already exists with different bytes; bump the release version`,
      );
    }
    console.log(`verified existing ${artifact.filename}`);
    return;
  }

  try {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: artifact.key,
        Body: fs.createReadStream(artifact.filePath),
        ContentLength: artifact.size,
        ContentType: artifact.contentType,
        ContentDisposition: artifact.contentDisposition,
        CacheControl: 'public, max-age=31536000, immutable',
        IfNoneMatch: '*',
        Metadata: {
          sha256: artifact.sha256,
          version,
          arch: artifact.arch,
        },
      }),
    );
    console.log(`uploaded ${artifact.filename}`);
  } catch (error) {
    if (
      error?.name !== 'PreconditionFailed' &&
      error?.$metadata?.httpStatusCode !== 412
    ) {
      throw error;
    }
    const raced = await loadReleaseObjectMetadata(client, bucket, artifact.key);
    if (!objectMatchesArtifact(raced, artifact)) {
      throw new Error(
        `${artifact.key} was concurrently published with different bytes`,
      );
    }
    console.log(`verified concurrently published ${artifact.filename}`);
  }
}

async function uploadImmutableBytes(client, bucket, artifact, body) {
  const existing = await loadReleaseObjectMetadata(
    client,
    bucket,
    artifact.key,
  );
  if (existing) {
    if (!objectMatchesArtifact(existing, artifact)) {
      throw new Error(
        `${artifact.key} already exists with different bytes; bump the release version`,
      );
    }
    console.log(`verified existing ${artifact.filename}`);
    return;
  }
  try {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: artifact.key,
        Body: body,
        ContentLength: artifact.size,
        ContentType: artifact.contentType,
        CacheControl: 'public, max-age=31536000, immutable',
        IfNoneMatch: '*',
        Metadata: {
          sha256: artifact.sha256,
          version,
        },
      }),
    );
    console.log(`uploaded ${artifact.filename}`);
  } catch (error) {
    if (
      error?.name !== 'PreconditionFailed' &&
      error?.$metadata?.httpStatusCode !== 412
    ) {
      throw error;
    }
    const raced = await loadReleaseObjectMetadata(
      client,
      bucket,
      artifact.key,
    );
    if (!objectMatchesArtifact(raced, artifact)) {
      throw new Error(
        `${artifact.key} was concurrently published with different bytes`,
      );
    }
    console.log(`verified concurrently published ${artifact.filename}`);
  }
}

const manualArtifacts = {};
const uploadFiles = [];
for (const definition of dmgDefinitions) {
  const artifact = localFileArtifact({
    ...definition,
    contentType: 'application/x-apple-diskimage',
    contentDisposition: `attachment; filename="${definition.filename}"`,
  });
  verifyDmg(artifact.filePath);
  uploadFiles.push(artifact);
  manualArtifacts[definition.platform] = {
    platform: 'darwin',
    arch: definition.arch,
    filename: definition.filename,
    key: artifact.key,
    size: artifact.size,
    sha256: artifact.sha256,
  };
}

const updaterArtifacts = {};
const metadataFiles = {};
for (const definition of updateDefinitions) {
  const zip = localFileArtifact({
    ...definition,
    contentType: 'application/zip',
    contentDisposition: `attachment; filename="${definition.filename}"`,
  });
  verifyZip(zip.filePath, definition.arch);
  zip.sha512 = hashFile(zip.filePath, 'sha512', 'base64');

  const blockmapFilename = `${definition.filename}.blockmap`;
  const blockmap = localFileArtifact({
    filename: blockmapFilename,
    arch: definition.arch,
    contentType: 'application/octet-stream',
    contentDisposition: `attachment; filename="${blockmapFilename}"`,
  });
  uploadFiles.push(zip, blockmap);
  metadataFiles[definition.arch] = {
    filename: zip.filename,
    sha512: zip.sha512,
    size: zip.size,
  };
  updaterArtifacts[definition.platform] = {
    platform: 'darwin',
    arch: definition.arch,
    filename: zip.filename,
    key: zip.key,
    size: zip.size,
    sha256: zip.sha256,
    sha512: zip.sha512,
    blockmap: {
      filename: blockmap.filename,
      key: blockmap.key,
      size: blockmap.size,
      sha256: blockmap.sha256,
    },
  };
}

const publishedAt = builderReleaseDate();
const updateMetadataBody = Buffer.from(
  buildMacUpdateMetadata({
    version,
    releaseDate: publishedAt,
    x64: metadataFiles.x64,
    arm64: metadataFiles.arm64,
  }),
);
const updateMetadataArtifact = {
  filename: 'latest-mac.yml',
  key: `releases/v${version}/latest-mac.yml`,
  size: updateMetadataBody.length,
  sha256: crypto.createHash('sha256').update(updateMetadataBody).digest('hex'),
  contentType: 'text/yaml; charset=utf-8',
};

const manifest = {
  schemaVersion: 2,
  product: 'Aside',
  version,
  publishedAt,
  artifacts: manualArtifacts,
  updater: {
    metadata: {
      filename: updateMetadataArtifact.filename,
      key: updateMetadataArtifact.key,
      size: updateMetadataArtifact.size,
      sha256: updateMetadataArtifact.sha256,
    },
    artifacts: updaterArtifacts,
  },
};

if (dryRun) {
  console.log(JSON.stringify(manifest, null, 2));
  process.exit(0);
}

const { client, config } = createReleaseStorage();
for (const artifact of uploadFiles) {
  await uploadImmutableFile(client, config.bucket, artifact);
}
await uploadImmutableBytes(
  client,
  config.bucket,
  updateMetadataArtifact,
  updateMetadataBody,
);

// The JSON manifest is the only mutable pointer. Publishing it last means every
// DMG, ZIP, blockmap and metadata object is already immutable and verified when
// clients first learn about the new version.
await client.send(
  new PutObjectCommand({
    Bucket: config.bucket,
    Key: RELEASE_MANIFEST_KEY,
    Body: `${JSON.stringify(manifest, null, 2)}\n`,
    ContentType: 'application/json; charset=utf-8',
    CacheControl: 'no-cache',
  }),
);
console.log(`published Aside ${version} to Railway Bucket ${config.bucket}`);
