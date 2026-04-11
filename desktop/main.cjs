const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, WebContentsView, ipcMain, shell, dialog, protocol, session } = require('electron');

const PROTOCOL = 'cynode';
const APP_ID = 'com.cynode.desktop';
const DEFAULT_DEV_URL = 'http://127.0.0.1:3001/';
const DEFAULT_REMOTE_URL = 'https://cynode.vercel.app/';
const WINDOW_PARTITION = 'persist:cynode-desktop';
const DESKTOP_WEB_CACHE_VERSION = 'desktop-web-cache-v4';
const DESKTOP_START_URL_VERSION = 'desktop-start-url-v1';

// Register cynode as a privileged scheme to ensure it works correctly in the browser context
protocol.registerSchemesAsPrivileged([
  { scheme: PROTOCOL, privileges: { secure: true, standard: true, supportFetchAPI: true, corsEnabled: true, stream: true } }
]);

let mainWindow = null;
let viewerWindow = null;
let viewerPageView = null;
const secondaryWindows = new Set();
let pendingProtocolUrl = null;
let viewerState = {
  nodeId: null,
  url: '',
  title: 'Cynode Viewer',
  status: 'idle',
  canGoBack: false,
  canGoForward: false,
};
let viewerStageBounds = { x: 0, y: 62, width: 1200, height: 800 };

function normalizeAppUrl(value) {
  if (!isSafeAppUrl(value)) return '';
  try {
    const parsed = new URL(String(value));
    parsed.hash = '';
    if (!parsed.pathname || parsed.pathname === '') parsed.pathname = '/';
    return parsed.toString();
  } catch (_) {
    return '';
  }
}

function getDesktopStartUrlMarkerPath() {
  try {
    if (!app.isReady()) return '';
    return path.join(app.getPath('userData'), `${DESKTOP_START_URL_VERSION}.txt`);
  } catch (_) {
    return '';
  }
}

function readStoredStartUrl() {
  const markerPath = getDesktopStartUrlMarkerPath();
  if (!markerPath) return '';
  try {
    return normalizeAppUrl(fs.readFileSync(markerPath, 'utf8').trim());
  } catch (_) {
    return '';
  }
}

function writeStoredStartUrl(value) {
  const markerPath = getDesktopStartUrlMarkerPath();
  const normalized = normalizeAppUrl(value);
  if (!markerPath || !normalized) return false;
  try {
    fs.writeFileSync(markerPath, `${normalized}\n`, 'utf8');
    console.log(`[CynodeDesktop] Stored preferred start URL: ${normalized}`);
    return true;
  } catch (error) {
    console.warn('[CynodeDesktop] Failed to store preferred start URL.', error);
    return false;
  }
}

function logViewer(message, extra) {
  if (typeof extra === 'undefined') {
    console.log(`[CynodeViewer] ${message}`);
    return;
  }
  console.log(`[CynodeViewer] ${message}`, extra);
}

function logProtocolError(context, error, extra = {}) {
  console.error(`[CynodeDesktop] ${context}`, {
    ...extra,
    message: String(error && error.message ? error.message : error),
  });
}

function sendViewerNavigationToMain(payload = {}) {
  logViewer('Forwarding viewer navigation to main window.', payload);
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const dispatch = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('cynode-desktop:viewer-navigation', payload);
  };

  if (mainWindow.webContents.isLoadingMainFrame()) {
    mainWindow.webContents.once('did-finish-load', dispatch);
  } else {
    dispatch();
  }
}

function updateViewerState(patch = {}) {
  viewerState = {
    ...viewerState,
    ...patch,
  };
  sendViewerNavigationToMain(viewerState);
  if (viewerWindow && !viewerWindow.isDestroyed()) {
    const dispatch = () => {
      if (!viewerWindow || viewerWindow.isDestroyed()) return;
      viewerWindow.webContents.send('cynode-viewer:state', viewerState);
    };
    if (viewerWindow.webContents.isLoadingMainFrame()) {
      viewerWindow.webContents.once('did-finish-load', dispatch);
    } else {
      dispatch();
    }
  }
}

function syncViewerNavState() {
  if (!viewerPageView || viewerPageView.webContents.isDestroyed()) return;
  let canGoBack = false;
  let canGoForward = false;
  try {
    canGoBack = viewerPageView.webContents.navigationHistory.canGoBack();
    canGoForward = viewerPageView.webContents.navigationHistory.canGoForward();
  } catch (_) {}
  updateViewerState({ canGoBack, canGoForward });
}

function applyViewerPageBounds() {
  if (!viewerWindow || viewerWindow.isDestroyed() || !viewerPageView) return;
  const contentBounds = viewerWindow.getContentBounds();
  const x = Math.max(0, Number(viewerStageBounds.x) || 0);
  const y = Math.max(0, Number(viewerStageBounds.y) || 0);
  const width = Math.max(0, Math.min(contentBounds.width - x, Number(viewerStageBounds.width) || 0));
  const height = Math.max(0, Math.min(contentBounds.height - y, Number(viewerStageBounds.height) || 0));
  viewerPageView.setBounds({ x, y, width, height });
  viewerPageView.setVisible(Boolean(viewerState.url) && width > 0 && height > 0);
  logViewer('Applied viewer page bounds.', { x, y, width, height });
}

function ensureViewerPageView() {
  if (viewerPageView && !viewerPageView.webContents.isDestroyed()) {
    return viewerPageView;
  }

  viewerPageView = new WebContentsView({
    webPreferences: {
      partition: WINDOW_PARTITION,
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  const pageContents = viewerPageView.webContents;
  pageContents.setWindowOpenHandler(({ url }) => {
    if (isSafeAppUrl(url)) {
      logViewer('Viewer intercepted popup and will reuse the same page view.', { url });
      openInAppViewer(url, { title: viewerState.title, nodeId: viewerState.nodeId });
      return { action: 'deny' };
    }
    shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  pageContents.on('did-start-loading', () => {
    logViewer('Viewer started loading.', { url: viewerState.url });
    updateViewerState({ status: 'loading' });
  });

  pageContents.on('did-stop-loading', () => {
    let loadedUrl = viewerState.url;
    try {
      const currentUrl = pageContents.getURL();
      if (currentUrl) loadedUrl = currentUrl;
    } catch (_) {}
    logViewer('Viewer stopped loading.', { url: loadedUrl });
    updateViewerState({ url: loadedUrl, status: 'loaded' });
    syncViewerNavState();
  });

  pageContents.on('did-start-navigation', (_event, url, isInPlace, isMainFrame) => {
    if (!isMainFrame) return;
    logViewer('Viewer navigation started.', { url, isInPlace });
    updateViewerState({ url: String(url || viewerState.url), status: 'loading' });
  });

  pageContents.on('did-redirect-navigation', (_event, url, isInPlace, isMainFrame) => {
    if (!isMainFrame) return;
    logViewer('Viewer navigation redirected.', { url, isInPlace });
    updateViewerState({ url: String(url || viewerState.url), status: 'redirected' });
  });

  pageContents.on('did-navigate', (_event, url, httpResponseCode, httpStatusText) => {
    logViewer('Viewer navigated.', { url, httpResponseCode, httpStatusText });
    updateViewerState({ url: String(url || viewerState.url), status: 'navigated' });
    syncViewerNavState();
  });

  pageContents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
    if (!isMainFrame) return;
    logViewer('Viewer navigated in page.', { url });
    updateViewerState({ url: String(url || viewerState.url), status: 'navigated-in-page' });
    syncViewerNavState();
  });

  pageContents.on('page-title-updated', (event, title) => {
    if (!title) return;
    logViewer('Viewer title updated.', { title });
    updateViewerState({ title: String(title), status: 'title' });
    try { event.preventDefault(); } catch (_) {}
  });

  pageContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return;
    console.error('[CynodeViewer] Viewer failed to load.', {
      errorCode,
      errorDescription,
      validatedURL,
    });
    updateViewerState({
      url: validatedURL ? String(validatedURL) : viewerState.url,
      status: 'error',
      errorCode: typeof errorCode === 'number' ? errorCode : null,
      errorDescription: errorDescription ? String(errorDescription) : '',
    });
    syncViewerNavState();
  });

  pageContents.on('render-process-gone', (_event, details) => {
    console.error('[CynodeViewer] Viewer page render process exited.', details);
  });

  if (viewerWindow && !viewerWindow.isDestroyed()) {
    viewerWindow.contentView.addChildView(viewerPageView);
    applyViewerPageBounds();
  }

  return viewerPageView;
}

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
    return normalizeAppUrl(configuredUrl);
  }

  const appBaseUrl = process.env.APP_BASE_URL;
  if (isSafeAppUrl(appBaseUrl)) {
    return normalizeAppUrl(appBaseUrl);
  }

  const storedUrl = readStoredStartUrl();
  if (storedUrl) {
    return storedUrl;
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
  if (!win || win.isDestroyed()) return;
  try {
    await win.loadURL(targetUrl);
  } catch (error) {
    if (!win || win.isDestroyed()) {
      console.warn('[CynodeDesktop] Skipping fallback page because target window was destroyed.', {
        targetUrl,
        message: String(error && error.message ? error.message : error),
      });
      return;
    }
    const helpText = app.isPackaged
      ? 'Check your internet connection, then reopen Cynode Desktop. If you use a self-hosted Cynode deployment, set CYNODE_DESKTOP_START_URL before launching the app.'
      : 'Start the Cynode server locally or set CYNODE_DESKTOP_START_URL to your deployed web app URL before launching the desktop app.';
    const message = [
      '<h2>Cynode Desktop Could Not Connect</h2>',
      `<p>Unable to load <code>${targetUrl}</code>.</p>`,
      `<p>${helpText}</p>`,
      `<pre>${String(error && error.message ? error.message : error)}</pre>`,
    ].join('');
    try {
      if (!win.isDestroyed()) {
        await win.loadURL(`data:text/html,${encodeURIComponent(message)}`);
      }
    } catch (fallbackError) {
      if (win && !win.isDestroyed()) {
        console.error('[CynodeDesktop] Failed to load fallback error page.', fallbackError);
      }
    }
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
  mainWindow.webContents.on('did-navigate', (_event, url) => {
    const normalized = normalizeAppUrl(url);
    if (normalized) writeStoredStartUrl(normalized);
  });
  mainWindow.webContents.on('did-navigate-in-page', (_event, url) => {
    const normalized = normalizeAppUrl(url);
    if (normalized) writeStoredStartUrl(normalized);
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  void loadIntoWindow(mainWindow, resolveStartUrl());
  return mainWindow;
}

function createViewerWindow() {
  if (viewerWindow && !viewerWindow.isDestroyed()) return viewerWindow;

  logViewer('Creating viewer window.');

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
      webSecurity: true,
    },
  });

  viewerWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[CynodeViewer] Viewer shell render process exited.', details);
  });

  viewerWindow.webContents.on('did-finish-load', () => {
    logViewer('Viewer shell finished loading.');
    updateViewerState({});
    applyViewerPageBounds();
  });

  viewerWindow.on('resize', () => {
    applyViewerPageBounds();
  });

  ensureViewerPageView();
  viewerPageView.setVisible(false);
  void viewerWindow.loadFile(path.join(__dirname, 'viewer.html'));

  viewerWindow.on('closed', () => {
    logViewer('Viewer window closed.');
    viewerState = {
      nodeId: null,
      url: '',
      title: 'Cynode Viewer',
      status: 'closed',
      canGoBack: false,
      canGoForward: false,
    };
    sendViewerNavigationToMain(viewerState);
    if (viewerPageView && !viewerPageView.webContents.isDestroyed()) {
      try { viewerPageView.webContents.close(); } catch (_) {}
    }
    viewerPageView = null;
    viewerWindow = null;
  });

  return viewerWindow;
}

function openInAppViewer(targetUrl, options = {}) {
  if (!isSafeAppUrl(targetUrl)) {
    throw new Error('unsupported_url');
  }

  const nextNodeId = Number(options.nodeId);
  const nextTitle = options.title ? String(options.title) : 'Cynode Viewer';
  logViewer('openInAppViewer called.', {
    url: String(targetUrl),
    title: nextTitle,
    nodeId: Number.isFinite(nextNodeId) ? nextNodeId : null,
  });

  // Ensure viewer partition has current session cookie available.
  (async () => {
    try {
      const sess = session.fromPartition(WINDOW_PARTITION);
      const startUrl = resolveStartUrl();
      // Try to read existing sid cookie and re-set it so the viewer has access.
      const cookies = await sess.cookies.get({ url: startUrl, name: 'sid' });
      if (Array.isArray(cookies) && cookies.length > 0) {
        const sid = cookies[0];
        // Re-set with same properties to ensure availability for new windows
        await sess.cookies.set({
          url: startUrl,
          name: sid.name,
          value: sid.value,
          domain: sid.domain || new URL(startUrl).hostname,
          path: sid.path || '/',
          httpOnly: Boolean(sid.httpOnly),
          secure: Boolean(sid.secure),
          expirationDate: sid.expirationDate || Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
        });
        logViewer('Viewer session cookie refreshed from shared partition.', {
          domain: sid.domain || new URL(startUrl).hostname,
          secure: Boolean(sid.secure),
          httpOnly: Boolean(sid.httpOnly),
        });
      } else {
        logViewer('No existing sid cookie was found for viewer sync.', { startUrl });
      }
    } catch (err) {
      // Non-fatal, continue opening viewer even if cookie sync fails.
      console.warn('openInAppViewer: ensuring session cookie failed:', err);
    }
  })();

  const win = createViewerWindow();
  updateViewerState({
    nodeId: Number.isFinite(nextNodeId) ? nextNodeId : null,
    url: String(targetUrl),
    title: nextTitle,
    status: 'requested',
    errorCode: null,
    errorDescription: '',
  });
  win.setTitle(nextTitle);
  const pageView = ensureViewerPageView();
  pageView.setVisible(true);
  applyViewerPageBounds();
  void pageView.webContents.loadURL(String(targetUrl)).catch((error) => {
    logProtocolError('Viewer page load failed.', error, { targetUrl: String(targetUrl) });
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
  const appOrigin = normalizeAppUrl(searchParams.get('appOrigin') || searchParams.get('origin') || '');

  if (appOrigin) {
    writeStoredStartUrl(appOrigin);
  }

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
      if (mainWindow && !mainWindow.isDestroyed()) {
        const nextStartUrl = resolveStartUrl();
        const currentUrl = mainWindow.webContents.getURL();
        const currentOrigin = normalizeAppUrl(currentUrl);
        const nextOrigin = normalizeAppUrl(nextStartUrl);
        try {
          if (!currentOrigin || (nextOrigin && new URL(currentOrigin).origin !== new URL(nextOrigin).origin)) {
            await loadIntoWindow(mainWindow, nextStartUrl);
          } else if (!mainWindow.isDestroyed()) {
            mainWindow.reload();
          }
        } catch (error) {
          logProtocolError('Refreshing main window after inherited session failed.', error, {
            nextStartUrl,
          });
        }
      }
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
    if (protocolArg) {
      void handleProtocolUrl(protocolArg).catch((error) => {
        logProtocolError('Handling second-instance protocol URL failed.', error, { protocolArg });
      });
    }
    else focusMainWindow();
  });
}

app.on('open-url', (event, url) => {
  event.preventDefault();
  if (!app.isReady()) {
    pendingProtocolUrl = url;
    return;
  }
  void handleProtocolUrl(url).catch((error) => {
    logProtocolError('Handling open-url protocol event failed.', error, { url });
  });
});

app.whenReady().then(async () => {
  app.setAppUserModelId(APP_ID);
  app.setName('Cynode Desktop');
  registerProtocolClient();
  await maybeResetDesktopWebCache();
  createMainWindow();
  if (pendingProtocolUrl) {
    void handleProtocolUrl(pendingProtocolUrl).catch((error) => {
      logProtocolError('Handling pending protocol URL failed.', error, { protocolArg: pendingProtocolUrl });
    });
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
    nodeId: payload && Number.isFinite(Number(payload.nodeId)) ? Number(payload.nodeId) : null,
  });
  return { ok: true };
});

ipcMain.on('cynode-viewer:command', (_event, payload) => {
  const command = payload && payload.command ? String(payload.command) : '';
  const pageContents = viewerPageView && !viewerPageView.webContents.isDestroyed()
    ? viewerPageView.webContents
    : null;
  if (!pageContents) return;

  if (command === 'back') {
    try {
      if (pageContents.navigationHistory.canGoBack()) pageContents.navigationHistory.goBack();
    } catch (_) {}
    return;
  }
  if (command === 'forward') {
    try {
      if (pageContents.navigationHistory.canGoForward()) pageContents.navigationHistory.goForward();
    } catch (_) {}
    return;
  }
  if (command === 'refresh') {
    try { pageContents.reload(); } catch (_) {}
    return;
  }
  if (command === 'go') {
    const targetUrl = payload && payload.url ? String(payload.url) : '';
    if (!isSafeAppUrl(targetUrl)) return;
    openInAppViewer(targetUrl, {
      title: viewerState.title || 'Cynode Viewer',
      nodeId: viewerState.nodeId,
    });
    return;
  }
  if (command === 'open-external') {
    const targetUrl = payload && payload.url ? String(payload.url) : viewerState.url;
    if (!isSafeAppUrl(targetUrl)) return;
    void shell.openExternal(targetUrl);
  }
});

ipcMain.on('cynode-viewer:set-stage-bounds', (_event, bounds) => {
  viewerStageBounds = {
    x: Math.max(0, Number(bounds && bounds.x) || 0),
    y: Math.max(0, Number(bounds && bounds.y) || 0),
    width: Math.max(0, Number(bounds && bounds.width) || 0),
    height: Math.max(0, Number(bounds && bounds.height) || 0),
  };
  applyViewerPageBounds();
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
  const appOrigin = normalizeAppUrl(payload && payload.appOrigin ? String(payload.appOrigin) : '');
  const sid = payload && payload.sid ? String(payload.sid) : '';
  let launchUrl = `${PROTOCOL}://open?url=${encodeURIComponent(targetUrl)}&title=${encodeURIComponent(title)}`;
  if (appOrigin) {
    launchUrl += `&appOrigin=${encodeURIComponent(appOrigin)}`;
  }
  if (sid) {
    launchUrl += `&sid=${encodeURIComponent(sid)}`;
  }
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
