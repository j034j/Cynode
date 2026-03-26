const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, ipcMain, shell, dialog, protocol, session } = require('electron');

const PROTOCOL = 'cynode';
const APP_ID = 'com.cynode.desktop';
const DEFAULT_DEV_URL = 'http://127.0.0.1:3001/';
const DEFAULT_REMOTE_URL = 'https://cynode.vercel.app/';
const WINDOW_PARTITION = 'persist:cynode-desktop';
const DESKTOP_WEB_CACHE_VERSION = 'desktop-web-cache-v1';

// Register cynode as a privileged scheme to ensure it works correctly in the browser context
protocol.registerSchemesAsPrivileged([
  { scheme: PROTOCOL, privileges: { secure: true, standard: true, supportFetchAPI: true, corsEnabled: true, stream: true } }
]);

let mainWindow = null;
let viewerWindow = null;
const secondaryWindows = new Set();
let pendingProtocolUrl = null;

async function maybeResetDesktopWebCache() {
  const markerPath = path.join(app.getPath('userData'), 'desktop-web-cache-version.txt');
  let currentVersion = '';

  try {
    currentVersion = fs.readFileSync(markerPath, 'utf8').trim();
  } catch (_) {}

  if (currentVersion === DESKTOP_WEB_CACHE_VERSION) {
    return;
  }

  try {
    const sess = session.fromPartition(WINDOW_PARTITION);
    await sess.clearCache();
    await sess.clearStorageData({
      storages: ['serviceworkers', 'cachestorage'],
    });
    fs.writeFileSync(markerPath, `${DESKTOP_WEB_CACHE_VERSION}\n`, 'utf8');
    console.log(`Desktop web cache reset for ${DESKTOP_WEB_CACHE_VERSION}.`);
  } catch (error) {
    console.error('Failed to reset desktop web cache:', error);
  }
}

function isSafeAppUrl(value) {
  if (!value) return false;
  try {
    const parsed = new URL(String(value));
    return ['http:', 'https:'].includes(parsed.protocol);
  } catch (_) {
    return false;
  }
}

function resolveStartUrl() {
  const configuredUrl = process.env.CYNODE_DESKTOP_START_URL;
  if (isSafeAppUrl(configuredUrl)) {
    return configuredUrl;
  }

  if (app.isPackaged) {
    return DEFAULT_REMOTE_URL;
  }

  return DEFAULT_DEV_URL;
}

function resolveWindowIconPath() {
  return path.join(__dirname, 'assets', 'icon.png');
}

function registerProtocolClient() {
  const protocol = PROTOCOL;
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(protocol, process.execPath, [path.resolve(process.argv[1])]);
    }
  } else {
    app.setAsDefaultProtocolClient(protocol);
  }
}

function attachWindowOpenHandler(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeAppUrl(url)) {
      openInAppViewer(url, { title: 'Cynode View' });
      return { action: 'deny' };
    }
    shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
}

async function loadIntoWindow(win, targetUrl) {
  try {
    await win.loadURL(targetUrl);
  } catch (error) {
    const helpText = app.isPackaged
      ? 'Check your internet connection, then reopen Cynode Desktop. If you use a self-hosted Cynode deployment, set CYNODE_DESKTOP_START_URL before launching the app.'
      : 'Start the Cynode server locally or set CYNODE_DESKTOP_START_URL to your deployed web app URL before launching the desktop app.';
    const message = [
      '<h2>Cynode Desktop Could Not Connect</h2>',
      `<p>Unable to load <code>${targetUrl}</code>.</p>`,
      `<p>${helpText}</p>`,
      `<pre>${String(error && error.message ? error.message : error)}</pre>`,
    ].join('');
    await win.loadURL(`data:text/html,${encodeURIComponent(message)}`);
  }
}

function createMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 720,
    autoHideMenuBar: true,
    backgroundColor: '#0f1722',
    title: 'Cynode Desktop',
    icon: resolveWindowIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      partition: WINDOW_PARTITION,
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  attachWindowOpenHandler(mainWindow);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  void loadIntoWindow(mainWindow, resolveStartUrl());
  return mainWindow;
}

function createViewerWindow() {
  if (viewerWindow && !viewerWindow.isDestroyed()) return viewerWindow;

  viewerWindow = new BrowserWindow({
    width: 1480,
    height: 980,
    minWidth: 1040,
    minHeight: 700,
    autoHideMenuBar: true,
    backgroundColor: '#0b1220',
    title: 'Cynode Viewer',
    icon: resolveWindowIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'viewer-preload.cjs'),
      partition: WINDOW_PARTITION,
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      webviewTag: true,
      webSecurity: true,
    },
  });

  viewerWindow.on('closed', () => {
    viewerWindow = null;
  });

  void viewerWindow.loadFile(path.join(__dirname, 'viewer.html'));
  return viewerWindow;
}

function sendViewerCommand(command, payload = {}) {
  const win = createViewerWindow();
  const dispatch = () => {
    if (!win || win.isDestroyed()) return;
    win.webContents.send(command, payload);
  };

  if (win.webContents.isLoadingMainFrame()) {
    win.webContents.once('did-finish-load', dispatch);
  } else {
    dispatch();
  }

  return win;
}

function openInAppViewer(targetUrl, options = {}) {
  if (!isSafeAppUrl(targetUrl)) {
    throw new Error('unsupported_url');
  }

  const win = sendViewerCommand('cynode-viewer:open-url', {
    url: String(targetUrl),
    title: options.title ? String(options.title) : 'Cynode Viewer',
  });

  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  return win;
}

function createSecondaryWindow(targetUrl, options = {}) {
  if (!isSafeAppUrl(targetUrl)) {
    throw new Error('unsupported_url');
  }

  const child = new BrowserWindow({
    width: Math.max(1100, Number(options.width) || 1360),
    height: Math.max(720, Number(options.height) || 900),
    minWidth: 900,
    minHeight: 600,
    autoHideMenuBar: true,
    backgroundColor: '#0f1722',
    title: options.title || 'Cynode Secondary Window',
    icon: resolveWindowIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      partition: WINDOW_PARTITION,
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  attachWindowOpenHandler(child);
  secondaryWindows.add(child);
  child.on('closed', () => secondaryWindows.delete(child));
  void loadIntoWindow(child, targetUrl);
  return child;
}

function focusMainWindow() {
  const win = createMainWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

async function handleProtocolUrl(rawUrl) {
  if (!rawUrl) return;
  const protocolPrefix = `${PROTOCOL}://`;
  // Normalize the custom protocol URL for the URL parser
  const normalized = rawUrl.startsWith(protocolPrefix)
    ? rawUrl.replace(protocolPrefix, 'http://cynode-protocol/')
    : rawUrl;

  let parsed;
  try {
    parsed = new URL(normalized);
  } catch (_) {
    return;
  }

  const action = (parsed.hostname || parsed.pathname.replace(/^\/+/, '') || '').toLowerCase();
  const searchParams = parsed.searchParams;
  const targetUrl = searchParams.get('url');
  const title = searchParams.get('title') || 'Cynode View';
  const sessionId = searchParams.get('sid');

  if (sessionId) {
    try {
      const sess = session.fromPartition(WINDOW_PARTITION);
      const startUrl = resolveStartUrl();
      const domain = new URL(startUrl).hostname;
      await sess.cookies.set({
        url: startUrl,
        name: 'sid',
        value: sessionId,
        domain,
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: startUrl.startsWith('https:'),
        expirationDate: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
      });
      console.log('Inherited session from deep link.');
      if (mainWindow) mainWindow.reload();
    } catch (err) {
      console.error('Failed to set inherited session cookie:', err);
    }
  }

  if (action === 'open' && targetUrl && isSafeAppUrl(targetUrl)) {
    openInAppViewer(targetUrl, { title });
  }

  focusMainWindow();
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const protocolArg = argv.find((arg) => typeof arg === 'string' && arg.startsWith(`${PROTOCOL}://`));
    if (protocolArg) handleProtocolUrl(protocolArg);
    else focusMainWindow();
  });
}

app.on('open-url', (event, url) => {
  event.preventDefault();
  if (!app.isReady()) {
    pendingProtocolUrl = url;
    return;
  }
  handleProtocolUrl(url);
});

app.whenReady().then(async () => {
  app.setAppUserModelId(APP_ID);
  app.setName('Cynode Desktop');
  registerProtocolClient();
  await maybeResetDesktopWebCache();
  createMainWindow();
  if (pendingProtocolUrl) {
    handleProtocolUrl(pendingProtocolUrl);
    pendingProtocolUrl = null;
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    else focusMainWindow();
  });
});

ipcMain.handle('cynode-desktop:get-app-info', () => {
  return {
    isDesktop: true,
    appId: APP_ID,
    protocol: PROTOCOL,
    startUrl: resolveStartUrl(),
    version: app.getVersion(),
    hasInAppViewer: true,
  };
});

ipcMain.handle('cynode-desktop:open-in-app-viewer', async (_event, payload) => {
  const targetUrl = payload && payload.url ? String(payload.url) : '';
  if (!isSafeAppUrl(targetUrl)) {
    throw new Error('unsupported_url');
  }
  openInAppViewer(targetUrl, {
    title: payload && payload.title ? String(payload.title) : 'Cynode Viewer',
  });
  return { ok: true };
});

ipcMain.handle('cynode-desktop:open-secondary-window', async (_event, payload) => {
  const targetUrl = payload && payload.url ? String(payload.url) : '';
  if (!isSafeAppUrl(targetUrl)) {
    throw new Error('unsupported_url');
  }
  createSecondaryWindow(targetUrl, {
    title: payload && payload.title ? String(payload.title) : 'Cynode View',
    width: payload && payload.width ? Number(payload.width) : undefined,
    height: payload && payload.height ? Number(payload.height) : undefined,
  });
  return { ok: true };
});

ipcMain.handle('cynode-desktop:open-external', async (_event, payload) => {
  const targetUrl = payload && payload.url ? String(payload.url) : '';
  if (!isSafeAppUrl(targetUrl)) {
    throw new Error('unsupported_url');
  }
  await shell.openExternal(targetUrl);
  return { ok: true };
});

ipcMain.handle('cynode-desktop:launch-protocol', async (_event, payload) => {
  const targetUrl = payload && payload.url ? String(payload.url) : '';
  if (!isSafeAppUrl(targetUrl)) {
    throw new Error('unsupported_url');
  }
  const title = payload && payload.title ? String(payload.title) : 'Cynode View';
  const launchUrl = `${PROTOCOL}://open?url=${encodeURIComponent(targetUrl)}&title=${encodeURIComponent(title)}`;
  await shell.openExternal(launchUrl);
  return { ok: true, launchUrl };
});

ipcMain.handle('cynode-desktop:show-message', async (_event, payload) => {
  const result = await dialog.showMessageBox({
    type: payload && payload.type ? payload.type : 'info',
    buttons: ['OK'],
    title: payload && payload.title ? String(payload.title) : 'Cynode Desktop',
    message: payload && payload.message ? String(payload.message) : '',
    detail: payload && payload.detail ? String(payload.detail) : '',
  });
  return { ok: true, response: result.response };
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
