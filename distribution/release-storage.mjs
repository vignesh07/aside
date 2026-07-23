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

export function validateReleaseManifest(manifest) {
  if (
    !manifest ||
    manifest.schemaVersion !== 1 ||
    typeof manifest.version !== 'string' ||
    !manifest.artifacts ||
    typeof manifest.artifacts !== 'object'
  ) {
    throw new Error('Release manifest has an unsupported shape');
  }
  for (const platform of ['mac-arm64', 'mac-intel']) {
    const artifact = manifest.artifacts[platform];
    if (
      !artifact ||
      typeof artifact.key !== 'string' ||
      typeof artifact.filename !== 'string' ||
      typeof artifact.sha256 !== 'string'
    ) {
      throw new Error(`Release manifest is missing ${platform}`);
    }
  }
}
