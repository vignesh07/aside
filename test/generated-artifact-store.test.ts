import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileGeneratedArtifactStore } from '../src/core/generated-artifact-store.js';
import type { GeneratedArtifact } from '../src/types/generated-artifact.js';

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryStore(): FileGeneratedArtifactStore {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'aside-generated-artifacts-'),
  );
  tempDirectories.push(directory);
  return new FileGeneratedArtifactStore(
    path.join(directory, 'private', 'artifacts.json'),
  );
}

function artifact(
  overrides: Partial<GeneratedArtifact> = {},
): GeneratedArtifact {
  return {
    id: 'daily:2026-07-26:abc123',
    kind: 'daily_recap',
    day: '2026-07-26',
    createdAt: '2026-07-26T21:15:00.000Z',
    provider: 'openai',
    model: 'gpt-5.6',
    inputHighWaterSeq: 42,
    inputHash: 'a'.repeat(64),
    evidenceIds: ['event-41', 'event-42'],
    markdown: '## Today\n\nTwo threads reached an outcome.',
    ...overrides,
  } as GeneratedArtifact;
}

describe('FileGeneratedArtifactStore', () => {
  it('round-trips both artifact kinds with provenance intact', () => {
    const store = temporaryStore();
    const daily = artifact();
    const review = artifact({
      id: 'review:codex:thread-1:abc123',
      kind: 'thread_review',
      day: undefined,
      threadKey: 'codex:thread-1',
      createdAt: '2026-07-26T21:16:00.000Z',
      inputHighWaterSeq: 48,
      inputHash: 'b'.repeat(64),
      evidenceIds: ['event-48'],
      markdown: '## Review\n\nThe test run completed.',
    });

    store.save([review, daily]);

    expect(store.load()).toEqual([daily, review]);
    expect(store.load()[1]).toMatchObject({
      kind: 'thread_review',
      provider: 'openai',
      model: 'gpt-5.6',
      inputHighWaterSeq: 48,
      evidenceIds: ['event-48'],
    });
  });

  it('writes a private atomic versioned snapshot', () => {
    const store = temporaryStore();
    store.save([artifact()]);

    expect(fs.statSync(path.dirname(store.location)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(store.location).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(store.location, 'utf-8'))).toMatchObject({
      version: 1,
      artifacts: [{ kind: 'daily_recap' }],
    });
    expect(
      fs
        .readdirSync(path.dirname(store.location))
        .filter((name) => name.endsWith('.tmp')),
    ).toEqual([]);
  });

  it('fails closed for corrupt, unsupported, or partially invalid state', () => {
    const store = temporaryStore();
    fs.mkdirSync(path.dirname(store.location), {
      recursive: true,
      mode: 0o700,
    });

    fs.writeFileSync(store.location, '{not json', { mode: 0o600 });
    expect(store.load()).toEqual([]);

    fs.writeFileSync(
      store.location,
      JSON.stringify({ version: 2, artifacts: [artifact()] }),
      { mode: 0o600 },
    );
    expect(store.load()).toEqual([]);

    fs.writeFileSync(
      store.location,
      JSON.stringify({
        version: 1,
        artifacts: [
          artifact(),
          artifact({ inputHash: 'not-a-sha256' }),
        ],
      }),
      { mode: 0o600 },
    );
    expect(store.load()).toEqual([]);
  });

  it('rejects invalid writes before replacing a valid snapshot', () => {
    const store = temporaryStore();
    const valid = artifact();
    store.save([valid]);

    expect(() =>
      store.save([
        artifact({
          evidenceIds: ['duplicate', 'duplicate'],
        }),
      ]),
    ).toThrow(TypeError);
    expect(store.load()).toEqual([valid]);

    expect(() =>
      store.save([
        artifact({
          markdown: 'x'.repeat(50_001),
        }),
      ]),
    ).toThrow(TypeError);
    expect(store.load()).toEqual([valid]);
  });

  it('fails closed before reading an oversized snapshot', () => {
    const store = temporaryStore();
    fs.mkdirSync(path.dirname(store.location), {
      recursive: true,
      mode: 0o700,
    });
    const descriptor = fs.openSync(store.location, 'w', 0o600);
    fs.ftruncateSync(descriptor, 8 * 1024 * 1024 + 1);
    fs.closeSync(descriptor);

    expect(store.load()).toEqual([]);
  });

  it('keeps only the most recent practical artifact count', () => {
    const store = temporaryStore();
    const artifacts = Array.from({ length: 501 }, (_, index) =>
      artifact({
        id: `daily:2026-07-26:${String(index).padStart(4, '0')}`,
        createdAt: new Date(
          Date.parse('2026-07-26T00:00:00.000Z') + index,
        ).toISOString(),
      }),
    );

    store.save(artifacts);

    const restored = store.load();
    expect(restored).toHaveLength(500);
    expect(restored[0]!.id).toBe('daily:2026-07-26:0001');
    expect(restored.at(-1)!.id).toBe('daily:2026-07-26:0500');
  });
});
