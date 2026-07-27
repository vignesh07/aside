// Renderer for the menubar window. It receives immutable state over the narrow
// preload bridge; model output is always rendered with textContent.

import type { MenubarState, SessionSummary } from './backend.js';
import { stripMarkdown } from '../../dist/utils/markdown.js';
import {
  filterAttentionHierarchy,
  groupSubagentsByRoot,
  groupThreadsByProject,
  splitThreadsByAge,
  threadKey,
  type ProjectGroup,
} from './thread-groups.js';
import type {
  ProviderAuthId,
  ProviderAuthStatus,
} from './provider-auth.js';
import type { AppUpdateStatus } from './app-update.js';
import type {
  SearchMatchKind,
  SearchSnippetPart,
  ThreadSearchResult,
} from './search-types.js';
import type { ThreadAttentionKind } from '../../dist/types/activity.js';
import {
  canDisconnectProvider,
  canAskWithProvider,
  isProviderUsable,
  providerDisplayName,
  providerHelpLink,
  providerStatusText,
  shouldShowFirstRun,
  visibleModels,
} from './auth-ui.js';

interface AsideBridge {
  getState(): Promise<MenubarState>;
  searchThreads(query: string): Promise<ThreadSearchResult[]>;
  rebuildSearchIndex(): Promise<void>;
  selectThread(threadId: string): Promise<void>;
  resolveAttention(threadId: string): Promise<void>;
  ask(question: string): Promise<void>;
  setModel(provider: string, model: string): Promise<void>;
  getProviderAuth(): Promise<ProviderAuthStatus[]>;
  refreshProviderAuth(): Promise<ProviderAuthStatus[]>;
  connectProvider(provider: ProviderAuthId): Promise<ProviderAuthStatus[]>;
  disconnectProvider(provider: ProviderAuthId): Promise<ProviderAuthStatus[]>;
  openProviderHelp(provider: ProviderAuthId): Promise<void>;
  getAppVersion(): Promise<string>;
  getWindowMode(): Promise<{ keepOpen: boolean }>;
  setKeepOpen(keepOpen: boolean): Promise<{ keepOpen: boolean }>;
  getUpdateStatus(): Promise<AppUpdateStatus>;
  checkForUpdates(): Promise<AppUpdateStatus>;
  restartToUpdate(): Promise<void>;
  openManualUpdate(): Promise<void>;
  openFeedback(kind: 'bug' | 'feature'): Promise<void>;
  openDataFolder(): Promise<void>;
  quit(): Promise<void>;
  onUpdate(callback: (state: MenubarState) => void): () => void;
  onProviderAuthUpdate(callback: (state: ProviderAuthStatus[]) => void): () => void;
  onAppUpdate(callback: (status: AppUpdateStatus) => void): () => void;
  onShowSettings(callback: () => void): () => void;
  onWindowMode(callback: (mode: { keepOpen: boolean }) => void): () => void;
}

declare global {
  interface Window {
    aside: AsideBridge;
  }
}

const FLEET_THREAD_ID = 'fleet';
const threadsEl = document.getElementById('threads') as HTMLDivElement;
const searchEl = document.getElementById('thread-search') as HTMLInputElement;
const searchStatusEl = document.getElementById('search-status') as HTMLDivElement;
const searchIndexStatusEl = document.getElementById('search-index-status') as HTMLSpanElement;
const rebuildSearchIndexEl = document.getElementById('rebuild-search-index') as HTMLButtonElement;
const showSubagentThreadsEl = document.getElementById(
  'show-subagent-threads',
) as HTMLInputElement;
const modelsEl = document.getElementById('models') as HTMLSelectElement;
const messagesEl = document.getElementById('messages') as HTMLDivElement;
const onboardingEl = document.getElementById('onboarding') as HTMLDivElement;
const onboardingProvidersEl = document.getElementById('onboarding-providers') as HTMLDivElement;
const formEl = document.getElementById('composer') as HTMLFormElement;
const inputEl = document.getElementById('input') as HTMLTextAreaElement;
const sendEl = document.getElementById('send') as HTMLButtonElement;
const providerLockEl = document.getElementById('provider-lock') as HTMLDivElement;
const providerLockCopyEl = document.getElementById('provider-lock-copy') as HTMLSpanElement;
const providerLockActionEl = document.getElementById('provider-lock-action') as HTMLButtonElement;
const scopeTitleEl = document.getElementById('scope-title') as HTMLHeadingElement;
const scopeMetaEl = document.getElementById('scope-meta') as HTMLDivElement;
const needsCountEl = document.getElementById('needs-count') as HTMLSpanElement;
const keepOpenEl = document.getElementById('keep-open') as HTMLButtonElement;
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
const accountsPopoverEl = document.getElementById('accounts-popover') as HTMLElement;
const accountsCloseEl = document.getElementById('accounts-close') as HTMLButtonElement;
const accountsProvidersEl = document.getElementById('accounts-providers') as HTMLDivElement;
const accountsErrorEl = document.getElementById('accounts-error') as HTMLDivElement;
const onboardingErrorEl = document.getElementById('onboarding-error') as HTMLDivElement;
const settingsErrorEl = document.getElementById('settings-error') as HTMLDivElement;
const accountsSettingsEl = document.getElementById('accounts-settings') as HTMLButtonElement;
const appVersionEl = document.getElementById('app-version') as HTMLSpanElement;
const updateStatusEl = document.getElementById('update-status') as HTMLSpanElement;
const checkUpdateEl = document.getElementById('check-update') as HTMLButtonElement;
const restartUpdateEl = document.getElementById('restart-update') as HTMLButtonElement;
const manualUpdateEl = document.getElementById('manual-update') as HTMLButtonElement;
const reportBugEl = document.getElementById('report-bug') as HTMLButtonElement;
const requestFeatureEl = document.getElementById('request-feature') as HTMLButtonElement;
const feedbackStatusEl = document.getElementById('feedback-status') as HTMLSpanElement;
const updateProgressEl = document.getElementById('update-progress') as HTMLSpanElement;
const updateProgressBarEl = document.getElementById('update-progress-bar') as HTMLSpanElement;
const updateReadyEl = document.getElementById('update-ready') as HTMLDivElement;
const updateReadyCopyEl = document.getElementById('update-ready-copy') as HTMLSpanElement;
const updateReadyRestartEl = document.getElementById('update-ready-restart') as HTMLButtonElement;

let latestState: MenubarState | null = null;
let lastRenderedThread = '';
let wasThinking = false;
let searchQuery = '';
let searchResults: ThreadSearchResult[] | null = null;
let searchInFlight = false;
let searchError: string | null = null;
let searchSequence = 0;
let searchTimer: ReturnType<typeof setTimeout> | null = null;
let lastIndexedThreadCount = -1;
let olderCollapsed = true;
let attentionOnly = false;
const collapsedProjects = new Set<string>();
const collapsedAttentionProjects = new Set<string>();
const expandedOlderProjects = new Set<string>();
const expandedSubagentRoots = new Set<string>();
const collapsedAttentionSubagentRoots = new Set<string>();
const showSubagentsStorageKey = 'aside:show-subagent-threads';
let showSubagentThreads =
  localStorage.getItem(showSubagentsStorageKey) !== '0';
let providerAuth: ProviderAuthStatus[] = [];
let authPhase: 'loading' | 'ready' | 'error' = 'loading';
let authError: string | null = null;
let busyProviderId: ProviderAuthId | null = null;
let pendingDisconnectId: ProviderAuthId | null = null;
let lastProviderSurfaceKey = '';
let appUpdateStatus: AppUpdateStatus | null = null;
let keepOpen = false;

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

function renderAppUpdate(status: AppUpdateStatus): void {
  appUpdateStatus = status;
  appVersionEl.textContent = `Aside ${status.currentVersion}`;
  // A failed native restart/install attempt can return the app to an error and
  // later to ready again. Re-enable both entry points on every authoritative
  // updater state instead of leaving a stale click-time disabled flag behind.
  restartUpdateEl.disabled = false;
  updateReadyRestartEl.disabled = false;
  checkUpdateEl.disabled =
    status.phase === 'checking' ||
    status.phase === 'downloading' ||
    status.phase === 'ready';
  restartUpdateEl.hidden = status.phase !== 'ready';
  manualUpdateEl.hidden = status.phase !== 'error';
  updateProgressEl.hidden = status.phase !== 'downloading';
  updateProgressBarEl.style.width = `${status.percent ?? 0}%`;
  updateReadyEl.hidden = status.phase !== 'ready';

  const latest = status.latestVersion ? ` ${status.latestVersion}` : '';
  if (status.phase === 'checking') {
    updateStatusEl.textContent = 'Checking for updates…';
  } else if (status.phase === 'downloading') {
    updateStatusEl.textContent = `Downloading Aside${latest} · ${status.percent ?? 0}%`;
  } else if (status.phase === 'ready') {
    updateStatusEl.textContent = `Aside${latest} is ready to install.`;
    updateReadyCopyEl.textContent = `Aside${latest} is ready.`;
  } else if (status.phase === 'current') {
    updateStatusEl.textContent = 'Aside is up to date.';
  } else if (status.phase === 'error') {
    updateStatusEl.textContent =
      status.error ?? 'Automatic update failed. Try again in a moment.';
  } else if (status.phase === 'unsupported') {
    updateStatusEl.textContent = 'Automatic updates run in the installed app.';
  } else {
    updateStatusEl.textContent = 'Updates download automatically.';
  }
}

function renderWindowMode(mode: { keepOpen: boolean }): void {
  keepOpen = mode.keepOpen;
  keepOpenEl.setAttribute('aria-pressed', String(keepOpen));
  keepOpenEl.title = keepOpen
    ? 'Return Aside to menu-bar behavior'
    : 'Keep Aside open when switching apps';
  keepOpenEl.setAttribute('aria-label', keepOpenEl.title);
}

function resizeComposerInput(): void {
  inputEl.style.height = '0';
  inputEl.style.height = `${Math.min(inputEl.scrollHeight, 104)}px`;
}

async function restartToUpdate(): Promise<void> {
  if (appUpdateStatus?.phase !== 'ready') return;
  restartUpdateEl.disabled = true;
  updateReadyRestartEl.disabled = true;
  updateStatusEl.textContent = 'Restarting to install…';
  try {
    await window.aside.restartToUpdate();
  } catch (error) {
    updateStatusEl.textContent = safeErrorMessage(error);
    restartUpdateEl.disabled = false;
    updateReadyRestartEl.disabled = false;
  }
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
  const help = status.state === 'missing'
    ? providerHelpLink(status.provider)
    : undefined;
  if (help) return help.label;
  if (status.state === 'signed_in') return `Use ${providerDisplayName(status.provider)}`;
  if (status.state === 'local_ready') return 'Use Ollama';
  if (status.state === 'signed_out') return 'Sign in';
  if (status.reason === 'no_models') return 'No models';
  if (status.state === 'error') return 'Try Again';
  return 'Unavailable';
}

function makeProviderRow(status: ProviderAuthStatus): HTMLDivElement {
  const help = status.state === 'missing'
    ? providerHelpLink(status.provider)
    : undefined;
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
    !status.enabled &&
    (status.state === 'signed_in' || status.state === 'local_ready' || help)
      ? ' primary'
      : ''
  }`;
  action.textContent = providerActionLabel(status);
  if (help) action.title = help.title;
  action.disabled =
    Boolean(busyProviderId) ||
    (!status.enabled &&
      ((status.state === 'missing' && !help) || status.reason === 'no_models'));
  action.addEventListener('click', () => {
    if (canDisconnectProvider(status)) {
      pendingDisconnectId = status.provider;
      lastProviderSurfaceKey = '';
      if (latestState) render(latestState);
      return;
    }
    if (help) {
      void window.aside.openProviderHelp(status.provider).catch((error) => {
        authError = safeErrorMessage(error);
        lastProviderSurfaceKey = '';
        if (latestState) render(latestState);
      });
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
    glyph?: string;
    needsAttention?: boolean;
    attentionKind?: ThreadAttentionKind;
    attentionUnread?: boolean;
    reason?: string;
    nested?: boolean;
    subagent?: boolean;
    searchResult?: boolean;
    subtitlePrefix?: string;
    snippet?: SearchSnippetPart[];
    selected?: boolean;
    smart?: boolean;
    pressed?: boolean;
    onSelect?: () => void;
  },
): HTMLButtonElement {
  const button = document.createElement('button');
  const selected = options.selected ?? state.activeThreadId === options.threadId;
  const attentionKind = options.attentionKind ?? 'none';
  button.type = 'button';
  button.className = `thread${selected ? ' active' : ''}${
    options.needsAttention ? ` needs-attention attention-${attentionKind}` : ''
  }${options.nested ? ' nested' : ''}`;
  if (options.subagent) button.classList.add('subagent');
  if (options.searchResult) button.classList.add('search-result');
  if (options.smart) button.classList.add('attention-smart');
  if (options.pressed) button.classList.add('filtered');
  button.dataset['threadId'] = options.threadId;
  if (selected) button.setAttribute('aria-current', 'page');
  if (options.smart) {
    button.setAttribute('aria-pressed', String(options.pressed ?? false));
  }

  const icon = document.createElement('span');
  icon.className = options.source ? `source source-${options.source}` : 'source fleet';
  icon.textContent = options.source
    ? sourceGlyph(options.source)
    : (options.glyph ?? '⌘');
  icon.setAttribute('aria-hidden', 'true');

  const copy = document.createElement('span');
  copy.className = 'thread-copy';
  const title = document.createElement('span');
  title.className = 'thread-title';
  title.textContent = options.title;
  const subtitle = document.createElement('span');
  subtitle.className = 'thread-subtitle';
  if (options.needsAttention && !options.searchResult && !options.smart) {
    subtitle.textContent = options.reason || 'Waiting for your input';
  } else {
    subtitle.textContent = options.subtitle;
  }
  copy.append(title, subtitle);
  if (
    options.searchResult &&
    options.snippet &&
    options.snippet.length > 0
  ) {
    button.classList.add('has-snippet');
    const snippet = document.createElement('span');
    snippet.className = 'thread-snippet';
    snippet.append(document.createTextNode(options.subtitlePrefix ?? ''));
    for (const part of options.snippet) {
      const node = part.match
        ? document.createElement('mark')
        : document.createTextNode(part.text);
      if (part.match) node.textContent = part.text;
      snippet.append(node);
    }
    copy.append(snippet);
  }

  button.append(icon, copy);
  if (options.needsAttention && attentionKind !== 'none') {
    const badge = document.createElement('span');
    badge.className = `attention-badge ${attentionKind}${
      options.attentionUnread ? ' unread' : ''
    }`;
    badge.title = attentionLabel(attentionKind);
    badge.textContent = attentionGlyph(attentionKind);
    badge.setAttribute('aria-hidden', 'true');
    button.appendChild(badge);
  }
  const accessibleDetail =
    options.needsAttention && !options.searchResult && !options.smart
      ? options.reason || attentionLabel(attentionKind)
      : options.subtitle;
  button.setAttribute(
    'aria-label',
    `${options.title}${accessibleDetail ? `, ${accessibleDetail}` : ''}`,
  );
  button.addEventListener('click', () => {
    if (options.onSelect) options.onSelect();
    else void window.aside.selectThread(options.threadId);
  });
  return button;
}

function attentionLabel(kind: ThreadAttentionKind): string {
  switch (kind) {
    case 'waiting': return 'Waiting for you';
    case 'failed': return 'Turn failed';
    case 'interrupted': return 'Turn interrupted';
    case 'completed': return 'Turn ready to review';
    case 'stalled': return 'Work may be stalled';
    case 'forgotten': return 'Unreviewed work';
    default: return '';
  }
}

function attentionGlyph(kind: ThreadAttentionKind): string {
  switch (kind) {
    case 'waiting': return '•';
    case 'failed': return '!';
    case 'interrupted': return '–';
    case 'completed': return '○';
    case 'stalled': return '…';
    case 'forgotten': return '·';
    default: return '';
  }
}

function attentionTiming(
  kind: ThreadAttentionKind,
  sinceMs: number | null,
): string {
  if (sinceMs === null) return '';
  const elapsed = formatDuration(Date.now() - sinceMs);
  if (kind === 'stalled') return `Quiet for ${elapsed}`;
  if (kind === 'failed' || kind === 'interrupted') return `${elapsed} ago`;
  return `Waiting for ${elapsed}`;
}

function attentionSidebarCopy(session: SessionSummary): string {
  const primary =
    session.attentionKind === 'waiting'
      ? stripMarkdown(session.attentionContext || session.attentionReason)
      : session.attentionHeadline || attentionLabel(session.attentionKind);
  const timing = attentionTiming(
    session.attentionKind,
    session.attentionSince,
  );
  return [primary, timing].filter(Boolean).join(' · ');
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

function makeSubagentGroupButton(
  subagents: SessionSummary[],
  collapsed: boolean,
  onToggle: () => void,
): HTMLButtonElement {
  const liveCount = subagents.filter(
    (session) => session.status === 'active' || session.status === 'idle',
  ).length;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'thread-group subagents';
  button.classList.toggle('has-live', liveCount > 0);
  button.setAttribute('aria-expanded', String(!collapsed));
  button.setAttribute(
    'aria-label',
    `Subagents, ${subagents.length} total${
      liveCount > 0 ? `, ${liveCount} live` : ''
    }`,
  );

  const disclosure = document.createElement('span');
  disclosure.className = 'disclosure';
  disclosure.textContent = collapsed ? '▶' : '▼';
  const name = document.createElement('span');
  name.className = 'group-name';
  name.textContent = 'Subagents';
  const total = document.createElement('span');
  total.className = 'group-count';
  total.textContent =
    liveCount > 0 ? `${liveCount} live · ${subagents.length}` : String(subagents.length);
  button.append(disclosure, name, total);
  button.addEventListener('click', onToggle);
  return button;
}

function appendProjectGroups(
  state: MenubarState,
  groups: ProjectGroup<SessionSummary>[],
  subagentsByRoot: Map<string, SessionSummary[]>,
  searching: boolean,
  defaultCollapsed = false,
  attentionMode = false,
): void {
  for (const group of groups) {
    const collapsed =
      !searching &&
      (attentionMode
        ? collapsedAttentionProjects.has(group.key)
        : defaultCollapsed
          ? !expandedOlderProjects.has(group.key)
          : collapsedProjects.has(group.key));
    threadsEl.appendChild(
      makeGroupButton(group, collapsed, () => {
        if (attentionMode) {
          if (collapsedAttentionProjects.has(group.key)) {
            collapsedAttentionProjects.delete(group.key);
          } else {
            collapsedAttentionProjects.add(group.key);
          }
        } else if (defaultCollapsed) {
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
      const rootKey = threadKey(session);
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
          needsAttention: session.needsAttention,
          attentionKind: session.attentionKind,
          attentionUnread: session.attentionUnread,
          reason: attentionSidebarCopy(session),
          nested: true,
        }),
      );
      const subagents = subagentsByRoot.get(rootKey) ?? [];
      if (!showSubagentThreads || subagents.length === 0) continue;
      const expanded = attentionMode
        ? !collapsedAttentionSubagentRoots.has(rootKey)
        : expandedSubagentRoots.has(rootKey);
      threadsEl.appendChild(
        makeSubagentGroupButton(subagents, !expanded, () => {
          if (attentionMode) {
            if (collapsedAttentionSubagentRoots.has(rootKey)) {
              collapsedAttentionSubagentRoots.delete(rootKey);
            } else {
              collapsedAttentionSubagentRoots.add(rootKey);
            }
          } else if (expandedSubagentRoots.has(rootKey)) {
            expandedSubagentRoots.delete(rootKey);
          } else {
            expandedSubagentRoots.add(rootKey);
          }
          if (latestState) renderThreads(latestState);
        }),
      );
      if (!expanded) continue;
      for (const subagent of subagents) {
        threadsEl.appendChild(
          makeThreadButton(state, {
            threadId: subagent.threadId,
            title: subagent.title || 'Subagent',
            subtitle: `subagent · ${subagent.status}${
              subagent.status === 'active'
                ? ''
                : ` · ${formatDuration(subagent.idleForMs)}`
            }`,
            source: subagent.source,
            needsAttention: subagent.needsAttention,
            attentionKind: subagent.attentionKind,
            attentionUnread: subagent.attentionUnread,
            reason: attentionSidebarCopy(subagent),
            nested: true,
            subagent: true,
          }),
        );
      }
    }
  }
}

function renderThreads(state: MenubarState): void {
  const topLevelSessions = state.sessions.filter(
    (session) => !session.isInternal,
  );
  const subagentsByRoot = groupSubagentsByRoot(state.sessions);
  const subagentCount = state.sessions.length - topLevelSessions.length;
  threadsEl.innerHTML = '';
  threadsEl.appendChild(
    makeThreadButton(state, {
      threadId: FLEET_THREAD_ID,
      title: 'All agents',
      subtitle: `${state.recentSessionCount} recent · ${topLevelSessions.length} threads`,
      selected: state.activeThreadId === FLEET_THREAD_ID,
      onSelect: () => {
        attentionOnly = false;
        void window.aside.selectThread(FLEET_THREAD_ID);
        if (latestState) renderThreads(latestState);
      },
    }),
  );
  threadsEl.appendChild(
    makeThreadButton(state, {
      threadId: 'attention',
      title: 'Attention',
      subtitle:
        state.attentionCount === 0
          ? 'All caught up'
          : state.unreadAttentionCount > 0
            ? `${state.unreadAttentionCount} unread · ${state.attentionCount} total`
            : `${state.attentionCount} waiting for follow-up`,
      glyph: '◉',
      selected: false,
      smart: true,
      pressed: attentionOnly,
      onSelect: () => {
        attentionOnly = !attentionOnly;
        if (latestState) renderThreads(latestState);
      },
    }),
  );

  const query = searchQuery.trim().toLowerCase();
  if (query) {
    renderSearchResults(state, query);
    return;
  }
  searchStatusEl.hidden = true;
  searchStatusEl.classList.remove('error');
  if (attentionOnly) {
    const attention = filterAttentionHierarchy(
      topLevelSessions,
      subagentsByRoot,
    );
    if (attention.roots.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'no-thread-results';
      empty.textContent = 'Nothing needs your attention';
      threadsEl.appendChild(empty);
      return;
    }
    appendProjectGroups(
      state,
      groupThreadsByProject(attention.roots),
      attention.subagentsByRoot,
      false,
      false,
      true,
    );
    return;
  }
  const { recent, older } = splitThreadsByAge(topLevelSessions);
  appendProjectGroups(
    state,
    groupThreadsByProject(recent),
    subagentsByRoot,
    false,
  );

  if (older.length > 0) {
    const olderButton = document.createElement('button');
    olderButton.type = 'button';
    olderButton.className = 'thread-group older';
    const expanded = !olderCollapsed;
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
        subagentsByRoot,
        false,
        true,
      );
    }
  }
}

function renderSearchResults(state: MenubarState, query: string): void {
  const bySession = new Map(
    state.sessions.map((session) => [
      `${session.source}:${session.id}`,
      session,
    ]),
  );
  const rootBySubagent = new Map<string, SessionSummary>();
  for (const [rootKey, subagents] of groupSubagentsByRoot(state.sessions)) {
    const root = bySession.get(rootKey);
    if (!root) continue;
    for (const subagent of subagents) {
      rootBySubagent.set(`${subagent.source}:${subagent.id}`, root);
    }
  }
  const localMatches = state.sessions
    .filter((session) =>
      [
        session.projectName,
        session.projectPath,
        session.title,
        session.source,
        session.id,
        session.status,
        session.currentActivity,
        session.attentionHeadline,
        session.attentionContext,
        session.attentionReason,
      ].some((value) => value.toLocaleLowerCase().includes(query)),
    )
    .map(
      (session): ThreadSearchResult => ({
        sessionId: session.id,
        source: session.source,
        kind: 'metadata',
        snippet: [],
        score: 0,
      }),
    );
  const results = searchResults ?? localMatches;

  searchStatusEl.hidden = false;
  searchStatusEl.classList.toggle('error', state.searchIndex.phase === 'error');
  if (query.length < 3) {
    searchStatusEl.textContent = 'Type 3 characters to search contents';
  } else if (state.searchIndex.phase === 'error') {
    searchStatusEl.textContent = 'Content index unavailable · showing metadata matches';
  } else if (searchError) {
    searchStatusEl.classList.add('error');
    searchStatusEl.textContent = searchError;
  } else if (
    state.searchIndex.phase === 'starting' ||
    state.searchIndex.phase === 'indexing'
  ) {
    const percent =
      state.searchIndex.totalBytes > 0
        ? Math.floor(
            (state.searchIndex.indexedBytes / state.searchIndex.totalBytes) * 100,
          )
        : 0;
    searchStatusEl.textContent =
      `Searching indexed content · ${Math.max(0, Math.min(100, percent))}% ready`;
  } else if (state.searchIndex.phase === 'optimizing') {
    searchStatusEl.textContent = 'Finishing content index…';
  } else if (searchInFlight) {
    searchStatusEl.textContent = 'Searching thread contents…';
  } else {
    searchStatusEl.textContent = `${results.length} result${
      results.length === 1 ? '' : 's'
    }`;
  }

  for (const result of results) {
    const session = bySession.get(`${result.source}:${result.sessionId}`);
    if (!session) continue;
    const matchLabel = searchMatchLabel(result.kind);
    const root = rootBySubagent.get(`${session.source}:${session.id}`);
    const rootTitle = root?.title || root?.projectName;
    const subtitle = session.isInternal
      ? `${session.projectName} · subagent${
          rootTitle ? ` of ${rootTitle}` : ''
        }`
      : `${session.projectName} · ${matchLabel}`;
    threadsEl.appendChild(
      makeThreadButton(state, {
        threadId: session.threadId,
        title: session.title || session.projectName,
        subtitle,
        subtitlePrefix: session.isInternal ? `${matchLabel} · ` : '',
        snippet: result.kind === 'metadata' ? [] : result.snippet,
        source: session.source,
        needsAttention: session.needsAttention,
        attentionKind: session.attentionKind,
        attentionUnread: session.attentionUnread,
        reason: session.attentionReason,
        searchResult: true,
      }),
    );
  }

  if (results.length === 0 && !searchInFlight) {
    const empty = document.createElement('div');
    empty.className = 'no-thread-results';
    empty.textContent =
      state.searchIndex.phase === 'indexing'
        ? 'No match in indexed threads yet'
        : 'No matching thread content';
    threadsEl.appendChild(empty);
  }
}

function searchMatchLabel(kind: SearchMatchKind): string {
  switch (kind) {
    case 'user':
      return 'your prompt';
    case 'assistant':
      return 'agent reply';
    case 'tool':
      return 'command or file';
    case 'error':
      return 'error';
    case 'side_user':
      return 'your side chat';
    case 'side_assistant':
      return 'Aside reply';
    default:
      return 'thread details';
  }
}

function scheduleThreadSearch(delayMs = 65): void {
  if (searchTimer) clearTimeout(searchTimer);
  const query = searchQuery.trim();
  if (query.length < 3) {
    searchInFlight = false;
    searchError = null;
    searchResults = null;
    return;
  }
  const sequence = ++searchSequence;
  searchTimer = setTimeout(() => {
    searchTimer = null;
    searchInFlight = true;
    searchError = null;
    if (latestState) renderThreads(latestState);
    void window.aside
      .searchThreads(query)
      .then((results) => {
        if (
          sequence !== searchSequence ||
          query !== searchQuery.trim()
        ) {
          return;
        }
        searchResults = results;
      })
      .catch(() => {
        if (sequence === searchSequence) {
          searchResults = null;
          searchError = 'Content search unavailable · showing metadata matches';
        }
      })
      .finally(() => {
        if (sequence !== searchSequence) return;
        searchInFlight = false;
        if (latestState) renderThreads(latestState);
      });
  }, delayMs);
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
  const session = activeSession(state);
  const attentionCard = session?.needsAttention
    ? makeAttentionCard(session)
    : null;
  if (
    state.messages.length === 0 &&
    !state.thinking &&
    !session?.needsAttention
  ) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    const title = document.createElement('strong');
    title.textContent = session
      ? `Ask about ${session.title || session.projectName}`
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
  if (attentionCard) {
    messagesEl.appendChild(attentionCard);
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

function makeAttentionCard(session: SessionSummary): HTMLElement {
  const card = document.createElement('section');
  card.className = `attention-card attention-card-${session.attentionKind}${
    session.attentionUnread ? ' unread' : ''
  }`;
  card.setAttribute('aria-label', 'Task attention status');

  const meta = document.createElement('div');
  meta.className = 'attention-card-meta';
  const status = document.createElement('span');
  status.className = 'attention-card-status';
  status.textContent =
    session.attentionKind === 'waiting'
      ? 'Needs your input'
      : session.attentionKind === 'completed' ||
          session.attentionKind === 'forgotten'
        ? 'Needs review'
        : 'Needs attention';
  const timing = document.createElement('span');
  timing.textContent = attentionTiming(
    session.attentionKind,
    session.attentionSince,
  );
  meta.append(status, timing);

  const headline = document.createElement('strong');
  headline.className = 'attention-card-headline';
  headline.textContent =
    session.attentionHeadline || attentionLabel(session.attentionKind);
  const context = document.createElement('p');
  context.textContent =
    stripMarkdown(
      session.attentionContext ||
      session.attentionReason ||
      'The latest agent activity is ready for review.',
    );
  card.append(meta, headline, context);

  // An explicit input/approval request is authoritative until the native
  // session moves forward. Other attention can be deliberately reviewed.
  if (session.attentionKind !== 'waiting') {
    const actions = document.createElement('div');
    actions.className = 'attention-card-actions';
    const review = document.createElement('button');
    review.type = 'button';
    review.className = 'attention-review';
    review.textContent = 'Mark reviewed';
    review.addEventListener('click', () => {
      review.disabled = true;
      void window.aside.resolveAttention(session.threadId);
    });
    actions.appendChild(review);
    card.appendChild(actions);
  }
  return card;
}

function render(state: MenubarState): void {
  latestState = state;
  if (
    searchQuery.trim().length >= 3 &&
    state.searchIndex.indexedThreads !== lastIndexedThreadCount &&
    !searchInFlight &&
    searchTimer === null
  ) {
    lastIndexedThreadCount = state.searchIndex.indexedThreads;
    scheduleThreadSearch(120);
  }
  const session = activeSession(state);
  const topLevelCount = state.sessions.filter(
    (item) => !item.isInternal,
  ).length;
  const subagentCount = state.sessions.length - topLevelCount;
  scopeTitleEl.textContent = session?.title || session?.projectName || 'All agents';
  scopeMetaEl.textContent = session
    ? `${session.projectName} · ${session.isInternal ? 'subagent · ' : ''}${
        session.source
      } · ${session.status} · persistent thread`
    : `${state.recentSessionCount} recent · ${topLevelCount} threads${
        showSubagentThreads && subagentCount > 0
          ? ` · ${subagentCount} subagents`
          : ''
      } · fleet conversation`;
  needsCountEl.textContent =
    state.attentionCount > 0
      ? `${state.attentionCount} need attention`
      : '';
  needsCountEl.hidden = state.attentionCount === 0;
  threadCountEl.textContent = String(topLevelCount);
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
  if (firstRun && !accountsPopoverEl.hidden) {
    accountsPopoverEl.hidden = true;
    accountsButtonEl.setAttribute('aria-expanded', 'false');
    pendingDisconnectId = null;
    lastProviderSurfaceKey = '';
  }

  inputEl.placeholder = canAsk
    ? session
      ? `Ask about ${session.title || session.projectName}…`
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
  storagePathEl.textContent = state.storagePath;
  diagnosticsEl.textContent =
    `${topLevelCount} threads · ${subagentCount} subagents · ${state.recentSessionCount} recent · ` +
    `${state.attentionCount} need attention · ` +
    `${state.provider}/${state.model} · ` +
    `${usable.length} connected`;
  searchIndexStatusEl.textContent =
    state.searchIndex.phase === 'error'
      ? `Index unavailable: ${state.searchIndex.message ?? 'unknown error'}`
      : state.searchIndex.phase === 'ready'
        ? `${state.searchIndex.indexedThreads} threads indexed on this Mac`
        : state.searchIndex.phase === 'optimizing'
          ? 'Optimizing the local content index…'
          : `${state.searchIndex.indexedThreads} of ${state.searchIndex.totalThreads} threads indexed…`;
  rebuildSearchIndexEl.disabled =
    state.searchIndex.phase === 'starting' ||
    state.searchIndex.phase === 'indexing' ||
    state.searchIndex.phase === 'optimizing';

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
  resizeComposerInput();
  void window.aside.ask(question).catch(() => void refreshProviderAuth());
});

inputEl.addEventListener('input', resizeComposerInput);
inputEl.addEventListener('keydown', (event) => {
  if (
    event.key === 'Enter' &&
    !event.shiftKey &&
    !event.isComposing
  ) {
    event.preventDefault();
    formEl.requestSubmit();
  }
});

keepOpenEl.addEventListener('click', () => {
  keepOpenEl.disabled = true;
  void window.aside
    .setKeepOpen(!keepOpen)
    .then(renderWindowMode)
    .finally(() => {
      keepOpenEl.disabled = false;
    });
});

accountsButtonEl.addEventListener('click', () => {
  if (accountsPopoverEl.hidden) showAccounts();
  else hideAccounts();
});
accountsCloseEl.addEventListener('click', hideAccounts);
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
showSubagentThreadsEl.checked = showSubagentThreads;
showSubagentThreadsEl.addEventListener('change', () => {
  showSubagentThreads = showSubagentThreadsEl.checked;
  localStorage.setItem(
    showSubagentsStorageKey,
    showSubagentThreads ? '1' : '0',
  );
  if (latestState) render(latestState);
});
openDataEl.addEventListener('click', () => void window.aside.openDataFolder());
quitEl.addEventListener('click', () => void window.aside.quit());
rebuildSearchIndexEl.addEventListener('click', () => {
  rebuildSearchIndexEl.disabled = true;
  void window.aside.rebuildSearchIndex();
});
checkUpdateEl.addEventListener('click', () => {
  checkUpdateEl.disabled = true;
  updateStatusEl.textContent = 'Checking for updates…';
  void window.aside
    .checkForUpdates()
    .then(renderAppUpdate)
    .catch((error) => {
      updateStatusEl.textContent = safeErrorMessage(error);
    })
    .finally(() => {
      if (appUpdateStatus?.phase !== 'downloading' && appUpdateStatus?.phase !== 'ready') {
        checkUpdateEl.disabled = false;
      }
    });
});
restartUpdateEl.addEventListener('click', () => void restartToUpdate());
updateReadyRestartEl.addEventListener('click', () => void restartToUpdate());
manualUpdateEl.addEventListener('click', () => {
  manualUpdateEl.disabled = true;
  updateStatusEl.textContent = 'Opening the signed installer…';
  void window.aside
    .openManualUpdate()
    .catch((error) => {
      updateStatusEl.textContent = safeErrorMessage(error);
    })
    .finally(() => {
      manualUpdateEl.disabled = false;
    });
});
function openFeedback(kind: 'bug' | 'feature'): void {
  reportBugEl.disabled = true;
  requestFeatureEl.disabled = true;
  feedbackStatusEl.hidden = true;
  feedbackStatusEl.textContent = '';
  void window.aside
    .openFeedback(kind)
    .catch((error) => {
      feedbackStatusEl.textContent = safeErrorMessage(error);
      feedbackStatusEl.hidden = false;
    })
    .finally(() => {
      reportBugEl.disabled = false;
      requestFeatureEl.disabled = false;
    });
}
reportBugEl.addEventListener('click', () => openFeedback('bug'));
requestFeatureEl.addEventListener('click', () => openFeedback('feature'));
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
  searchResults = null;
  searchError = null;
  searchSequence += 1;
  scheduleThreadSearch();
  if (latestState) renderThreads(latestState);
});

searchEl.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && searchEl.value) {
    searchEl.value = '';
    searchQuery = '';
    searchResults = null;
    searchInFlight = false;
    searchError = null;
    searchSequence += 1;
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = null;
    if (latestState) renderThreads(latestState);
    event.stopPropagation();
  }
});

window.aside.onUpdate(render);
window.aside.onProviderAuthUpdate(updateProviderAuth);
window.aside.onAppUpdate(renderAppUpdate);
window.aside.onShowSettings(showSettings);
window.aside.onWindowMode(renderWindowMode);
void window.aside.getState().then(render);
void window.aside.getWindowMode().then(renderWindowMode);
void window.aside
  .getUpdateStatus()
  .then(renderAppUpdate)
  .catch(() => {
    appVersionEl.textContent = 'Aside';
    updateStatusEl.textContent = 'Version unavailable.';
  });
void window.aside
  .getProviderAuth()
  .then(updateProviderAuth)
  .catch((error) => {
    authPhase = 'error';
    authError = safeErrorMessage(error);
    lastProviderSurfaceKey = '';
    if (latestState) render(latestState);
  });
