const { contextBridge, ipcRenderer } = require('electron');

const desktopApi = {
  isElectron: true,
  getAppInfo: () => ipcRenderer.invoke('cynode-desktop:get-app-info'),
  setSessionCookie: (token) => ipcRenderer.invoke('cynode-desktop:set-session-cookie', { token }),
  openInAppViewer: (url, options = {}) => ipcRenderer.invoke('cynode-desktop:open-in-app-viewer', { url, ...options }),
  openSecondaryWindow: (url, options = {}) => ipcRenderer.invoke('cynode-desktop:open-secondary-window', { url, ...options }),
  openExternal: (url) => ipcRenderer.invoke('cynode-desktop:open-external', { url }),
  launchProtocol: (url, options = {}) => ipcRenderer.invoke('cynode-desktop:launch-protocol', { url, ...options }),
  showMessage: (options = {}) => ipcRenderer.invoke('cynode-desktop:show-message', options),
  onViewerNavigation: (handler) => {
    if (typeof handler !== 'function') return () => {};
    const listener = (_event, payload) => handler(payload || {});
    ipcRenderer.on('cynode-desktop:viewer-navigation', listener);
    return () => ipcRenderer.removeListener('cynode-desktop:viewer-navigation', listener);
  },
};

contextBridge.exposeInMainWorld('cynodeDesktop', desktopApi);

window.addEventListener('DOMContentLoaded', () => {
  try {
    document.documentElement.dataset.desktopApp = 'electron';
    window.dispatchEvent(new CustomEvent('cynode-desktop-ready'));
  } catch (_) {}
});
