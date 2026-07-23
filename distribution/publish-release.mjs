import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import {
  createReleaseStorage,
  loadReleaseObjectMetadata,
  RELEASE_MANIFEST_KEY,
} from './release-storage.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const packageJson = JSON.parse(
  fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
);
const versionArg = process.argv.find((argument) => argument.startsWith('--version='));
const version = versionArg?.slice('--version='.length) || packageJson.version;
const dryRun = process.argv.includes('--dry-run');
const releaseDir = path.join(root, 'menubar', 'release');

const artifacts = [
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

function sha256(filePath) {
  const hash = crypto.createHash('sha256');
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
  return hash.digest('hex');
}

function objectMatchesArtifact(metadata, artifact) {
  return (
    metadata?.size === artifact.size &&
    metadata?.sha256 === artifact.sha256
  );
}

async function uploadImmutableArtifact(client, bucket, artifact) {
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
        Body: fs.createReadStream(path.join(releaseDir, artifact.filename)),
        ContentLength: artifact.size,
        ContentType: 'application/x-apple-diskimage',
        ContentDisposition: `attachment; filename="${artifact.filename}"`,
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

const manifest = {
  schemaVersion: 1,
  product: 'Aside',
  version,
  publishedAt: new Date().toISOString(),
  artifacts: {},
};

for (const artifact of artifacts) {
  const filePath = path.join(releaseDir, artifact.filename);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing release artifact: ${filePath}`);
  }
  verifyDmg(filePath);
  const stat = fs.statSync(filePath);
  const digest = sha256(filePath);
  manifest.artifacts[artifact.platform] = {
    platform: 'darwin',
    arch: artifact.arch,
    filename: artifact.filename,
    key: `releases/v${version}/${artifact.filename}`,
    size: stat.size,
    sha256: digest,
  };
}

if (dryRun) {
  console.log(JSON.stringify(manifest, null, 2));
  process.exit(0);
}

const { client, config } = createReleaseStorage();
for (const artifact of Object.values(manifest.artifacts)) {
  await uploadImmutableArtifact(client, config.bucket, artifact);
}

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
