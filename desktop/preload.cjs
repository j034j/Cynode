const { contextBridge, ipcRenderer } = require('electron');

const desktopApi = {
  isElectron: true,
  getAppInfo: () => ipcRenderer.invoke('cynode-desktop:get-app-info'),
  openInAppViewer: (url, options = {}) => ipcRenderer.invoke('cynode-desktop:open-in-app-viewer', { url, ...options }),
  openSecondaryWindow: (url, options = {}) => ipcRenderer.invoke('cynode-desktop:open-secondary-window', { url, ...options }),
  openExternal: (url) => ipcRenderer.invoke('cynode-desktop:open-external', { url }),
  launchProtocol: (url, options = {}) => ipcRenderer.invoke('cynode-desktop:launch-protocol', { url, ...options }),
  showMessage: (options = {}) => ipcRenderer.invoke('cynode-desktop:show-message', options),
};

contextBridge.exposeInMainWorld('cynodeDesktop', desktopApi);

window.addEventListener('DOMContentLoaded', () => {
  try {
    document.documentElement.dataset.desktopApp = 'electron';
    window.dispatchEvent(new CustomEvent('cynode-desktop-ready'));
  } catch (_) {}
});
