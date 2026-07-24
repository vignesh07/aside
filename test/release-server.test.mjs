import * as crypto from 'node:crypto';
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createReleaseServer } from '../distribution/server.mjs';

const VERSION = '0.1.4';
const BUCKET = 'aside-releases';
const METADATA = [
  `version: "${VERSION}"`,
  'files:',
  `  - url: "Aside-${VERSION}-mac.zip"`,
  '',
].join('\n');

function releaseManifest() {
  return {
    schemaVersion: 2,
    product: 'Aside',
    version: VERSION,
    publishedAt: '2026-07-23T12:00:00.000Z',
    artifacts: {
      'mac-arm64': {
        filename: `Aside-${VERSION}-arm64.dmg`,
        key: `releases/v${VERSION}/Aside-${VERSION}-arm64.dmg`,
        size: 1_024,
        sha256: 'a'.repeat(64),
      },
      'mac-intel': {
        filename: `Aside-${VERSION}.dmg`,
        key: `releases/v${VERSION}/Aside-${VERSION}.dmg`,
        size: 2_048,
        sha256: 'b'.repeat(64),
      },
    },
    updater: {
      metadata: {
        filename: 'latest-mac.yml',
        key: `releases/v${VERSION}/latest-mac.yml`,
        size: Buffer.byteLength(METADATA),
        sha256: crypto.createHash('sha256').update(METADATA).digest('hex'),
      },
      artifacts: {},
    },
  };
}

function missingObject() {
  const error = new Error('missing');
  error.name = 'NoSuchKey';
  error.$metadata = { httpStatusCode: 404 };
  return error;
}

function createClient(heads = new Map()) {
  const commands = [];
  return {
    commands,
    async send(command) {
      commands.push(command);
      if (command instanceof HeadObjectCommand) {
        if (!heads.has(command.input.Key)) throw missingObject();
        return { ContentLength: heads.get(command.input.Key) };
      }
      throw new Error(`Unexpected command: ${command.constructor.name}`);
    },
  };
}

const openServers = new Set();

async function startServer(overrides = {}) {
  const client = overrides.client || createClient();
  const manifest = overrides.manifest || releaseManifest();
  const server = createReleaseServer({
    client,
    bucket: BUCKET,
    loadManifest: overrides.loadManifest || vi.fn(async () => manifest),
    loadObjectText:
      overrides.loadObjectText || vi.fn(async () => METADATA),
    signUrl:
      overrides.signUrl ||
      vi.fn(async (_client, command) => (
        `https://bucket.example/${encodeURIComponent(command.input.Key)}`
      )),
    logger: overrides.logger || {
      log: vi.fn(),
      error: vi.fn(),
    },
    now: () => Date.parse('2026-07-23T12:00:00.000Z'),
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  openServers.add(server);
  const address = server.address();
  return {
    client,
    origin: `http://127.0.0.1:${address.port}`,
    server,
  };
}

afterEach(async () => {
  await Promise.all(
    [...openServers].map(
      (server) =>
        new Promise((resolve) => {
          server.close(resolve);
        }),
    ),
  );
  openServers.clear();
});

describe('release server', () => {
  it('serves verified update metadata for GET and HEAD', async () => {
    const loadManifest = vi.fn(async () => releaseManifest());
    const loadObjectText = vi.fn(async () => METADATA);
    const { origin } = await startServer({ loadManifest, loadObjectText });

    const getResponse = await fetch(`${origin}/updates/latest-mac.yml`);
    expect(getResponse.status).toBe(200);
    expect(getResponse.headers.get('content-type')).toBe(
      'text/yaml; charset=utf-8',
    );
    expect(getResponse.headers.get('cache-control')).toBe('no-store');
    expect(await getResponse.text()).toBe(METADATA);

    const headResponse = await fetch(`${origin}/updates/latest-mac.yml`, {
      method: 'HEAD',
    });
    expect(headResponse.status).toBe(200);
    expect(headResponse.headers.get('content-length')).toBe(
      String(Buffer.byteLength(METADATA)),
    );
    expect(await headResponse.text()).toBe('');
    expect(loadManifest).toHaveBeenCalledTimes(1);
    expect(loadObjectText).toHaveBeenCalledTimes(2);
  });

  it('serves immutable update HEAD and redirects ranged GET without a manifest', async () => {
    const filename = `Aside-${VERSION}-arm64-mac.zip`;
    const key = `releases/v${VERSION}/${filename}`;
    const client = createClient(new Map([[key, 4_096]]));
    const loadManifest = vi.fn(async () => {
      throw new Error('immutable update route loaded the mutable manifest');
    });
    const signUrl = vi.fn(async () => 'https://bucket.example/signed-update');
    const { origin } = await startServer({
      client,
      loadManifest,
      signUrl,
    });

    const headResponse = await fetch(`${origin}/updates/${filename}`, {
      method: 'HEAD',
    });
    expect(headResponse.status).toBe(200);
    expect(headResponse.headers.get('content-length')).toBe('4096');
    expect(headResponse.headers.get('content-type')).toBe('application/zip');
    expect(headResponse.headers.get('accept-ranges')).toBe('bytes');
    expect(headResponse.headers.get('cache-control')).toContain('immutable');

    const getResponse = await fetch(`${origin}/updates/${filename}`, {
      headers: { range: 'bytes=0-1023' },
      redirect: 'manual',
    });
    expect(getResponse.status).toBe(302);
    expect(getResponse.headers.get('location')).toBe(
      'https://bucket.example/signed-update',
    );
    // The object store fulfills the Range after the redirect. Locally, the
    // release handler can guarantee that ranged requests still receive that
    // redirect and that the endpoint advertises byte-range support.
    expect(getResponse.headers.get('accept-ranges')).toBe('bytes');
    expect(signUrl).toHaveBeenCalledTimes(1);
    expect(signUrl.mock.calls[0][1].input).toMatchObject({
      Bucket: BUCKET,
      Key: key,
      ResponseContentType: 'application/zip',
    });
    expect(loadManifest).not.toHaveBeenCalled();
  });

  it('returns 404 when release objects are missing', async () => {
    const client = createClient();
    const loadObjectText = vi.fn(async () => {
      throw missingObject();
    });
    const { origin } = await startServer({ client, loadObjectText });

    const updateHead = await fetch(
      `${origin}/updates/Aside-${VERSION}-mac.zip`,
      { method: 'HEAD' },
    );
    expect(updateHead.status).toBe(404);
    expect(await updateHead.text()).toBe('');

    const metadataGet = await fetch(`${origin}/updates/latest-mac.yml`);
    expect(metadataGet.status).toBe(404);
    expect(await metadataGet.json()).toEqual({ error: 'Release not found' });
  });

  it('uses HeadObject rather than a redirect for manual download HEAD', async () => {
    const manifest = releaseManifest();
    const artifact = manifest.artifacts['mac-arm64'];
    const client = createClient(new Map([[artifact.key, artifact.size]]));
    const signUrl = vi.fn(async () => 'https://bucket.example/unused');
    const { origin } = await startServer({ client, manifest, signUrl });

    const response = await fetch(`${origin}/download/mac-arm64`, {
      method: 'HEAD',
      redirect: 'manual',
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('content-length')).toBe(String(artifact.size));
    expect(response.headers.get('content-type')).toBe(
      'application/x-apple-diskimage',
    );
    expect(response.headers.get('content-disposition')).toBe(
      `attachment; filename="${artifact.filename}"`,
    );
    expect(client.commands).toHaveLength(1);
    expect(client.commands[0]).toBeInstanceOf(HeadObjectCommand);
    expect(client.commands[0].input).toEqual({
      Bucket: BUCKET,
      Key: artifact.key,
    });
    expect(signUrl).not.toHaveBeenCalled();
  });

  it('redirects manual download GET to the latest manifest artifact', async () => {
    const manifest = releaseManifest();
    const artifact = manifest.artifacts['mac-intel'];
    const signUrl = vi.fn(async () => 'https://bucket.example/signed-dmg');
    const { origin } = await startServer({ manifest, signUrl });

    const response = await fetch(`${origin}/download/mac-intel`, {
      redirect: 'manual',
    });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(
      'https://bucket.example/signed-dmg',
    );
    expect(signUrl).toHaveBeenCalledTimes(1);
    expect(signUrl.mock.calls[0][1].input).toMatchObject({
      Bucket: BUCKET,
      Key: artifact.key,
      ResponseContentType: 'application/x-apple-diskimage',
    });
  });
});
