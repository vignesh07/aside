export const OLDER_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export interface GroupableThread {
  projectName: string;
  projectPath: string;
  idleForMs: number;
  needsUser: boolean;
}

export interface ProjectGroup<T extends GroupableThread> {
  key: string;
  name: string;
  path: string;
  sessions: T[];
}

export function splitThreadsByAge<T extends GroupableThread>(
  sessions: T[],
): { recent: T[]; older: T[] } {
  return {
    recent: sessions.filter((session) => session.idleForMs < OLDER_AFTER_MS),
    older: sessions.filter((session) => session.idleForMs >= OLDER_AFTER_MS),
  };
}

export function groupThreadsByProject<T extends GroupableThread>(
  sessions: T[],
): ProjectGroup<T>[] {
  const byProject = new Map<string, ProjectGroup<T>>();
  for (const session of sessions) {
    const key = session.projectPath || `name:${session.projectName}`;
    const group = byProject.get(key) ?? {
      key,
      name: session.projectName,
      path: session.projectPath,
      sessions: [],
    };
    group.sessions.push(session);
    byProject.set(key, group);
  }
  const groups = [...byProject.values()];
  const nameCounts = new Map<string, number>();
  for (const group of groups) {
    nameCounts.set(group.name, (nameCounts.get(group.name) ?? 0) + 1);
  }

  return groups
    .map((group) => ({
      ...group,
      name:
        (nameCounts.get(group.name) ?? 0) > 1
          ? disambiguatedFolderName(group.path, group.name)
          : group.name,
      sessions: [...group.sessions].sort(
        (a, b) =>
          Number(b.needsUser) - Number(a.needsUser) ||
          a.idleForMs - b.idleForMs,
      ),
    }))
    .sort(
      (a, b) =>
        Math.min(...a.sessions.map((session) => session.idleForMs)) -
          Math.min(...b.sessions.map((session) => session.idleForMs)) ||
        a.name.localeCompare(b.name),
    );
}

function disambiguatedFolderName(projectPath: string, projectName: string): string {
  const parts = projectPath.split(/[\\/]/).filter(Boolean);
  const parent = parts.at(-2);
  return parent && parent !== projectName
    ? `${parent} / ${projectName}`
    : projectName;
}
