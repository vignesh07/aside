// Renderer for the menubar window. It receives immutable state over the narrow
// preload bridge; model output is always rendered with textContent.

import type { MenubarState, SessionSummary } from './backend.js';
import { stripMarkdown } from '../../dist/utils/markdown.js';
import {
  groupThreadsByProject,
  splitThreadsByAge,
  type ProjectGroup,
} from './thread-groups.js';
import type {
  ProviderAuthId,
  ProviderAuthStatus,
} from './provider-auth.js';
import {
  canDisconnectProvider,
  canAskWithProvider,
  isProviderUsable,
  providerDisplayName,
  providerStatusText,
  shouldShowFirstRun,
  visibleModels,
} from './auth-ui.js';

interface AsideBridge {
  getState(): Promise<MenubarState>;
  selectThread(threadId: string): Promise<void>;
  ask(question: string): Promise<void>;
  setModel(provider: string, model: string): Promise<void>;
  getProviderAuth(): Promise<ProviderAuthStatus[]>;
  refreshProviderAuth(): Promise<ProviderAuthStatus[]>;
  connectProvider(provider: ProviderAuthId): Promise<ProviderAuthStatus[]>;
  disconnectProvider(provider: ProviderAuthId): Promise<ProviderAuthStatus[]>;
  openDataFolder(): Promise<void>;
  quit(): Promise<void>;
  onUpdate(callback: (state: MenubarState) => void): () => void;
  onProviderAuthUpdate(callback: (state: ProviderAuthStatus[]) => void): () => void;
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
const onboardingEl = document.getElementById('onboarding') as HTMLDivElement;
const onboardingProvidersEl = document.getElementById('onboarding-providers') as HTMLDivElement;
const formEl = document.getElementById('composer') as HTMLFormElement;
const inputEl = document.getElementById('input') as HTMLInputElement;
const sendEl = document.getElementById('send') as HTMLButtonElement;
const providerLockEl = document.getElementById('provider-lock') as HTMLDivElement;
const providerLockCopyEl = document.getElementById('provider-lock-copy') as HTMLSpanElement;
const providerLockActionEl = document.getElementById('provider-lock-action') as HTMLButtonElement;
const scopeTitleEl = document.getElementById('scope-title') as HTMLHeadingElement;
const scopeMetaEl = document.getElementById('scope-meta') as HTMLDivElement;
const needsCountEl = document.getElementById('needs-count') as HTMLSpanElement;
const threadCountEl = document.getElementById('thread-count') as HTMLSpanElement;
const settingsEl = document.getElementById('settings') as HTMLDivElement;
const settingsButtonEl = document.getElementById('settings-button') as HTMLButtonElement;
const settingsCloseEl = document.getElementById('settings-close') as HTMLButtonElement;
const settingsProvidersEl = document.getElementById('settings-providers') as HTMLDivElement;
const openDataEl = document.getElementById('open-data') as HTMLButtonElement;
const quitEl = document.getElementById('quit') as HTMLButtonElement;
const storagePathEl = document.getElementById('storage-path') as HTMLSpanElement;
const diagnosticsEl = document.getElementById('diagnostics') as HTMLDivElement;
const privacyBannerEl = document.getElementById('privacy-banner') as HTMLDivElement;
const privacyDismissEl = document.getElementById('privacy-dismiss') as HTMLButtonElement;
const accountsButtonEl = document.getElementById('accounts-button') as HTMLButtonElement;
const observerLabelEl = document.getElementById('observer-label') as HTMLSpanElement;
const accountSummaryEl = document.getElementById('account-summary') as HTMLSpanElement;
const accountInlineEl = document.getElementById('account-inline') as HTMLButtonElement;
const accountsPopoverEl = document.getElementById('accounts-popover') as HTMLElement;
const accountsCloseEl = document.getElementById('accounts-close') as HTMLButtonElement;
const accountsProvidersEl = document.getElementById('accounts-providers') as HTMLDivElement;
const accountsErrorEl = document.getElementById('accounts-error') as HTMLDivElement;
const onboardingErrorEl = document.getElementById('onboarding-error') as HTMLDivElement;
const settingsErrorEl = document.getElementById('settings-error') as HTMLDivElement;
const accountsSettingsEl = document.getElementById('accounts-settings') as HTMLButtonElement;

let latestState: MenubarState | null = null;
let lastRenderedThread = '';
let wasThinking = false;
let searchQuery = '';
let olderCollapsed = true;
const collapsedProjects = new Set<string>();
const expandedOlderProjects = new Set<string>();
let providerAuth: ProviderAuthStatus[] = [];
let authPhase: 'loading' | 'ready' | 'error' = 'loading';
let authError: string | null = null;
let busyProviderId: ProviderAuthId | null = null;
let pendingDisconnectId: ProviderAuthId | null = null;
let lastProviderSurfaceKey = '';

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

function providerMark(provider: ProviderAuthId): string {
  if (provider === 'codex-cli') return 'G';
  if (provider === 'claude-cli') return 'C';
  return 'O';
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+':\s*/i, '').slice(0, 180);
}

function updateProviderAuth(statuses: ProviderAuthStatus[]): void {
  providerAuth = statuses;
  authPhase = 'ready';
  authError = null;
  if (statuses.some(isProviderUsable)) {
    localStorage.setItem('aside:onboarding:v1', '1');
  }
  lastProviderSurfaceKey = '';
  if (latestState) render(latestState);
}

async function refreshProviderAuth(): Promise<void> {
  try {
    updateProviderAuth(await window.aside.refreshProviderAuth());
  } catch (error) {
    authPhase = 'error';
    authError = safeErrorMessage(error);
    lastProviderSurfaceKey = '';
    if (latestState) render(latestState);
  }
}

async function connectProvider(provider: ProviderAuthId): Promise<void> {
  if (busyProviderId) return;
  busyProviderId = provider;
  pendingDisconnectId = null;
  authError = null;
  lastProviderSurfaceKey = '';
  if (latestState) render(latestState);
  try {
    const statuses = await window.aside.connectProvider(provider);
    updateProviderAuth(statuses);
    inputEl.focus();
  } catch (error) {
    authError = safeErrorMessage(error);
  } finally {
    busyProviderId = null;
    lastProviderSurfaceKey = '';
    if (latestState) render(latestState);
  }
}

async function disconnectProvider(provider: ProviderAuthId): Promise<void> {
  if (busyProviderId) return;
  busyProviderId = provider;
  authError = null;
  lastProviderSurfaceKey = '';
  if (latestState) render(latestState);
  try {
    updateProviderAuth(await window.aside.disconnectProvider(provider));
    pendingDisconnectId = null;
  } catch (error) {
    authError = safeErrorMessage(error);
  } finally {
    busyProviderId = null;
    lastProviderSurfaceKey = '';
    if (latestState) render(latestState);
  }
}

function providerActionLabel(status: ProviderAuthStatus): string {
  if (busyProviderId === status.provider) {
    return status.state === 'signed_out' ? 'Waiting…' : 'Working…';
  }
  if (canDisconnectProvider(status)) return 'Disconnect';
  if (status.state === 'signed_in') return `Use ${providerDisplayName(status.provider)}`;
  if (status.state === 'local_ready') return 'Use Ollama';
  if (status.state === 'signed_out') return 'Sign in';
  if (status.reason === 'no_models') return 'No models';
  if (status.state === 'error') return 'Try Again';
  return 'Unavailable';
}

function makeProviderRow(status: ProviderAuthStatus): HTMLDivElement {
  const row = document.createElement('div');
  row.className = `provider-row${isProviderUsable(status) ? ' usable' : ''}`;

  const mark = document.createElement('span');
  mark.className = 'provider-mark';
  mark.textContent = providerMark(status.provider);

  const copy = document.createElement('span');
  copy.className = 'provider-copy';
  const name = document.createElement('span');
  name.className = 'provider-name';
  name.textContent = providerDisplayName(status.provider);
  const detail = document.createElement('span');
  detail.className = 'provider-detail';
  detail.textContent =
    pendingDisconnectId === status.provider
      ? `Only disconnect from Aside. ${providerDisplayName(status.provider)} stays signed in.`
      : busyProviderId === status.provider
        ? status.state === 'signed_out'
          ? 'Waiting for sign-in in your browser…'
          : 'Updating Aside…'
        : providerStatusText(status);
  copy.append(name, detail);

  row.append(mark, copy);
  if (pendingDisconnectId === status.provider) {
    row.classList.add('confirming');
    const actions = document.createElement('span');
    actions.className = 'disconnect-actions';
    const cancel = document.createElement('button');
    cancel.className = 'provider-cancel';
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => {
      pendingDisconnectId = null;
      lastProviderSurfaceKey = '';
      if (latestState) render(latestState);
    });
    const confirm = document.createElement('button');
    confirm.className = 'provider-confirm';
    confirm.type = 'button';
    confirm.textContent = 'Disconnect';
    confirm.addEventListener('click', () => void disconnectProvider(status.provider));
    actions.append(cancel, confirm);
    row.append(actions);
    return row;
  }

  const action = document.createElement('button');
  action.type = 'button';
  action.className = `provider-action${
    !status.enabled && (status.state === 'signed_in' || status.state === 'local_ready')
      ? ' primary'
      : ''
  }`;
  action.textContent = providerActionLabel(status);
  action.disabled =
    Boolean(busyProviderId) ||
    (!status.enabled &&
      (status.state === 'missing' || status.reason === 'no_models'));
  action.addEventListener('click', () => {
    if (canDisconnectProvider(status)) {
      pendingDisconnectId = status.provider;
      lastProviderSurfaceKey = '';
      if (latestState) render(latestState);
      return;
    }
    if (status.state === 'error') {
      void refreshProviderAuth();
      return;
    }
    void connectProvider(status.provider);
  });
  row.append(action);
  return row;
}

function fillProviderList(container: HTMLElement): void {
  container.innerHTML = '';
  for (const status of providerAuth) {
    container.appendChild(makeProviderRow(status));
  }
}

function renderProviderSurfaces(): void {
  const key = JSON.stringify({
    providerAuth,
    authPhase,
    authError,
    busyProviderId,
    pendingDisconnectId,
  });
  if (key === lastProviderSurfaceKey) return;
  lastProviderSurfaceKey = key;
  fillProviderList(onboardingProvidersEl);
  fillProviderList(accountsProvidersEl);
  fillProviderList(settingsProvidersEl);
  accountsErrorEl.hidden = !authError;
  accountsErrorEl.textContent = authError ?? '';
  onboardingErrorEl.hidden = !authError;
  onboardingErrorEl.textContent = authError ?? '';
  settingsErrorEl.hidden = !authError;
  settingsErrorEl.textContent = authError ?? '';
}

function showAccounts(): void {
  const onboardingCompleted = localStorage.getItem('aside:onboarding:v1') === '1';
  if (
    !settingsEl.hidden ||
    (authPhase === 'ready' && shouldShowFirstRun(providerAuth, onboardingCompleted))
  ) {
    return;
  }
  accountsPopoverEl.hidden = false;
  accountsButtonEl.setAttribute('aria-expanded', 'true');
  pendingDisconnectId = null;
  lastProviderSurfaceKey = '';
  renderProviderSurfaces();
  accountsCloseEl.focus();
  void refreshProviderAuth();
}

function hideAccounts(): void {
  accountsPopoverEl.hidden = true;
  accountsButtonEl.setAttribute('aria-expanded', 'false');
  pendingDisconnectId = null;
  lastProviderSurfaceKey = '';
  accountsButtonEl.focus();
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
  const available = authPhase === 'ready'
    ? visibleModels(state.models, providerAuth)
    : [];
  const activeKey = modelKey(state.provider, state.model);
  const activeAvailable = available.some(
    (model) => modelKey(model.provider, model.model) === activeKey,
  );
  const activeProvider = providerAuth.find(
    (status) => status.provider === state.provider,
  );
  const activeProviderLabel = activeProvider
    ? providerDisplayName(activeProvider.provider)
    : state.provider;
  const modelsKey = [
    activeKey,
    activeProviderLabel,
    activeAvailable ? 'active' : 'locked',
    ...available.map((model) => modelKey(model.provider, model.model)),
  ].join('|');
  if (modelsEl.dataset['key'] !== modelsKey) {
    modelsEl.dataset['key'] = modelsKey;
    modelsEl.innerHTML = '';
    if (!activeAvailable) {
      const locked = document.createElement('option');
      locked.value = activeKey;
      locked.textContent = `${activeProviderLabel} · disconnected`;
      locked.disabled = true;
      modelsEl.appendChild(locked);
    }
    const byProvider = new Map<string, typeof available>();
    for (const model of available) {
      const list = byProvider.get(model.provider) ?? [];
      list.push(model);
      byProvider.set(model.provider, list);
    }
    for (const [provider, list] of byProvider) {
      const group = document.createElement('optgroup');
      const knownProvider = providerAuth.find(
        (status) => status.provider === provider,
      );
      group.label = knownProvider
        ? providerDisplayName(knownProvider.provider)
        : provider;
      for (const model of list) {
        const option = document.createElement('option');
        option.value = modelKey(model.provider, model.model);
        const label = (model.label ?? model.model).replace(/\s+\([^()]+\)$/, '');
        option.textContent = `${label}${model.recommended ? ' · recommended' : ''}`;
        group.appendChild(option);
      }
      modelsEl.appendChild(group);
    }
    const connect = document.createElement('option');
    connect.value = '__connect__';
    connect.textContent = available.length > 0
      ? 'Connect another provider…'
      : 'Connect an account…';
    modelsEl.appendChild(connect);
  }
  modelsEl.value = activeKey;
  modelsEl.disabled = state.thinking || authPhase === 'loading';
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
  threadCountEl.textContent = String(state.sessions.length);
  const activeAuth = providerAuth.find((status) => status.provider === state.provider);
  const activeProviderLabel = activeAuth
    ? providerDisplayName(activeAuth.provider)
    : state.provider;
  const canAsk =
    authPhase === 'ready' &&
    canAskWithProvider(providerAuth, state.provider);
  const onboardingCompleted = localStorage.getItem('aside:onboarding:v1') === '1';
  const firstRun =
    authPhase === 'ready' &&
    shouldShowFirstRun(providerAuth, onboardingCompleted);
  onboardingEl.hidden = !firstRun;
  messagesEl.hidden = firstRun;
  accountsButtonEl.hidden = firstRun;
  observerLabelEl.hidden = !firstRun;
  accountInlineEl.hidden = firstRun;
  if (firstRun && !accountsPopoverEl.hidden) {
    accountsPopoverEl.hidden = true;
    accountsButtonEl.setAttribute('aria-expanded', 'false');
    pendingDisconnectId = null;
    lastProviderSurfaceKey = '';
  }

  inputEl.placeholder = canAsk
    ? session
      ? `Ask about ${session.projectName}…`
      : 'Ask across all agents…'
      : authPhase === 'loading'
        ? 'Checking account status…'
        : firstRun
          ? 'Choose an account above to chat…'
          : activeAuth
            ? `${activeAuth.enabled ? 'Reconnect' : 'Connect'} ${activeProviderLabel} to chat…`
            : 'Connect an account to chat…';
  inputEl.disabled = state.thinking || !canAsk;
  sendEl.disabled = state.thinking || !canAsk;
  providerLockEl.hidden = canAsk;
  providerLockActionEl.hidden = firstRun;
  providerLockCopyEl.textContent =
    authPhase === 'loading'
      ? 'Checking account status…'
      : firstRun
        ? 'Choose a model account above to unlock this side chat.'
        : activeAuth
          ? `This thread uses ${activeProviderLabel}. ${
              activeAuth.enabled ? 'Reconnect it' : 'Connect it'
            } or choose a connected model.`
          : 'Connect an account before sending transcript context to a model.';
  providerLockActionEl.textContent = activeAuth?.enabled ? 'Reconnect…' : 'Connect…';

  const usable = providerAuth.filter(isProviderUsable);
  accountsButtonEl.classList.toggle('connected', usable.length > 0);
  accountSummaryEl.textContent =
    authPhase === 'loading'
      ? 'Checking accounts…'
      : usable.length === 0
        ? 'Connect an account'
        : usable.length === 1
          ? providerDisplayName(usable[0]!.provider)
          : `${usable.length} accounts`;
  accountInlineEl.textContent =
    usable.length === 0
      ? 'Connect an account'
      : `${usable.length} account${usable.length === 1 ? '' : 's'}`;
  storagePathEl.textContent = state.storagePath;
  diagnosticsEl.textContent =
    `${state.sessions.length} detected threads · ${state.recentSessionCount} recent · ` +
    `${state.needsUserCount} need you · ` +
    `${state.provider}/${state.model} · ` +
    `${usable.length} connected`;

  renderThreads(state);
  renderModels(state);
  if (firstRun) modelsEl.disabled = true;
  renderMessages(state);
  renderProviderSurfaces();
}

function showSettings(): void {
  if (!accountsPopoverEl.hidden) {
    accountsPopoverEl.hidden = true;
    accountsButtonEl.setAttribute('aria-expanded', 'false');
    pendingDisconnectId = null;
    lastProviderSurfaceKey = '';
  }
  settingsEl.hidden = false;
  void refreshProviderAuth();
}

function hideSettings(): void {
  settingsEl.hidden = true;
  settingsButtonEl.focus();
}

modelsEl.addEventListener('change', () => {
  const raw = modelsEl.value;
  if (raw === '__connect__') {
    showAccounts();
    if (latestState) modelsEl.value = modelKey(latestState.provider, latestState.model);
    return;
  }
  const separator = raw.indexOf(':');
  if (separator === -1) return;
  void window.aside
    .setModel(raw.slice(0, separator), raw.slice(separator + 1))
    .catch(() => void refreshProviderAuth());
});

formEl.addEventListener('submit', (event) => {
  event.preventDefault();
  const question = inputEl.value.trim();
  if (
    !question ||
    !latestState ||
    latestState.thinking ||
    !canAskWithProvider(providerAuth, latestState.provider)
  ) {
    return;
  }
  inputEl.value = '';
  void window.aside.ask(question).catch(() => void refreshProviderAuth());
});

accountsButtonEl.addEventListener('click', () => {
  if (accountsPopoverEl.hidden) showAccounts();
  else hideAccounts();
});
accountsCloseEl.addEventListener('click', hideAccounts);
accountInlineEl.addEventListener('click', showAccounts);
providerLockActionEl.addEventListener('click', showAccounts);
accountsSettingsEl.addEventListener('click', () => {
  hideAccounts();
  showSettings();
});
settingsButtonEl.addEventListener('click', () => {
  if (!accountsPopoverEl.hidden) hideAccounts();
  showSettings();
});
settingsCloseEl.addEventListener('click', hideSettings);
openDataEl.addEventListener('click', () => void window.aside.openDataFolder());
quitEl.addEventListener('click', () => void window.aside.quit());
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (!accountsPopoverEl.hidden) {
    hideAccounts();
    return;
  }
  if (!settingsEl.hidden) hideSettings();
});
document.addEventListener('mousedown', (event) => {
  if (
    accountsPopoverEl.hidden ||
    accountsPopoverEl.contains(event.target as Node) ||
    accountsButtonEl.contains(event.target as Node) ||
    accountInlineEl.contains(event.target as Node) ||
    providerLockActionEl.contains(event.target as Node)
  ) {
    return;
  }
  hideAccounts();
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
window.aside.onProviderAuthUpdate(updateProviderAuth);
window.aside.onShowSettings(showSettings);
void window.aside.getState().then(render);
void window.aside
  .getProviderAuth()
  .then(updateProviderAuth)
  .catch((error) => {
    authPhase = 'error';
    authError = safeErrorMessage(error);
    lastProviderSurfaceKey = '';
    if (latestState) render(latestState);
  });
