import * as http from 'node:http';
import * as crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  createReleaseStorage,
  loadReleaseManifest,
  loadReleaseObjectText,
} from './release-storage.mjs';
import {
  releaseLinks,
  releasePlatformForPath,
} from './release-routes.mjs';
import {
  parseUpdateArtifactPath,
  UPDATE_METADATA_PATH,
} from './update-metadata.mjs';

const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const SIGNED_URL_SECONDS = 15 * 60;
const MANIFEST_CACHE_MS = 60_000;

function json(response, status, value, includeBody = true) {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(includeBody ? body : undefined);
}

function text(
  response,
  status,
  value,
  contentType,
  cacheControl,
  includeBody = true,
) {
  response.writeHead(status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(value),
    'cache-control': cacheControl,
    'x-content-type-options': 'nosniff',
  });
  response.end(includeBody ? value : undefined);
}

function isMissingObject(error) {
  return (
    error?.name === 'NotFound' ||
    error?.name === 'NoSuchKey' ||
    error?.$metadata?.httpStatusCode === 404
  );
}

function attachmentHeaders({
  contentLength,
  contentType,
  filename,
  immutable,
}) {
  return {
    'content-type': contentType,
    'content-length': contentLength ?? 0,
    'content-disposition': `attachment; filename="${filename}"`,
    'cache-control': immutable
      ? 'public, max-age=31536000, immutable'
      : 'no-store',
    'accept-ranges': 'bytes',
    'x-content-type-options': 'nosniff',
  };
}

export function createReleaseRequestHandler({
  client,
  bucket,
  loadManifest = loadReleaseManifest,
  loadObjectText = loadReleaseObjectText,
  signUrl = getSignedUrl,
  now = () => Date.now(),
  logger = console,
  manifestCacheMs = MANIFEST_CACHE_MS,
  signedUrlSeconds = SIGNED_URL_SECONDS,
}) {
  if (!client || !bucket) {
    throw new Error('Release request handler requires storage');
  }

  let manifestCache = null;
  let manifestCachedAt = 0;

  async function currentManifest() {
    const currentTime = now();
    if (
      manifestCache &&
      currentTime - manifestCachedAt < manifestCacheMs
    ) {
      return manifestCache;
    }
    manifestCache = await loadManifest(client, bucket);
    manifestCachedAt = currentTime;
    return manifestCache;
  }

  return async function releaseRequestHandler(request, response) {
    try {
      const method = request.method || 'GET';
      const includeBody = method !== 'HEAD';
      if (method !== 'GET' && method !== 'HEAD') {
        response.setHeader('allow', 'GET, HEAD');
        return json(response, 405, { error: 'Method not allowed' }, includeBody);
      }

      const origin = `https://${request.headers.host || 'localhost'}`;
      const url = new URL(request.url || '/', origin);

      // Versioned update artifacts are immutable and self-addressing. Serve
      // them without consulting the mutable latest-release manifest so clients
      // can finish differential downloads across a concurrent publication.
      const updateArtifact = parseUpdateArtifactPath(url.pathname);
      if (updateArtifact) {
        if (method === 'HEAD') {
          const head = await client.send(
            new HeadObjectCommand({
              Bucket: bucket,
              Key: updateArtifact.key,
            }),
          );
          response.writeHead(200, attachmentHeaders({
            contentLength: head.ContentLength,
            contentType: updateArtifact.contentType,
            filename: updateArtifact.filename,
            immutable: true,
          }));
          return response.end();
        }
        const signedUrl = await signUrl(
          client,
          new GetObjectCommand({
            Bucket: bucket,
            Key: updateArtifact.key,
            ResponseContentType: updateArtifact.contentType,
            ResponseContentDisposition:
              `attachment; filename="${updateArtifact.filename}"`,
          }),
          { expiresIn: signedUrlSeconds },
        );
        logger.log(JSON.stringify({
          event: 'automatic_update_download',
          arch: updateArtifact.arch,
          blockmap: updateArtifact.blockmap,
          version: updateArtifact.version,
          at: new Date(now()).toISOString(),
        }));
        response.writeHead(302, {
          location: signedUrl,
          'cache-control': 'no-store',
          'accept-ranges': 'bytes',
          'referrer-policy': 'no-referrer',
        });
        return response.end();
      }

      const manifest = await currentManifest();
      if (url.pathname === '/health') {
        return json(
          response,
          200,
          { ok: true, version: manifest.version },
          includeBody,
        );
      }
      if (url.pathname === '/' || url.pathname === '/releases/latest.json') {
        return json(response, 200, {
          product: 'Aside',
          version: manifest.version,
          publishedAt: manifest.publishedAt,
          downloads: releaseLinks(origin),
          artifacts: manifest.artifacts,
        }, includeBody);
      }

      if (url.pathname === UPDATE_METADATA_PATH) {
        if (manifest.schemaVersion < 2 || !manifest.updater?.metadata?.key) {
          return json(
            response,
            404,
            { error: 'No automatic update feed' },
            includeBody,
          );
        }
        const metadata = await loadObjectText(
          client,
          bucket,
          manifest.updater.metadata.key,
        );
        const metadataBytes = Buffer.from(metadata);
        const metadataDigest = crypto
          .createHash('sha256')
          .update(metadataBytes)
          .digest('hex');
        if (
          metadataBytes.length !== manifest.updater.metadata.size ||
          metadataDigest !== manifest.updater.metadata.sha256
        ) {
          throw new Error(
            'Automatic update metadata failed integrity validation',
          );
        }
        return text(
          response,
          200,
          metadata,
          'text/yaml; charset=utf-8',
          'no-store',
          includeBody,
        );
      }

      const platform = releasePlatformForPath(url.pathname);
      if (!platform) {
        return json(response, 404, { error: 'Not found' }, includeBody);
      }
      const artifact = manifest.artifacts[platform];
      if (method === 'HEAD') {
        const head = await client.send(
          new HeadObjectCommand({
            Bucket: bucket,
            Key: artifact.key,
          }),
        );
        response.writeHead(200, attachmentHeaders({
          contentLength: head.ContentLength,
          contentType: 'application/x-apple-diskimage',
          filename: artifact.filename,
          immutable: false,
        }));
        return response.end();
      }

      const signedUrl = await signUrl(
        client,
        new GetObjectCommand({
          Bucket: bucket,
          Key: artifact.key,
          ResponseContentType: 'application/x-apple-diskimage',
          ResponseContentDisposition:
            `attachment; filename="${artifact.filename}"`,
        }),
        { expiresIn: signedUrlSeconds },
      );
      logger.log(JSON.stringify({
        event: 'release_download',
        platform,
        version: manifest.version,
        at: new Date(now()).toISOString(),
      }));
      response.writeHead(302, {
        location: signedUrl,
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
      });
      return response.end();
    } catch (error) {
      if (isMissingObject(error)) {
        return json(
          response,
          404,
          { error: 'Release not found' },
          request.method !== 'HEAD',
        );
      }
      logger.error('release request failed', error);
      return json(
        response,
        503,
        { error: 'Release temporarily unavailable' },
        request.method !== 'HEAD',
      );
    }
  };
}

export function createReleaseServer(options) {
  return http.createServer(createReleaseRequestHandler(options));
}

export function startReleaseServer({
  port = PORT,
  host = '0.0.0.0',
  storage = createReleaseStorage(),
  logger = console,
} = {}) {
  const server = createReleaseServer({
    client: storage.client,
    bucket: storage.config.bucket,
    logger,
  });
  server.listen(port, host, () => {
    logger.log(`Aside release service listening on ${port}`);
  });
  return server;
}

const isMain =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const server = startReleaseServer();
  function shutdown() {
    server.close(() => process.exit(0));
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
