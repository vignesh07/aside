import { describe, expect, it } from 'vitest';
import {
  OLDER_AFTER_MS,
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
});
