import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildFtsQuery,
  ThreadSearchReader,
  ThreadSearchWriter,
} from '../menubar/src/search-database.js';
import type { IndexableThread } from '../menubar/src/search-types.js';

const roots: string[] = [];

function tempIndex() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aside-search-index-'));
  roots.push(root);
  const reader = new ThreadSearchReader(path.join(root, 'search.sqlite'));
  const writer = new ThreadSearchWriter(path.join(root, 'search.sqlite'));
  return { root, reader, writer };
}

function codexLine(text: string): string {
  return JSON.stringify({
    timestamp: '2026-07-23T12:00:00Z',
    type: 'event_msg',
    payload: { type: 'user_message', message: text },
  });
}

function thread(root: string, id: string, title = ''): IndexableThread {
  return {
    sessionId: id,
    source: 'codex',
    jsonlPath: path.join(root, `${id}.jsonl`),
    projectName: 'search-project',
    projectPath: '/work/search-project',
    title,
    gitBranch: 'main',
    lastEventMs: Date.now(),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('thread content search index', () => {
  it('returns ranked threads with highlighted content snippets', async () => {
    const { root, reader, writer } = tempIndex();
    const first = thread(root, 'first', 'Ordinary work');
    const second = thread(root, 'second', 'Orbital banana plan');
    fs.writeFileSync(
      first.jsonlPath,
      `${codexLine('Investigate the orbital banana cache')}\n`,
    );
    fs.writeFileSync(
      second.jsonlPath,
      `${codexLine('Something unrelated')}\n`,
    );

    await writer.syncSessions([first, second], () => {});
    const results = reader.search('orbital ban');

    expect(results.map((result) => result.sessionId)).toEqual([
      'second',
      'first',
    ]);
    expect(results[0]?.kind).toBe('metadata');
    expect(results[1]?.snippet).toContainEqual({
      text: 'orbital',
      match: true,
    });
    writer.close();
    reader.close();
  });

  it('indexes only complete appended records and picks them up incrementally', async () => {
    const { root, reader, writer } = tempIndex();
    const session = thread(root, 'incremental');
    fs.writeFileSync(session.jsonlPath, `${codexLine('initial alpha')}\n`);
    await writer.syncSessions([session], () => {});

    const partial = codexLine('fresh zephyr result');
    fs.appendFileSync(session.jsonlPath, partial.slice(0, -2));
    session.lastEventMs += 1;
    await writer.syncSessions([session], () => {});
    expect(reader.search('zephyr')).toEqual([]);

    fs.appendFileSync(session.jsonlPath, `${partial.slice(-2)}\n`);
    session.lastEventMs += 1;
    await writer.syncSessions([session], () => {});
    expect(reader.search('zephyr')[0]?.sessionId).toBe('incremental');
    writer.close();
    reader.close();
  });

  it('rebuilds truncated transcripts and prunes deleted sessions', async () => {
    const { root, reader, writer } = tempIndex();
    const session = thread(root, 'replaceable');
    fs.writeFileSync(session.jsonlPath, `${codexLine('obsolete narwhal')}\n`);
    await writer.syncSessions([session], () => {});
    expect(reader.search('narwhal')).toHaveLength(1);

    fs.writeFileSync(session.jsonlPath, `${codexLine('replacement kestrel')}\n`);
    session.lastEventMs += 1;
    await writer.syncSessions([session], () => {});
    expect(reader.search('narwhal')).toEqual([]);
    expect(reader.search('kestrel')).toHaveLength(1);

    await writer.syncSessions([], () => {});
    expect(reader.search('kestrel')).toEqual([]);
    writer.close();
    reader.close();
  });

  it('skips unchanged transcript files without reopening their contents', async () => {
    const { root, reader, writer } = tempIndex();
    const session = thread(root, 'unchanged');
    fs.writeFileSync(session.jsonlPath, `${codexLine('stable capybara')}\n`);
    await writer.syncSessions([session], () => {});

    fs.chmodSync(session.jsonlPath, 0o000);
    await expect(writer.syncSessions([session], () => {})).resolves.toBeUndefined();
    expect(reader.search('capybara')).toHaveLength(1);

    fs.chmodSync(session.jsonlPath, 0o600);
    writer.close();
    reader.close();
  });

  it('redacts secret-shaped metadata before adding it to full-text search', async () => {
    const { root, reader, writer } = tempIndex();
    const session = thread(
      root,
      'metadata-secret',
      'password: "launch-secret-value"',
    );
    fs.writeFileSync(session.jsonlPath, `${codexLine('ordinary work')}\n`);

    await writer.syncSessions([session], () => {});

    expect(reader.search('launch-secret-value')).toEqual([]);
    expect(reader.search('redacted')[0]?.sessionId).toBe('metadata-secret');
    writer.close();
    reader.close();
  });

  it('makes durable side-chat turns searchable in their agent thread', async () => {
    const { root, reader, writer } = tempIndex();
    const session = thread(root, 'sidechat');
    fs.writeFileSync(session.jsonlPath, `${codexLine('ordinary work')}\n`);
    await writer.syncSessions([session], () => {});
    writer.syncSideChats([
      {
        sessionId: session.sessionId,
        updatedAt: '2026-07-23T12:00:00Z',
        turns: [
          {
            role: 'user',
            content: 'Why did we choose the heliotrope tokenizer?',
            timestamp: '2026-07-23T12:00:00Z',
          },
        ],
      },
    ]);

    const [result] = reader.search('heliotrope');
    expect(result).toMatchObject({
      sessionId: 'sidechat',
      kind: 'side_user',
    });
    writer.close();
    reader.close();
  });

  it('can clear the rebuildable index without touching source transcripts', async () => {
    const { root, reader, writer } = tempIndex();
    const session = thread(root, 'rebuildable');
    fs.writeFileSync(session.jsonlPath, `${codexLine('durable source quokka')}\n`);
    await writer.syncSessions([session], () => {});
    expect(reader.search('quokka')).toHaveLength(1);

    writer.clear();

    expect(reader.search('quokka')).toEqual([]);
    expect(fs.readFileSync(session.jsonlPath, 'utf8')).toContain('quokka');
    writer.close();
    reader.close();
  });

  it('keeps the database private to the current user', () => {
    const { root, reader, writer } = tempIndex();
    const mode = fs.statSync(path.join(root, 'search.sqlite')).mode & 0o777;
    expect(mode).toBe(0o600);
    writer.close();
    reader.close();
  });
});

describe('FTS query construction', () => {
  it('uses AND semantics and prefixes only the in-progress final token', () => {
    expect(buildFtsQuery('Railway auto depl')).toBe(
      '"railway" AND "auto" AND "depl"*',
    );
    expect(buildFtsQuery('Railway auto deploy ')).toBe(
      '"railway" AND "auto" AND "deploy"',
    );
  });

  it('does not run broad one- or two-character content queries', () => {
    expect(buildFtsQuery('a')).toBeNull();
    expect(buildFtsQuery('th')).toBeNull();
    expect(buildFtsQuery('the')).toBe('"the"*');
  });
});
