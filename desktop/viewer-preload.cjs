const { contextBridge, ipcRenderer, shell } = require('electron');

contextBridge.exposeInMainWorld('cynodeViewer', {
  onOpenUrl: (handler) => {
    if (typeof handler !== 'function') return () => {};
    const listener = (_event, payload) => handler(payload || {});
    ipcRenderer.on('cynode-viewer:open-url', listener);
    return () => ipcRenderer.removeListener('cynode-viewer:open-url', listener);
  },
  openExternal: (url) => {
    if (!url) return;
    shell.openExternal(String(url)).catch(() => {});
  },
});
