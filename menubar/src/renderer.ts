// Renderer for the menubar window. It receives immutable state over the narrow
// preload bridge; model output is always rendered with textContent.

import type { MenubarState, SessionSummary } from './backend.js';
import { stripMarkdown } from '../../dist/utils/markdown.js';
import {
  groupThreadsByProject,
  splitThreadsByAge,
  type ProjectGroup,
} from './thread-groups.js';

interface AsideBridge {
  getState(): Promise<MenubarState>;
  selectThread(threadId: string): Promise<void>;
  ask(question: string): Promise<void>;
  setModel(provider: string, model: string): Promise<void>;
  openDataFolder(): Promise<void>;
  quit(): Promise<void>;
  onUpdate(callback: (state: MenubarState) => void): () => void;
  onShowSettings(callback: () => void): () => void;
}

declare global {
  interface Window {
    aside: AsideBridge;
  }
}

const FLEET_THREAD_ID = 'fleet';
const threadsEl = document.getElementById('threads') as HTMLDivElement;
const searchEl = document.getElementById('thread-search') as HTMLInputElement;
const modelsEl = document.getElementById('models') as HTMLSelectElement;
const messagesEl = document.getElementById('messages') as HTMLDivElement;
const formEl = document.getElementById('composer') as HTMLFormElement;
const inputEl = document.getElementById('input') as HTMLInputElement;
const sendEl = document.getElementById('send') as HTMLButtonElement;
const scopeTitleEl = document.getElementById('scope-title') as HTMLHeadingElement;
const scopeMetaEl = document.getElementById('scope-meta') as HTMLDivElement;
const needsCountEl = document.getElementById('needs-count') as HTMLSpanElement;
const threadCountEl = document.getElementById('thread-count') as HTMLSpanElement;
const settingsEl = document.getElementById('settings') as HTMLDivElement;
const settingsButtonEl = document.getElementById('settings-button') as HTMLButtonElement;
const settingsCloseEl = document.getElementById('settings-close') as HTMLButtonElement;
const openDataEl = document.getElementById('open-data') as HTMLButtonElement;
const quitEl = document.getElementById('quit') as HTMLButtonElement;
const storagePathEl = document.getElementById('storage-path') as HTMLSpanElement;
const diagnosticsEl = document.getElementById('diagnostics') as HTMLDivElement;
const privacyBannerEl = document.getElementById('privacy-banner') as HTMLDivElement;
const privacyDismissEl = document.getElementById('privacy-dismiss') as HTMLButtonElement;

let latestState: MenubarState | null = null;
let lastRenderedThread = '';
let wasThinking = false;
let searchQuery = '';
let olderCollapsed = true;
const collapsedProjects = new Set<string>();
const expandedOlderProjects = new Set<string>();

const modelKey = (provider: string, model: string) => `${provider}:${model}`;

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function sourceGlyph(source: string): string {
  if (source === 'claude') return 'C';
  if (source === 'codex') return 'X';
  return 'P';
}

function activeSession(state: MenubarState): SessionSummary | undefined {
  return state.sessions.find((session) => session.threadId === state.activeThreadId);
}

function makeThreadButton(
  state: MenubarState,
  options: {
    threadId: string;
    title: string;
    subtitle: string;
    source?: string;
    needsUser?: boolean;
    reason?: string;
    nested?: boolean;
  },
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `thread${state.activeThreadId === options.threadId ? ' active' : ''}${
    options.needsUser ? ' needs-user' : ''
  }${options.nested ? ' nested' : ''}`;
  button.dataset['threadId'] = options.threadId;

  const icon = document.createElement('span');
  icon.className = options.source ? `source source-${options.source}` : 'source fleet';
  icon.textContent = options.source ? sourceGlyph(options.source) : '⌘';

  const copy = document.createElement('span');
  copy.className = 'thread-copy';
  const title = document.createElement('span');
  title.className = 'thread-title';
  title.textContent = options.title;
  const subtitle = document.createElement('span');
  subtitle.className = 'thread-subtitle';
  subtitle.textContent = options.needsUser
    ? options.reason || 'Waiting for your input'
    : options.subtitle;
  copy.append(title, subtitle);

  button.append(icon, copy);
  if (options.needsUser) {
    const badge = document.createElement('span');
    badge.className = 'attention-dot';
    badge.title = 'Needs you';
    badge.textContent = '';
    button.appendChild(badge);
  }
  button.addEventListener('click', () => void window.aside.selectThread(options.threadId));
  return button;
}

function makeGroupButton(
  group: ProjectGroup<SessionSummary>,
  collapsed: boolean,
  onToggle: () => void,
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'thread-group project';
  button.title = group.path || group.name;
  button.setAttribute('aria-expanded', String(!collapsed));

  const disclosure = document.createElement('span');
  disclosure.className = 'disclosure';
  disclosure.textContent = collapsed ? '▶' : '▼';
  const name = document.createElement('span');
  name.className = 'group-name';
  name.textContent = group.name;
  const count = document.createElement('span');
  count.className = 'group-count';
  count.textContent = String(group.sessions.length);
  button.append(disclosure, name, count);
  button.addEventListener('click', onToggle);
  return button;
}

function appendProjectGroups(
  state: MenubarState,
  groups: ProjectGroup<SessionSummary>[],
  searching: boolean,
  defaultCollapsed = false,
): void {
  for (const group of groups) {
    const collapsed =
      !searching &&
      (defaultCollapsed
        ? !expandedOlderProjects.has(group.key)
        : collapsedProjects.has(group.key));
    threadsEl.appendChild(
      makeGroupButton(group, collapsed, () => {
        if (defaultCollapsed) {
          if (expandedOlderProjects.has(group.key)) expandedOlderProjects.delete(group.key);
          else expandedOlderProjects.add(group.key);
        } else if (collapsedProjects.has(group.key)) {
          collapsedProjects.delete(group.key);
        } else {
          collapsedProjects.add(group.key);
        }
        if (latestState) renderThreads(latestState);
      }),
    );
    if (collapsed) continue;
    for (const session of group.sessions) {
      threadsEl.appendChild(
        makeThreadButton(state, {
          threadId: session.threadId,
          title: session.title || session.projectName,
          subtitle: session.title
            ? `${session.source} · ${session.status}${
                session.status === 'active' ? '' : ` · ${formatDuration(session.idleForMs)}`
              }`
            : session.currentActivity ||
              `${session.source} · ${session.status}${
                session.status === 'active' ? '' : ` · ${formatDuration(session.idleForMs)}`
              }`,
          source: session.source,
          needsUser: session.needsUser,
          reason: session.attentionReason,
          nested: true,
        }),
      );
    }
  }
}

function renderThreads(state: MenubarState): void {
  threadsEl.innerHTML = '';
  threadsEl.appendChild(
    makeThreadButton(state, {
      threadId: FLEET_THREAD_ID,
      title: 'All agents',
      subtitle:
        state.needsUserCount > 0
          ? `${state.needsUserCount} waiting for you`
          : `${state.recentSessionCount} recent · ${state.sessions.length} total`,
      needsUser: state.needsUserCount > 0,
      reason:
        state.needsUserCount > 0
          ? `${state.needsUserCount} session${state.needsUserCount === 1 ? '' : 's'} need you`
          : undefined,
    }),
  );

  const query = searchQuery.trim().toLowerCase();
  const matching = query
    ? state.sessions.filter((session) =>
        [
          session.projectName,
          session.projectPath,
          session.title,
          session.source,
          session.id,
          session.status,
          session.currentActivity,
          session.attentionReason,
        ].some((value) => value.toLowerCase().includes(query)),
      )
    : state.sessions;

  const { recent, older } = splitThreadsByAge(matching);
  appendProjectGroups(state, groupThreadsByProject(recent), Boolean(query));

  if (older.length > 0) {
    const olderButton = document.createElement('button');
    olderButton.type = 'button';
    olderButton.className = 'thread-group older';
    const expanded = Boolean(query) || !olderCollapsed;
    olderButton.setAttribute('aria-expanded', String(expanded));

    const disclosure = document.createElement('span');
    disclosure.className = 'disclosure';
    disclosure.textContent = expanded ? '▼' : '▶';
    const name = document.createElement('span');
    name.className = 'group-name';
    name.textContent = 'Older Threads';
    const count = document.createElement('span');
    count.className = 'group-count';
    count.textContent = `${older.length} · 7d+`;
    olderButton.append(disclosure, name, count);
    olderButton.addEventListener('click', () => {
      olderCollapsed = !olderCollapsed;
      if (latestState) renderThreads(latestState);
    });
    threadsEl.appendChild(olderButton);
    if (expanded) {
      appendProjectGroups(
        state,
        groupThreadsByProject(older),
        Boolean(query),
        true,
      );
    }
  }

  if (query && matching.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'no-thread-results';
    empty.textContent = 'No matching threads';
    threadsEl.appendChild(empty);
  }
}

function renderModels(state: MenubarState): void {
  const modelsKey = state.models.map((model) => modelKey(model.provider, model.model)).join('|');
  if (modelsEl.dataset['key'] !== modelsKey) {
    modelsEl.dataset['key'] = modelsKey;
    modelsEl.innerHTML = '';
    const byProvider = new Map<string, typeof state.models>();
    for (const model of state.models) {
      const list = byProvider.get(model.provider) ?? [];
      list.push(model);
      byProvider.set(model.provider, list);
    }
    for (const [provider, list] of byProvider) {
      const group = document.createElement('optgroup');
      group.label = provider;
      for (const model of list) {
        const option = document.createElement('option');
        option.value = modelKey(model.provider, model.model);
        const label = (model.label ?? model.model).replace(/\s+\([^()]+\)$/, '');
        option.textContent = `${label}${model.recommended ? ' · recommended' : ''}`;
        group.appendChild(option);
      }
      modelsEl.appendChild(group);
    }
  }
  modelsEl.value = modelKey(state.provider, state.model);
  modelsEl.disabled = state.thinking;
}

function renderMessages(state: MenubarState): void {
  const threadChanged = lastRenderedThread !== state.activeThreadId;
  messagesEl.innerHTML = '';
  if (state.messages.length === 0 && !state.thinking) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    const session = activeSession(state);
    const title = document.createElement('strong');
    title.textContent = session
      ? `Ask about ${session.projectName}`
      : state.sessions.length > 0
        ? 'Ask about your agents'
        : 'No agent sessions';
    const body = document.createElement('p');
    body.textContent = session
      ? 'This conversation stays with this session.'
      : state.sessions.length > 0
        ? 'Use the fleet thread, or choose one session from the sidebar.'
        : 'Claude, Codex, and Pi sessions appear here automatically.';
    empty.append(title, body);
    messagesEl.appendChild(empty);
  }
  for (const turn of state.messages) {
    const row = document.createElement('div');
    row.className = `turn ${turn.role}${turn.error ? ' error' : ''}`;
    const who = document.createElement('div');
    who.className = 'who';
    who.textContent = turn.role === 'user' ? 'You' : 'Aside';
    const body = document.createElement('div');
    body.className = 'body';
    body.textContent = stripMarkdown(turn.content);
    row.append(who, body);
    messagesEl.appendChild(row);
  }
  if (state.thinking) {
    const thinking = document.createElement('div');
    thinking.className = 'thinking';
    thinking.textContent = 'Thinking';
    messagesEl.appendChild(thinking);
  }
  if (threadChanged || (wasThinking && !state.thinking)) {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
  lastRenderedThread = state.activeThreadId;
  wasThinking = state.thinking;
}

function render(state: MenubarState): void {
  latestState = state;
  const session = activeSession(state);
  scopeTitleEl.textContent = session?.title || session?.projectName || 'All agents';
  scopeMetaEl.textContent = session
    ? `${session.projectName} · ${session.source} · ${session.status} · persistent thread`
    : `${state.recentSessionCount} recent · ${state.sessions.length} total · fleet conversation`;
  needsCountEl.textContent =
    state.needsUserCount > 0
      ? `${state.needsUserCount} need${state.needsUserCount === 1 ? 's' : ''} you`
      : '';
  needsCountEl.hidden = state.needsUserCount === 0;
  threadCountEl.textContent = String(state.sessions.length + 1);
  inputEl.placeholder = session ? `Ask about ${session.projectName}…` : 'Ask across all agents…';
  inputEl.disabled = false;
  sendEl.disabled = state.thinking;
  storagePathEl.textContent = state.storagePath;
  diagnosticsEl.textContent =
    `${state.sessions.length} detected threads · ${state.recentSessionCount} recent · ` +
    `${state.needsUserCount} need you · ` +
    `${state.provider}/${state.model}`;

  renderThreads(state);
  renderModels(state);
  renderMessages(state);
}

function showSettings(): void {
  settingsEl.hidden = false;
  settingsCloseEl.focus();
}

function hideSettings(): void {
  settingsEl.hidden = true;
  settingsButtonEl.focus();
}

modelsEl.addEventListener('change', () => {
  const raw = modelsEl.value;
  const separator = raw.indexOf(':');
  if (separator === -1) return;
  void window.aside.setModel(raw.slice(0, separator), raw.slice(separator + 1));
});

formEl.addEventListener('submit', (event) => {
  event.preventDefault();
  const question = inputEl.value.trim();
  if (!question || latestState?.thinking) return;
  inputEl.value = '';
  void window.aside.ask(question);
});

settingsButtonEl.addEventListener('click', showSettings);
settingsCloseEl.addEventListener('click', hideSettings);
settingsEl.addEventListener('click', (event) => {
  if (event.target === settingsEl) hideSettings();
});
openDataEl.addEventListener('click', () => void window.aside.openDataFolder());
quitEl.addEventListener('click', () => void window.aside.quit());
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !settingsEl.hidden) hideSettings();
});

if (localStorage.getItem('aside:privacy-seen') === '1') {
  privacyBannerEl.hidden = true;
}
privacyDismissEl.addEventListener('click', () => {
  localStorage.setItem('aside:privacy-seen', '1');
  privacyBannerEl.hidden = true;
});

searchEl.addEventListener('input', () => {
  searchQuery = searchEl.value;
  if (latestState) renderThreads(latestState);
});

searchEl.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && searchEl.value) {
    searchEl.value = '';
    searchQuery = '';
    if (latestState) renderThreads(latestState);
    event.stopPropagation();
  }
});

window.aside.onUpdate(render);
window.aside.onShowSettings(showSettings);
void window.aside.getState().then(render);
