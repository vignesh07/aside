(() => {
  const parameters = new URLSearchParams(location.search);
  const captureTheme = parameters.get('theme');
  if (captureTheme === 'light' || captureTheme === 'dark') {
    document.documentElement.dataset.captureTheme = captureTheme;
  }
  const requestedRoutes = Number.parseInt(parameters.get('routes') ?? '10000', 10);
  const routeCount = Math.max(2, Math.min(20_000, requestedRoutes || 10_000));
  const models = [
    {
      provider: 'codex-cli',
      model: 'gpt-5.6-sol',
      label: 'GPT-5.6 Sol',
      recommended: true,
    },
    {
      provider: 'claude-cli',
      model: 'claude-sonnet-4-6',
      label: 'Claude Sonnet 4.6',
      recommended: true,
    },
    {
      provider: 'pi-cli',
      model: 'anthropic/claude-sonnet-4-6',
      label: 'Anthropic · Claude Sonnet 4.6',
    },
  ];
  for (let index = 0; index < routeCount; index += 1) {
    const upstream = index % 3 === 0
      ? 'openai'
      : index % 3 === 1
        ? 'anthropic'
        : 'google';
    models.push({
      provider: 'opencode-cli',
      model: `${upstream}/route-${String(index + 1).padStart(4, '0')}`,
      label: `${upstream[0].toUpperCase()}${upstream.slice(1)} · ${
        index % 3 === 0
          ? 'GPT'
          : index % 3 === 1
            ? 'Claude'
            : 'Gemini'
      } Route ${index + 1}`,
    });
  }
  models[3] = {
    provider: 'opencode-cli',
    model: 'openai/gpt-5.4',
    label: 'OpenAI · GPT-5.4',
  };
  const activeModel = parameters.get('active') ?? 'openai/gpt-5.4';
  const selectedModel = models.some(
    (model) => model.provider === 'opencode-cli' && model.model === activeModel,
  )
    ? activeModel
    : 'openai/gpt-5.4';

  const statuses = [
    { provider: 'codex-cli', state: 'signed_in', enabled: true },
    { provider: 'claude-cli', state: 'signed_in', enabled: true },
    { provider: 'pi-cli', state: 'configured', enabled: true },
    { provider: 'opencode-cli', state: 'configured', enabled: true },
    { provider: 'ollama', state: 'local_ready', enabled: true },
  ];
  const state = {
    sessions: [],
    activeThreadId: 'fleet',
    messages: [],
    thinking: false,
    provider: 'opencode-cli',
    model: selectedModel,
    needsUserCount: 0,
    attentionCount: 0,
    unreadAttentionCount: 0,
    attentionCounts: {
      waiting: 0,
      failed: 0,
      interrupted: 0,
      completed: 0,
      stalled: 0,
      forgotten: 0,
    },
    recentSessionCount: 0,
    storagePath: '/capture/aside/chats.json',
    models,
    searchIndex: {
      phase: 'ready',
      indexedThreads: 0,
      totalThreads: 0,
      indexedBytes: 0,
      totalBytes: 0,
    },
    activityHighWaterSeq: 0,
    activityCursorRevision: 'capture',
  };
  const noOp = async () => {};
  const noOpSubscription = () => () => {};
  const currentUpdate = { phase: 'current', currentVersion: '0.2.0' };
  const setModelCalls = [];
  window.__asidePickerCapture = { setModelCalls };

  window.aside = {
    getState: async () => state,
    searchThreads: async () => [],
    rebuildSearchIndex: noOp,
    getUsage: async () => ({
      rangeDays: 365,
      endDate: '2026-08-09',
      totals: {
        totalTokens: 0,
        estimatedCostUsd: 0,
        estimatedSavingsUsd: 0,
        activeDays: 0,
        pricedTokens: 0,
      },
      providers: [],
      models: [],
      days: [],
    }),
    selectThread: noOp,
    resolveAttention: noOp,
    ask: noOp,
    setModel: async (provider, model) => {
      setModelCalls.push({ provider, model });
      document.documentElement.dataset.captureSetModel = `${provider}:${model}`;
    },
    getProviderAuth: async () => statuses,
    refreshProviderAuth: async () => statuses,
    connectProvider: async () => statuses,
    disconnectProvider: async () => statuses,
    openProviderHelp: noOp,
    getAppVersion: async () => '0.2.0',
    getWindowMode: async () => ({ keepOpen: false }),
    setKeepOpen: async (keepOpen) => ({ keepOpen }),
    getToday: async () => null,
    getTodayGenerationConsent: async () => false,
    allowTodayGeneration: async () => false,
    generateTodayRecap: async () => null,
    getThreadReview: async () => null,
    generateThreadReview: async () => null,
    getUpdateStatus: async () => currentUpdate,
    checkForUpdates: async () => currentUpdate,
    restartToUpdate: noOp,
    openManualUpdate: noOp,
    openFeedback: noOp,
    openDataFolder: noOp,
    quit: noOp,
    onUpdate: noOpSubscription,
    onProviderAuthUpdate: noOpSubscription,
    onAppUpdate: noOpSubscription,
    onShowSettings: noOpSubscription,
    onWindowMode: noOpSubscription,
  };
})();
