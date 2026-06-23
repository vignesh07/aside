// CommonJS preload (loaded by Electron in an isolated context). Exposes a tiny,
// typed bridge to the renderer — no Node access leaks through.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aside', {
  getState: () => ipcRenderer.invoke('aside:get-state'),
  selectSession: (id) => ipcRenderer.invoke('aside:select', id),
  ask: (question) => ipcRenderer.invoke('aside:ask', question),
  setModel: (provider, model) => ipcRenderer.invoke('aside:set-model', provider, model),
  onUpdate: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('aside:update', listener);
    return () => ipcRenderer.removeListener('aside:update', listener);
  },
});
