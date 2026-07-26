// CommonJS preload (loaded by Electron in an isolated context). Exposes a tiny,
// typed bridge to the renderer — no Node access leaks through.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aside', {
  getState: () => ipcRenderer.invoke('aside:get-state'),
  searchThreads: (query) => ipcRenderer.invoke('aside:search-threads', query),
  rebuildSearchIndex: () => ipcRenderer.invoke('aside:search-rebuild'),
  selectThread: (threadId) => ipcRenderer.invoke('aside:select-thread', threadId),
  ask: (question) => ipcRenderer.invoke('aside:ask', question),
  setModel: (provider, model) => ipcRenderer.invoke('aside:set-model', provider, model),
  getProviderAuth: () => ipcRenderer.invoke('aside:auth:get'),
  refreshProviderAuth: () => ipcRenderer.invoke('aside:auth:refresh'),
  connectProvider: (provider) => ipcRenderer.invoke('aside:auth:connect', provider),
  disconnectProvider: (provider) => ipcRenderer.invoke('aside:auth:disconnect', provider),
  openProviderHelp: (provider) => ipcRenderer.invoke('aside:auth:help', provider),
  getAppVersion: () => ipcRenderer.invoke('aside:app-version'),
  getWindowMode: () => ipcRenderer.invoke('aside:window-mode:get'),
  setKeepOpen: (keepOpen) => ipcRenderer.invoke('aside:window-mode:set', keepOpen),
  getUpdateStatus: () => ipcRenderer.invoke('aside:update:get'),
  checkForUpdates: () => ipcRenderer.invoke('aside:update:check'),
  restartToUpdate: () => ipcRenderer.invoke('aside:update:restart'),
  openManualUpdate: () => ipcRenderer.invoke('aside:update:manual-download'),
  openDataFolder: () => ipcRenderer.invoke('aside:open-data'),
  quit: () => ipcRenderer.invoke('aside:quit'),
  onUpdate: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('aside:update', listener);
    return () => ipcRenderer.removeListener('aside:update', listener);
  },
  onProviderAuthUpdate: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('aside:auth:update', listener);
    return () => ipcRenderer.removeListener('aside:auth:update', listener);
  },
  onAppUpdate: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('aside:app-update', listener);
    return () => ipcRenderer.removeListener('aside:app-update', listener);
  },
  onShowSettings: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('aside:show-settings', listener);
    return () => ipcRenderer.removeListener('aside:show-settings', listener);
  },
  onWindowMode: (callback) => {
    const listener = (_event, mode) => callback(mode);
    ipcRenderer.on('aside:window-mode', listener);
    return () => ipcRenderer.removeListener('aside:window-mode', listener);
  },
});
