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
  onState: (handler) => {
    if (typeof handler !== 'function') return () => {};
    const listener = (_event, payload) => handler(payload || {});
    ipcRenderer.on('cynode-viewer:state', listener);
    return () => ipcRenderer.removeListener('cynode-viewer:state', listener);
  },
  sendCommand: (command, payload = {}) => {
    ipcRenderer.send('cynode-viewer:command', { command, ...payload });
  },
  setStageBounds: (bounds = {}) => {
    ipcRenderer.send('cynode-viewer:set-stage-bounds', bounds);
  },
});
