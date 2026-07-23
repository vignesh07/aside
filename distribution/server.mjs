import * as http from 'node:http';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  createReleaseStorage,
  loadReleaseManifest,
} from './release-storage.mjs';
import {
  releaseLinks,
  releasePlatformForPath,
} from './release-routes.mjs';

const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const SIGNED_URL_SECONDS = 15 * 60;
const MANIFEST_CACHE_MS = 60_000;
const { client, config } = createReleaseStorage();

let manifestCache = null;
let manifestCachedAt = 0;

async function currentManifest() {
  if (manifestCache && Date.now() - manifestCachedAt < MANIFEST_CACHE_MS) {
    return manifestCache;
  }
  manifestCache = await loadReleaseManifest(client, config.bucket);
  manifestCachedAt = Date.now();
  return manifestCache;
}

function json(response, status, value, includeBody = true) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(includeBody ? `${JSON.stringify(value, null, 2)}\n` : undefined);
}

const server = http.createServer(async (request, response) => {
  try {
    const method = request.method || 'GET';
    const includeBody = method !== 'HEAD';
    if (method !== 'GET' && method !== 'HEAD') {
      response.setHeader('allow', 'GET, HEAD');
      return json(response, 405, { error: 'Method not allowed' }, includeBody);
    }

    const origin = `https://${request.headers.host || 'localhost'}`;
    const url = new URL(request.url || '/', origin);
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

    const platform = releasePlatformForPath(url.pathname);
    if (!platform) {
      return json(response, 404, { error: 'Not found' }, includeBody);
    }
    const artifact = manifest.artifacts[platform];
    const signedUrl = await getSignedUrl(
      client,
      new GetObjectCommand({
        Bucket: config.bucket,
        Key: artifact.key,
        ResponseContentType: 'application/x-apple-diskimage',
        ResponseContentDisposition: `attachment; filename="${artifact.filename}"`,
      }),
      { expiresIn: SIGNED_URL_SECONDS },
    );
    if (method === 'GET') {
      console.log(JSON.stringify({
        event: 'release_download',
        platform,
        version: manifest.version,
        at: new Date().toISOString(),
      }));
    }
    response.writeHead(302, {
      location: signedUrl,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    });
    response.end();
  } catch (error) {
    console.error('release request failed', error);
    json(
      response,
      503,
      { error: 'Release temporarily unavailable' },
      request.method !== 'HEAD',
    );
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Aside release service listening on ${PORT}`);
});

function shutdown() {
  server.close(() => process.exit(0));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
