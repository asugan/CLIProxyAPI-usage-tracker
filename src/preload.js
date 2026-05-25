const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cliproxy', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  collectUsage: () => ipcRenderer.invoke('usage:collect'),
  getSummary: () => ipcRenderer.invoke('usage:summary'),
  clearUsage: () => ipcRenderer.invoke('usage:clear'),
  getApiKeyUsage: () => ipcRenderer.invoke('usage:api-key'),
  getLogs: (after) => ipcRenderer.invoke('logs:get', after),
  onUsageUpdated: (callback) => {
    ipcRenderer.on('usage-updated', callback);
  },
  onCollectorError: (callback) => {
    ipcRenderer.on('collector-error', (_event, message) => callback(message));
  },
});
