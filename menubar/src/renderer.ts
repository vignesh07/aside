// Renderer for the menubar window. It receives immutable state over the narrow
// preload bridge; model output is always rendered with textContent.

import type {
  MenubarState,
  SessionSummary,
  ThreadReviewViewState,
  TodayViewState,
} from './backend.js';
import type {
  ActivityEvidenceRef,
  ActivityInsight,
  TodayProjectDiary,
  TodayThreadDiary,
} from '../../dist/types/today.js';
import type { GeneratedArtifact } from '../../dist/types/generated-artifact.js';
import { stripMarkdown } from '../../dist/utils/markdown.js';
import { parseGeneratedProse } from './generated-prose.js';
import { shouldGenerateTodayOnEntry } from './today-generation.js';
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
import type {
  UsageAnalyticsQuery,
  UsageAnalyticsSnapshot,
  UsageDay,
} from './usage-types.js';
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
  getUsage(query: UsageAnalyticsQuery): Promise<UsageAnalyticsSnapshot>;
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
  getToday(): Promise<TodayViewState>;
  getTodayGenerationConsent(provider: string): Promise<boolean>;
  allowTodayGeneration(provider: string): Promise<boolean>;
  generateTodayRecap(): Promise<TodayViewState>;
  getThreadReview(
    threadId: string,
    source: SessionSummary['source'],
  ): Promise<ThreadReviewViewState>;
  generateThreadReview(
    threadId: string,
    source: SessionSummary['source'],
  ): Promise<ThreadReviewViewState>;
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
const analysisViewEl = document.getElementById('analysis-view') as HTMLDivElement;
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
const reviewThreadEl = document.getElementById('review-thread') as HTMLButtonElement;
const composerShellEl = document.getElementById('composer-shell') as HTMLDivElement;
const threadCountEl = document.getElementById('thread-count') as HTMLSpanElement;
const settingsEl = document.getElementById('settings') as HTMLDivElement;
const settingsButtonEl = document.getElementById('settings-button') as HTMLButtonElement;
const settingsCloseEl = document.getElementById('settings-close') as HTMLButtonElement;
const settingsProvidersEl = document.getElementById('settings-providers') as HTMLDivElement;
const openUsageEl = document.getElementById('open-usage') as HTMLButtonElement;
const usageViewEl = document.getElementById('usage-view') as HTMLDivElement;
const usageStatusEl = document.getElementById('usage-status') as HTMLDivElement;
const usageIndexProgressEl = document.getElementById('usage-index-progress') as HTMLParagraphElement;
const usageContentEl = document.getElementById('usage-content') as HTMLDivElement;
const usageProviderFiltersEl = document.getElementById('usage-provider-filters') as HTMLDivElement;
const usageModelFilterEl = document.getElementById('usage-model-filter') as HTMLSelectElement;
const usageTotalTokensEl = document.getElementById('usage-total-tokens') as HTMLElement;
const usageEstimatedCostEl = document.getElementById('usage-estimated-cost') as HTMLElement;
const usageEstimatedSavingsEl = document.getElementById('usage-estimated-savings') as HTMLElement;
const usageActiveDaysEl = document.getElementById('usage-active-days') as HTMLElement;
const usageStreaksEl = document.getElementById('usage-streaks') as HTMLSpanElement;
const usageChartEl = document.getElementById('usage-chart') as HTMLDivElement;
const usageChartScrollEl = document.getElementById('usage-chart-scroll') as HTMLDivElement;
const usageMonthsEl = document.getElementById('usage-months') as HTMLDivElement;
const usageGridEl = document.getElementById('usage-grid') as HTMLDivElement;
const usagePeakEl = document.getElementById('usage-peak') as HTMLSpanElement;
const usagePricedCoverageEl = document.getElementById('usage-priced-coverage') as HTMLSpanElement;
const usageBreakdownEl = document.getElementById('usage-breakdown') as HTMLDivElement;
const usageNoteEl = document.getElementById('usage-note') as HTMLParagraphElement;
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
type ActiveView = 'thread' | 'today' | 'review' | 'usage';
let activeView: ActiveView = 'thread';
let todayView: TodayViewState | null = null;
let todayLoading = false;
let todayGenerating = false;
let todayError: string | null = null;
let todayGenerationError: string | null = null;
let todayLoadedRevision = '';
let todayFailedRevision = '';
let todayRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let todayEntryGenerationAttempted = false;
let todayConsentProvider = '';
let todayConsentGranted = false;
let todayConsentGranting = false;
let todayConsentError: string | null = null;
let reviewView: ThreadReviewViewState | null = null;
let reviewThreadId: string | null = null;
let reviewThreadSource: SessionSummary['source'] | null = null;
let reviewLoading = false;
let reviewGenerating = false;
let reviewError: string | null = null;
let reviewGenerationError: string | null = null;
let reviewLoadedRevision = '';
let reviewFailedRevision = '';
let reviewRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let usageRangeDays: 90 | 365 = 365;
let usageProviders = new Set<string>();
let usageModel: { provider: string; model: string } | null = null;
let usageSequence = 0;
let usageRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let usageIndexSignature = '';
let usageScrollToLatest = true;

const modelKey = (provider: string, model: string) => `${provider}:${model}`;

function observerModelLabel(provider: string, model: string): string {
  const status = providerAuth.find((item) => item.provider === provider);
  const providerLabel = status
    ? providerDisplayName(status.provider)
    : provider;
  const option = latestState?.models.find(
    (item) => item.provider === provider && item.model === model,
  );
  const modelLabel = (option?.label ?? model).replace(/\s+\([^()]+\)$/, '');
  return `${providerLabel} · ${modelLabel}`;
}

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

function clearSearch(): void {
  searchEl.value = '';
  searchQuery = '';
  searchResults = null;
  searchInFlight = false;
  searchError = null;
  searchSequence += 1;
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = null;
}

function selectChatThread(threadId: string): void {
  activeView = 'thread';
  reviewError = null;
  reviewGenerationError = null;
  void window.aside.selectThread(threadId);
  if (latestState) render(latestState);
}

function sessionForActivityThreadKey(
  state: MenubarState,
  activityThreadKey: string,
): SessionSummary | undefined {
  return state.sessions.find(
    (session) => `${session.source}:${session.id}` === activityThreadKey,
  );
}

function openEvidenceThread(activityThreadKey: string): void {
  if (!latestState) return;
  const session = sessionForActivityThreadKey(latestState, activityThreadKey);
  if (!session) return;
  attentionOnly = false;
  clearSearch();
  selectChatThread(session.threadId);
}

function localDateKey(now = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function activityViewRevision(state: MenubarState): string {
  return [
    state.activityHighWaterSeq,
    state.activityCursorRevision,
    localDateKey(),
    state.provider,
    state.model,
  ].join(':');
}

function showToday(): void {
  activeView = 'today';
  todayError = null;
  todayGenerationError = null;
  todayConsentError = null;
  todayFailedRevision = '';
  todayLoadedRevision = '';
  todayEntryGenerationAttempted = false;
  if (
    todayView &&
    todayView.diary.range.dateKey !== localDateKey()
  ) {
    todayView = null;
  }
  if (todayRefreshTimer) clearTimeout(todayRefreshTimer);
  todayRefreshTimer = null;
  if (latestState) {
    render(latestState);
    scheduleTodayRefresh(activityViewRevision(latestState), 0);
  }
}

function showUsage(): void {
  activeView = 'usage';
  usageScrollToLatest = true;
  if (!settingsEl.hidden) settingsEl.hidden = true;
  if (latestState) render(latestState);
  else renderAnalysisView();
  void loadUsage(true);
}

function showThreadReview(session: SessionSummary): void {
  activeView = 'review';
  reviewThreadId = session.threadId;
  reviewThreadSource = session.source;
  reviewView = null;
  reviewError = null;
  reviewGenerationError = null;
  reviewLoadedRevision = '';
  reviewFailedRevision = '';
  if (latestState) {
    render(latestState);
    scheduleReviewRefresh(activityViewRevision(latestState), 0);
  }
}

function scheduleTodayRefresh(revision: string, delayMs = 160): void {
  if (activeView !== 'today' || todayGenerating) return;
  if (
    (todayView && todayLoadedRevision === revision) ||
    todayFailedRevision === revision
  ) {
    return;
  }
  if (todayRefreshTimer) clearTimeout(todayRefreshTimer);
  todayRefreshTimer = setTimeout(() => {
    todayRefreshTimer = null;
    void loadToday(revision);
  }, delayMs);
}

async function loadToday(requestedRevision: string): Promise<void> {
  if (todayLoading || activeView !== 'today') return;
  todayLoading = true;
  todayError = null;
  let loaded = false;
  renderAnalysisView();
  try {
    const nextView = await window.aside.getToday();
    todayView = nextView;
    todayConsentProvider = nextView.provider;
    try {
      todayConsentGranted = await window.aside.getTodayGenerationConsent(
        nextView.provider,
      );
      todayConsentError = null;
    } catch (error) {
      todayConsentGranted = false;
      todayConsentError = safeErrorMessage(error);
    }
    todayLoadedRevision = requestedRevision;
    todayFailedRevision = '';
    loaded = true;
  } catch (error) {
    todayError = safeErrorMessage(error);
    todayFailedRevision = requestedRevision;
  } finally {
    todayLoading = false;
    if (loaded) maybeGenerateTodayForEntry();
    if (latestState) render(latestState);
    else renderAnalysisView();
    const current = latestState
      ? activityViewRevision(latestState)
      : requestedRevision;
    if (activeView === 'today' && current !== todayLoadedRevision) {
      scheduleTodayRefresh(current);
    }
  }
}

/**
 * Opening Today is the only automatic generation intent. A live activity
 * stream may refresh the local diary many times, but it must never turn into a
 * provider-call loop. Re-entering Today grants exactly one new attempt.
 */
function maybeGenerateTodayForEntry(): void {
  if (!todayView) return;
  if (!shouldGenerateTodayOnEntry({
    active: activeView === 'today',
    attemptedThisEntry: todayEntryGenerationAttempted,
    generating: todayGenerating,
    eventCount: todayView.narrativeEventCount,
    hasArtifact: todayView.artifact !== null,
    artifactIsStale: todayView.artifactIsStale,
    authReady: authPhase === 'ready',
    providerUsable: canAskWithProvider(providerAuth, todayView.provider),
    consentGranted:
      todayConsentProvider === todayView.provider && todayConsentGranted,
  })) return;
  todayEntryGenerationAttempted = true;
  void generateTodayRecap();
}

async function allowTodayGeneration(): Promise<void> {
  const view = todayView;
  if (!view || todayConsentGranting) return;
  const provider = view.provider;
  todayConsentGranting = true;
  todayConsentError = null;
  renderAnalysisView();
  try {
    const granted = await window.aside.allowTodayGeneration(provider);
    if (todayView?.provider === provider) {
      todayConsentProvider = provider;
      todayConsentGranted = granted;
    }
  } catch (error) {
    if (todayView?.provider === provider) {
      todayConsentGranted = false;
      todayConsentError = safeErrorMessage(error);
    }
  } finally {
    todayConsentGranting = false;
    if (latestState) render(latestState);
    else renderAnalysisView();
    maybeGenerateTodayForEntry();
  }
}

function scheduleReviewRefresh(revision: string, delayMs = 160): void {
  if (
    activeView !== 'review' ||
    !reviewThreadId ||
    !reviewThreadSource ||
    reviewGenerating
  ) {
    return;
  }
  if (
    (reviewView && reviewLoadedRevision === revision) ||
    reviewFailedRevision === revision
  ) {
    return;
  }
  if (reviewRefreshTimer) clearTimeout(reviewRefreshTimer);
  reviewRefreshTimer = setTimeout(() => {
    reviewRefreshTimer = null;
    void loadThreadReview(revision);
  }, delayMs);
}

async function loadThreadReview(requestedRevision: string): Promise<void> {
  const threadId = reviewThreadId;
  const source = reviewThreadSource;
  if (reviewLoading || activeView !== 'review' || !threadId || !source) return;
  reviewLoading = true;
  reviewError = null;
  renderAnalysisView();
  try {
    const next = await window.aside.getThreadReview(threadId, source);
    if (
      activeView === 'review' &&
      reviewThreadId === threadId &&
      reviewThreadSource === source
    ) {
      reviewView = next;
      reviewLoadedRevision = requestedRevision;
      reviewFailedRevision = '';
    }
  } catch (error) {
    if (
      activeView === 'review' &&
      reviewThreadId === threadId &&
      reviewThreadSource === source
    ) {
      reviewError = safeErrorMessage(error);
      reviewFailedRevision = requestedRevision;
    }
  } finally {
    reviewLoading = false;
    if (latestState) render(latestState);
    else renderAnalysisView();
    const current = latestState
      ? activityViewRevision(latestState)
      : requestedRevision;
    if (
      activeView === 'review' &&
      current !== reviewLoadedRevision
    ) {
      scheduleReviewRefresh(current);
    }
  }
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
  const todayProvider =
    activeView === 'today' ? todayView?.provider ?? null : null;
  const previousTodayStatus = todayProvider
    ? providerAuth.find((status) => status.provider === todayProvider)
    : undefined;
  providerAuth = statuses;
  authPhase = 'ready';
  authError = null;
  if (statuses.some(isProviderUsable)) {
    localStorage.setItem('aside:onboarding:v1', '1');
  }
  lastProviderSurfaceKey = '';
  const nextTodayStatus = todayProvider
    ? statuses.find((status) => status.provider === todayProvider)
    : undefined;
  const todayAccessChanged =
    todayProvider !== null &&
    (previousTodayStatus?.state !== nextTodayStatus?.state ||
      previousTodayStatus?.enabled !== nextTodayStatus?.enabled);
  if (todayAccessChanged && todayProvider) {
    // Base provider access and Today permission are independent. Re-read the
    // narrower grant after a disconnect/reconnect instead of trusting cached
    // renderer state; the main process remains authoritative either way.
    todayConsentProvider = todayProvider;
    todayConsentGranted = false;
    todayConsentError = null;
    if (latestState) render(latestState);
    void refreshTodayConsentAfterAuthChange(todayProvider);
    return;
  }
  if (latestState) render(latestState);
  maybeGenerateTodayForEntry();
}

async function refreshTodayConsentAfterAuthChange(
  provider: string,
): Promise<void> {
  let granted = false;
  let error: string | null = null;
  try {
    granted = await window.aside.getTodayGenerationConsent(provider);
  } catch (reason) {
    error = safeErrorMessage(reason);
  }
  if (activeView !== 'today' || todayView?.provider !== provider) return;
  todayConsentProvider = provider;
  todayConsentGranted = granted;
  todayConsentError = error;
  if (latestState) render(latestState);
  else renderAnalysisView();
  maybeGenerateTodayForEntry();
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
    today?: boolean;
    usage?: boolean;
    pressed?: boolean;
    onSelect?: () => void;
  },
): HTMLButtonElement {
  const button = document.createElement('button');
  const selected =
    options.selected ??
    ((activeView === 'thread' || activeView === 'review') &&
      state.activeThreadId === options.threadId);
  const attentionKind = options.attentionKind ?? 'none';
  button.type = 'button';
  button.className = `thread${selected ? ' active' : ''}${
    options.needsAttention ? ` needs-attention attention-${attentionKind}` : ''
  }${options.nested ? ' nested' : ''}`;
  if (options.subagent) button.classList.add('subagent');
  if (options.searchResult) button.classList.add('search-result');
  if (options.smart) button.classList.add('attention-smart');
  if (options.today) button.classList.add('today-smart');
  if (options.usage) button.classList.add('usage-smart');
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
    else selectChatThread(options.threadId);
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
      selected:
        activeView === 'thread' &&
        state.activeThreadId === FLEET_THREAD_ID,
      onSelect: () => {
        attentionOnly = false;
        selectChatThread(FLEET_THREAD_ID);
      },
    }),
  );
  threadsEl.appendChild(
    makeThreadButton(state, {
      threadId: 'today',
      title: 'Today',
      subtitle: 'Your daily recap',
      glyph: String(new Date().getDate()),
      selected: activeView === 'today',
      today: true,
      onSelect: showToday,
    }),
  );
  threadsEl.appendChild(
    makeThreadButton(state, {
      threadId: 'usage',
      title: 'Usage',
      subtitle: 'Tokens and models',
      glyph: '▥',
      selected: activeView === 'usage',
      usage: true,
      onSelect: showUsage,
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

function formatTime(timestampMs: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(timestampMs));
}

function formatTodayDate(dateKey: string): string {
  const [year, month, day] = dateKey.split('-').map(Number);
  if (!year || !month || !day) return dateKey;
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(new Date(year, month - 1, day));
}

function plural(value: number, singular: string, pluralForm = `${singular}s`): string {
  return `${value} ${value === 1 ? singular : pluralForm}`;
}

function makeAnalysisAction(
  label: string,
  onClick: () => void,
  options: { id?: string; primary?: boolean; disabled?: boolean } = {},
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `analysis-action${options.primary ? ' primary' : ''}`;
  if (options.id) button.id = options.id;
  button.textContent = label;
  button.disabled = options.disabled ?? false;
  button.addEventListener('click', onClick);
  return button;
}

function makeSectionHeading(
  titleText: string,
  detailText?: string,
): HTMLDivElement {
  const heading = document.createElement('div');
  heading.className = 'analysis-section-heading';
  const copy = document.createElement('div');
  const title = document.createElement('h2');
  title.textContent = titleText;
  copy.appendChild(title);
  if (detailText) {
    const detail = document.createElement('p');
    detail.textContent = detailText;
    copy.appendChild(detail);
  }
  heading.appendChild(copy);
  return heading;
}

function appendMetric(
  container: HTMLElement,
  value: number,
  label: string,
): void {
  const metric = document.createElement('div');
  metric.className = 'analysis-metric';
  const number = document.createElement('strong');
  number.textContent = String(value);
  const copy = document.createElement('span');
  copy.textContent = label;
  metric.append(number, copy);
  container.appendChild(metric);
}

function makeStatusMessage(
  message: string,
  options: {
    kind?: 'error' | 'empty' | 'loading';
    actionLabel?: string;
    onAction?: () => void;
  } = {},
): HTMLDivElement {
  const row = document.createElement('div');
  row.className = `analysis-status ${options.kind ?? ''}`.trim();
  row.setAttribute('role', options.kind === 'error' ? 'alert' : 'status');
  const copy = document.createElement('span');
  copy.textContent = message;
  row.appendChild(copy);
  if (options.actionLabel && options.onAction) {
    row.appendChild(
      makeAnalysisAction(options.actionLabel, options.onAction),
    );
  }
  return row;
}

function makeEvidenceControl(
  evidence: ActivityEvidenceRef,
  compact = false,
  citationNumber?: number,
): HTMLElement {
  const session = latestState
    ? sessionForActivityThreadKey(latestState, evidence.threadKey)
    : undefined;
  const control = document.createElement(session ? 'button' : 'div');
  control.className = compact ? 'evidence-chip' : 'evidence-row';
  if (control instanceof HTMLButtonElement) {
    control.type = 'button';
    control.addEventListener('click', () => openEvidenceThread(evidence.threadKey));
    control.title = 'Open this thread';
  }

  if (citationNumber !== undefined) {
    const citation = document.createElement('span');
    citation.className = 'evidence-citation';
    citation.textContent = `[${citationNumber}]`;
    control.appendChild(citation);
  }
  const time = document.createElement('span');
  time.className = 'evidence-time';
  time.textContent = formatTime(evidence.occurredAtMs);
  const copy = document.createElement('span');
  copy.className = 'evidence-copy';
  const sourceLabel = session?.title || session?.projectName || 'Recorded activity';
  copy.textContent = compact
    ? sourceLabel
    : `${evidence.summary} · ${evidence.kind.replaceAll('_', ' ')}`;
  control.append(time, copy);
  if (session) {
    const arrow = document.createElement('span');
    arrow.className = 'evidence-arrow';
    arrow.textContent = '›';
    arrow.setAttribute('aria-hidden', 'true');
    control.appendChild(arrow);
  }
  control.setAttribute(
    'aria-label',
    `${
      citationNumber !== undefined ? `Evidence ${citationNumber}, ` : ''
    }${formatTime(evidence.occurredAtMs)}, ${compact ? sourceLabel : evidence.summary}${
      session ? `, open ${session.title || session.projectName}` : ''
    }`,
  );
  return control;
}

function appendEvidenceChips(
  container: HTMLElement,
  evidence: ActivityEvidenceRef[],
  limit = 3,
): void {
  if (evidence.length === 0) return;
  const chips = document.createElement('div');
  chips.className = 'evidence-chips';
  for (const item of evidence.slice(0, limit)) {
    chips.appendChild(makeEvidenceControl(item, true));
  }
  container.appendChild(chips);
}

function appendInsights(
  container: HTMLElement,
  insights: ActivityInsight[],
): void {
  if (insights.length === 0) return;
  const section = document.createElement('section');
  section.className = 'analysis-section insight-section';
  section.appendChild(
    makeSectionHeading(
      'Needs attention',
      'Threads that may need a decision or follow-up.',
    ),
  );
  const list = document.createElement('div');
  list.className = 'insight-list';
  for (const insight of insights) {
    const row = document.createElement('article');
    row.className = `insight-row severity-${insight.severity}`;
    const marker = document.createElement('span');
    marker.className = 'insight-marker';
    marker.setAttribute('aria-hidden', 'true');
    const copy = document.createElement('div');
    copy.className = 'insight-copy';
    const headline = document.createElement('h3');
    headline.textContent = insight.headline;
    const detail = document.createElement('p');
    detail.textContent = insight.detail;
    const meta = document.createElement('div');
    meta.className = 'insight-meta';
    meta.textContent = `${insight.projectName} · ${formatTime(insight.occurredAtMs)}`;
    copy.append(headline, detail, meta);
    appendEvidenceChips(copy, insight.evidence);
    row.append(marker, copy);
    list.appendChild(row);
  }
  section.appendChild(list);
  container.appendChild(section);
}

function appendArtifactEvidence(
  container: HTMLElement,
  artifact: GeneratedArtifact,
  available: ActivityEvidenceRef[],
  missingCount: number,
): void {
  const byId = new Map(available.map((item) => [item.eventId, item]));
  const cited = artifact.evidenceIds.map((id, index) => ({
    index: index + 1,
    evidence: byId.get(id),
  }));
  const retained = cited.filter(
    (item): item is { index: number; evidence: ActivityEvidenceRef } =>
      Boolean(item.evidence),
  );
  if (retained.length > 0) {
    const sources = document.createElement('details');
    sources.className = 'artifact-sources';
    const label = document.createElement('summary');
    label.className = 'artifact-evidence-label';
    label.textContent = `Sources · ${retained.length}`;
    sources.appendChild(label);
    const chips = document.createElement('div');
    chips.className = 'evidence-chips artifact-evidence';
    for (const item of retained) {
      chips.appendChild(
        makeEvidenceControl(item.evidence, true, item.index),
      );
    }
    sources.appendChild(chips);
    container.appendChild(sources);
  }
  if (missingCount > 0) {
    const missing = document.createElement('p');
    missing.className = 'analysis-footnote artifact-missing';
    missing.textContent =
      `${plural(missingCount, 'older citation')} no longer retained locally.`;
    container.appendChild(missing);
  }
}

function makeGeneratedProse(markdown: string): HTMLDivElement {
  const prose = document.createElement('div');
  prose.className = 'artifact-prose';
  for (const [index, section] of parseGeneratedProse(markdown).entries()) {
    const block = document.createElement('section');
    block.className = `artifact-block${index === 0 ? ' lead' : ''}`;
    if (section.heading) {
      const heading = document.createElement('h3');
      heading.textContent = section.heading;
      block.appendChild(heading);
    }
    for (const value of section.paragraphs) {
      const paragraph = document.createElement('p');
      paragraph.textContent = value;
      block.appendChild(paragraph);
    }
    if (section.items.length > 0) {
      const list = document.createElement('ul');
      for (const value of section.items) {
        const item = document.createElement('li');
        item.textContent = value;
        list.appendChild(item);
      }
      block.appendChild(list);
    }
    prose.appendChild(block);
  }
  return prose;
}

function appendGeneratedArtifact(
  container: HTMLElement,
  options: {
    kind: 'today' | 'review';
    title: string;
    emptyCopy: string;
    buttonId: string;
    artifact: GeneratedArtifact | null;
    evidence: ActivityEvidenceRef[];
    artifactEvidenceMissingCount: number;
    newEventCount: number;
    artifactIsStale: boolean;
    provider: string;
    model: string;
    generating: boolean;
    error: string | null;
    disabled: boolean;
    consentRequired?: boolean;
    consentGranted?: boolean;
    consentGranting?: boolean;
    consentError?: string | null;
    onConsent?: () => void;
    onGenerate: () => void;
  },
): void {
  const isToday = options.kind === 'today';
  const selectedModel = observerModelLabel(options.provider, options.model);
  const section = document.createElement('section');
  section.className = `analysis-section generated-section generated-${options.kind}`;
  const heading = makeSectionHeading(options.title);
  const actionLabel = isToday && options.consentRequired
    ? null
    : isToday
    ? options.error
      ? null
      : options.generating && options.artifact
        ? 'Updating…'
        : options.artifactIsStale
          ? 'Update'
          : null
    : options.generating
      ? 'Generating…'
      : options.artifact
        ? 'Regenerate'
        : 'Generate review';
  if (actionLabel) {
    heading.appendChild(
      makeAnalysisAction(actionLabel, options.onGenerate, {
        id: options.buttonId,
        primary: !isToday,
        disabled: options.disabled || options.generating,
      }),
    );
  }
  section.appendChild(heading);

  if (options.artifact) {
    const artifactMeta = document.createElement('div');
    artifactMeta.className = 'artifact-meta';
    const created = Date.parse(options.artifact.createdAt);
    const artifactModel = observerModelLabel(
      options.artifact.provider,
      options.artifact.model,
    );
    artifactMeta.textContent = Number.isFinite(created)
      ? `Updated ${formatTime(created)} · ${artifactModel}`
      : `Generated with ${artifactModel}`;
    if (options.artifactIsStale) {
      const stale = document.createElement('span');
      stale.className = 'artifact-stale';
      stale.textContent =
        options.newEventCount > 0
          ? `${plural(options.newEventCount, 'new update')} since this ${
              isToday ? 'recap' : 'review'
            }`
          : `Activity changed since this ${isToday ? 'recap' : 'review'}`;
      artifactMeta.appendChild(stale);
    }
    section.appendChild(artifactMeta);
    section.appendChild(makeGeneratedProse(options.artifact.markdown));
    appendArtifactEvidence(
      section,
      options.artifact,
      options.evidence,
      options.artifactEvidenceMissingCount,
    );
  } else if (options.generating) {
    section.appendChild(
      makeStatusMessage(
        isToday ? 'Preparing today’s recap…' : 'Generating this review…',
        { kind: 'loading' },
      ),
    );
  } else if (!options.consentRequired) {
    const empty = document.createElement('p');
    empty.className = 'analysis-muted';
    empty.textContent = options.emptyCopy;
    section.appendChild(empty);
  }

  if (options.error) {
    section.appendChild(
      makeStatusMessage(options.error, {
        kind: 'error',
        actionLabel: options.disabled ? undefined : 'Try again',
        onAction: options.disabled ? undefined : options.onGenerate,
      }),
    );
  }

  if (isToday && options.consentRequired) {
    const consent = document.createElement('div');
    consent.className = 'today-consent';
    const copy = document.createElement('div');
    copy.className = 'today-consent-copy';
    const title = document.createElement('h3');
    title.textContent = 'Generate recaps when you open Today';
    const detail = document.createElement('p');
    detail.textContent =
      `This sends a limited, redacted set of the day’s activity to ${selectedModel}. ` +
      'Aside stores the recap and its source links on this Mac.';
    copy.append(title, detail);
    const allow = makeAnalysisAction(
      options.consentGranting ? 'Saving…' : 'Allow Today recaps',
      options.onConsent ?? (() => {}),
      {
        id: 'allow-today-recaps',
        primary: true,
        disabled: options.consentGranting || !options.onConsent,
      },
    );
    consent.append(copy, allow);
    if (options.consentError) {
      const error = document.createElement('p');
      error.className = 'today-consent-error';
      error.setAttribute('role', 'alert');
      error.textContent = options.consentError;
      consent.appendChild(error);
    }
    section.appendChild(consent);
  }

  if (isToday && options.consentRequired) {
    container.appendChild(section);
    return;
  }

  const privacy = document.createElement('p');
  privacy.className = 'analysis-footnote';
  privacy.textContent = options.provider === 'ollama'
    ? isToday
      ? `When needed, opening Today refreshes locally with ${selectedModel}. Aside stores recaps on this Mac.`
      : `Generates locally with ${selectedModel} when you ask. Review data stays on this Mac.`
    : isToday
      ? options.consentGranted
        ? `When needed, opening Today refreshes with ${selectedModel}. Scoped activity is redacted first; Aside stores recaps on this Mac.`
        : `This recap was generated with ${selectedModel}. Scoped activity was redacted first; Aside stores the recap on this Mac.`
      : `Uses ${selectedModel} when you choose Generate. Scoped activity is redacted before it leaves this Mac.`;
  section.appendChild(privacy);
  container.appendChild(section);
}

function diaryState(
  digest: TodayThreadDiary['digest'],
  session?: SessionSummary,
): { label: string; tone: string } {
  if (session?.needsAttention) {
    switch (session.attentionKind) {
      case 'waiting':
        return { label: 'Waiting for you', tone: 'attention' };
      case 'failed':
        return { label: 'Turn failed', tone: 'danger' };
      case 'interrupted':
        return { label: 'Interrupted', tone: 'attention' };
      case 'completed':
      case 'forgotten':
        return { label: 'Ready to review', tone: 'ready' };
      case 'stalled':
        return { label: 'Quiet', tone: 'muted' };
      default:
        break;
    }
  }
  switch (digest.state) {
    case 'waiting':
      return { label: 'Waiting for you', tone: 'attention' };
    case 'ready':
      return { label: 'Ready to review', tone: 'ready' };
    case 'failed':
      return { label: 'Turn failed', tone: 'danger' };
    case 'interrupted':
      return { label: 'Interrupted', tone: 'attention' };
    default:
      return { label: 'Active today', tone: 'active' };
  }
}

function makeThreadDiaryRow(thread: TodayThreadDiary): HTMLDivElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'diary-thread';
  const session = latestState
    ? sessionForActivityThreadKey(latestState, thread.threadKey)
    : undefined;
  const heading = document.createElement(session ? 'button' : 'div');
  heading.className = 'diary-thread-heading';
  if (heading instanceof HTMLButtonElement) {
    heading.type = 'button';
    heading.addEventListener('click', () => openEvidenceThread(thread.threadKey));
  }
  const copy = document.createElement('span');
  copy.className = 'diary-thread-copy';
  const title = document.createElement('strong');
  title.textContent = thread.title;
  const meta = document.createElement('span');
  const state = diaryState(thread.digest, session);
  meta.className = `diary-thread-state state-${state.tone}`;
  meta.textContent = state.label;
  copy.append(title, meta);
  heading.appendChild(copy);
  if (thread.digest.occurredAtMs !== null) {
    const time = document.createElement('time');
    time.textContent = formatTime(thread.digest.occurredAtMs);
    heading.appendChild(time);
  }
  wrapper.appendChild(heading);

  const digestCopy = session?.needsAttention
    ? session.attentionContext || session.attentionReason || thread.digest.summary
    : thread.digest.summary;
  if (digestCopy) {
    const digest = document.createElement('p');
    digest.className = 'diary-thread-digest';
    digest.textContent = stripMarkdown(digestCopy);
    wrapper.appendChild(digest);
  }

  if (thread.subagents.length > 0) {
    const subagents = document.createElement('details');
    subagents.className = 'diary-subagents';
    const label = document.createElement('summary');
    label.className = 'diary-subagents-label';
    label.textContent = plural(thread.subagents.length, 'subagent');
    subagents.appendChild(label);
    const list = document.createElement('div');
    list.className = 'diary-subagent-list';
    for (const subagent of thread.subagents) {
      const subagentSession = latestState
        ? sessionForActivityThreadKey(latestState, subagent.threadKey)
        : undefined;
      const row = document.createElement(
        subagentSession ? 'button' : 'div',
      );
      row.className = 'diary-subagent';
      if (row instanceof HTMLButtonElement) {
        row.type = 'button';
        row.addEventListener('click', () =>
          openEvidenceThread(subagent.threadKey),
        );
      }
      const title = document.createElement('span');
      title.textContent = subagent.title;
      const facts = document.createElement('small');
      const state = diaryState(subagent.digest, subagentSession);
      facts.className = `state-${state.tone}`;
      facts.textContent = state.label;
      row.append(title, facts);
      if (subagent.digest.occurredAtMs !== null) {
        const time = document.createElement('time');
        time.textContent = formatTime(subagent.digest.occurredAtMs);
        row.appendChild(time);
      }
      list.appendChild(row);
    }
    subagents.appendChild(list);
    wrapper.appendChild(subagents);
  }
  return wrapper;
}

function appendTodayProject(
  container: HTMLElement,
  project: TodayProjectDiary,
): void {
  const section = document.createElement('section');
  section.className = 'diary-project';
  const heading = document.createElement('div');
  heading.className = 'diary-project-heading';
  const title = document.createElement('h2');
  title.textContent = project.projectName;
  const meta = document.createElement('span');
  const subagentCount = project.memberThreadCount - project.threadCount;
  meta.textContent = [
    plural(project.threadCount, 'conversation'),
    subagentCount > 0 ? plural(subagentCount, 'subagent') : '',
  ].filter(Boolean).join(' · ');
  heading.append(title, meta);
  section.appendChild(heading);
  for (const thread of project.threads) {
    section.appendChild(makeThreadDiaryRow(thread));
  }
  container.appendChild(section);
}

function renderTodayContent(view: TodayViewState): void {
  const content = document.createElement('div');
  content.className = 'analysis-content';
  const summary = document.createElement('section');
  summary.className = `today-summary${view.artifact ? ' has-artifact' : ''}`;
  const date = document.createElement('p');
  date.className = 'analysis-kicker';
  date.textContent = formatTodayDate(view.diary.range.dateKey);
  const overview = document.createElement('p');
  overview.className = 'today-overview';
  overview.textContent = view.diary.overview;
  summary.appendChild(date);
  // The deterministic local digest is the useful fallback while generation
  // is unavailable or in progress. Once a durable recap exists, let that
  // artifact lead instead of repeating a count-based summary above it.
  if (!view.artifact) summary.appendChild(overview);
  content.appendChild(summary);

  // On an empty day, `diary.overview` is sufficient; avoid adding a second,
  // visually heavier empty state below it.
  if (view.diary.counts.eventCount > 0) {
    const canGenerate =
      authPhase === 'ready' &&
      canAskWithProvider(providerAuth, view.provider);
    const recapNeedsGeneration =
      view.artifact === null || view.artifactIsStale;
    const consentGranted =
      todayConsentProvider === view.provider && todayConsentGranted;
    const consentRequired =
      canGenerate && recapNeedsGeneration && !consentGranted;
    if (view.artifact || view.narrativeEventCount > 0) {
      appendGeneratedArtifact(content, {
        kind: 'today',
        title: 'Daily recap',
        emptyCopy: canGenerate
          ? 'Preparing today’s recap…'
          : 'Connect the selected observer account to add a generated recap.',
        buttonId: 'update-today-recap',
        artifact: view.artifact,
        evidence: view.artifactEvidence,
        artifactEvidenceMissingCount: view.artifactEvidenceMissingCount,
        newEventCount: view.newEventCount,
        artifactIsStale: view.artifactIsStale,
        provider: view.provider,
        model: view.model,
        generating: todayGenerating,
        error: todayGenerationError,
        disabled: !canGenerate || !consentGranted,
        consentRequired,
        consentGranted,
        consentGranting: todayConsentGranting,
        consentError: todayConsentError,
        onConsent: () => void allowTodayGeneration(),
        onGenerate: () => void generateTodayRecap(),
      });
    }
    appendInsights(content, view.insights);

    const diary = document.createElement('section');
    diary.className = 'analysis-section diary-section';
    diary.appendChild(
      makeSectionHeading(
        'Projects',
        'The conversations that moved today.',
      ),
    );
    for (const project of view.diary.projects) {
      appendTodayProject(diary, project);
    }
    content.appendChild(diary);
  }
  analysisViewEl.appendChild(content);
}

function renderReviewContent(view: ThreadReviewViewState): void {
  const content = document.createElement('div');
  content.className = 'analysis-content';
  const evidence = view.evidence;
  const counts = view.counts;
  const overview = document.createElement('section');
  overview.className = 'review-overview';
  const metrics = document.createElement('div');
  metrics.className = 'analysis-metrics review-metrics';
  appendMetric(metrics, counts.eventCount, 'Events');
  appendMetric(metrics, counts.waitingCount, 'Input requests');
  appendMetric(metrics, counts.warningCount, 'Warnings');
  appendMetric(metrics, counts.errorCount, 'Turn failures');
  overview.appendChild(metrics);
  content.appendChild(overview);

  if (evidence.length === 0) {
    content.appendChild(
      makeStatusMessage(
        'No recorded activity is available for this thread yet.',
        { kind: 'empty' },
      ),
    );
  } else {
    appendInsights(content, view.insights);
    appendGeneratedArtifact(content, {
      kind: 'review',
      title: 'Thread review',
      emptyCopy:
        'Generate a review of the goal, approach, friction, observed outcome, and possible next step.',
      buttonId: 'generate-review',
      artifact: view.artifact,
      evidence: view.artifactEvidence,
      artifactEvidenceMissingCount: view.artifactEvidenceMissingCount,
      newEventCount: view.newEventCount,
      artifactIsStale: view.artifactIsStale,
      provider: view.provider,
      model: view.model,
      generating: reviewGenerating,
      error: reviewGenerationError,
      disabled:
        authPhase !== 'ready' ||
        !canAskWithProvider(providerAuth, view.provider),
      onGenerate: () => void generateThreadReview(),
    });

    const observed = document.createElement('section');
    observed.className = 'analysis-section observed-section';
    observed.appendChild(
      makeSectionHeading(
        'Observed activity',
        'The latest recorded activity in this thread.',
      ),
    );
    const list = document.createElement('div');
    list.className = 'observed-list';
    for (const item of evidence.slice(-16).reverse()) {
      list.appendChild(makeEvidenceControl(item));
    }
    observed.appendChild(list);
    content.appendChild(observed);
  }
  analysisViewEl.appendChild(content);
}

async function generateTodayRecap(): Promise<void> {
  if (todayGenerating || !todayView) return;
  todayEntryGenerationAttempted = true;
  todayGenerating = true;
  todayGenerationError = null;
  renderAnalysisView();
  const requestedRevision = latestState
    ? activityViewRevision(latestState)
    : todayLoadedRevision;
  try {
    todayView = await window.aside.generateTodayRecap();
    todayLoadedRevision = requestedRevision;
    todayFailedRevision = '';
  } catch (error) {
    todayGenerationError = safeErrorMessage(error);
  } finally {
    todayGenerating = false;
    if (latestState) render(latestState);
    else renderAnalysisView();
    const current = latestState
      ? activityViewRevision(latestState)
      : requestedRevision;
    if (activeView === 'today' && current !== todayLoadedRevision) {
      scheduleTodayRefresh(current);
    }
  }
}

async function generateThreadReview(): Promise<void> {
  const threadId = reviewThreadId;
  const source = reviewThreadSource;
  if (reviewGenerating || !reviewView || !threadId || !source) return;
  reviewGenerating = true;
  reviewGenerationError = null;
  renderAnalysisView();
  const requestedRevision = latestState
    ? activityViewRevision(latestState)
    : reviewLoadedRevision;
  try {
    const next = await window.aside.generateThreadReview(threadId, source);
    if (
      activeView === 'review' &&
      reviewThreadId === threadId &&
      reviewThreadSource === source
    ) {
      reviewView = next;
      reviewLoadedRevision = requestedRevision;
      reviewFailedRevision = '';
    }
  } catch (error) {
    if (
      activeView === 'review' &&
      reviewThreadId === threadId &&
      reviewThreadSource === source
    ) {
      reviewGenerationError = safeErrorMessage(error);
    }
  } finally {
    reviewGenerating = false;
    if (latestState) render(latestState);
    else renderAnalysisView();
    const current = latestState
      ? activityViewRevision(latestState)
      : requestedRevision;
    if (activeView === 'review' && current !== reviewLoadedRevision) {
      scheduleReviewRefresh(current);
    }
  }
}

function renderAnalysisView(): void {
  analysisViewEl.replaceChildren();
  analysisViewEl.hidden = activeView === 'thread';
  if (activeView === 'thread') return;

  if (activeView === 'usage') {
    usageViewEl.hidden = false;
    analysisViewEl.appendChild(usageViewEl);
    return;
  }

  if (activeView === 'today') {
    if (todayLoading && !todayView) {
      analysisViewEl.appendChild(
        makeStatusMessage('Reading today’s local activity…', { kind: 'loading' }),
      );
      return;
    }
    if (todayError && !todayView) {
      analysisViewEl.appendChild(
        makeStatusMessage(todayError, {
          kind: 'error',
          actionLabel: 'Try again',
          onAction: () => {
            todayFailedRevision = '';
            const revision = latestState
              ? activityViewRevision(latestState)
              : localDateKey();
            void loadToday(revision);
          },
        }),
      );
      return;
    }
    if (todayView) {
      if (todayLoading) {
        analysisViewEl.appendChild(
          makeStatusMessage('Updating activity…', { kind: 'loading' }),
        );
      }
      renderTodayContent(todayView);
    }
    return;
  }

  if (reviewLoading && !reviewView) {
    analysisViewEl.appendChild(
      makeStatusMessage('Reading this thread’s local activity…', {
        kind: 'loading',
      }),
    );
    return;
  }
  if (reviewError && !reviewView) {
    analysisViewEl.appendChild(
      makeStatusMessage(reviewError, {
        kind: 'error',
        actionLabel: 'Try again',
        onAction: () => {
          reviewFailedRevision = '';
          const revision = latestState
            ? activityViewRevision(latestState)
            : localDateKey();
          void loadThreadReview(revision);
        },
      }),
    );
    return;
  }
  if (reviewView) {
    if (reviewLoading) {
      analysisViewEl.appendChild(
        makeStatusMessage('Updating activity…', { kind: 'loading' }),
      );
    }
    renderReviewContent(reviewView);
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
    activeView === 'review' &&
    (!reviewThreadId ||
      !reviewThreadSource ||
      !state.sessions.some(
        (item) =>
          item.threadId === reviewThreadId &&
          item.source === reviewThreadSource,
      ))
  ) {
    activeView = 'thread';
    reviewView = null;
    reviewThreadId = null;
    reviewThreadSource = null;
    reviewError = null;
    reviewGenerationError = null;
    reviewLoadedRevision = '';
    reviewFailedRevision = '';
    if (reviewRefreshTimer) clearTimeout(reviewRefreshTimer);
    reviewRefreshTimer = null;
  }
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
  if (activeView === 'today') {
    scopeTitleEl.textContent = 'Today';
    scopeMetaEl.textContent = todayView
      ? `${plural(todayView.diary.projectCount, 'project')} · ${plural(
          todayView.diary.threadCount,
          'conversation',
        )}`
      : 'Your daily recap across projects';
  } else if (activeView === 'usage') {
    scopeTitleEl.textContent = 'Usage';
    scopeMetaEl.textContent = 'Local token activity across providers';
  } else if (activeView === 'review') {
    scopeTitleEl.textContent =
      `${reviewView?.title || session?.title || session?.projectName || 'Thread'} review`;
    scopeMetaEl.textContent = reviewView
      ? `${reviewView.projectName} · evidence-linked review`
      : 'Reading local activity';
  } else {
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
  }
  needsCountEl.textContent =
    state.attentionCount > 0
      ? `${state.attentionCount} need attention`
      : '';
  needsCountEl.hidden =
    activeView !== 'thread' || state.attentionCount === 0;
  reviewThreadEl.hidden =
    activeView === 'today' ||
    activeView === 'usage' ||
    (activeView === 'thread' && !session);
  reviewThreadEl.textContent =
    activeView === 'review' ? 'Back to chat' : 'Review thread';
  reviewThreadEl.setAttribute(
    'aria-label',
    activeView === 'review'
      ? 'Return to this thread’s side chat'
      : 'Review this thread’s activity',
  );
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
  onboardingEl.hidden = activeView !== 'thread' || !firstRun;
  messagesEl.hidden = activeView !== 'thread' || firstRun;
  composerShellEl.hidden = activeView !== 'thread';
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
  renderAnalysisView();
  renderProviderSurfaces();
  if (activeView === 'today') {
    scheduleTodayRefresh(activityViewRevision(state));
  } else if (activeView === 'review') {
    scheduleReviewRefresh(activityViewRevision(state));
  }
  const nextUsageIndexSignature =
    `${state.searchIndex.phase}:${state.searchIndex.indexedBytes}:${state.searchIndex.totalBytes}`;
  if (activeView === 'usage' && nextUsageIndexSignature !== usageIndexSignature) {
    usageIndexSignature = nextUsageIndexSignature;
    if (usageRefreshTimer) clearTimeout(usageRefreshTimer);
    usageRefreshTimer = setTimeout(() => {
      usageRefreshTimer = null;
      if (activeView === 'usage') void loadUsage();
    }, 600);
  }
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

function usageQuery(): UsageAnalyticsQuery {
  return {
    rangeDays: usageRangeDays,
    providers: [...usageProviders],
    models: usageModel ? [usageModel] : [],
  };
}

async function loadUsage(initial = false): Promise<void> {
  const sequence = ++usageSequence;
  if (initial || usageContentEl.hidden) {
    usageStatusEl.textContent = 'Preparing usage insights…';
    usageStatusEl.hidden = false;
    usageContentEl.hidden = true;
  }
  try {
    const snapshot = await window.aside.getUsage(usageQuery());
    if (sequence !== usageSequence || activeView !== 'usage') return;
    renderUsage(snapshot);
    usageStatusEl.hidden = true;
    usageContentEl.hidden = false;
  } catch (error) {
    if (sequence !== usageSequence || activeView !== 'usage') return;
    usageStatusEl.textContent = `Usage unavailable: ${safeErrorMessage(error)}`;
    usageStatusEl.hidden = false;
    usageContentEl.hidden = true;
  }
}

function renderUsage(snapshot: UsageAnalyticsSnapshot): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-usage-days]')) {
    button.setAttribute(
      'aria-pressed',
      String(Number(button.dataset['usageDays']) === snapshot.rangeDays),
    );
  }
  renderUsageProviders(snapshot);
  renderUsageModels(snapshot);
  usageTotalTokensEl.textContent = formatTokenCount(snapshot.totals.totalTokens);
  usageEstimatedCostEl.textContent = formatMoney(snapshot.totals.estimatedCostUsd);
  usageEstimatedSavingsEl.textContent = formatMoney(snapshot.totals.estimatedSavingsUsd);
  usageActiveDaysEl.textContent = String(snapshot.totals.activeDays);
  const index = latestState?.searchIndex;
  usageIndexProgressEl.hidden = !index || index.phase === 'ready';
  usageIndexProgressEl.textContent = !index
    ? ''
    : index.phase === 'error'
      ? 'The local index paused; these totals include everything indexed so far.'
      : `${index.indexedThreads} of ${index.totalThreads} threads indexed. Totals update as local history is read.`;
  usageStreaksEl.textContent = snapshot.longestStreak > 0
    ? `${snapshot.currentStreak} day current · ${snapshot.longestStreak} day best`
    : 'No active streak yet';
  renderUsageGrid(snapshot);
  renderUsageBreakdown(snapshot);

  const pricedShare = snapshot.totals.totalTokens > 0
    ? snapshot.totals.pricedTokens / snapshot.totals.totalTokens
    : 1;
  usagePricedCoverageEl.textContent = snapshot.totals.unpricedTokens > 0
    ? `${Math.round(pricedShare * 100)}% price coverage`
    : 'Public prices matched';
  usageNoteEl.textContent =
    `API-equivalent estimates use public list prices checked ${formatShortDate(snapshot.pricingAsOf)}. ` +
    'They are not invoices and exclude subscriptions, free tiers, taxes, tool-call charges, ' +
    'and special regional or long-context rates. ' +
    `Local equivalents use a conservative ${snapshot.localBenchmark}; unknown cloud models stay unpriced.`;
}

function renderUsageProviders(snapshot: UsageAnalyticsSnapshot): void {
  const focusedProvider =
    document.activeElement instanceof HTMLButtonElement
      ? document.activeElement.dataset['usageProvider']
      : undefined;
  usageProviderFiltersEl.innerHTML = '';
  const choices = [
    { id: '', label: 'All' },
    ...snapshot.providers.map((provider) => ({
      id: provider.id,
      label: provider.local ? `${provider.label} · local` : provider.label,
    })),
  ];
  for (const choice of choices) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'usage-filter-chip';
    button.textContent = choice.label;
    button.dataset['usageProvider'] = choice.id;
    button.setAttribute(
      'aria-pressed',
      String(choice.id ? usageProviders.has(choice.id) : usageProviders.size === 0),
    );
    button.addEventListener('click', () => {
      if (!choice.id) usageProviders.clear();
      else if (usageProviders.has(choice.id)) usageProviders.delete(choice.id);
      else usageProviders.add(choice.id);
      usageModel = null;
      void loadUsage();
    });
    usageProviderFiltersEl.appendChild(button);
  }
  if (focusedProvider !== undefined) {
    const restored = [...usageProviderFiltersEl.querySelectorAll<HTMLButtonElement>(
      '[data-usage-provider]',
    )].find((button) => button.dataset['usageProvider'] === focusedProvider);
    restored?.focus({ preventScroll: true });
  }
}

function renderUsageModels(snapshot: UsageAnalyticsSnapshot): void {
  usageModelFilterEl.innerHTML = '';
  const all = document.createElement('option');
  all.value = '';
  all.textContent = 'All models';
  usageModelFilterEl.appendChild(all);
  const providerLabels = new Map(
    snapshot.providers.map((provider) => [provider.id, provider.label]),
  );
  for (const model of snapshot.models) {
    if (usageProviders.size > 0 && !usageProviders.has(model.provider)) continue;
    const option = document.createElement('option');
    option.value = JSON.stringify({ provider: model.provider, model: model.model });
    option.textContent = `${providerLabels.get(model.provider) ?? model.provider} · ${model.label}`;
    option.selected =
      usageModel?.provider === model.provider && usageModel.model === model.model;
    usageModelFilterEl.appendChild(option);
  }
  if (!usageModel) usageModelFilterEl.value = '';
}

function renderUsageGrid(snapshot: UsageAnalyticsSnapshot): void {
  usageGridEl.innerHTML = '';
  usageMonthsEl.innerHTML = '';
  const first = localDate(snapshot.startDate);
  const prefixDays = first.getDay();
  const totalCells = Math.ceil((prefixDays + snapshot.days.length) / 7) * 7;
  const weeks = totalCells / 7;
  usageChartEl.style.setProperty('--usage-weeks', String(weeks));
  for (let index = 0; index < prefixDays; index += 1) {
    usageGridEl.appendChild(usagePlaceholder());
  }

  const activeTokenCounts = snapshot.days
    .map((day) => day.totalTokens)
    .filter((tokens) => tokens > 0)
    .sort((a, b) => a - b);
  const monthColumns = new Set<number>();
  snapshot.days.forEach((day, index) => {
    const date = localDate(day.date);
    const column = Math.floor((prefixDays + index) / 7) + 1;
    if ((index === 0 || date.getDate() === 1) && !monthColumns.has(column)) {
      monthColumns.add(column);
      const month = document.createElement('span');
      month.style.gridColumn = String(column);
      month.textContent = date.toLocaleDateString(undefined, { month: 'short' });
      usageMonthsEl.appendChild(month);
    }
    const cell = document.createElement('i');
    cell.className = 'usage-cell';
    cell.dataset['level'] = String(usageLevel(day.totalTokens, activeTokenCounts));
    const label = usageDayLabel(day);
    cell.title = label;
    cell.setAttribute('aria-hidden', 'true');
    usageGridEl.appendChild(cell);
  });
  while (usageGridEl.children.length < totalCells) {
    usageGridEl.appendChild(usagePlaceholder());
  }

  usagePeakEl.textContent = snapshot.peakDay
    ? `Peak ${formatTokenCount(snapshot.peakDay.totalTokens)} · ${formatLongDate(snapshot.peakDay.date)}`
    : 'No recorded usage in this range';
  usageGridEl.setAttribute(
    'aria-label',
    `${formatTokenCount(snapshot.totals.totalTokens)} tokens from ${formatLongDate(
      snapshot.startDate,
    )} through ${formatLongDate(snapshot.endDate)}, across ${snapshot.totals.activeDays} active days. ${
      snapshot.peakDay
        ? `Peak ${formatTokenCount(snapshot.peakDay.totalTokens)} on ${formatLongDate(snapshot.peakDay.date)}.`
        : 'No recorded usage.'
    }`,
  );
  if (usageScrollToLatest) {
    usageScrollToLatest = false;
    requestAnimationFrame(() => {
      usageChartScrollEl.scrollLeft = usageChartScrollEl.scrollWidth;
    });
  }
}

function renderUsageBreakdown(snapshot: UsageAnalyticsSnapshot): void {
  usageBreakdownEl.innerHTML = '';
  const shown = snapshot.breakdown.slice(0, 7);
  if (shown.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'usage-note';
    empty.textContent = 'No token counters were found for these filters.';
    usageBreakdownEl.appendChild(empty);
    return;
  }
  for (const model of shown) {
    const row = document.createElement('div');
    row.className = 'usage-model-row';
    const copy = document.createElement('div');
    copy.className = 'usage-model-copy';
    const dot = document.createElement('i');
    dot.className = 'usage-provider-dot';
    const name = document.createElement('span');
    name.className = 'usage-model-name';
    name.textContent = model.model;
    name.title = `${model.provider} · ${model.model}`;
    copy.append(dot, name);

    const bar = document.createElement('span');
    bar.className = 'usage-model-bar';
    const fill = document.createElement('span');
    fill.style.width = `${Math.max(2, model.share * 100)}%`;
    bar.appendChild(fill);

    const value = document.createElement('span');
    value.className = 'usage-model-value';
    const tokens = document.createElement('strong');
    tokens.textContent = formatTokenCount(model.totalTokens);
    const estimate = document.createElement('span');
    estimate.textContent = model.local
      ? `${formatMoney(model.estimatedSavingsUsd)} equivalent`
      : model.priced
        ? formatMoney(model.estimatedCostUsd)
        : 'Unpriced';
    value.append(tokens, estimate);
    row.append(copy, bar, value);
    usageBreakdownEl.appendChild(row);
  }
}

function usagePlaceholder(): HTMLElement {
  const cell = document.createElement('i');
  cell.className = 'usage-cell placeholder';
  cell.setAttribute('aria-hidden', 'true');
  return cell;
}

function usageLevel(tokens: number, sortedActiveTokens: number[]): number {
  if (tokens <= 0 || sortedActiveTokens.length === 0) return 0;
  const quartile = (fraction: number) =>
    sortedActiveTokens[
      Math.min(
        sortedActiveTokens.length - 1,
        Math.floor(sortedActiveTokens.length * fraction),
      )
    ]!;
  if (tokens <= quartile(0.25)) return 1;
  if (tokens <= quartile(0.5)) return 2;
  if (tokens <= quartile(0.75)) return 3;
  return 4;
}

function usageDayLabel(day: UsageDay): string {
  const estimates = [
    day.estimatedCostUsd > 0 ? `${formatMoney(day.estimatedCostUsd)} API equivalent` : '',
    day.estimatedSavingsUsd > 0 ? `${formatMoney(day.estimatedSavingsUsd)} local equivalent` : '',
  ].filter(Boolean);
  return `${formatLongDate(day.date)} · ${formatTokenCount(day.totalTokens)} tokens${
    estimates.length > 0 ? ` · ${estimates.join(' · ')}` : ''
  }`;
}

function formatTokenCount(value: number): string {
  const amount = Math.max(0, value);
  if (amount < 1_000) return Math.round(amount).toLocaleString();
  const units = [
    { threshold: 1_000_000_000, suffix: 'B' },
    { threshold: 1_000_000, suffix: 'M' },
    { threshold: 1_000, suffix: 'K' },
  ];
  const unit = units.find((candidate) => amount >= candidate.threshold)!;
  const scaled = amount / unit.threshold;
  return `${scaled >= 100 ? scaled.toFixed(0) : scaled.toFixed(1).replace(/\.0$/u, '')}${unit.suffix}`;
}

function formatMoney(value: number): string {
  if (value > 0 && value < 0.01) return '<$0.01';
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: value >= 100 ? 0 : 2,
  }).format(Math.max(0, value));
}

function localDate(day: string): Date {
  return new Date(`${day}T12:00:00`);
}

function formatLongDate(day: string): string {
  return localDate(day).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatShortDate(day: string): string {
  return localDate(day).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
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

reviewThreadEl.addEventListener('click', () => {
  if (activeView === 'review') {
    activeView = 'thread';
    if (latestState) render(latestState);
    return;
  }
  if (!latestState) return;
  const session = activeSession(latestState);
  if (session) showThreadReview(session);
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
openUsageEl.addEventListener('click', showUsage);
settingsCloseEl.addEventListener('click', hideSettings);
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-usage-days]')) {
  button.addEventListener('click', () => {
    const days = Number(button.dataset['usageDays']);
    if (days !== 90 && days !== 365) return;
    usageRangeDays = days;
    usageScrollToLatest = true;
    void loadUsage();
  });
}
usageModelFilterEl.addEventListener('change', () => {
  if (!usageModelFilterEl.value) {
    usageModel = null;
  } else {
    try {
      const parsed = JSON.parse(usageModelFilterEl.value) as {
        provider?: unknown;
        model?: unknown;
      };
      usageModel =
        typeof parsed.provider === 'string' && typeof parsed.model === 'string'
          ? { provider: parsed.provider, model: parsed.model }
          : null;
    } catch {
      usageModel = null;
    }
  }
  void loadUsage();
});
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
  if (!settingsEl.hidden) {
    hideSettings();
  }
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
