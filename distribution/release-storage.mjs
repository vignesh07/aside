import {
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

export const RELEASE_MANIFEST_KEY = 'releases/latest.json';

function firstEnv(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  return '';
}

export function releaseStorageConfig() {
  const config = {
    bucket: firstEnv('BUCKET', 'AWS_S3_BUCKET_NAME', 'ASIDE_RELEASE_BUCKET'),
    endpoint: firstEnv('ENDPOINT', 'AWS_ENDPOINT_URL', 'ASIDE_RELEASE_ENDPOINT'),
    accessKeyId: firstEnv(
      'ACCESS_KEY_ID',
      'AWS_ACCESS_KEY_ID',
      'ASIDE_RELEASE_ACCESS_KEY_ID',
    ),
    secretAccessKey: firstEnv(
      'SECRET_ACCESS_KEY',
      'AWS_SECRET_ACCESS_KEY',
      'ASIDE_RELEASE_SECRET_ACCESS_KEY',
    ),
    region: firstEnv(
      'REGION',
      'AWS_DEFAULT_REGION',
      'ASIDE_RELEASE_REGION',
    ) || 'auto',
    urlStyle: firstEnv('AWS_S3_URL_STYLE') || 'virtual',
  };
  const missing = Object.entries(config)
    .filter(([key, value]) => key !== 'urlStyle' && !value)
    .map(([key]) => key);
  if (missing.length > 0) {
    throw new Error(
      `Missing Railway Bucket configuration: ${missing.join(', ')}`,
    );
  }
  return config;
}

export function createReleaseStorage() {
  const config = releaseStorageConfig();
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.urlStyle === 'path',
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    maxAttempts: 3,
  });
  return { client, config };
}

export async function loadReleaseManifest(client, bucket) {
  const response = await client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: RELEASE_MANIFEST_KEY,
    }),
  );
  const raw = await response.Body?.transformToString();
  if (!raw) throw new Error('Release manifest is empty');
  const manifest = JSON.parse(raw);
  validateReleaseManifest(manifest);
  return manifest;
}

export async function loadReleaseObjectText(client, bucket, key) {
  const response = await client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    }),
  );
  const raw = await response.Body?.transformToString();
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error(`Release object is empty: ${key}`);
  }
  return raw;
}

export async function loadReleaseObjectMetadata(client, bucket, key) {
  try {
    const response = await client.send(
      new HeadObjectCommand({
        Bucket: bucket,
        Key: key,
      }),
    );
    return {
      size: response.ContentLength,
      sha256: response.Metadata?.sha256,
    };
  } catch (error) {
    if (
      error?.name === 'NotFound' ||
      error?.name === 'NoSuchKey' ||
      error?.$metadata?.httpStatusCode === 404
    ) {
      return null;
    }
    throw error;
  }
}

const SHA256 = /^[a-f0-9]{64}$/;
const SHA512_BASE64 = /^[A-Za-z0-9+/]{86}==$/;

function isPositiveSafeSize(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isSha512Base64(value) {
  if (typeof value !== 'string' || !SHA512_BASE64.test(value)) return false;
  const decoded = Buffer.from(value, 'base64');
  return decoded.length === 64 && decoded.toString('base64') === value;
}

function validateArtifact({
  artifact,
  expectedFilename,
  expectedVersion,
  label,
  expectedArch,
  requireSha512 = false,
}) {
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
    throw new Error(`Release manifest is missing ${label}`);
  }
  if (artifact.filename !== expectedFilename) {
    throw new Error(`Release manifest has an unexpected ${label} filename`);
  }
  if (
    artifact.key !==
    `releases/v${expectedVersion}/${expectedFilename}`
  ) {
    throw new Error(`Release manifest has an unsafe ${label} key`);
  }
  if (!isPositiveSafeSize(artifact.size)) {
    throw new Error(`Release manifest has an invalid ${label} size`);
  }
  if (typeof artifact.sha256 !== 'string' || !SHA256.test(artifact.sha256)) {
    throw new Error(`Release manifest has an invalid ${label} SHA-256`);
  }
  if (requireSha512 && !isSha512Base64(artifact.sha512)) {
    throw new Error(`Release manifest has an invalid ${label} SHA-512`);
  }
  if (
    expectedArch &&
    (artifact.platform !== 'darwin' || artifact.arch !== expectedArch)
  ) {
    throw new Error(`Release manifest has an invalid ${label} architecture`);
  }
}

export function validateReleaseManifest(manifest) {
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    Array.isArray(manifest) ||
    (manifest.schemaVersion !== 1 && manifest.schemaVersion !== 2) ||
    manifest.product !== 'Aside' ||
    typeof manifest.version !== 'string' ||
    !/^\d+\.\d+\.\d+$/.test(manifest.version) ||
    !manifest.artifacts ||
    typeof manifest.artifacts !== 'object' ||
    Array.isArray(manifest.artifacts)
  ) {
    throw new Error('Release manifest has an unsupported shape');
  }

  const manualArtifacts = [
    {
      platform: 'mac-arm64',
      arch: 'arm64',
      filename: `Aside-${manifest.version}-arm64.dmg`,
    },
    {
      platform: 'mac-intel',
      arch: 'x64',
      filename: `Aside-${manifest.version}.dmg`,
    },
  ];
  for (const expected of manualArtifacts) {
    validateArtifact({
      artifact: manifest.artifacts[expected.platform],
      expectedFilename: expected.filename,
      expectedVersion: manifest.version,
      expectedArch: expected.arch,
      label: expected.platform,
    });
  }
  if (manifest.schemaVersion === 1) return;

  const metadata = manifest.updater?.metadata;
  validateArtifact({
    artifact: metadata,
    expectedFilename: 'latest-mac.yml',
    expectedVersion: manifest.version,
    label: 'updater metadata',
  });

  const updaterArtifacts = [
    {
      platform: 'mac-arm64',
      arch: 'arm64',
      filename: `Aside-${manifest.version}-arm64-mac.zip`,
    },
    {
      platform: 'mac-intel',
      arch: 'x64',
      filename: `Aside-${manifest.version}-mac.zip`,
    },
  ];
  for (const expected of updaterArtifacts) {
    const label = `updater ${expected.platform}`;
    const artifact = manifest.updater?.artifacts?.[expected.platform];
    validateArtifact({
      artifact,
      expectedFilename: expected.filename,
      expectedVersion: manifest.version,
      expectedArch: expected.arch,
      label,
      requireSha512: true,
    });
    validateArtifact({
      artifact: artifact.blockmap,
      expectedFilename: `${expected.filename}.blockmap`,
      expectedVersion: manifest.version,
      label: `${label} blockmap`,
    });
  }
}
