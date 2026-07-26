export const OLDER_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export interface GroupableThread {
  projectName: string;
  projectPath: string;
  idleForMs: number;
  needsUser: boolean;
  needsAttention?: boolean;
}

export interface HierarchicalThread extends GroupableThread {
  id: string;
  source: string;
  isInternal: boolean;
  parentSessionId?: string;
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
          Number(b.needsAttention ?? b.needsUser) -
            Number(a.needsAttention ?? a.needsUser) ||
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

/**
 * Flattens nested worker trees beneath their nearest user-owned root. Missing
 * parents and cycles are intentionally omitted from the sidebar hierarchy;
 * their transcripts remain available to content search.
 */
export function groupSubagentsByRoot<T extends HierarchicalThread>(
  sessions: T[],
): Map<string, T[]> {
  const byKey = new Map(
    sessions.map((session) => [threadKey(session), session]),
  );
  const grouped = new Map<string, T[]>();

  for (const session of sessions) {
    if (!session.isInternal) continue;
    let current: T | undefined = session;
    const visited = new Set<string>();
    while (current?.isInternal) {
      const key = threadKey(current);
      if (visited.has(key) || !current.parentSessionId) {
        current = undefined;
        break;
      }
      visited.add(key);
      current = byKey.get(`${current.source}:${current.parentSessionId}`);
    }
    if (!current) continue;
    const rootKey = threadKey(current);
    const children = grouped.get(rootKey) ?? [];
    children.push(session);
    grouped.set(rootKey, children);
  }

  for (const children of grouped.values()) {
    children.sort((a, b) => a.idleForMs - b.idleForMs);
  }
  return grouped;
}

/**
 * Keep an attentive root or the quiet root that owns an attentive subagent,
 * while removing unrelated workers from the focused Attention view.
 */
export function filterAttentionHierarchy<T extends HierarchicalThread>(
  roots: T[],
  subagentsByRoot: Map<string, T[]>,
): { roots: T[]; subagentsByRoot: Map<string, T[]> } {
  const attentiveSubagents = new Map<string, T[]>();
  for (const [rootKey, subagents] of subagentsByRoot) {
    const filtered = subagents.filter((session) => session.needsAttention);
    if (filtered.length > 0) attentiveSubagents.set(rootKey, filtered);
  }
  return {
    roots: roots.filter(
      (session) =>
        session.needsAttention ||
        attentiveSubagents.has(threadKey(session)),
    ),
    subagentsByRoot: attentiveSubagents,
  };
}

export function threadKey(thread: Pick<HierarchicalThread, 'id' | 'source'>): string {
  return `${thread.source}:${thread.id}`;
}

function disambiguatedFolderName(projectPath: string, projectName: string): string {
  const parts = projectPath.split(/[\\/]/).filter(Boolean);
  const parent = parts.at(-2);
  return parent && parent !== projectName
    ? `${parent} / ${projectName}`
    : projectName;
}
