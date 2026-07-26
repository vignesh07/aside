import { describe, expect, it } from 'vitest';
import {
  filterAttentionHierarchy,
  OLDER_AFTER_MS,
  groupSubagentsByRoot,
  groupThreadsByProject,
  splitThreadsByAge,
} from '../menubar/src/thread-groups.js';

function thread(
  id: string,
  projectName: string,
  projectPath: string,
  idleForMs: number,
  needsUser = false,
) {
  return { id, projectName, projectPath, idleForMs, needsUser };
}

describe('menubar thread hierarchy', () => {
  it('places threads at exactly seven days under Older Threads', () => {
    const sessions = [
      thread('recent', 'a', '/a', OLDER_AFTER_MS - 1),
      thread('older', 'b', '/b', OLDER_AFTER_MS),
    ];
    const split = splitThreadsByAge(sessions);
    expect(split.recent.map((item) => item.id)).toEqual(['recent']);
    expect(split.older.map((item) => item.id)).toEqual(['older']);
  });

  it('groups by folder path rather than conflating same-named projects', () => {
    const groups = groupThreadsByProject([
      thread('one', 'app', '/work/one/app', 20),
      thread('two', 'app', '/work/two/app', 10),
      thread('three', 'app', '/work/one/app', 30),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.find((group) => group.path === '/work/one/app')?.sessions).toHaveLength(2);
    expect(groups.map((group) => group.name).sort()).toEqual(['one / app', 'two / app']);
  });

  it('sorts needs-user threads first inside a project', () => {
    const [group] = groupThreadsByProject([
      thread('quiet', 'app', '/app', 10),
      thread('waiting', 'app', '/app', 50, true),
    ]);
    expect(group?.sessions.map((item) => item.id)).toEqual(['waiting', 'quiet']);
  });

  it('sorts every richer attention state ahead of ordinary recency', () => {
    const [group] = groupThreadsByProject([
      { ...thread('quiet', 'app', '/app', 10), needsAttention: false },
      { ...thread('completed', 'app', '/app', 50), needsAttention: true },
    ]);
    expect(group?.sessions.map((item) => item.id)).toEqual([
      'completed',
      'quiet',
    ]);
  });

  it('folds nested subagents beneath their user-owned root', () => {
    const base = {
      projectName: 'app',
      projectPath: '/app',
      needsUser: false,
    };
    const sessions = [
      { ...base, id: 'root', source: 'codex', idleForMs: 30, isInternal: false },
      {
        ...base,
        id: 'child',
        source: 'codex',
        idleForMs: 20,
        isInternal: true,
        parentSessionId: 'root',
      },
      {
        ...base,
        id: 'grandchild',
        source: 'codex',
        idleForMs: 10,
        isInternal: true,
        parentSessionId: 'child',
      },
      {
        ...base,
        id: 'orphan',
        source: 'codex',
        idleForMs: 5,
        isInternal: true,
        parentSessionId: 'missing',
      },
    ];

    expect(
      groupSubagentsByRoot(sessions)
        .get('codex:root')
        ?.map((session) => session.id),
    ).toEqual(['grandchild', 'child']);
  });

  it('keeps quiet roots as context for attentive subagents and removes unrelated workers', () => {
    const base = {
      projectName: 'app',
      projectPath: '/app',
      needsUser: false,
    };
    const quietRoot = {
      ...base,
      id: 'quiet-root',
      source: 'codex',
      idleForMs: 30,
      isInternal: false,
      needsAttention: false,
    };
    const attentiveRoot = {
      ...quietRoot,
      id: 'attentive-root',
      needsAttention: true,
    };
    const attentiveChild = {
      ...quietRoot,
      id: 'attentive-child',
      isInternal: true,
      parentSessionId: 'quiet-root',
      needsAttention: true,
    };
    const quietChild = {
      ...attentiveChild,
      id: 'quiet-child',
      needsAttention: false,
    };
    const attention = filterAttentionHierarchy(
      [quietRoot, attentiveRoot],
      new Map([
        ['codex:quiet-root', [attentiveChild, quietChild]],
      ]),
    );

    expect(attention.roots.map((session) => session.id)).toEqual([
      'quiet-root',
      'attentive-root',
    ]);
    expect(
      attention.subagentsByRoot
        .get('codex:quiet-root')
        ?.map((session) => session.id),
    ).toEqual(['attentive-child']);
  });
});
