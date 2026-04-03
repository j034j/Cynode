// --- State ---
const DEFAULT_CLEAR_NODE_COUNT = 8;
let currentNodeCount = DEFAULT_CLEAR_NODE_COUNT;
let nodeUrls = {}; // Stores URL for each node ID { 1: "url1", 2: "url2", ... }
let nodeCaptions = {}; // Stores { title: string, caption: string } for each node ID
let lastSelectedNode = null; // Track the most recently interacted node ID
let currentUser = null;
let loadedFromSharedGraph = false;
let currentShareAnalyticsContext = null;
let currentSavedShareCode = null;
let currentSavedShareUrl = null;

window._isEditingMode = false; // Global single source of truth for all modules
let normalPlaybackDelaySec = 7;
let playbackBaseDelaySec = 3; 
let nodeExtraDelaySecByNode = {};
let voiceEnabled = false;
let voiceAutoplay = true;
let voiceHold = true;

let bgAudioEnabled = false;
let bgAudioSource = '';
let bgAudioUrl = '';
let bgAudioVolume = 0.35;
let bgAudioMode = 'continuous';
let bgAudioDuck = true;

// --- Constants ---
const PLAYBACK_MODE_KEY = 'playbackMode'; // 'normal' | 'editing'
const NORMAL_PLAYBACK_DELAY_KEY = 'normalPlaybackDelaySec';
const PLAYBACK_BASE_DELAY_KEY = 'playbackBaseDelaySec';
const NODE_EXTRA_DELAYS_KEY = 'nodeExtraDelaySecByNode';
const VOICE_ENABLED_KEY = 'voiceEnabled';
const VOICE_AUTOPLAY_KEY = 'voiceAutoplay';
const VOICE_HOLD_KEY = 'voiceHold';
const BG_AUDIO_ENABLED_KEY = 'bgAudioEnabled';
const BG_AUDIO_SOURCE_KEY = 'bgAudioSource'; // 'file' | 'url' | ''
const BG_AUDIO_URL_KEY = 'bgAudioUrl';
const BG_AUDIO_VOLUME_KEY = 'bgAudioVolume';
const BG_AUDIO_MODE_KEY = 'bgAudioMode'; // 'continuous' | 'restart_per_node'
const BG_AUDIO_DUCK_KEY = 'bgAudioDuck';

// --- DOM Elements (Cached on Load) ---
let nodeGraph, nodeSelector, urlInput, nodeCountInput, recentUrlDiv,
    nodeAssociationsDiv, urlFormModal, browserSourceModal, modalBackdrop,
    addressBar, itemLimitInput, nodeTitleInput, nodeCaptionInput,
    browserBridgeStatusEl, browserBridgeRefreshBtn, importTabsBtn, importBookmarksBtn, importHistoryBtn,
    browserBridgeSummaryEl, browserBridgeBadgeEl, browserBridgeMetaEl, browserImportHintEl, browserImportFeedbackEl,
    splitContentEl, previewPaneToggleBtn, nodeAssociationsToggleBtn,
    qrSavedGraphSelect, generateQrBtn, qrDisplayArea;
let authFormEl, signInBtnEl;

// --- Constants ---
const MAX_NODES = 20;
const MIN_NODES = 1;
const PREVIEW_EXPANDED_KEY = 'previewPaneExpanded';
const EXTENSION_BRIDGE_MESSAGE_TYPE = 'CYNODE_EXTENSION_REQUEST';
const EXTENSION_BRIDGE_RESPONSE_TYPE = 'CYNODE_EXTENSION_RESPONSE';
const EXTENSION_BRIDGE_AVAILABLE_TYPE = 'CYNODE_EXTENSION_AVAILABLE';
const EXTENSION_BRIDGE_SOURCE = 'cynode-webapp';
const EXTENSION_BRIDGE_TIMEOUT_MS = 4000;
const BROWSER_IMPORT_ACTION_LABELS = {
    tabs: 'open tabs',
    bookmarks: 'recent bookmarks',
    history: 'recent history',
};
const BROWSER_IMPORT_BUTTON_LABELS = {
    tabs: 'Import Open Tabs',
    bookmarks: 'Import Recent Bookmarks',
    history: 'Import Recent History',
};
const BROWSER_INSTALL_GUIDES = {
    chrome: '/extensions/chrome/install.html',
    edge: '/extensions/edge/install.html',
    firefox: '/extensions/firefox/install.html',
};
let browserBridgeRequestId = 0;
let browserBridgeState = {
    available: false,
    browser: null,
    capabilities: [],
    via: null,
    lastError: '',
    detectInFlight: false,
    importInFlight: null,
};
let previewPaneExpanded = false;

function getDesktopBridge() {
    return (typeof window !== 'undefined' && window.cynodeDesktop && window.cynodeDesktop.isElectron)
        ? window.cynodeDesktop
        : null;
}

async function openUrlInBestTarget(url, options = {}) {
    const targetUrl = String(url || '');
    if (!targetUrl) return false;

    const desktop = getDesktopBridge();
    const canUseDesktopViewer = desktop
        && typeof desktop.openInAppViewer === 'function'
        && /^(https?:)\/\//i.test(targetUrl);

    if (canUseDesktopViewer) {
        try {
            await desktop.openInAppViewer(targetUrl, options);
            return true;
        } catch (error) {
            console.warn('Desktop in-app viewer launch failed, falling back to browser popup.', error);
        }
    }

    const canUseDesktopSecondary = desktop
        && typeof desktop.openSecondaryWindow === 'function'
        && /^(https?:)\/\//i.test(targetUrl);

    if (canUseDesktopSecondary) {
        try {
            await desktop.openSecondaryWindow(targetUrl, options);
            return true;
        } catch (error) {
            console.warn('Desktop secondary window launch failed, falling back to browser popup.', error);
        }
    }

    window.open(targetUrl, '_blank', 'noopener,noreferrer');
    return true;
}

async function launchDesktopProtocolUrl(url, title = 'Cynode View') {
    const targetUrl = String(url || '');
    if (!/^(https?:)\/\//i.test(targetUrl)) return false;

    let sessionId = null;
    try {
        const res = await fetch('/api/v1/auth/session-id');
        const data = await res.json();
        if (data && data.sessionId) sessionId = data.sessionId;
    } catch (_) {
        // Fallback for network issues or unauthenticated sessions
    }

    let protocolUrl = `cynode://open?url=${encodeURIComponent(targetUrl)}&title=${encodeURIComponent(String(title || 'Cynode View'))}`;
    if (sessionId) {
        protocolUrl += `&sid=${encodeURIComponent(sessionId)}`;
    }

    window.location.href = protocolUrl;
    return true;
}

try {
    if (typeof window !== 'undefined') {
        window.cynodeLaunchDesktop = launchDesktopProtocolUrl;
    }
} catch (_) {}

function isLikelyMobileDevice() {
    // Heuristic: width + coarse pointer; avoids relying only on UA.
    try {
        const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
        return coarse || window.innerWidth <= 900;
    } catch (_) {
        return window.innerWidth <= 900;
    }
}

function setupDeviceMode() {
    let lastDevice = '';
    const apply = () => {
        const html = document.documentElement;
        const nextDevice = isLikelyMobileDevice() ? 'mobile' : 'desktop';
        html.dataset.device = nextDevice;
        if (nextDevice !== lastDevice) {
            window.dispatchEvent(new CustomEvent('cynode:devicemodechange', { detail: { device: nextDevice } }));
            lastDevice = nextDevice;
        }
    };
    apply();
    window.addEventListener('resize', () => apply());
    window.addEventListener('orientationchange', () => apply());
}

function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    // Best-effort; failures should not impact core UI.
    navigator.serviceWorker.register('/sw.js?v=0402_syncfix').catch(() => { });
}

function setPreviewPaneExpanded(expanded, options = {}) {
    previewPaneExpanded = !!expanded;
    const split = splitContentEl || document.getElementById('splitContent');
    if (split) split.classList.toggle('preview-expanded', previewPaneExpanded);

    const expandLabel = previewPaneExpanded ? 'Show Associations' : 'Expand Preview';
    const inlineLabel = previewPaneExpanded ? 'Show Pane' : 'Hide Pane';

    if (previewPaneToggleBtn) {
        previewPaneToggleBtn.textContent = expandLabel;
        previewPaneToggleBtn.setAttribute('aria-pressed', previewPaneExpanded ? 'true' : 'false');
        previewPaneToggleBtn.title = previewPaneExpanded ? 'Restore the Node Associations pane' : 'Hide the Node Associations pane and expand Preview';
    }

    if (nodeAssociationsToggleBtn) {
        nodeAssociationsToggleBtn.textContent = inlineLabel;
        nodeAssociationsToggleBtn.setAttribute('aria-pressed', previewPaneExpanded ? 'true' : 'false');
        nodeAssociationsToggleBtn.title = previewPaneExpanded ? 'Show the Node Associations pane again' : 'Hide the Node Associations pane';
    }

    if (options.persist === false) return;
    try {
        localStorage.setItem(PREVIEW_EXPANDED_KEY, previewPaneExpanded ? '1' : '0');
    } catch (_) { }
}

function togglePreviewPane() {
    setPreviewPaneExpanded(!previewPaneExpanded);
}

function initializePreviewPaneToggle() {
    splitContentEl = document.getElementById('splitContent');
    previewPaneToggleBtn = document.getElementById('previewPaneToggle');
    nodeAssociationsToggleBtn = document.getElementById('nodeAssociationsToggle');

    if (previewPaneToggleBtn) {
        previewPaneToggleBtn.addEventListener('click', togglePreviewPane);
    }
    if (nodeAssociationsToggleBtn) {
        nodeAssociationsToggleBtn.addEventListener('click', togglePreviewPane);
    }

    try {
        const savedPreviewState = localStorage.getItem(PREVIEW_EXPANDED_KEY);
        if (savedPreviewState === null) {
            previewPaneExpanded = document.documentElement.dataset.device === 'mobile';
        } else {
            previewPaneExpanded = savedPreviewState === '1';
        }
    } catch (_) {
        previewPaneExpanded = document.documentElement.dataset.device === 'mobile';
    }
    setPreviewPaneExpanded(previewPaneExpanded, { persist: false });
}

/**
 * Backend persistence.
 */
const GRAPH_ID_KEY = 'graphId';
let graphId = null;
let pendingSaveTimer = null;
const GRAPH_TOPIC_KEY = 'graphTopic';
const GRAPH_TOPIC_ORIGIN_KEY = 'graphTopicOrigin'; 
const LAST_ACTIVE_GRAPH_KEY_PREFIX = 'lastActiveGraph:v1:';
const CACHED_ME_KEY = 'cynodeCachedMe:v1';
const OFFLINE_USER_KEY = 'cynode_offline_user';
const PENDING_GRAPH_SYNC_KEY_PREFIX = 'pendingGraphSync:v1:';
const PENDING_SAVED_SYNC_KEY_PREFIX = 'pendingSavedSync:v1:';

function getScopedKey(base) {
    const scope = currentUser && (currentUser.id || currentUser.handle) ? String(currentUser.id || currentUser.handle) : 'draft';
    return `${base}:${scope}`;
}

function getUserScopeId(user = currentUser) {
    if (!user) return 'draft';
    const raw = user.id || user.handle;
    return raw ? String(raw) : 'draft';
}

function readJsonStorage(key, fallback = null) {
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
    } catch (_) {
        return fallback;
    }
}

function writeJsonStorage(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
        return true;
    } catch (_) {
        return false;
    }
}

function removeStorage(key) {
    try { localStorage.removeItem(key); } catch (_) { }
}

function cloneSerializable(value) {
    try {
        return JSON.parse(JSON.stringify(value));
    } catch (_) {
        return value;
    }
}

function buildPendingId(prefix = 'pending') {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function getPendingGraphSyncStorageKey(user = currentUser) {
    return `${PENDING_GRAPH_SYNC_KEY_PREFIX}${getUserScopeId(user)}`;
}

function getPendingSavedSyncStorageKey(user = currentUser) {
    return `${PENDING_SAVED_SYNC_KEY_PREFIX}${getUserScopeId(user)}`;
}

function readCachedMe() {
    return readJsonStorage(CACHED_ME_KEY, null);
}

function writeCachedMe(me) {
    if (!me || typeof me !== 'object') return;
    writeJsonStorage(CACHED_ME_KEY, me);
}

function getOfflineSessionUser() {
    const explicit = readJsonStorage(OFFLINE_USER_KEY, null);
    if (explicit && typeof explicit === 'object') return explicit;

    const cached = readCachedMe();
    if (cached && cached.user) {
        return { ...cached.user, isOffline: true };
    }
    return null;
}

function setOfflineSessionUser(user) {
    if (!user || typeof user !== 'object') return;
    writeJsonStorage(OFFLINE_USER_KEY, user);
}

function clearCachedAuthState() {
    removeStorage(OFFLINE_USER_KEY);
    removeStorage(CACHED_ME_KEY);
}

function readPendingGraphSync(user = currentUser) {
    return readJsonStorage(getPendingGraphSyncStorageKey(user), null);
}

function writePendingGraphSync(payload, user = currentUser) {
    return writeJsonStorage(getPendingGraphSyncStorageKey(user), payload);
}

function clearPendingGraphSync(user = currentUser) {
    removeStorage(getPendingGraphSyncStorageKey(user));
}

function readPendingSavedActions(user = currentUser) {
    const items = readJsonStorage(getPendingSavedSyncStorageKey(user), []);
    return Array.isArray(items) ? items : [];
}

function writePendingSavedActions(items, user = currentUser) {
    return writeJsonStorage(getPendingSavedSyncStorageKey(user), Array.isArray(items) ? items : []);
}

function countPendingCloudSyncItems(user = currentUser) {
    const savedCount = readPendingSavedActions(user).length;
    const graphCount = readPendingGraphSync(user) ? 1 : 0;
    return savedCount + graphCount;
}

function isOfflineCapableError(error) {
    const msg = String(error && error.message ? error.message : error || '');
    return /Failed to fetch|NetworkError|Load failed|offline|API 502|API 503|API 504|Database unavailable|Service Unavailable/i.test(msg);
}

function isOfflineCapableResponse(status, text = '') {
    return status === 0 || status === 502 || status === 503 || status === 504 || /database unavailable|service unavailable/i.test(String(text || ''));
}

function queueGraphSnapshotForSync(snapshot, { graphIdOverride = graphId, user = currentUser } = {}) {
    if (!snapshot || typeof snapshot !== 'object') return;
    writePendingGraphSync({
        graphId: graphIdOverride || null,
        snapshot: cloneSerializable(snapshot),
        updatedAt: new Date().toISOString(),
    }, user);
}

function queuePendingSavedCreate({ snapshot, organizationId, topic, user = currentUser } = {}) {
    const actions = readPendingSavedActions(user);
    const queued = {
        id: buildPendingId('saved'),
        type: 'create',
        placeholderCode: buildPendingId('offline'),
        snapshot: cloneSerializable(snapshot),
        organizationId: organizationId || null,
        topic: topic || null,
        queuedAt: new Date().toISOString(),
    };
    actions.unshift(queued);
    writePendingSavedActions(actions, user);
    return queued;
}

function queuePendingSavedUpdate({ code, snapshot, topic, user = currentUser } = {}) {
    const normalizedCode = String(code || '').trim();
    const actions = readPendingSavedActions(user);

    if (normalizedCode.startsWith('offline_')) {
        const existingCreate = actions.find((item) => item && item.type === 'create' && item.placeholderCode === normalizedCode);
        if (existingCreate) {
            existingCreate.snapshot = cloneSerializable(snapshot);
            existingCreate.topic = topic || null;
            existingCreate.updatedAt = new Date().toISOString();
            writePendingSavedActions(actions, user);
            return existingCreate;
        }
        return queuePendingSavedCreate({ snapshot, topic, user });
    }

    const existingUpdate = actions.find((item) => item && item.type === 'update' && item.code === normalizedCode);
    if (existingUpdate) {
        existingUpdate.snapshot = cloneSerializable(snapshot);
        existingUpdate.topic = topic || null;
        existingUpdate.updatedAt = new Date().toISOString();
        writePendingSavedActions(actions, user);
        return existingUpdate;
    }

    const queued = {
        id: buildPendingId('saved'),
        type: 'update',
        code: normalizedCode,
        snapshot: cloneSerializable(snapshot),
        topic: topic || null,
        queuedAt: new Date().toISOString(),
    };
    actions.unshift(queued);
    writePendingSavedActions(actions, user);
    return queued;
}

function updateAccountProfileCard() {
    const card = document.getElementById('accountProfileCard');
    const nameEl = document.getElementById('accountProfileName');
    const handleEl = document.getElementById('accountProfileHandle');
    const emailEl = document.getElementById('accountProfileEmail');
    const stateEl = document.getElementById('accountProfileState');

    if (!card || !nameEl || !handleEl || !emailEl || !stateEl) return;

    if (!currentUser) {
        card.style.display = 'none';
        nameEl.textContent = '';
        handleEl.textContent = '';
        emailEl.textContent = '';
        stateEl.textContent = '';
        return;
    }

    const pendingCount = countPendingCloudSyncItems(currentUser);
    const isOfflineSession = !!currentUser.isOffline;
    const isDesktop = !!getDesktopBridge();

    card.style.display = '';
    nameEl.textContent = currentUser.displayName || currentUser.handle || 'Cynode user';
    handleEl.textContent = currentUser.handle ? `@${currentUser.handle}` : 'Signed in';
    emailEl.textContent = currentUser.email || (isOfflineSession ? 'Offline session profile cached on this device' : 'Email available in Manage Account');

    if (isOfflineSession && pendingCount > 0) {
        stateEl.textContent = `${pendingCount} queued change${pendingCount === 1 ? '' : 's'} will sync when Cynode reconnects.`;
    } else if (isOfflineSession) {
        stateEl.textContent = 'Offline mode active. Local changes stay available here and sync when the backend is reachable again.';
    } else if (pendingCount > 0) {
        stateEl.textContent = `${pendingCount} queued change${pendingCount === 1 ? '' : 's'} waiting for cloud sync.`;
    } else if (isDesktop) {
        stateEl.textContent = 'Desktop account session is ready. Manage Account and saved work stay aligned with the web app.';
    } else {
        stateEl.textContent = 'Account connected. Saved graphs and profile changes sync through the same Cynode backend.';
    }
}

async function maybeHandleOfflineApiFallback(path, init = {}, detail = {}) {
    const method = String(init.method || 'GET').toUpperCase();
    const status = Number(detail.status || 0);
    const text = String(detail.text || detail.message || '');
    const offlineLike = !navigator.onLine || isOfflineCapableResponse(status, text) || isOfflineCapableError(detail.error || text);
    if (!offlineLike) return null;

    let bodyJson = {};
    try {
        if (typeof init.body === 'string' && init.body) bodyJson = JSON.parse(init.body);
    } catch (_) { }

    if (path.includes('/api/v1/me')) {
        const offlineUser = getOfflineSessionUser();
        if (offlineUser) {
            return {
                user: { ...offlineUser, isOffline: true },
                userPlan: null,
                organizations: [],
                offline: true,
            };
        }
        return null;
    }

    if (path.includes('/api/v1/auth/login') || path.includes('/api/v1/auth/register')) {
        const cached = readCachedMe();
        const cachedUser = cached && cached.user ? cached.user : null;
        const ident = String(bodyJson.identifier || bodyJson.email || bodyJson.handle || '').trim().toLowerCase();
        let offlineUser = null;

        if (cachedUser) {
            const handle = String(cachedUser.handle || '').trim().toLowerCase();
            const email = String(cachedUser.email || '').trim().toLowerCase();
            if (!ident || ident === handle || (email && ident === email)) {
                offlineUser = { ...cachedUser, isOffline: true };
            }
        }

        if (!offlineUser) {
            const fallbackHandle = bodyJson.handle || bodyJson.identifier || (bodyJson.email ? String(bodyJson.email).split('@')[0] : 'offline_user');
            offlineUser = {
                id: `offline_${Date.now()}`,
                handle: String(fallbackHandle || 'offline_user'),
                displayName: bodyJson.displayName || null,
                email: bodyJson.email || null,
                isOffline: true,
                isLocalOnly: true,
            };
        }

        setOfflineSessionUser(offlineUser);
        return { success: true, user: offlineUser, offline: true };
    }

    if (path.includes('/api/v1/logout')) {
        clearCachedAuthState();
        return { success: true, offline: true };
    }

    if (path.includes('/api/v1/saved') && method === 'GET') {
        return [];
    }

    return null;
}

let graphTopic = '';
let graphTopicOrigin = null;
let pendingLastActiveGraphRestore = null;
let pendingCloudSyncInFlight = false;
let refreshSavedLinksFn = null;
let currentSavedLinksCache = [];
let explicitSaveBaselineSignature = '';
let cloudRefreshInFlight = false;
let lastCloudRefreshAt = 0;
let desktopViewerState = { nodeId: null, url: '', title: '' };

// Playback media state

// Remote media loaded from a share code (public URLs served by backend).
let remoteMedia = { background: null, voiceByNode: {}, filesByNode: {} };
let activeShareCode = null;

let voiceDbPromise = null;
let voiceAudioEl = null;
let bgAudioEl = null;
let bgAudioObjectUrl = '';
let bgAudioDesiredPlaying = false; // whether playback wants background audio
let bgAudioDuckRestoreVolume = null;
let activeRecording = { recorder: null, stream: null, nodeId: null, chunks: [] };

// Local file attachments are stored in IndexedDB and referenced as `localfile:<id>?name=...&mime=...`.
// They only work on the device/browser that originally stored the blob (shared links degrade gracefully).
const localFileObjectUrlById = new Map(); // id -> blob: URL

function isLocalFileUrl(value) {
    if (!value) return false;
    try { return new URL(String(value)).protocol === 'localfile:'; } catch (_) { return String(value).startsWith('localfile:'); }
}

function parseLocalFileUrl(value) {
    try {
        const u = new URL(String(value));
        if (u.protocol !== 'localfile:') return null;
        const id = (u.pathname || '').replace(/^\/+/, '');
        const name = u.searchParams.get('name') || '';
        const mimeType = u.searchParams.get('mime') || '';
        const size = Number(u.searchParams.get('size') || '') || null;
        return { id, name, mimeType, size };
    } catch (_) {
        return null;
    }
}

function displayTextForUrl(url) {
    if (!url) return '';
    if (!isLocalFileUrl(url)) return String(url);
    const meta = parseLocalFileUrl(url);
    if (!meta) return 'Local file';
    return meta.name ? `Local file: ${meta.name}` : 'Local file';
}

function buildComparableGraphState() {
    const normalizedUrls = {};
    const normalizedCaptions = {};
    const normalizedPauseSecByNode = {};

    for (let i = 1; i <= currentNodeCount; i++) {
        normalizedUrls[i] = nodeUrls[i] ? String(nodeUrls[i]) : '';
        if (nodeCaptions[i]) {
            normalizedCaptions[i] = {
                title: nodeCaptions[i].title ? String(nodeCaptions[i].title) : '',
                caption: nodeCaptions[i].caption ? String(nodeCaptions[i].caption) : '',
            };
        }
        if (Object.prototype.hasOwnProperty.call(nodeExtraDelaySecByNode || {}, i)) {
            normalizedPauseSecByNode[i] = Number(nodeExtraDelaySecByNode[i]);
        }
    }

    return {
        nodeCount: currentNodeCount,
        lastSelectedNode: lastSelectedNode ?? null,
        nodeUrls: normalizedUrls,
        nodeCaptions: normalizedCaptions,
        nodePauseSecByNode: normalizedPauseSecByNode,
        topic: String(graphTopic || '').trim(),
    };
}

function computeComparableGraphSignature() {
    return JSON.stringify(buildComparableGraphState());
}

function markExplicitSaveBaseline() {
    explicitSaveBaselineSignature = computeComparableGraphSignature();
}

function clearExplicitSaveBaseline() {
    explicitSaveBaselineSignature = '';
}

function hasMeaningfulGraphContent() {
    if (String(graphTopic || '').trim()) return true;
    if (Object.keys(nodeCaptions || {}).length > 0) return true;
    if (Object.keys(nodeExtraDelaySecByNode || {}).length > 0) return true;
    for (let i = 1; i <= currentNodeCount; i++) {
        if (nodeUrls[i] && String(nodeUrls[i]).trim()) return true;
    }
    return false;
}

function hasUnsavedChangesSinceExplicitSave() {
    if (!hasMeaningfulGraphContent()) return false;
    if (!explicitSaveBaselineSignature) return true;
    return computeComparableGraphSignature() !== explicitSaveBaselineSignature;
}

function buildUntitledTopicLabel() {
    return 'Untitled Nodegraph';
}

function setDesktopViewerState(payload = {}) {
    const nextNodeId = Number(payload.nodeId);
    desktopViewerState = {
        nodeId: Number.isFinite(nextNodeId) && nextNodeId >= 1 ? nextNodeId : null,
        url: payload && payload.url ? String(payload.url) : '',
        title: payload && payload.title ? String(payload.title) : '',
    };

    if (desktopViewerState.nodeId && desktopViewerState.nodeId === lastSelectedNode) {
        updateRecentUrl(lastSelectedNode);
    }
}

function getDisplayUrlForNode(nodeId) {
    if (
        desktopViewerState
        && desktopViewerState.url
        && desktopViewerState.nodeId
        && Number(desktopViewerState.nodeId) === Number(nodeId)
    ) {
        return desktopViewerState.url;
    }
    return nodeUrls[nodeId] ? String(nodeUrls[nodeId]) : '';
}

function buildSavedLinksRenderSignature(items) {
    const normalizedItems = Array.isArray(items)
        ? items.map((item) => ({
            code: item && item.code ? String(item.code) : '',
            shareUrl: item && item.shareUrl ? String(item.shareUrl) : '',
            topic: item && item.topic ? String(item.topic) : '',
            namespace: item && item.namespace ? String(item.namespace) : '',
            createdAt: item && item.createdAt ? String(item.createdAt) : '',
        }))
        : [];

    return JSON.stringify({
        items: normalizedItems,
        currentSavedShareCode: currentSavedShareCode || '',
        currentSavedShareUrl: currentSavedShareUrl || '',
        graphTopic: String(graphTopic || '').trim(),
    });
}

function getLastActiveGraphStorageKey(user = currentUser) {
    const scope = user && (user.id || user.handle) ? String(user.id || user.handle) : '';
    return scope ? `${LAST_ACTIVE_GRAPH_KEY_PREFIX}${scope}` : null;
}

function readLastActiveGraphForUser(user = currentUser) {
    const storageKey = getLastActiveGraphStorageKey(user);
    if (!storageKey) return null;
    try {
        const raw = localStorage.getItem(storageKey);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || !parsed.code) return null;
        return {
            code: String(parsed.code),
            origin: parsed.origin === 'share' ? 'share' : 'saved',
            shareUrl: parsed.shareUrl ? String(parsed.shareUrl) : null,
            updatedAt: parsed.updatedAt ? String(parsed.updatedAt) : null,
        };
    } catch (_) {
        return null;
    }
}

function inferLastActiveGraphFromTopicOrigin(origin = graphTopicOrigin) {
    const raw = String(origin || '').trim();
    if (!raw) return null;

    if (raw.startsWith('saved:')) {
        const code = raw.slice(6).trim();
        return code ? { code, origin: 'saved', updatedAt: null } : null;
    }

    if (raw.startsWith('share:')) {
        const code = raw.slice(6).trim();
        return code ? { code, origin: 'share', updatedAt: null } : null;
    }

    return null;
}

function writeLastActiveGraphForUser(code, { origin = 'saved', shareUrl = null, user = currentUser } = {}) {
    const storageKey = getLastActiveGraphStorageKey(user);
    const normalizedCode = String(code || '').trim();
    const normalizedShareUrl = typeof shareUrl === 'string' && shareUrl.trim() ? shareUrl.trim() : null;
    if (!storageKey || !normalizedCode) return;
    try {
        localStorage.setItem(storageKey, JSON.stringify({
            code: normalizedCode,
            origin: origin === 'share' ? 'share' : 'saved',
            shareUrl: normalizedShareUrl,
            updatedAt: new Date().toISOString(),
        }));
    } catch (_) { }
}

function clearLastActiveGraphForUser(user = currentUser) {
    const storageKey = getLastActiveGraphStorageKey(user);
    if (!storageKey) return;
    try { localStorage.removeItem(storageKey); } catch (_) { }
}

function clearLastActiveGraphIfMatches(code, user = currentUser) {
    const stored = readLastActiveGraphForUser(user);
    if (stored && stored.code === String(code || '').trim()) {
        clearLastActiveGraphForUser(user);
    }
}

async function resolveUrlForViewer(url, nodeId) {
    if (!url) return { kind: 'empty', url: null, meta: null, nodeId };
    if (isLocalFileUrl(url)) {
        const meta = parseLocalFileUrl(url);
        const resolved = await resolveLocalFileToObjectUrl(url);
        return { kind: 'localfile', url: resolved, meta, nodeId };
    }
    return { kind: 'web', url: String(url), meta: null, nodeId };
}

function openVoiceDb() {
    if (voiceDbPromise) return voiceDbPromise;
    voiceDbPromise = new Promise((resolve, reject) => {
        if (!('indexedDB' in window)) return reject(new Error('IndexedDB not available'));
        const req = indexedDB.open('cynode-voice', 2);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains('recordings')) db.createObjectStore('recordings');
            if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error('Failed to open voice DB'));
    });
    return voiceDbPromise;
}

function voiceScopeKey() {
    // Scope recordings to the current local graph id if available.
    let id = graphId;
    if (!id) {
        try { id = localStorage.getItem(GRAPH_ID_KEY); } catch (_) { }
    }
    return id ? `graph:${id}` : 'graph:local';
}

function voiceKeyForNode(nodeId) {
    return `${voiceScopeKey()}:node:${nodeId}`;
}

async function idbGet(storeName, key) {
    const db = await openVoiceDb();
    return await new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const req = store.get(key);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = () => reject(req.error);
    });
}

async function idbPut(storeName, key, value) {
    const db = await openVoiceDb();
    return await new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        const req = store.put(value, key);
        req.onsuccess = () => resolve(true);
        req.onerror = () => reject(req.error);
    });
}

async function idbDel(storeName, key) {
    const db = await openVoiceDb();
    return await new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        const req = store.delete(key);
        req.onsuccess = () => resolve(true);
        req.onerror = () => reject(req.error);
    });
}

async function filePut(fileId, entry) {
    return await idbPut('files', fileId, entry);
}

async function fileGet(fileId) {
    return await idbGet('files', fileId);
}

async function resolveLocalFileToObjectUrl(localUrl) {
    const meta = parseLocalFileUrl(localUrl);
    if (!meta || !meta.id) return null;
    if (localFileObjectUrlById.has(meta.id)) return localFileObjectUrlById.get(meta.id);
    const entry = await fileGet(meta.id);
    if (!entry || !entry.blob) return null;
    const objUrl = URL.createObjectURL(entry.blob);
    localFileObjectUrlById.set(meta.id, objUrl);
    return objUrl;
}

async function voiceGetBlobForNode(nodeId) {
    try {
        return await idbGet('recordings', voiceKeyForNode(nodeId));
    } catch (_) {
        return null;
    }
}

function bgAudioKey() {
    return `${voiceScopeKey()}:bgAudio`;
}

async function bgGetBlob() {
    try { return await idbGet('recordings', bgAudioKey()); } catch (_) { return null; }
}

async function bgSetBlob(blob) {
    return await idbPut('recordings', bgAudioKey(), blob);
}

async function bgClearBlob() {
    return await idbDel('recordings', bgAudioKey());
}

function ensureBgAudioEl() {
    if (bgAudioEl) return bgAudioEl;
    bgAudioEl = new Audio();
    bgAudioEl.preload = 'metadata';
    bgAudioEl.loop = true;
    bgAudioEl.volume = Math.max(0, Math.min(1, Number(bgAudioVolume) || 0.35));
    return bgAudioEl;
}

async function bgLoadSourceIntoAudio() {
    const audio = ensureBgAudioEl();
    audio.loop = (bgAudioMode === 'continuous');
    audio.volume = Math.max(0, Math.min(1, Number(bgAudioVolume) || 0.35));

    if (bgAudioObjectUrl) {
        try { URL.revokeObjectURL(bgAudioObjectUrl); } catch (_) { }
        bgAudioObjectUrl = '';
    }

    if (bgAudioSource === 'remote') {
        const r = remoteMedia && remoteMedia.background ? remoteMedia.background : null;
        if (!r || !r.url) return false;
        if (audio.src !== String(r.url)) {
            audio.src = String(r.url);
        }
        return true;
    }

    if (bgAudioSource === 'file') {
        const blob = await bgGetBlob();
        if (!blob) return false;
        bgAudioObjectUrl = URL.createObjectURL(blob);
        audio.src = bgAudioObjectUrl;
        return true;
    }
    if (bgAudioSource === 'url') {
        if (!bgAudioUrl || !String(bgAudioUrl).trim()) return false;
        const targetUrl = String(bgAudioUrl).trim();
        if (audio.src !== targetUrl) {
            audio.src = targetUrl;
        }
        return true;
    }
    return false;
}

async function bgStartPlayback() {
    bgAudioDesiredPlaying = true;
    if (!bgAudioEnabled) return;
    const ok = await bgLoadSourceIntoAudio();
    if (!ok) return;
    try { await ensureBgAudioEl().play(); } catch (_) { }
}

function bgStopPlayback() {
    bgAudioDesiredPlaying = false;
    if (!bgAudioEl) return;
    try { bgAudioEl.pause(); } catch (_) { }
}

async function bgOnNodeChanged(nodeId) {
    if (!bgAudioEnabled || !bgAudioDesiredPlaying) return;
    const audio = ensureBgAudioEl();
    
    if (bgAudioMode === 'restart_per_node') {
        audio.currentTime = 0;
        try { await audio.play(); } catch (_) { }
    } else if (bgAudioMode === 'continuous') {
        if (audio.paused) {
            try { await audio.play(); } catch (_) { }
        }
    }
}

function bgSetVolume(vol) {
    const next = Math.max(0, Math.min(1, Number(vol)));
    if (!Number.isFinite(next)) return;
    bgAudioVolume = next;
    if (bgAudioEl) {
        // If currently ducked, keep the duck ratio.
        if (bgAudioDuckRestoreVolume !== null) {
            bgAudioDuckRestoreVolume = next;
            bgAudioEl.volume = Math.max(0, Math.min(1, next * 0.35));
        } else {
            bgAudioEl.volume = next;
        }
    }
}

function applyRemoteMediaFromShare(shared) {
    remoteMedia = { background: null, voiceByNode: {}, filesByNode: {} };
    if (!shared || !shared.media) return;

    if (shared.media.background && shared.media.background.url) {
        remoteMedia.background = shared.media.background;
        bgAudioEnabled = true;
        bgAudioSource = 'remote';
        if (bgAudioEnabledEl) bgAudioEnabledEl.checked = true;
        if (bgAudioStatusEl) bgAudioStatusEl.textContent = 'Background source: saved link audio.';
    }

    if (shared.media.voiceByNode && typeof shared.media.voiceByNode === 'object') {
        remoteMedia.voiceByNode = shared.media.voiceByNode;
        const hasAny = Object.keys(remoteMedia.voiceByNode).length > 0;
        if (hasAny) {
            voiceEnabled = true;
            if (voiceEnabledEl) voiceEnabledEl.checked = true;
            if (voiceStatusEl) voiceStatusEl.textContent = 'Voice annotations: saved link audio.';
        }
    }

    if (shared.media.filesByNode && typeof shared.media.filesByNode === 'object') {
        remoteMedia.filesByNode = shared.media.filesByNode;
    }
}

async function voiceSetBlobForNode(nodeId, blob) {
    return await idbPut('recordings', voiceKeyForNode(nodeId), blob);
}

async function voiceClearForNode(nodeId) {
    return await idbDel('recordings', voiceKeyForNode(nodeId));
}

function ensureVoiceAudioEl() {
    if (voiceAudioEl) return voiceAudioEl;
    voiceAudioEl = new Audio();
    voiceAudioEl.preload = 'metadata';
    return voiceAudioEl;
}

async function playAudioUrl(url) {
    const audio = ensureVoiceAudioEl();
    try {
        // Optional ducking of background audio while the voice plays.
        if (bgAudioEnabled && bgAudioDuck && bgAudioEl && !bgAudioEl.paused) {
            bgAudioDuckRestoreVolume = bgAudioVolume;
            bgAudioEl.volume = Math.max(0, Math.min(1, (bgAudioVolume || 0.35) * 0.35));
        }

        audio.src = String(url);
        const durationMs = await new Promise((resolve) => {
            const onMeta = () => resolve(Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : 0);
            audio.addEventListener('loadedmetadata', onMeta, { once: true });
            setTimeout(() => resolve(0), 800);
        });
        await audio.play();
        await new Promise((resolve) => audio.addEventListener('ended', resolve, { once: true }));
        return durationMs;
    } catch (_) {
        return 0;
    } finally {
        if (bgAudioDuckRestoreVolume !== null && bgAudioEl) {
            bgAudioEl.volume = Math.max(0, Math.min(1, Number(bgAudioDuckRestoreVolume) || 0.35));
            bgAudioDuckRestoreVolume = null;
        }
    }
}

async function playVoiceForNode(nodeId) {
    if (!voiceEnabled || !voiceAutoplay) return 0;

    const remote = remoteMedia && remoteMedia.voiceByNode ? remoteMedia.voiceByNode[String(nodeId)] : null;
    if (remote && remote.url) {
        return await playAudioUrl(remote.url);
    }

    const blob = await voiceGetBlobForNode(nodeId);
    if (!blob) return 0;

    const audio = ensureVoiceAudioEl();
    let url = '';
    try {
        // Optional ducking of background audio while the voice plays.
        if (bgAudioEnabled && bgAudioDuck && bgAudioEl && !bgAudioEl.paused) {
            bgAudioDuckRestoreVolume = bgAudioVolume;
            bgAudioEl.volume = Math.max(0, Math.min(1, (bgAudioVolume || 0.35) * 0.35));
        }

        url = URL.createObjectURL(blob);
        audio.src = url;
        const durationMs = await new Promise((resolve) => {
            const onMeta = () => resolve(Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : 0);
            audio.addEventListener('loadedmetadata', onMeta, { once: true });
            // If metadata never loads, fall back quickly.
            setTimeout(() => resolve(0), 800);
        });

        await audio.play();
        await new Promise((resolve) => audio.addEventListener('ended', resolve, { once: true }));
        return durationMs;
    } catch (_) {
        return 0;
    } finally {
        if (bgAudioDuckRestoreVolume !== null && bgAudioEl) {
            bgAudioEl.volume = Math.max(0, Math.min(1, Number(bgAudioDuckRestoreVolume) || 0.35));
            bgAudioDuckRestoreVolume = null;
        }
        try { if (url) URL.revokeObjectURL(url); } catch (_) { }
    }
}

function getPlaybackDelayMs(nodeId, voiceDurationMs) {
    if (!window._isEditingMode) {
        // STRICT DECOUPLING: In Normal mode, we ignore voice duration and node-specific pauses.
        const sec = Number(normalPlaybackDelaySec) || 7;
        const ms = Math.round(Math.max(0.5, sec) * 1000);
        console.log(`[PlaybackEngine] NORMAL Mode Timer Enforced: ${sec}s (${ms}ms)`);
        return ms;
    }

    // Editing mode: Use base delay + overrides + voice
    const baseMs = Math.max(0.5, Number(playbackBaseDelaySec) || 3) * 1000;
    const customSec = getNodeCustomPauseSec(nodeId);
    let delay = Math.round((customSec !== null ? customSec * 1000 : baseMs));
    if (voiceEnabled && voiceAutoplay && voiceHold) {
        delay = Math.max(delay, Math.max(0, Number(voiceDurationMs) || 0) + 250);
    }
    console.log(`[PlaybackEngine] Editing Mode Delay for Node ${nodeId}: ${delay}ms`);
    return Math.round(delay);
}

// Sidepanel UI state (persisted)
const SIDEPANEL_WIDTH_KEY = 'sidepanelWidth';
const SIDEPANEL_COLLAPSED_KEY = 'sidepanelCollapsed';
const THEME_KEY = 'appTheme'; // 'light' | 'dark' | 'system'

function applyTheme(theme) {
    const html = document.documentElement;
    const resolved = theme === 'dark' || theme === 'light'
        ? theme
        : (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    html.dataset.theme = resolved;
    const btn = document.getElementById('themeToggle');
    if (btn) {
        btn.textContent = resolved === 'dark' ? '☾' : '☀';
        btn.setAttribute('aria-label', resolved === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
        btn.title = resolved === 'dark' ? 'Light mode' : 'Dark mode';
    }
}

function setupThemeToggle() {
    let theme = 'system';
    try { theme = localStorage.getItem(THEME_KEY) || 'system'; } catch (_) { }
    applyTheme(theme);

    const btn = document.getElementById('themeToggle');
    btn?.addEventListener('click', () => {
        const current = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
        const next = current === 'dark' ? 'light' : 'dark';
        try { localStorage.setItem(THEME_KEY, next); } catch (_) { }
        applyTheme(next);
    });

    if (window.matchMedia) {
        const mq = window.matchMedia('(prefers-color-scheme: dark)');
        // Update if user chooses system (or we have legacy value).
        mq.addEventListener?.('change', () => {
            try {
                const stored = localStorage.getItem(THEME_KEY) || 'system';
                if (stored === 'system') applyTheme('system');
            } catch (_) { }
        });
    }
}

function setupSidepanel() {
    const sidepanel = document.getElementById('sidepanel');
    const resizer = document.getElementById('sidepanelResizer');
    const toggle = document.getElementById('sidepanelToggle');
    const mobileToggle = document.getElementById('mobileSidepanelToggle');
    const backdrop = document.getElementById('sidepanelBackdrop');
    if (!sidepanel || !resizer || !toggle) return;

    const root = document.documentElement;
    function updateDeviceStatus() {
        const isMobile = window.innerWidth <= 760;
        const currentDevice = root.dataset.device;
        const newDevice = isMobile ? 'mobile' : 'desktop';
        if (currentDevice !== newDevice) {
            root.dataset.device = newDevice;
            window.dispatchEvent(new Event('cynode:devicemodechange'));
        }
    }
    window.addEventListener('resize', updateDeviceStatus);
    updateDeviceStatus();

    const isMobileLayout = () => root.dataset.device === 'mobile';

    const syncMobileChrome = () => {
        const mobile = isMobileLayout();
        const open = mobile && !sidepanel.classList.contains('collapsed');
        if (mobileToggle) {
            mobileToggle.hidden = !mobile;
            mobileToggle.textContent = open ? 'Close' : 'Menu';
            mobileToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
            mobileToggle.setAttribute('aria-label', open ? 'Close side panel' : 'Open side panel');
        }
        if (backdrop) {
            backdrop.hidden = !open;
            backdrop.setAttribute('aria-hidden', open ? 'false' : 'true');
        }
        document.body.classList.toggle('mobile-sidepanel-open', open);
    };

    const setToggleGlyph = () => {
        const collapsed = sidepanel.classList.contains('collapsed');
        if (isMobileLayout()) {
            toggle.textContent = collapsed ? 'Menu' : 'Close';
            toggle.setAttribute('aria-label', collapsed ? 'Open side panel' : 'Close side panel');
            toggle.title = collapsed ? 'Open side panel' : 'Close side panel';
        } else {
            // When panel is open, show << to indicate "close". When collapsed, show >> to indicate "open".
            toggle.textContent = collapsed ? '>>' : '<<';
            toggle.setAttribute('aria-label', collapsed ? 'Expand side panel' : 'Collapse side panel');
            toggle.title = collapsed ? 'Expand side panel' : 'Collapse side panel';
        }
    };

    let setCollapsed = (collapsed, options = {}) => {
        sidepanel.classList.toggle('collapsed', !!collapsed);
        if (options.persist !== false) {
            localStorage.setItem(SIDEPANEL_COLLAPSED_KEY, collapsed ? '1' : '0');
        }
        setToggleGlyph();
        syncMobileChrome();
    };

    const savedWidth = parseInt(localStorage.getItem(SIDEPANEL_WIDTH_KEY) || '', 10);
    if (!isNaN(savedWidth) && savedWidth >= 160 && savedWidth <= 800) {
        root.style.setProperty('--sidepanel-width', `${savedWidth}px`);
    }

    const savedCollapsed = localStorage.getItem(SIDEPANEL_COLLAPSED_KEY);
    const initialCollapsed = savedCollapsed === '1' || (savedCollapsed === null && isMobileLayout());
    setCollapsed(initialCollapsed, { persist: false });

    const togglePanel = () => {
        setCollapsed(!sidepanel.classList.contains('collapsed'));
    };

    const closePanelIfMobile = (options = {}) => {
        if (!isMobileLayout()) return;
        if (!sidepanel.classList.contains('collapsed')) {
            setCollapsed(true, options);
        }
    };

    toggle.addEventListener('click', togglePanel);
    mobileToggle?.addEventListener('click', togglePanel);
    backdrop?.addEventListener('click', () => closePanelIfMobile());
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closePanelIfMobile();
        }
    });

    let dragging = false;
    let startX = 0;
    let startWidth = 0;

    const onMove = (e) => {
        if (!dragging || isMobileLayout()) return;
        const dx = e.clientX - startX;
        const next = Math.max(220, Math.min(520, startWidth + dx));
        root.style.setProperty('--sidepanel-width', `${next}px`);
    };

    const onUp = () => {
        if (!dragging) return;
        dragging = false;
        document.body.style.userSelect = '';
        const value = getComputedStyle(sidepanel).width;
        const n = parseInt(value, 10);
        if (!isNaN(n)) localStorage.setItem(SIDEPANEL_WIDTH_KEY, String(n));
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
    };

    resizer.addEventListener('mousedown', (e) => {
        if (sidepanel.classList.contains('collapsed') || isMobileLayout()) return;
        dragging = true;
        startX = e.clientX;
        startWidth = parseInt(getComputedStyle(sidepanel).width, 10) || 280;
        document.body.style.userSelect = 'none';
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    });

    window.addEventListener('cynode:devicemodechange', () => {
        const saved = localStorage.getItem(SIDEPANEL_COLLAPSED_KEY);
        if (isMobileLayout()) {
            setCollapsed(saved === null ? true : saved === '1', { persist: false });
        } else {
            setCollapsed(saved === '1', { persist: false });
        }
    });

    // Ensure ARIA attributes are in sync for assistive tech
    const syncAria = () => {
        const expanded = !sidepanel.classList.contains('collapsed') && isMobileLayout();
        if (mobileToggle) mobileToggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        if (backdrop) backdrop.setAttribute('aria-hidden', expanded ? 'false' : 'true');
    };
    // Keep in sync after toggles
    const origSetCollapsed = setCollapsed;
    setCollapsed = (collapsed, options) => {
        // call original implementation which is now in closure; we already defined setCollapsed earlier; to avoid complex refactor just call side effects
        sidepanel.classList.toggle('collapsed', !!collapsed);
        if (options === undefined || options.persist !== false) {
            try { localStorage.setItem(SIDEPANEL_COLLAPSED_KEY, collapsed ? '1' : '0'); } catch(_){}
        }
        setToggleGlyph();
        syncMobileChrome();
        syncAria();
    };
}

function syncModalBodyLock() {
    document.body.classList.toggle('modal-open', !!document.querySelector('.modal.visible'));
}

function saveNodeDataLegacy() {
    try {
        localStorage.setItem('nodeCount', currentNodeCount.toString());
        localStorage.setItem('nodeUrls', JSON.stringify(nodeUrls));
        if (lastSelectedNode !== null) {
            localStorage.setItem('lastSelectedNode', lastSelectedNode.toString());
        } else {
            localStorage.removeItem('lastSelectedNode');
        }
    } catch (e) {
        console.error("Error saving node data to localStorage:", e);
    }
}

function getApiBase() {
    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
        return ''; // Localhost uses relative paths
    }
    // Desktop check (if running in Electron)
    if (navigator.userAgent.toLowerCase().includes('electron')) {
        return 'https://cynode.vercel.app';
    }
    // Default to current origin for web/PWA
    return '';
}

async function apiJson(path, options) {
    const baseUrl = getApiBase();
    const fullPath = path.startsWith('http') ? path : baseUrl + path;
    
    const init = { ...(options || {}) };
    const body = init.body;
    const hasBody =
        body !== undefined &&
        body !== null &&
        !(typeof body === 'string' && body.length === 0);

    // Avoid sending an empty JSON body with a JSON content-type, which Fastify rejects.
    if (!hasBody) delete init.body;

    const headers = new Headers(init.headers || {});
    if (hasBody) headers.set('content-type', 'application/json');
    else headers.delete('content-type');
    init.headers = headers;

    let res;
    try {
        res = await fetch(fullPath, init);
    } catch (e) {
        const fallback = await maybeHandleOfflineApiFallback(path, init, { error: e });
        if (fallback !== null) return fallback;
        throw e;
    }

    if (!res.ok) {
        const text = await res.text().catch(() => '');
        const fallback = await maybeHandleOfflineApiFallback(path, init, { status: res.status, text });
        if (fallback !== null) return fallback;
        throw new Error(`API ${res.status} ${res.statusText}${text ? `: ${text}` : ''}`);
    }
    const json = await res.json();

    if (path.includes('/api/v1/me')) {
        if (json && json.user) {
            writeCachedMe(json);
            setOfflineSessionUser(json.user);
        } else {
            clearCachedAuthState();
        }
    } else if (path.includes('/api/v1/logout')) {
        clearCachedAuthState();
    }

    return json;
}

async function apiUpload(path, formData) {
    const baseUrl = getApiBase();
    const fullPath = baseUrl + path;
    const res = await fetch(fullPath, {
        method: 'POST',
        body: formData,
        credentials: 'same-origin',
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`API ${res.status} ${res.statusText}${text ? `: ${text}` : ''}`);
    }
    return res.json();
}

async function sendAnalyticsEvent(type, nodeIndex, url) {
    // Only record analytics when we are viewing a share snapshot.
    if (!activeShareCode) return;
    try {
        const baseUrl = getApiBase();
        await fetch(baseUrl + '/api/v1/analytics/event', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                shareCode: activeShareCode,
                type,
                nodeIndex: typeof nodeIndex === 'number' ? nodeIndex : undefined,
                url: typeof url === 'string' ? url : undefined,
                pagePath: currentShareAnalyticsContext?.pagePath,
                utmSource: currentShareAnalyticsContext?.utmSource,
                utmMedium: currentShareAnalyticsContext?.utmMedium,
                utmCampaign: currentShareAnalyticsContext?.utmCampaign,
                utmContent: currentShareAnalyticsContext?.utmContent,
                utmTerm: currentShareAnalyticsContext?.utmTerm,
            }),
            keepalive: true,
        });
    } catch (_) { }
}

function buildNormalizedExportSnapshot() {
    const populatedNodeIds = [];
    for (let i = 1; i <= currentNodeCount; i++) {
        const url = nodeUrls[i];
        if (url && String(url).trim() !== '') populatedNodeIds.push(i);
    }

    if (populatedNodeIds.length === 0) return null;

    const normalizedUrls = {};
    const normalizedCaptions = {};
    const normalizedPauseSecByNode = {};
    const nodeIndexMap = {};

    populatedNodeIds.forEach((oldNodeId, idx) => {
        const newNodeId = idx + 1;
        nodeIndexMap[oldNodeId] = newNodeId;
        normalizedUrls[newNodeId] = nodeUrls[oldNodeId];

        if (nodeCaptions[oldNodeId]) {
            normalizedCaptions[newNodeId] = { ...nodeCaptions[oldNodeId] };
        }
        const pauseSec = getNodeCustomPauseSec(oldNodeId);
        if (pauseSec !== null) normalizedPauseSecByNode[newNodeId] = pauseSec;
    });

    const normalizedLastSelectedNode =
        lastSelectedNode !== null && Object.prototype.hasOwnProperty.call(nodeIndexMap, lastSelectedNode)
            ? nodeIndexMap[lastSelectedNode]
            : 1;

    return {
        nodeCount: populatedNodeIds.length,
        lastSelectedNode: normalizedLastSelectedNode,
        nodeUrls: normalizedUrls,
        nodeCaptions: Object.keys(normalizedCaptions).length > 0 ? normalizedCaptions : undefined,
        nodePauseSecByNode: Object.keys(normalizedPauseSecByNode).length > 0 ? normalizedPauseSecByNode : undefined,
        removedNodeIds: Array.from({ length: currentNodeCount }, (_, idx) => idx + 1).filter((nodeId) => !populatedNodeIds.includes(nodeId)),
        nodeIndexMap,
    };
}

function confirmNormalizedExport(actionLabel, exportSnapshot) {
    if (!exportSnapshot) return false;
    const removedCount = Array.isArray(exportSnapshot.removedNodeIds) ? exportSnapshot.removedNodeIds.length : 0;
    if (removedCount < 1) return true;
    const nodeLabel = removedCount === 1 ? 'empty node' : 'empty nodes';
    return window.confirm(`${actionLabel} will remove ${removedCount} ${nodeLabel} with no URL or file before continuing. Continue?`);
}

function requireSignedInForSharedRemix(actionLabel = 'remix this shared nodegraph') {
    if (!loadedFromSharedGraph || currentUser) return true;

    clearAuthError();
    if (authFormEl) authFormEl.style.display = '';
    if (signInBtnEl) signInBtnEl.style.display = '';
    if (typeof setAuthMode === 'function') setAuthMode('register');
    try { authFormEl?.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (_) { }
    alert(`Please sign in or create an account to ${actionLabel}.`);
    return false;
}

function applySharedReadOnlyMode() {
    const readOnly = !!loadedFromSharedGraph && !currentUser;
    document.body.classList.toggle('shared-readonly-mode', readOnly);
    if (!readOnly) return;

    const authStatus = document.getElementById('authStatus');
    if (authStatus) {
        authStatus.textContent = 'Viewing a shared Nodegraph in read-only mode. Sign in to remix, save, share, or generate QR codes.';
    }

    const signInBtn = document.getElementById('signInBtn');
    if (signInBtn) signInBtn.textContent = 'Sign In to Remix';

    const readOnlyTitles = {
        shareBtn: 'Sign in to share your own version of this Nodegraph.',
        saveBtn: 'Sign in to save this shared Nodegraph to your account.',
        updateSavedBtn: 'Sign in to update or remix this shared Nodegraph.',
        addManualBtn: 'Sign in to add URLs to this shared Nodegraph.',
        addFileBtn: 'Sign in to attach files to this shared Nodegraph.',
        importBrowserBtn: 'Sign in to import browser content into this shared Nodegraph.',
        clearAllBtn: 'Sign in to clear or remix this shared Nodegraph.',
        generateQrBtn: 'Sign in to generate QR codes for your saved Nodegraphs.',
        saveUrlBtn: 'Sign in to edit this shared Nodegraph.',
        clearUrlBtn: 'Sign in to edit this shared Nodegraph.',
        topicInput: 'Sign in to edit the topic for this shared Nodegraph.',
        nodeCount: 'Sign in to change nodes in this shared Nodegraph.',
        setNodeCountBtn: 'Sign in to change nodes in this shared Nodegraph.',
        saveAsSelect: 'Sign in to save this shared Nodegraph to your account.',
        qrSavedGraphSelect: 'Sign in to generate QR codes for your saved Nodegraphs.',
    };

    Object.entries(readOnlyTitles).forEach(([id, title]) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.setAttribute('title', title);
        if ('disabled' in el) el.disabled = true;
        el.setAttribute('aria-disabled', 'true');
    });
}

async function uploadSavedMedia(code, exportSnapshot, { topic } = {}) {
    if (!code) return { portableSnapshot: exportSnapshot || null, replacedLocalFiles: false };
    const nodeIndexMap = exportSnapshot && exportSnapshot.nodeIndexMap ? exportSnapshot.nodeIndexMap : {};
    const portableNodeUrls = exportSnapshot && exportSnapshot.nodeUrls
        ? { ...exportSnapshot.nodeUrls }
        : {};
    let replacedLocalFiles = false;

    // Background audio: only upload when a local file is selected (URL sources cannot be reliably fetched due to CORS/SSRF).
    if (bgAudioEnabled && bgAudioSource === 'file') {
        const blob = await bgGetBlob().catch(() => null);
        if (blob) {
            const fd = new FormData();
            fd.append('file', blob, 'background.webm');
            try {
                const res = await apiUpload(`/api/v1/saved/${encodeURIComponent(code)}/media/background`, fd);
                if (res && res.url) remoteMedia.background = res;
                if (bgAudioStatusEl) bgAudioStatusEl.textContent = 'Background audio published to saved link.';
            } catch (e) {
                console.warn('Background audio upload failed', e);
                if (bgAudioStatusEl) bgAudioStatusEl.textContent = 'Background audio upload failed.';
            }
        }
    }

    // Voice annotations: upload any node recordings found locally.
    if (voiceEnabled) {
        const voiceByNode = {};
        for (const [oldNodeIdRaw, newNodeId] of Object.entries(nodeIndexMap)) {
            const oldNodeId = Number(oldNodeIdRaw);
            const blob = await voiceGetBlobForNode(oldNodeId).catch(() => null);
            if (!blob) continue;
            const fd = new FormData();
            fd.append('file', blob, `node-${newNodeId}.webm`);
            try {
                const res = await apiUpload(`/api/v1/saved/${encodeURIComponent(code)}/media/voice/${newNodeId}`, fd);
                if (res && res.url) voiceByNode[String(newNodeId)] = res;
            } catch (e) {
                console.warn(`Voice upload failed for node ${oldNodeId}`, e);
            }
        }
        if (Object.keys(voiceByNode).length > 0) {
            remoteMedia.voiceByNode = { ...(remoteMedia.voiceByNode || {}), ...voiceByNode };
            if (voiceStatusEl) voiceStatusEl.textContent = 'Voice annotations published to saved link.';
        }
    }

    // Node files: upload any local files assigned to nodes.
    const filesByNode = {};
    for (const [oldNodeIdRaw, newNodeId] of Object.entries(nodeIndexMap)) {
        const oldNodeId = Number(oldNodeIdRaw);
        const u = nodeUrls[oldNodeId];
        if (u && String(u).startsWith('localfile:')) {
            const id = u.split('?')[0].split(':')[1];
            try {
                const f = await fileGet(id).catch(() => null);
                if (f && f.blob) {
                    const fd = new FormData();
                    fd.append('file', f.blob, f.name || 'file');
                    const res = await apiUpload(`/api/v1/saved/${encodeURIComponent(code)}/media/node/${newNodeId}`, fd);
                    if (res && res.url) {
                        filesByNode[String(newNodeId)] = res;
                        portableNodeUrls[String(newNodeId)] = res.url;
                        nodeUrls[oldNodeId] = res.url; // Immediately swap it locally
                        replacedLocalFiles = true;
                    }
                }
            } catch (e) {
                console.warn(`Local file upload failed for node ${oldNodeId}`, e);
            }
        }
    }
    if (Object.keys(filesByNode).length > 0) {
        remoteMedia.filesByNode = { ...(remoteMedia.filesByNode || {}), ...filesByNode };
    }

    const portableSnapshot = exportSnapshot
        ? { ...exportSnapshot, nodeUrls: portableNodeUrls }
        : null;

    if (portableSnapshot && replacedLocalFiles) {
        await apiJson(`/api/v1/saved/${encodeURIComponent(code)}`, {
            method: 'PUT',
            body: JSON.stringify(buildSavedPayload(portableSnapshot, {
                topic: topic || undefined,
            })),
        });
    }

    return { portableSnapshot, replacedLocalFiles };
}

function buildSavedPayload(exportSnapshot, extras = {}) {
    return {
        nodeCount: exportSnapshot.nodeCount,
        lastSelectedNode: exportSnapshot.lastSelectedNode,
        nodeUrls: exportSnapshot.nodeUrls,
        nodeCaptions: exportSnapshot.nodeCaptions,
        nodePauseSecByNode: exportSnapshot.nodePauseSecByNode,
        ...extras,
    };
}

async function saveNodegraphToAccount(exportSnapshot, { organizationId, topic } = {}) {
    try {
        const response = await apiJson('/api/v1/saved', {
            method: 'POST',
            body: JSON.stringify(buildSavedPayload(exportSnapshot, {
                organizationId,
                topic: topic || undefined,
            })),
        });
        clearPendingGraphSync(currentUser);
        return { queued: false, ...response };
    } catch (error) {
        if (!isOfflineCapableError(error)) throw error;
        const queued = queuePendingSavedCreate({ snapshot: exportSnapshot, organizationId, topic });
        queueGraphSnapshotForSync(buildSavedPayload(exportSnapshot), { user: currentUser });
        updateAccountProfileCard();
        return {
            queued: true,
            code: queued.placeholderCode,
            shareUrl: null,
            message: 'Saved offline. Cynode will publish it to your account after reconnect.',
        };
    }
}

async function updateSavedNodegraphInAccount(code, exportSnapshot, { topic } = {}) {
    try {
        const response = await apiJson(`/api/v1/saved/${encodeURIComponent(code)}`, {
            method: 'PUT',
            body: JSON.stringify(buildSavedPayload(exportSnapshot, {
                topic: topic || undefined,
            })),
        });
        return { queued: false, ...response };
    } catch (error) {
        if (!isOfflineCapableError(error)) throw error;
        const queued = queuePendingSavedUpdate({ code, snapshot: exportSnapshot, topic });
        queueGraphSnapshotForSync(buildSavedPayload(exportSnapshot), { user: currentUser });
        updateAccountProfileCard();
        return {
            queued: true,
            code: queued.placeholderCode || queued.code || code,
            shareUrl: null,
            message: String(code || '').startsWith('offline_')
                ? 'Saved offline draft updated. Cynode will sync it after reconnect.'
                : 'Saved changes queued offline. Cynode will update the cloud version after reconnect.',
        };
    }
}

async function persistCurrentGraphAsSaved({ preferUpdate = true, fallbackTopic = null } = {}) {
    flushPendingGraphTopicInput();
    const exportSnapshot = buildNormalizedExportSnapshot();
    if (!exportSnapshot) {
        return { ok: false, reason: 'empty_graph' };
    }

    const normalizedFallbackTopic = String(fallbackTopic || '').trim();
    const effectiveTopic = String(graphTopic || '').trim() || normalizedFallbackTopic || undefined;
    const saveAsSelect = document.getElementById('saveAsSelect');

    const shouldUpdateExisting = preferUpdate && !!currentSavedShareCode;
    const result = shouldUpdateExisting
        ? await updateSavedNodegraphInAccount(currentSavedShareCode, exportSnapshot, { topic: effectiveTopic })
        : await saveNodegraphToAccount(exportSnapshot, {
            organizationId: saveAsSelect && saveAsSelect.value ? saveAsSelect.value : undefined,
            topic: effectiveTopic,
        });

    if (!result) {
        return { ok: false, reason: 'save_failed' };
    }

    const finalCode = result.code || currentSavedShareCode || null;
    const finalTopic = effectiveTopic || '';

    if (finalCode) {
        graphTopicOrigin = `saved:${finalCode}`;
        currentSavedShareCode = finalCode;
        currentSavedShareUrl = result.shareUrl || (result.queued ? null : createSavedGraphUrl(finalCode));
        updateUpdateSavedButton();
        if (finalTopic || !String(graphTopic || '').trim()) {
            setGraphTopicFromExternal(finalTopic, graphTopicOrigin);
        }
    }

    if (!result.queued && finalCode) {
        const mediaResult = await uploadSavedMedia(finalCode, exportSnapshot, { topic: finalTopic || undefined });
        if (mediaResult && mediaResult.portableSnapshot) {
            saveNodeData();
        }
        writeLastActiveGraphForUser(finalCode, {
            origin: 'saved',
            shareUrl: currentSavedShareUrl || createSavedGraphUrl(finalCode),
        });
        if (typeof refreshSavedLinksFn === 'function') {
            try { await refreshSavedLinksFn(); } catch (_) { }
        }
    } else {
        updateAccountProfileCard();
    }

    markExplicitSaveBaseline();
    return { ok: true, result };
}

async function refreshCloudBackedEditorState({ force = false } = {}) {
    if (!currentUser || cloudRefreshInFlight) return false;
    if (!force && Date.now() - lastCloudRefreshAt < 15000) return false;
    if (!navigator.onLine) return false;

    cloudRefreshInFlight = true;
    lastCloudRefreshAt = Date.now();

    try {
        if (typeof refreshSavedLinksFn === 'function') {
            try { await refreshSavedLinksFn(); } catch (_) { }
        }

        if (
            currentSavedShareCode
            && !String(currentSavedShareCode).startsWith('offline_')
            && !hasUnsavedChangesSinceExplicitSave()
        ) {
            await loadSavedOrSharedGraphIntoEditor(currentSavedShareCode, {
                origin: 'saved',
                enableShareAnalytics: false,
                editableAsShared: false,
                shareUrl: currentSavedShareUrl || null,
            });
            return true;
        }
    } finally {
        cloudRefreshInFlight = false;
    }

    return false;
}

async function processPendingCloudSync() {
    if (pendingCloudSyncInFlight || !navigator.onLine) {
        updateAccountProfileCard();
        return false;
    }

    const syncUser = currentUser || getOfflineSessionUser();
    if (!syncUser) {
        updateAccountProfileCard();
        return false;
    }

    pendingCloudSyncInFlight = true;
    let changed = false;

    try {
        const pendingGraph = readPendingGraphSync(syncUser);
        if (pendingGraph && pendingGraph.snapshot) {
            const graphSnapshot = cloneSerializable(pendingGraph.snapshot);
            let savedGraphId = pendingGraph.graphId || graphId || null;
            if (!savedGraphId) {
                try { savedGraphId = localStorage.getItem(getScopedKey('graphId')); } catch (_) { }
            }
            try {
                if (savedGraphId) {
                    await apiJson(`/api/v1/graphs/${savedGraphId}`, {
                        method: 'PUT',
                        body: JSON.stringify(graphSnapshot),
                    });
                    graphId = savedGraphId;
                } else {
                    const created = await apiJson('/api/v1/graphs', {
                        method: 'POST',
                        body: JSON.stringify(graphSnapshot),
                    });
                    if (created && created.id) {
                        graphId = created.id;
                        localStorage.setItem(getScopedKey('graphId'), graphId);
                    }
                }
                clearPendingGraphSync(syncUser);
                changed = true;
            } catch (error) {
                if (!isOfflineCapableError(error)) {
                    console.warn('[SyncQueue] Graph sync failed:', error);
                }
            }
        }

        const queuedActions = readPendingSavedActions(syncUser);
        if (queuedActions.length > 0) {
            const remaining = [];

            for (let i = 0; i < queuedActions.length; i++) {
                const action = queuedActions[i];
                try {
                    if (action.type === 'create') {
                        const response = await apiJson('/api/v1/saved', {
                            method: 'POST',
                            body: JSON.stringify(buildSavedPayload(action.snapshot, {
                                organizationId: action.organizationId || undefined,
                                topic: action.topic || undefined,
                            })),
                        });
                        if (response && response.code) {
                            try { await uploadSavedMedia(response.code, action.snapshot, { topic: action.topic || undefined }); } catch (_) { }
                            if (currentSavedShareCode === action.placeholderCode) {
                                currentSavedShareCode = response.code;
                                currentSavedShareUrl = response.shareUrl || createSavedGraphUrl(response.code);
                                graphTopicOrigin = `saved:${response.code}`;
                                writeLastActiveGraphForUser(response.code, { origin: 'saved', shareUrl: currentSavedShareUrl, user: syncUser });
                                updateUpdateSavedButton();
                            }
                            changed = true;
                            continue;
                        }
                    } else if (action.type === 'update' && action.code) {
                        const response = await apiJson(`/api/v1/saved/${encodeURIComponent(action.code)}`, {
                            method: 'PUT',
                            body: JSON.stringify(buildSavedPayload(action.snapshot, {
                                topic: action.topic || undefined,
                            })),
                        });
                        try { await uploadSavedMedia(action.code, action.snapshot, { topic: action.topic || undefined }); } catch (_) { }
                        if (response && response.shareUrl && currentSavedShareCode === action.code) {
                            currentSavedShareUrl = response.shareUrl;
                            writeLastActiveGraphForUser(action.code, { origin: 'saved', shareUrl: currentSavedShareUrl, user: syncUser });
                        }
                        changed = true;
                        continue;
                    }
                } catch (error) {
                    if (!isOfflineCapableError(error)) {
                        console.warn('[SyncQueue] Saved item sync failed:', error);
                    }
                }

                remaining.push(action);
            }

            writePendingSavedActions(remaining, syncUser);
        }
    } finally {
        pendingCloudSyncInFlight = false;
        updateAccountProfileCard();
    }

    if (changed && typeof refreshSavedLinksFn === 'function') {
        try { await refreshSavedLinksFn(); } catch (_) { }
    }

    return changed;
}

function setGraphTopicFromInput(value) {
    // Do not trim the live input value, otherwise typing a space (as a trailing char) gets immediately removed.
    graphTopic = String(value || '');
    const trimmed = graphTopic.trim();

    const savedOrigin = typeof graphTopicOrigin === 'string' && graphTopicOrigin.startsWith('saved:')
        ? graphTopicOrigin
        : null;

    if (savedOrigin && currentSavedShareCode) {
        graphTopicOrigin = savedOrigin;
    } else {
        graphTopicOrigin = 'draft';
        currentSavedShareCode = null;
        currentSavedShareUrl = null;
    }
    updateUpdateSavedButton();

    try {
        if (trimmed) localStorage.setItem(GRAPH_TOPIC_KEY, trimmed);
        else localStorage.removeItem(GRAPH_TOPIC_KEY);
        localStorage.setItem(GRAPH_TOPIC_ORIGIN_KEY, graphTopicOrigin);
    } catch (_) { }

    const display = document.getElementById('graphTopicDisplay');
    if (display) display.textContent = trimmed;
}

function setGraphTopicFromExternal(value, origin) {
    // Used when loading from storage/share; safe to normalize and set the input value.
    graphTopic = String(value || '');
    const trimmed = graphTopic.trim();
    if (typeof origin === 'string') {
        graphTopicOrigin = origin;
    } else if (origin === null) {
        graphTopicOrigin = null;
    }
    currentSavedShareCode = graphTopicOrigin && graphTopicOrigin.startsWith('saved:') ? graphTopicOrigin.slice(6) : null;
    if (!currentSavedShareCode) currentSavedShareUrl = null;
    updateUpdateSavedButton();

    try {
        if (trimmed) localStorage.setItem(GRAPH_TOPIC_KEY, trimmed);
        else localStorage.removeItem(GRAPH_TOPIC_KEY);
        if (graphTopicOrigin) localStorage.setItem(GRAPH_TOPIC_ORIGIN_KEY, graphTopicOrigin);
        else localStorage.removeItem(GRAPH_TOPIC_ORIGIN_KEY);
    } catch (_) { }

    const display = document.getElementById('graphTopicDisplay');
    if (display) display.textContent = trimmed;

    const input = document.getElementById('topicInput');
    if (input) input.value = trimmed;
}

// --- Voice + Playback Override UI ---
let playbackBaseDelayRange;
let playbackBaseDelayNum;
let settingsNodePicker;
let nodePauseOverrideNum;
let applyNodePauseOverrideBtn;
let clearNodePauseOverrideBtn;
let playbackSelectedNodeHint;
let nodePauseOverrideHint;
let nodePauseOverridesList;
let settingsNodeContext;
let settingsMiniNodeGraph;
let updateSavedBtn;
let settingsNodePickerSummary;
let voiceNodePicker;
let voiceNodeContext;

let voiceEnabledEl;
let voiceAutoplayEl;
let voiceHoldEl;
let voiceRecBtn;
let voiceStopBtn;
let voicePlayBtn;
let voiceClearBtn;
let voiceStatusEl;

let bgAudioEnabledEl;
let bgAudioFileEl;
let bgAudioClearFileBtn;
let bgAudioUrlEl;
let bgAudioUseUrlBtn;
let bgAudioModeEl;
let bgAudioVolumeEl;
let bgAudioVolumeNumEl;
let bgAudioDuckEl;
let bgAudioPreviewPlayBtn;
let bgAudioPreviewStopBtn;
let bgAudioStatusEl;
let settingsPickerRenderSignature = '';
let settingsMiniGraphRenderSignature = '';
let settingsOverridesRenderSignature = '';
let topicInputCommitTimer = null;
let playbackSettingsPersistTimer = null;
let savedLinksRenderSignature = '';

function readJson(value, fallback) {
    try { return JSON.parse(value); } catch (_) { return fallback; }
}

function persistPlaybackSettings() {
    try {
        localStorage.setItem(PLAYBACK_MODE_KEY, window._isEditingMode ? 'editing' : 'normal');
        localStorage.setItem(NORMAL_PLAYBACK_DELAY_KEY, String(normalPlaybackDelaySec));
        localStorage.setItem(PLAYBACK_BASE_DELAY_KEY, String(playbackBaseDelaySec));
        localStorage.setItem(NODE_EXTRA_DELAYS_KEY, JSON.stringify(nodeExtraDelaySecByNode || {}));
        localStorage.setItem(VOICE_ENABLED_KEY, voiceEnabled ? '1' : '0');
        localStorage.setItem(VOICE_AUTOPLAY_KEY, voiceAutoplay ? '1' : '0');
        localStorage.setItem(VOICE_HOLD_KEY, voiceHold ? '1' : '0');
        localStorage.setItem(BG_AUDIO_ENABLED_KEY, bgAudioEnabled ? '1' : '0');
        localStorage.setItem(BG_AUDIO_SOURCE_KEY, String(bgAudioSource || ''));
        localStorage.setItem(BG_AUDIO_URL_KEY, String(bgAudioUrl || ''));
        localStorage.setItem(BG_AUDIO_VOLUME_KEY, String(bgAudioVolume));
        localStorage.setItem(BG_AUDIO_MODE_KEY, String(bgAudioMode || 'continuous'));
        localStorage.setItem(BG_AUDIO_DUCK_KEY, bgAudioDuck ? '1' : '0');
    } catch (_) { }
}

function scheduleGraphTopicInput(value) {
    if (topicInputCommitTimer) {
        clearTimeout(topicInputCommitTimer);
        topicInputCommitTimer = null;
    }
    topicInputCommitTimer = setTimeout(() => {
        topicInputCommitTimer = null;
        setGraphTopicFromInput(value);
    }, 120);
}

function flushPendingGraphTopicInput() {
    if (!topicInputCommitTimer) return;
    clearTimeout(topicInputCommitTimer);
    topicInputCommitTimer = null;
    const input = document.getElementById('topicInput');
    setGraphTopicFromInput(input ? input.value : graphTopic);
}

function schedulePlaybackSettingsPersist(delay = 120) {
    if (playbackSettingsPersistTimer) {
        clearTimeout(playbackSettingsPersistTimer);
        playbackSettingsPersistTimer = null;
    }
    playbackSettingsPersistTimer = setTimeout(() => {
        playbackSettingsPersistTimer = null;
        persistPlaybackSettings();
    }, Math.max(0, Number(delay) || 0));
}

function loadPlaybackSettings() {
    try {
        // READ playback mode from localStorage, default to normal for predictable viewer experience
        const mode = localStorage.getItem(PLAYBACK_MODE_KEY);
        window._isEditingMode = mode === 'editing';

        const norm = localStorage.getItem(NORMAL_PLAYBACK_DELAY_KEY);
        if (norm) normalPlaybackDelaySec = Number(norm) || 7;
        const normTimerInput = document.getElementById('nodeTimer');
        if (normTimerInput) normTimerInput.value = String(normalPlaybackDelaySec);

        const base = localStorage.getItem(PLAYBACK_BASE_DELAY_KEY);
        if (base) playbackBaseDelaySec = Number(base) || 3;
        const panelDelayNum = document.getElementById('playbackBaseDelayNum');
        if (panelDelayNum) panelDelayNum.value = String(playbackBaseDelaySec);
        const panelDelayRange = document.getElementById('playbackBaseDelay');
        if (panelDelayRange) panelDelayRange.value = String(playbackBaseDelaySec);

        const perNode = localStorage.getItem(NODE_EXTRA_DELAYS_KEY);
        if (perNode) {
            const parsed = readJson(perNode, {});
            if (parsed && typeof parsed === 'object') {
                for (const k in nodeExtraDelaySecByNode) delete nodeExtraDelaySecByNode[k];
                Object.assign(nodeExtraDelaySecByNode, parsed);
            }
        }
        
        voiceEnabled = localStorage.getItem(VOICE_ENABLED_KEY) === '1';
        const ap = localStorage.getItem(VOICE_AUTOPLAY_KEY);
        voiceAutoplay = ap ? ap === '1' : true;
        const hold = localStorage.getItem(VOICE_HOLD_KEY);
        voiceHold = hold ? hold === '1' : true;

        bgAudioEnabled = localStorage.getItem(BG_AUDIO_ENABLED_KEY) === '1';
        bgAudioSource = localStorage.getItem(BG_AUDIO_SOURCE_KEY) || '';
        bgAudioUrl = localStorage.getItem(BG_AUDIO_URL_KEY) || '';
        const v = localStorage.getItem(BG_AUDIO_VOLUME_KEY);
        bgAudioVolume = v ? Math.max(0, Math.min(1, Number(v) || 0.35)) : 0.35;
        bgAudioMode = localStorage.getItem(BG_AUDIO_MODE_KEY) || 'continuous';
        bgAudioDuck = (localStorage.getItem(BG_AUDIO_DUCK_KEY) || '1') === '1';

        // Update sidepanel UI to match state
        if (typeof window._updatePlaybackModeUI === 'function') window._updatePlaybackModeUI();
    } catch (_) { }
}

function getSelectedNodeIdForSettings() {
    const pickerValue = Number(settingsNodePicker?.value);
    if (Number.isFinite(pickerValue) && pickerValue >= 1 && pickerValue <= currentNodeCount) return pickerValue;
    const n = Number(lastSelectedNode);
    if (Number.isFinite(n) && n >= 1 && n <= currentNodeCount) return n;
    return currentNodeCount >= 1 ? 1 : null;
}

function getNodeCustomPauseSec(nodeId) {
    if (!nodeId) return null;
    if (!nodeExtraDelaySecByNode || !Object.prototype.hasOwnProperty.call(nodeExtraDelaySecByNode, nodeId)) return null;
    const value = Number(nodeExtraDelaySecByNode[nodeId]);
    return Number.isFinite(value) ? Math.max(0.5, value) : null;
}

function getEffectiveNodePauseSec(nodeId) {
    const custom = getNodeCustomPauseSec(nodeId);
    return custom !== null ? custom : Math.max(0.5, Number(playbackBaseDelaySec) || 7);
}

function getNodePickerLabel(nodeId) {
    const customPause = getNodeCustomPauseSec(nodeId);
    const labelParts = [`Node ${nodeId}`];
    const url = nodeUrls[nodeId];
    if (url && String(url).trim()) {
        const cap = nodeCaptions[nodeId];
        if (cap && cap.title && cap.title.trim()) labelParts.push(cap.title.trim());
        else {
            const shown = displayTextForUrl(url);
            labelParts.push(shown.length > 34 ? `${shown.slice(0, 31)}...` : shown);
        }
    } else {
        labelParts.push('No URL');
    }
    labelParts.push(customPause !== null ? `${customPause}s custom` : 'default pause');
    return labelParts.join(' | ');
}

function buildSettingsPickerRenderSignature(selectedNodeId) {
    const labels = [];
    for (let i = 1; i <= currentNodeCount; i++) labels.push(getNodePickerLabel(i));
    return JSON.stringify({
        selectedNodeId: selectedNodeId || null,
        nodeCount: currentNodeCount,
        labels,
    });
}

function buildSettingsMiniGraphRenderSignature(activeNodeId) {
    const nodes = [];
    for (let i = 1; i <= currentNodeCount; i++) {
        nodes.push([
            i,
            !!(nodeUrls[i] && String(nodeUrls[i]).trim()),
            !!(remoteMedia?.voiceByNode?.[String(i)]),
            i === activeNodeId,
        ]);
    }
    return JSON.stringify(nodes);
}

function buildNodePauseOverridesRenderSignature(activeNodeId) {
    const rows = [];
    for (let i = 1; i <= currentNodeCount; i++) {
        rows.push([
            i,
            i === activeNodeId,
            getNodeCustomPauseSec(i),
            getEffectiveNodePauseSec(i),
            !!(nodeUrls[i] && String(nodeUrls[i]).trim()),
            !!(remoteMedia?.voiceByNode?.[String(i)]),
        ]);
    }
    return JSON.stringify(rows);
}

function updateUpdateSavedButton() {
    if (!updateSavedBtn) return;
    const canUpdate = !!currentSavedShareCode;
    updateSavedBtn.style.display = canUpdate ? '' : 'none';
    updateSavedBtn.disabled = !canUpdate;
}

function updateSettingsNodeContext(nodeId) {
    if (!settingsNodeContext) return;
    if (!nodeId || nodeId < 1 || nodeId > currentNodeCount) {
        settingsNodeContext.textContent = 'Choose a node from the current graph to edit its pause timing and voice note.';
        return;
    }

    const parts = [`Editing Node ${nodeId}`];
    const url = nodeUrls[nodeId];
    if (url && String(url).trim()) {
        parts.push(displayTextForUrl(url));
    } else {
        parts.push('No URL assigned yet');
    }
    settingsNodeContext.textContent = parts.join(' | ');
    if (voiceNodeContext) {
        voiceNodeContext.textContent = nodeId
            ? `Voice note target: Node ${nodeId}${url && String(url).trim() ? ` | ${displayTextForUrl(url)}` : ' | No URL assigned yet'}`
            : '';
    }
}

function renderSettingsMiniNodeGraph(activeNodeId, { force = false } = {}) {
    if (!settingsMiniNodeGraph) return;
    const signature = buildSettingsMiniGraphRenderSignature(activeNodeId);
    if (!force && signature === settingsMiniGraphRenderSignature) return;
    settingsMiniGraphRenderSignature = signature;
    settingsMiniNodeGraph.innerHTML = '';
    for (let i = 1; i <= currentNodeCount; i++) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'settings-mini-node';
        btn.title = getNodePickerLabel(i);
        if (nodeUrls[i] && String(nodeUrls[i]).trim()) btn.classList.add('is-loaded');
        if (i === activeNodeId) btn.classList.add('is-active');
        if (remoteMedia?.voiceByNode?.[String(i)]) btn.classList.add('has-voice');
        btn.addEventListener('click', () => {
            lastSelectedNode = i;
            updateRecentUrl(i);
        });
        settingsMiniNodeGraph.appendChild(btn);
    }
}

function syncSettingsNodePicker(nodeId) {
    const target = nodeId && nodeId >= 1 && nodeId <= currentNodeCount ? nodeId : (currentNodeCount >= 1 ? 1 : '');
    if (settingsNodePicker) settingsNodePicker.value = String(target);
    if (voiceNodePicker) voiceNodePicker.value = String(target);
}

function buildNodePickerOptions(selectEl, selectedNodeId) {
    if (!selectEl) return;

    const fragment = document.createDocumentFragment();
    if (currentNodeCount < 1) {
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = 'No nodes loaded';
        placeholder.label = 'No nodes loaded';
        fragment.appendChild(placeholder);
        selectEl.replaceChildren(fragment);
        selectEl.disabled = true;
        selectEl.selectedIndex = 0;
        return;
    }

    for (let i = 1; i <= currentNodeCount; i++) {
        const label = getNodePickerLabel(i);
        const option = document.createElement('option');
        option.value = String(i);
        option.textContent = label;
        option.label = label;
        option.title = label;
        fragment.appendChild(option);
    }

    selectEl.replaceChildren(fragment);
    selectEl.disabled = false;
    const target = selectedNodeId && selectedNodeId >= 1 && selectedNodeId <= currentNodeCount ? selectedNodeId : 1;
    selectEl.value = String(target);
}

function rebuildSettingsNodePickers({ force = false } = {}) {
    const selected = getSelectedNodeIdForSettings();
    const signature = buildSettingsPickerRenderSignature(selected);
    if (force || signature !== settingsPickerRenderSignature) {
        settingsPickerRenderSignature = signature;
        buildNodePickerOptions(settingsNodePicker, selected);
        buildNodePickerOptions(voiceNodePicker, selected);
        if (settingsNodePickerSummary) {
            settingsNodePickerSummary.textContent = currentNodeCount > 0
                ? `Current graph copy in this panel: ${currentNodeCount} node${currentNodeCount === 1 ? '' : 's'} with the same node order and URL associations as the active nodegraph.`
                : 'No nodes are available in the current graph yet.';
        }
    }
    syncSettingsNodePicker(selected);
    updateSettingsNodeContext(selected);
    renderSettingsMiniNodeGraph(selected);
}

function renderNodePauseOverridesList(activeNodeId, { rebuildPickers = true, force = false } = {}) {
    if (!nodePauseOverridesList) return;
    if (rebuildPickers) rebuildSettingsNodePickers({ force });
    const signature = buildNodePauseOverridesRenderSignature(activeNodeId);
    if (!force && signature === settingsOverridesRenderSignature) return;
    settingsOverridesRenderSignature = signature;
    nodePauseOverridesList.innerHTML = '';
    if (currentNodeCount < 1) {
        nodePauseOverridesList.textContent = '';
        return;
    }

    for (let i = 1; i <= currentNodeCount; i++) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'settings-node-override-row';
        if (i === activeNodeId) row.classList.add('is-active');
        row.addEventListener('click', () => {
            lastSelectedNode = i;
            updateRecentUrl(i);
        });

        const customPause = getNodeCustomPauseSec(i);
        const effectivePause = getEffectiveNodePauseSec(i);
        const hasVoice = remoteMedia?.voiceByNode?.[String(i)] || false;

        const node = document.createElement('div');
        node.className = 'settings-node-override-node';
        node.textContent = `Node ${i}`;

        const meta = document.createElement('div');
        meta.className = 'settings-node-override-meta';
        const parts = [];
        parts.push(customPause !== null ? `Custom pause ${effectivePause}s` : `Default pause ${effectivePause}s`);
        if (nodeUrls[i] && String(nodeUrls[i]).trim()) parts.push('URL loaded');
        else parts.push('No URL');
        if (hasVoice) parts.push('Voice note');
        meta.textContent = parts.join(' | ');

        const badge = document.createElement('div');
        badge.className = 'settings-node-override-badge';
        badge.textContent = customPause !== null ? 'Custom' : 'Default';

        row.appendChild(node);
        row.appendChild(meta);
        row.appendChild(badge);
        nodePauseOverridesList.appendChild(row);
    }
}

async function playVoicePreviewForNode(nodeId) {
    const blob = await voiceGetBlobForNode(nodeId);
    if (!blob) return 0;
    const audio = ensureVoiceAudioEl();
    let url = '';
    try {
        url = URL.createObjectURL(blob);
        audio.src = url;
        const durationMs = await new Promise((resolve) => {
            const onMeta = () => resolve(Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : 0);
            audio.addEventListener('loadedmetadata', onMeta, { once: true });
            setTimeout(() => resolve(0), 800);
        });
        await audio.play();
        await new Promise((resolve) => audio.addEventListener('ended', resolve, { once: true }));
        return durationMs;
    } catch (_) {
        return 0;
    } finally {
        try { if (url) URL.revokeObjectURL(url); } catch (_) { }
    }
}

async function getAudioDurationSecFromBlob(blob) {
    if (!blob) return null;
    const audio = new Audio();
    let url = '';
    try {
        url = URL.createObjectURL(blob);
        audio.src = url;
        const duration = await new Promise((resolve) => {
            const done = () => resolve(Number.isFinite(audio.duration) ? Number(audio.duration) : 0);
            audio.addEventListener('loadedmetadata', done, { once: true });
            setTimeout(() => resolve(0), 1200);
        });
        return duration > 0 ? duration : null;
    } catch (_) {
        return null;
    } finally {
        try { if (url) URL.revokeObjectURL(url); } catch (_) { }
    }
}

async function updateVoiceStatus(nodeId) {
    if (!voiceStatusEl) return;
    if (!nodeId) {
        voiceStatusEl.textContent = 'Select a node to record a voice annotation.';
        return;
    }
    const blob = await voiceGetBlobForNode(nodeId);
    if (!blob) {
        voiceStatusEl.textContent = `Node ${nodeId}: no voice annotation recorded.`;
        return;
    }
    voiceStatusEl.textContent = `Node ${nodeId}: voice annotation recorded.`;
}

async function startVoiceRecording(nodeId) {
    if (!nodeId) return;
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
        alert('Voice recording is not supported in this browser.');
        return;
    }

    // Recording implies voice feature on.
    voiceEnabled = true;
    if (voiceEnabledEl) voiceEnabledEl.checked = true;
    persistPlaybackSettings();

    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const recorder = new MediaRecorder(stream);
        activeRecording = { recorder, stream, nodeId, chunks: [] };

        recorder.addEventListener('dataavailable', (ev) => {
            if (ev.data && ev.data.size > 0) activeRecording.chunks.push(ev.data);
        });

        recorder.addEventListener('stop', async () => {
            try {
                const blob = new Blob(activeRecording.chunks, { type: recorder.mimeType || 'audio/webm' });
                await voiceSetBlobForNode(nodeId, blob);
                const durationSec = await getAudioDurationSecFromBlob(blob);
                if (durationSec !== null) {
                    const roundedPause = Math.min(45, Math.max(0.5, Math.ceil(durationSec * 2) / 2));
                    nodeExtraDelaySecByNode[nodeId] = roundedPause;
                    persistPlaybackSettings();
                }
            } catch (e) {
                console.warn('Failed to store voice annotation', e);
            } finally {
                try { activeRecording.stream?.getTracks()?.forEach(t => t.stop()); } catch (_) { }
                activeRecording = { recorder: null, stream: null, nodeId: null, chunks: [] };
                if (voiceRecBtn) voiceRecBtn.disabled = false;
                if (voiceStopBtn) voiceStopBtn.disabled = true;
                const selected = getSelectedNodeIdForSettings();
                await updateVoiceSettingsForSelectedNode(selected, { forceRender: true });
            }
        });

        recorder.start();
        if (voiceRecBtn) voiceRecBtn.disabled = true;
        if (voiceStopBtn) voiceStopBtn.disabled = false;
        if (voiceStatusEl) voiceStatusEl.textContent = `Recording Node ${nodeId}...`;
    } catch (e) {
        console.warn('Microphone permission denied or unavailable', e);
        alert('Unable to access microphone. Check browser permissions.');
    }
}

function stopVoiceRecording() {
    if (!activeRecording || !activeRecording.recorder) return;
    try { activeRecording.recorder.stop(); } catch (_) { }
}

async function clearVoiceForSelectedNode(nodeId) {
    if (!nodeId) return;
    try {
        await voiceClearForNode(nodeId);
    } catch (e) {
        console.warn('Failed to clear voice annotation', e);
    }
    await updateVoiceStatus(nodeId);
}

function setupVoiceSettings() {
    loadPlaybackSettings();

    playbackBaseDelayRange = document.getElementById('playbackBaseDelay');
    playbackBaseDelayNum = document.getElementById('playbackBaseDelayNum');
    settingsNodePicker = document.getElementById('settingsNodePicker');
    nodePauseOverrideNum = document.getElementById('nodePauseOverrideNum');
    applyNodePauseOverrideBtn = document.getElementById('applyNodePauseOverrideBtn');
    clearNodePauseOverrideBtn = document.getElementById('clearNodePauseOverrideBtn');
    playbackSelectedNodeHint = document.getElementById('playbackSelectedNodeHint');
    nodePauseOverrideHint = document.getElementById('nodePauseOverrideHint');
    nodePauseOverridesList = document.getElementById('nodePauseOverridesList');
    settingsNodeContext = document.getElementById('settingsNodeContext');
    settingsMiniNodeGraph = document.getElementById('settingsMiniNodeGraph');
    settingsNodePickerSummary = document.getElementById('settingsNodePickerSummary');
    voiceNodePicker = document.getElementById('voiceNodePicker');
    voiceNodeContext = document.getElementById('voiceNodeContext');

    voiceEnabledEl = document.getElementById('voiceEnabled');
    voiceAutoplayEl = document.getElementById('voiceAutoplay');
    voiceHoldEl = document.getElementById('voiceHold');
    voiceRecBtn = document.getElementById('voiceRecBtn');
    voiceStopBtn = document.getElementById('voiceStopBtn');
    voicePlayBtn = document.getElementById('voicePlayBtn');
    voiceClearBtn = document.getElementById('voiceClearBtn');
    voiceStatusEl = document.getElementById('voiceStatus');

    bgAudioEnabledEl = document.getElementById('bgAudioEnabled');
    bgAudioFileEl = document.getElementById('bgAudioFile');
    bgAudioClearFileBtn = document.getElementById('bgAudioClearFileBtn');
    bgAudioUrlEl = document.getElementById('bgAudioUrl');
    bgAudioUseUrlBtn = document.getElementById('bgAudioUseUrlBtn');
    bgAudioModeEl = document.getElementById('bgAudioMode');
    bgAudioVolumeEl = document.getElementById('bgAudioVolume');
    bgAudioVolumeNumEl = document.getElementById('bgAudioVolumeNum');
    bgAudioDuckEl = document.getElementById('bgAudioDuck');
    bgAudioPreviewPlayBtn = document.getElementById('bgAudioPreviewPlayBtn');
    bgAudioPreviewStopBtn = document.getElementById('bgAudioPreviewStopBtn');
    bgAudioStatusEl = document.getElementById('bgAudioStatus');

    if (playbackBaseDelayRange) playbackBaseDelayRange.value = String(playbackBaseDelaySec);
    if (playbackBaseDelayNum) playbackBaseDelayNum.value = String(playbackBaseDelaySec);

    if (voiceEnabledEl) voiceEnabledEl.checked = !!voiceEnabled;
    if (voiceAutoplayEl) voiceAutoplayEl.checked = !!voiceAutoplay;
    if (voiceHoldEl) voiceHoldEl.checked = !!voiceHold;

    if (bgAudioEnabledEl) bgAudioEnabledEl.checked = !!bgAudioEnabled;
    if (bgAudioUrlEl) bgAudioUrlEl.value = bgAudioUrl || '';
    if (bgAudioModeEl) bgAudioModeEl.value = bgAudioMode || 'continuous';
    if (bgAudioVolumeEl) bgAudioVolumeEl.value = String(bgAudioVolume);
    if (bgAudioVolumeNumEl) bgAudioVolumeNumEl.value = String(bgAudioVolume);
    if (bgAudioDuckEl) bgAudioDuckEl.checked = !!bgAudioDuck;

    const syncBaseDelay = (sec, { immediatePersist = false } = {}) => {
        const next = Math.min(12, Math.max(0.5, Number(sec) || 3));
        playbackBaseDelaySec = next;
        if (playbackBaseDelayRange) playbackBaseDelayRange.value = String(next);
        if (playbackBaseDelayNum) playbackBaseDelayNum.value = String(next);
        if (immediatePersist) persistPlaybackSettings();
        else schedulePlaybackSettingsPersist();
        renderNodePauseOverridesList(getSelectedNodeIdForSettings(), { rebuildPickers: false });
        if (nodePauseOverrideHint) {
            const selectedNodeId = getSelectedNodeIdForSettings();
            const customPause = getNodeCustomPauseSec(selectedNodeId);
            if (selectedNodeId && customPause === null) {
                nodePauseOverrideHint.textContent = `Node ${selectedNodeId} currently uses the default pause of ${next}s.`;
            }
        }
    };

    // Exported via shared so it can be called from loadPlaybackSettings
    // Exported via window so play.js can subscribe to changes
    window._updatePlaybackModeUI = (preventLog = false) => {
        const normBtn = document.getElementById('toNormalModeBtn');
        const editBtn = document.getElementById('toEditingModeBtn');
        const hint = document.getElementById('modeHintText');
        if (!normBtn || !editBtn) return;

        if (window._isEditingMode) {
            editBtn.classList.add('active');
            normBtn.classList.remove('active');
            
            // Brute force style enforcement (overrides CSS failures)
            editBtn.style.setProperty('background-color', '#8b5cf6', 'important');
            editBtn.style.setProperty('color', '#ffffff', 'important');
            normBtn.style.setProperty('background-color', 'transparent', 'important');
            normBtn.style.setProperty('color', '#64748b', 'important');

            if (hint) {
                hint.textContent = "✔ Editing Mode Active: Using custom pauses, voice narrations, and per-node overrides.";
                hint.style.color = "#8b5cf6";
                hint.style.fontWeight = "800";
            }
            if (!preventLog) console.log("[ModeSwitcher] UI -> EDITING MODE applied.");
        } else {
            normBtn.classList.add('active');
            editBtn.classList.remove('active');

            // Brute force style reversal
            normBtn.style.setProperty('background-color', '#0b5fff', 'important');
            normBtn.style.color = "#ffffff";
            editBtn.style.backgroundColor = "transparent";
            editBtn.style.color = "#64748b";

            if (hint) {
                hint.textContent = "✔ Normal Mode Active: Using the global sequence timer (ignore overrides).";
                hint.style.color = "#0b5fff";
                hint.style.fontWeight = "800";
            }
            if (!preventLog) console.log("[ModeSwitcher] UI -> NORMAL MODE applied.");
        }
    };

    document.getElementById('toNormalModeBtn')?.addEventListener('click', () => {
        window._isEditingMode = false;
        persistPlaybackSettings();
        window._updatePlaybackModeUI();
        // FORCE a loop restart if it's currently playing to apply timing changes immediately.
        if (typeof stopPlaySequence === 'function') stopPlaySequence();
    });

    document.getElementById('toEditingModeBtn')?.addEventListener('click', () => {
        window._isEditingMode = true;
        persistPlaybackSettings();
        window._updatePlaybackModeUI();
    });

    // Initialize UI state
    window._updatePlaybackModeUI(true);

    playbackBaseDelayRange?.addEventListener('input', () => syncBaseDelay(playbackBaseDelayRange.value));
    playbackBaseDelayRange?.addEventListener('change', () => syncBaseDelay(playbackBaseDelayRange.value, { immediatePersist: true }));
    playbackBaseDelayNum?.addEventListener('input', () => syncBaseDelay(playbackBaseDelayNum.value));
    playbackBaseDelayNum?.addEventListener('change', () => syncBaseDelay(playbackBaseDelayNum.value, { immediatePersist: true }));
    playbackBaseDelayNum?.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        syncBaseDelay(playbackBaseDelayNum.value, { immediatePersist: true });
    });

    voiceEnabledEl?.addEventListener('change', () => {
        voiceEnabled = !!voiceEnabledEl.checked;
        persistPlaybackSettings();
    });
    voiceAutoplayEl?.addEventListener('change', () => {
        voiceAutoplay = !!voiceAutoplayEl.checked;
        persistPlaybackSettings();
    });
    voiceHoldEl?.addEventListener('change', () => {
        voiceHold = !!voiceHoldEl.checked;
        persistPlaybackSettings();
    });

    const setBgStatus = (msg) => { if (bgAudioStatusEl) bgAudioStatusEl.textContent = msg; };

    bgAudioEnabledEl?.addEventListener('change', async () => {
        bgAudioEnabled = !!bgAudioEnabledEl.checked;
        persistPlaybackSettings();
        if (!bgAudioEnabled) {
            bgStopPlayback();
            setBgStatus('Background audio disabled.');
        } else {
            setBgStatus('Background audio enabled.');
            if (bgAudioDesiredPlaying) await bgStartPlayback();
        }
    });

    bgAudioFileEl?.addEventListener('change', async () => {
        const file = bgAudioFileEl.files && bgAudioFileEl.files[0] ? bgAudioFileEl.files[0] : null;
        if (!file) return;
        try {
            await bgSetBlob(file);
            bgAudioSource = 'file';
            persistPlaybackSettings();
            setBgStatus(`Using file: ${file.name}`);
            if (bgAudioDesiredPlaying && bgAudioEnabled) await bgStartPlayback();
        } catch (e) {
            console.warn('Failed to store background audio file', e);
            alert('Unable to store audio file.');
        }
    });

    bgAudioClearFileBtn?.addEventListener('click', async () => {
        try {
            await bgClearBlob();
        } catch (_) { }
        if (bgAudioFileEl) bgAudioFileEl.value = '';
        if (bgAudioSource === 'file') bgAudioSource = '';
        persistPlaybackSettings();
        setBgStatus('Background audio file cleared.');
        if (bgAudioDesiredPlaying) bgStopPlayback();
    });

    bgAudioUseUrlBtn?.addEventListener('click', async () => {
        bgAudioUrl = String(bgAudioUrlEl?.value || '').trim();
        if (!bgAudioUrl) { alert('Enter an audio URL first.'); return; }
        bgAudioSource = 'url';
        persistPlaybackSettings();
        setBgStatus('Using background audio URL.');
        if (bgAudioDesiredPlaying && bgAudioEnabled) await bgStartPlayback();
    });

    bgAudioModeEl?.addEventListener('change', () => {
        bgAudioMode = String(bgAudioModeEl.value || 'continuous');
        persistPlaybackSettings();
    });

    const syncBgVol = (v, { immediatePersist = false } = {}) => {
        const next = Math.max(0, Math.min(1, Number(v)));
        if (!Number.isFinite(next)) return;
        bgSetVolume(next);
        if (bgAudioVolumeEl) bgAudioVolumeEl.value = String(next);
        if (bgAudioVolumeNumEl) bgAudioVolumeNumEl.value = String(next);
        if (immediatePersist) persistPlaybackSettings();
        else schedulePlaybackSettingsPersist();
    };
    bgAudioVolumeEl?.addEventListener('input', () => syncBgVol(bgAudioVolumeEl.value));
    bgAudioVolumeEl?.addEventListener('change', () => syncBgVol(bgAudioVolumeEl.value, { immediatePersist: true }));
    bgAudioVolumeNumEl?.addEventListener('input', () => syncBgVol(bgAudioVolumeNumEl.value));
    bgAudioVolumeNumEl?.addEventListener('change', () => syncBgVol(bgAudioVolumeNumEl.value, { immediatePersist: true }));
    bgAudioVolumeNumEl?.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        syncBgVol(bgAudioVolumeNumEl.value, { immediatePersist: true });
    });

    bgAudioDuckEl?.addEventListener('change', () => {
        bgAudioDuck = !!bgAudioDuckEl.checked;
        persistPlaybackSettings();
    });

    bgAudioPreviewPlayBtn?.addEventListener('click', async () => {
        // Preview does not require playback to be active.
        bgAudioDesiredPlaying = true;
        await bgStartPlayback();
        setBgStatus('Playing background audio preview.');
    });
    bgAudioPreviewStopBtn?.addEventListener('click', () => {
        bgStopPlayback();
        setBgStatus('Background audio stopped.');
    });

    settingsNodePicker?.addEventListener('change', () => {
        const nodeId = getSelectedNodeIdForSettings();
        if (!nodeId) return;
        lastSelectedNode = nodeId;
        updateRecentUrl(nodeId);
    });
    voiceNodePicker?.addEventListener('change', () => {
        const nodeId = Number(voiceNodePicker.value);
        if (!nodeId) return;
        lastSelectedNode = nodeId;
        updateRecentUrl(nodeId);
    });

    applyNodePauseOverrideBtn?.addEventListener('click', () => {
        const nodeId = getSelectedNodeIdForSettings();
        if (!nodeId) return;
        const sec = Math.min(45, Math.max(0.5, Number(nodePauseOverrideNum?.value || 0) || Math.max(0.5, Number(playbackBaseDelaySec) || 7)));
        nodeExtraDelaySecByNode[nodeId] = sec;
        if (nodePauseOverrideNum) nodePauseOverrideNum.value = String(sec);

        // UX: Auto-switch to Editing Mode when the user explicitly sets an override.
        if (!window._isEditingMode) {
            window._isEditingMode = true;
            window._updatePlaybackModeUI?.();
        }

        persistPlaybackSettings();
        void updateVoiceSettingsForSelectedNode(nodeId, { forceRender: true });
    });

    clearNodePauseOverrideBtn?.addEventListener('click', () => {
        const nodeId = getSelectedNodeIdForSettings();
        if (!nodeId) return;
        delete nodeExtraDelaySecByNode[nodeId];
        persistPlaybackSettings();
        void updateVoiceSettingsForSelectedNode(nodeId, { forceRender: true });
    });

    nodePauseOverrideNum?.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        applyNodePauseOverrideBtn?.click();
    });

    voiceRecBtn?.addEventListener('click', async () => {
        const nodeId = getSelectedNodeIdForSettings();
        if (!nodeId) return;

        // Start recording implies editing intent.
        if (!window._isEditingMode) {
            window._isEditingMode = true;
            window._updatePlaybackModeUI?.();
        }

        await startVoiceRecording(nodeId);
    });
    voiceStopBtn?.addEventListener('click', () => stopVoiceRecording());
    voicePlayBtn?.addEventListener('click', async () => {
        const nodeId = getSelectedNodeIdForSettings();
        if (!nodeId) return;
        const blob = await voiceGetBlobForNode(nodeId);
        if (!blob) { alert('No voice annotation recorded for this node.'); return; }
        await playVoicePreviewForNode(nodeId);
    });
    voiceClearBtn?.addEventListener('click', async () => {
        const nodeId = getSelectedNodeIdForSettings();
        if (!nodeId) return;
        await clearVoiceForSelectedNode(nodeId);
    });

    syncSettingsNodePicker(getSelectedNodeIdForSettings());
    renderNodePauseOverridesList(getSelectedNodeIdForSettings(), { force: true });
    updateVoiceSettingsForSelectedNode(getSelectedNodeIdForSettings(), { forceRender: true });
    if (bgAudioStatusEl) {
        void (async () => {
            const hasFile = (await bgGetBlob()) ? true : false;
            if (bgAudioSource === 'file') setBgStatus(hasFile ? 'Background source: file.' : 'Background source: file (missing).');
            else if (bgAudioSource === 'url') setBgStatus(bgAudioUrl ? 'Background source: URL.' : 'Background source: URL (empty).');
            else setBgStatus('No background audio selected.');
        })();
    }
}

// Called from updateRecentUrl() when node selection changes.
async function updateVoiceSettingsForSelectedNode(nodeId, { forceRender = false } = {}) {
    syncSettingsNodePicker(nodeId);
    if (playbackSelectedNodeHint) {
        playbackSelectedNodeHint.textContent = nodeId ? `Recording and pause changes here only affect Node ${nodeId}.` : 'Selected node: none';
    }
    updateSettingsNodeContext(nodeId);
    renderSettingsMiniNodeGraph(nodeId, { force: forceRender });
    if (nodePauseOverrideNum) {
        const customPause = getNodeCustomPauseSec(nodeId);
        nodePauseOverrideNum.value = String(customPause !== null ? customPause : getEffectiveNodePauseSec(nodeId));
    }
    if (nodePauseOverrideHint) {
        const customPause = getNodeCustomPauseSec(nodeId);
        if (!nodeId) {
            nodePauseOverrideHint.textContent = '';
        } else if (customPause !== null) {
            nodePauseOverrideHint.textContent = `Node ${nodeId} uses a custom pause of ${customPause}s. If voice notes are longer and "Hold playback until voice finishes" is enabled, playback will wait for the recording to finish.`;
        } else {
            nodePauseOverrideHint.textContent = `Node ${nodeId} currently uses the default pause of ${Math.max(0.5, Number(playbackBaseDelaySec) || 7)}s.`;
        }
    }
    renderNodePauseOverridesList(nodeId, { rebuildPickers: false, force: forceRender });
    await updateVoiceStatus(nodeId);
}

function getShareContextFromLocation(loc = window.location) {
    const url = new URL(loc.href);
    const queryCode = String(url.searchParams.get('share') || '').trim();
    const queryNamespace = String(url.searchParams.get('ns') || '').trim();
    if (queryCode) {
        return {
            code: queryCode,
            namespace: queryNamespace || null,
            source: 'query',
        };
    }

    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length === 2) {
        const [namespace, code] = parts;
        if (/^[0-9A-Za-z][0-9A-Za-z-_]*$/.test(namespace) && /^[0-9A-Za-z]{4,32}$/.test(code)) {
            return {
                code,
                namespace,
                source: 'branded-path',
            };
        }
    }

    return null;
}

async function ensureGraphId() {
    // 1. Try URL share code first (Viewing mode)
    const shareContext = getShareContextFromLocation();
    if (shareContext && shareContext.code) {
        try {
            const graph = await apiJson(`/api/v1/shares/${shareContext.code}`, { method: 'GET' });
            if (graph && graph.id) {
                activeShareCode = shareContext.code;
                console.log("[ensureGraphId] Using share code graph:", graph.id);
                return graph.id;
            }
        } catch (e) {
            console.warn("[ensureGraphId] Could not load share code graph:", e);
        }
    }

    // 2. Try stored graphId (Persistent editing) - SCOPED TO USER
    const storageKey = getScopedKey('graphId');
    let id = localStorage.getItem(storageKey);
    if (id) {
        try {
            // Validate with backend
            const graph = await apiJson(`/api/v1/graphs/${id}`, { method: 'GET' });
            if (graph && graph.id) {
                console.log("[ensureGraphId] Reconnected to existing graph:", id);
                return id;
            }
        } catch (e) {
            console.warn(`[ensureGraphId] Graph ${id} not found on backend, creating new one.`, e);
            localStorage.removeItem(storageKey);
        }
    }

    // 3. Create new graph if needed (Standard start)
    try {
        const newGraph = await apiJson('/api/v1/graphs', {
            method: 'POST',
            body: JSON.stringify({ nodeCount: currentNodeCount })
        });
        if (newGraph && newGraph.id) {
            localStorage.setItem(storageKey, newGraph.id);
            console.log("[ensureGraphId] Created new graph:", newGraph.id);
            return newGraph.id;
        }
    } catch (e) {
        console.error("[ensureGraphId] Catastrophic failure creating graph:", e);
        return null;
    }
    return null;
}

async function tryLoadShareFromUrl() {
    const shareContext = getShareContextFromLocation();
    if (!shareContext || !shareContext.code) return false;

    const url = new URL(window.location.href);
    const code = shareContext.code;

    try {
        currentShareAnalyticsContext = {
            pagePath: `${url.pathname}${url.hash || ''}`,
            utmSource: url.searchParams.get('utm_source') || undefined,
            utmMedium: url.searchParams.get('utm_medium') || undefined,
            utmCampaign: url.searchParams.get('utm_campaign') || undefined,
            utmContent: url.searchParams.get('utm_content') || undefined,
            utmTerm: url.searchParams.get('utm_term') || undefined,
        };
        await loadSavedOrSharedGraphIntoEditor(code, { origin: 'share', enableShareAnalytics: true, editableAsShared: true });

        // Clean up query-style share URLs so refresh doesn't repeatedly import,
        // but keep branded share paths intact.
        if (shareContext.source === 'query') {
            url.searchParams.delete('share');
            url.searchParams.delete('ns');
            const nextUrl = url.pathname + (url.search ? url.search : '') + url.hash;
            window.history.replaceState({}, document.title, nextUrl);
        }

        return true;
    } catch (e) {
        console.warn('Failed to load share code; falling back to saved state.', e);
        return false;
    }
}

async function loadSavedOrSharedGraphIntoEditor(code, { origin = 'saved', enableShareAnalytics = false, editableAsShared = false, shareUrl = null } = {}) {
    const shared = await apiJson(`/api/v1/shares/${encodeURIComponent(code)}`, { method: 'GET' });
    activeShareCode = enableShareAnalytics ? code : null;
    loadedFromSharedGraph = !!editableAsShared;
    currentSavedShareCode = origin === 'saved' ? code : null;
    currentSavedShareUrl = origin === 'saved' ? (shareUrl || createSavedGraphUrl(code)) : null;
    writeLastActiveGraphForUser(code, { origin, shareUrl: currentSavedShareUrl });
    updateUpdateSavedButton();
    if (enableShareAnalytics) void sendAnalyticsEvent('share_view');

    const count = parseInt(String(shared.nodeCount), 10);
    if (!isNaN(count) && count >= MIN_NODES && count <= MAX_NODES) {
        currentNodeCount = count;
    }

    for (const k in nodeUrls) delete nodeUrls[k];
    if (shared.nodeUrls && typeof shared.nodeUrls === 'object') Object.assign(nodeUrls, shared.nodeUrls);
    
    for (const k in nodeCaptions) delete nodeCaptions[k];
    if (shared.nodeCaptions && typeof shared.nodeCaptions === 'object') Object.assign(nodeCaptions, shared.nodeCaptions);

    nodeExtraDelaySecByNode = (shared.nodePauseSecByNode && typeof shared.nodePauseSecByNode === 'object') ? shared.nodePauseSecByNode : {};
    if (shared.media && typeof shared.media.filesByNode === 'object') {
        for (const [idx, file] of Object.entries(shared.media.filesByNode)) {
            if (file && file.url) nodeUrls[idx] = file.url;
        }
    }

    if (shared.lastSelectedNode === null || shared.lastSelectedNode === undefined) {
        lastSelectedNode = null;
    } else {
        const n = parseInt(String(shared.lastSelectedNode), 10);
        lastSelectedNode = (!isNaN(n) && n >= 1 && n <= currentNodeCount) ? n : null;
    }
    if (lastSelectedNode === null) findAndSetInitialNode();

    setGraphTopicFromExternal(shared && typeof shared.topic === 'string' ? shared.topic : '', `${origin}:${code}`);

    applyRemoteMediaFromShare(shared);

    try {
        const created = await apiJson('/api/v1/graphs', {
            method: 'POST',
            body: JSON.stringify({
                nodeCount: currentNodeCount,
                lastSelectedNode: lastSelectedNode,
                nodeUrls: nodeUrls,
                nodeCaptions: nodeCaptions,
                nodePauseSecByNode: nodeExtraDelaySecByNode,
                topic: graphTopic || undefined,
            }),
        });
        if (created && created.id) {
            graphId = created.id;
            localStorage.setItem(GRAPH_ID_KEY, graphId);
        }
    } catch (e) {
        console.warn('Unable to create local graph from loaded snapshot; continuing with localStorage fallback.', e);
        graphId = null;
        localStorage.removeItem(GRAPH_ID_KEY);
    }

    if (nodeCountInput) nodeCountInput.value = currentNodeCount;
    if (typeof initNodes === 'function') initNodes(currentNodeCount);
    if (typeof updateNodeDisplay === 'function') updateNodeDisplay();
    if (typeof updateRecentUrl === 'function') updateRecentUrl(lastSelectedNode ?? (currentNodeCount > 0 ? 1 : null));
    try {
        if (typeof loadUrlInViewer === 'function' && lastSelectedNode && nodeUrls[lastSelectedNode]) {
            await loadUrlInViewer(nodeUrls[lastSelectedNode], lastSelectedNode);
        }
    } catch (_) { }

    // --- Mode Preservation (Decoupled Timers) ---
    // IMPORTANT: We PRESERVE the user's explicit mode preference instead of auto-forcing.
    // The user may have set a specific Normal Mode timer (e.g., 10s) and we must respect that.
    // Only auto-switch if the user has NEVER explicitly chosen a mode (first load).
    const storedMode = localStorage.getItem(PLAYBACK_MODE_KEY);
    
    // If user has never set a mode preference, use intelligent defaults
    if (!storedMode) {
        const hasOverrides = 
            Object.keys(nodeExtraDelaySecByNode).length > 0 || 
            Object.keys(nodeCaptions).length > 0 || 
            (shared.media && shared.media.voiceByNode && Object.keys(shared.media.voiceByNode).length > 0);
        
        // Default to Editing Mode only if there are overrides (for voice alignment)
        window._isEditingMode = !!hasOverrides;
        console.log(`[PlaybackEngine] First load detected. Auto-sensing: overrides=${hasOverrides}, defaulting to: ${window._isEditingMode ? 'Editing' : 'Normal'} Mode.`);
    } else {
        // Respect user's explicit preference
        window._isEditingMode = storedMode === 'editing';
        console.log(`[PlaybackEngine] Graph loaded. Preserving user's explicit mode preference: ${storedMode}.`);
    }
    
    persistPlaybackSettings();
    if (typeof window._updatePlaybackModeUI === 'function') window._updatePlaybackModeUI();
    markExplicitSaveBaseline();
}

function scheduleApiSave({ flush = false } = {}) {
    if (pendingSaveTimer) {
        clearTimeout(pendingSaveTimer);
        pendingSaveTimer = null;
    }

    const doSave = async () => {
        const snapshot = {
            nodeCount: currentNodeCount,
            lastSelectedNode: lastSelectedNode,
            nodeUrls: nodeUrls,
            nodeCaptions: nodeCaptions,
            nodePauseSecByNode: nodeExtraDelaySecByNode,
        };
        const id = await ensureGraphId();
        if (!id) {
            queueGraphSnapshotForSync(snapshot, { user: currentUser });
            saveNodeDataLegacy();
            updateAccountProfileCard();
            return;
        }
        try {
            await apiJson(`/api/v1/graphs/${id}`, {
                method: 'PUT',
                body: JSON.stringify(snapshot),
                keepalive: flush === true,
            });
            clearPendingGraphSync(currentUser);
            updateAccountProfileCard();
        } catch (e) {
            console.warn('Backend save failed; keeping localStorage as fallback.', e);
            queueGraphSnapshotForSync(snapshot, { graphIdOverride: id, user: currentUser });
            saveNodeDataLegacy();
            updateAccountProfileCard();
        }
    };

    if (flush) {
        void doSave();
        return;
    }

    pendingSaveTimer = setTimeout(async () => {
        try {
            await doSave();
        } catch (e) {
            console.warn("[scheduleApiSave] Background save failed:", e);
        }
    }, 500);
}

function saveNodeData(options) {
    scheduleApiSave(options);
    
    // Also save to Scoped Storage for disaster recovery/refresh
    const storageKey = getScopedKey('graph_snapshot');
    try {
        localStorage.setItem(storageKey, JSON.stringify({
            nodeCount: currentNodeCount,
            nodeUrls,
            nodeCaptions,
            nodeExtraDelaySecByNode
        }));
    } catch (_) { }
}

async function loadSavedNodeData() {
    try {
        const id = await ensureGraphId();
        if (id) {
            const graph = await apiJson(`/api/v1/graphs/${id}`, { method: 'GET' });
            if (graph && typeof graph === 'object') {
                const count = parseInt(String(graph.nodeCount), 10);
                if (!isNaN(count) && count >= MIN_NODES && count <= MAX_NODES) {
                    currentNodeCount = count;
                }

                for (const k in nodeUrls) delete nodeUrls[k];
                if (graph.nodeUrls && typeof graph.nodeUrls === 'object') Object.assign(nodeUrls, graph.nodeUrls);

                for (const k in nodeCaptions) delete nodeCaptions[k];
                if (graph.nodeCaptions && typeof graph.nodeCaptions === 'object') Object.assign(nodeCaptions, graph.nodeCaptions);

                if (graph.nodePauseSecByNode && typeof graph.nodePauseSecByNode === 'object') {
                    nodeExtraDelaySecByNode = graph.nodePauseSecByNode;
                } else {
                    nodeExtraDelaySecByNode = {};
                }

                if (graph.lastSelectedNode === null || graph.lastSelectedNode === undefined) {
                    findAndSetInitialNode();
                } else {
                    const loadedLastNodeId = parseInt(String(graph.lastSelectedNode), 10);
                    if (!isNaN(loadedLastNodeId) && loadedLastNodeId >= 1 && loadedLastNodeId <= currentNodeCount) {
                        lastSelectedNode = loadedLastNodeId;
                    } else {
                        findAndSetInitialNode();
                    }
                }
                
                // ... Rest of the function remains the same ...

                // --- Mode Preservation (Decoupled Timers for Personal Graph) ---
                // IMPORTANT: We PRESERVE the user's explicit mode preference instead of auto-forcing.
                // Only auto-switch if the user has NEVER explicitly chosen a mode (first load).
                const storedMode = localStorage.getItem(PLAYBACK_MODE_KEY);
                
                // If user has never set a mode preference, use intelligent defaults
                if (!storedMode) {
                    const hasOverrides = 
                        (nodeExtraDelaySecByNode && Object.keys(nodeExtraDelaySecByNode).length > 0) || 
                        (nodeCaptions && Object.keys(nodeCaptions).length > 0) ||
                        (graph.media && graph.media.voiceByNode && Object.keys(graph.media.voiceByNode).length > 0);
                    
                    // Default to Editing Mode only if there are overrides (for voice alignment)
                    window._isEditingMode = !!hasOverrides;
                    console.log(`[PlaybackEngine] Personal graph first load. Auto-sensing: overrides=${hasOverrides}, defaulting to: ${window._isEditingMode ? 'Editing' : 'Normal'} Mode.`);
                } else {
                    // Respect user's explicit preference
                    window._isEditingMode = storedMode === 'editing';
                    console.log(`[PlaybackEngine] Personal graph loaded. Preserving user's explicit mode preference: ${storedMode}.`);
                }
                
                persistPlaybackSettings();
                if (typeof window._updatePlaybackModeUI === 'function') window._updatePlaybackModeUI();

                return;
            }
        }

        // Fall back to legacy localStorage if backend is unavailable or data is invalid.
        const savedNodeCount = localStorage.getItem('nodeCount');
        const savedNodeUrls = localStorage.getItem('nodeUrls');
        const savedLastNode = localStorage.getItem('lastSelectedNode');

        if (savedNodeCount) {
            const count = parseInt(savedNodeCount, 10);
            if (!isNaN(count) && count >= MIN_NODES && count <= MAX_NODES) {
                currentNodeCount = count;
            }
        }

        if (savedNodeUrls) {
            try {
                const parsedUrls = JSON.parse(savedNodeUrls);
                // Basic validation: ensure it's an object
                if (typeof parsedUrls === 'object' && parsedUrls !== null) {
                    // Ensure keys are numbers - JSON stringifies keys as strings
                    const correctedUrls = {};
                    for (const key in parsedUrls) {
                        // Use hasOwnProperty for safer iteration
                        if (Object.prototype.hasOwnProperty.call(parsedUrls, key)) {
                            const numKey = parseInt(key, 10);
                            if (!isNaN(numKey)) {
                                correctedUrls[numKey] = parsedUrls[key];
                            }
                        }
                    }
                    for (const k in nodeUrls) delete nodeUrls[k];
                    Object.assign(nodeUrls, correctedUrls);
                }
            } catch (e) { }
        }
        // Handle missing or invalid lastSelectedNode
        const loadedLastNodeId = parseInt(savedLastNode, 10);
        if (!isNaN(loadedLastNodeId) && loadedLastNodeId >= 1 && loadedLastNodeId <= currentNodeCount && nodeUrls[loadedLastNodeId]) {
            lastSelectedNode = loadedLastNodeId;
        } else {
            findAndSetInitialNode(); 
        }

    } catch (e) {
        console.error("Error loading node data:", e);
        // Reset to defaults if loading fails catastrophically
        currentNodeCount = 8;
        for (const k in nodeUrls) delete nodeUrls[k];
        lastSelectedNode = 1;
    }
    
    // --- Mode Preservation (Final Pass - Legacy Data) ---
    // IMPORTANT: We PRESERVE the user's explicit mode preference instead of auto-forcing.
    // Only auto-switch if the user has NEVER explicitly chosen a mode (first load).
    const storedMode = localStorage.getItem(PLAYBACK_MODE_KEY);
    
    // If user has never set a mode preference, use intelligent defaults
    if (!storedMode) {
        const hasOverrides = 
            Object.keys(nodeExtraDelaySecByNode || {}).length > 0 || 
            Object.keys(nodeCaptions || {}).length > 0 ||
            (remoteMedia?.voiceByNode && Object.keys(remoteMedia.voiceByNode).length > 0);
            
        // Default to Editing Mode only if there are overrides (for voice alignment)
        window._isEditingMode = !!hasOverrides;
        console.log(`[PlaybackEngine] Legacy data first load. Auto-sensing: overrides=${hasOverrides}, defaulting to: ${window._isEditingMode ? 'Editing' : 'Normal'} Mode.`);
    } else {
        // Respect user's explicit preference
        window._isEditingMode = storedMode === 'editing';
        console.log(`[PlaybackEngine] Legacy data loaded. Preserving user's explicit mode preference: ${storedMode}.`);
    }
    
    persistPlaybackSettings();
    if (typeof window._updatePlaybackModeUI === 'function') window._updatePlaybackModeUI();
}

/**
 * Finds the first node with a URL, or defaults to 1, and sets lastSelectedNode.
 */
function findAndSetInitialNode() {
    for (let i = 1; i <= currentNodeCount; i++) {
        if (nodeUrls[i] && nodeUrls[i].trim() !== '') {
            lastSelectedNode = i;
            return;
        }
    }
    // Default to 1 only if currentNodeCount > 0, otherwise null
    lastSelectedNode = currentNodeCount > 0 ? 1 : null;
}


/**
 * Initializes or re-initializes the node graph display and the node selector dropdown.
 * @param {number} count - The number of nodes to display.
 */
function initNodes(count) {
    if (!nodeGraph || !nodeSelector) {
        console.error("Cannot init nodes: nodeGraph or nodeSelector element not found.");
        return;
    }

    const nodeFragment = document.createDocumentFragment();
    const optionFragment = document.createDocumentFragment();

    // Create nodes and selector options
    for (let i = 1; i <= count; i++) {
        // Create Node Element
        const node = document.createElement('div');
        node.className = 'node';
        node.setAttribute('data-node-id', i);
        node.addEventListener('click', () => handleNodeClick(i)); // Use specific handler
        nodeFragment.appendChild(node);

        // Ensure URL entry exists, default to empty string
        if (!Object.prototype.hasOwnProperty.call(nodeUrls, i)) {
            nodeUrls[i] = '';
        }

        // Create Selector Option
        const option = document.createElement('option');
        option.value = i;
        option.textContent = `Node ${i}`;
        optionFragment.appendChild(option);

    }

    nodeGraph.replaceChildren(nodeFragment);
    nodeSelector.replaceChildren(optionFragment);
    for (let i = 1; i <= count; i++) {
        updateNodeStatus(i);
    }

    // Update connection line position after nodes are rendered
    // Use requestAnimationFrame to ensure layout is calculated
    requestAnimationFrame(() => updateConnectionLine(count));
    rebuildSettingsNodePickers({ force: true });
    syncSettingsNodePicker(getSelectedNodeIdForSettings());
    renderNodePauseOverridesList(getSelectedNodeIdForSettings(), { force: true });
}

/**
 * Handles clicks on a node in the graph.
 * Opens the URL if set, otherwise opens the config modal.
 * @param {number} nodeId - The ID of the clicked node.
 */
async function handleNodeClick(nodeId) {
    lastSelectedNode = nodeId;
    // No need to saveNodeData() here, only on actual data change.

    updateRecentUrl(nodeId); // Update the display below address bar

    const url = nodeUrls[nodeId];
    if (url && url.trim() !== '') {
        // Resolve URL if needed (localfile: -> blob:)
        let target = url;
        try {
            if (isLocalFileUrl(url)) {
                target = await resolveLocalFileToObjectUrl(url);
                if (!target) {
                    alert('That local file is not available in this browser/device.');
                    return;
                }
            }
        } catch (_) { }

        // Manual Navigation intent: If playing, we PAUSE the sequence 
        // as requested so the user can read more carefully.
        if (typeof isPlayingInModule === 'function' && isPlayingInModule()) {
            if (typeof stopPlaySequence === 'function') {
                stopPlaySequence();
                console.log(`[Playback] Manual click on Node ${nodeId} - Pausing Automated sequence.`);
            }
        }

        // Update the embedded preview in parallel, but do not block the full desktop viewer/window.
        if (typeof loadUrlInViewer === 'function') {
            try { void loadUrlInViewer(url, nodeId); } catch (_) { }
        } else {
            console.warn("loadUrlInViewer function not available.");
        }

        // Open the full page immediately in the best available desktop target.
        try { await openUrlInBestTarget(target, { title: `Node ${nodeId}`, nodeId }); } catch (_) { }
    } else {
        openNodeConfig(nodeId); // Open modal to set URL
    }
}


/**
 * Updates the visual appearance of a node (filled if URL exists).
 * @param {number} nodeId - The ID of the node to update.
 */
function updateNodeStatus(nodeId) {
    // Ensure nodeGraph is available before querying
    if (!nodeGraph) return;
    const node = nodeGraph.querySelector(`.node[data-node-id="${nodeId}"]`);
    if (!node) return;

    const url = nodeUrls[nodeId];
    if (url && url.trim() !== '') {
        node.classList.add('connected');
        node.title = `Node ${nodeId}: ${displayTextForUrl(url)}`; // Add tooltip
    } else {
        node.classList.remove('connected');
        node.title = `Node ${nodeId}: No URL set`; // Add tooltip
    }
}

/**
 * Saves or updates the URL for a selected node from the modal.
 */
function saveUrl() {
    if (!requireSignedInForSharedRemix('save edits to this shared graph')) return;
    // Ensure modal elements are available
    if (!nodeSelector || !urlInput) return;

    const nodeId = nodeSelector.value;
    let url = urlInput.value.trim();

    if (!nodeId) {
        alert('Please select a node from the dropdown.');
        return;
    }

    const numericNodeId = parseInt(nodeId, 10);

    // Read caption fields from the modal.
    const titleVal = nodeTitleInput ? nodeTitleInput.value.trim() : '';
    const captionVal = nodeCaptionInput ? nodeCaptionInput.value.trim() : '';

    if (titleVal || captionVal) {
        nodeCaptions[numericNodeId] = { title: titleVal, caption: captionVal };
    } else {
        delete nodeCaptions[numericNodeId];
    }

    if (url) {
        // Basic URL validation and prefixing
        if (!/^https?:\/\//i.test(url) && !url.startsWith('localfile:') && !url.startsWith('blob:') && !url.startsWith('data:')) {
            url = 'https://' + url;
        }

        try {
            const parsed = new URL(url);
            if (!['http:', 'https:', 'localfile:', 'blob:', 'data:'].includes(parsed.protocol)) {
                throw new Error('Unsupported protocol');
            }
            
            const numericNodeId = parseInt(nodeId, 10);
            nodeUrls[numericNodeId] = url;
            
            // Save title/caption if provided
            if (titleVal || captionVal) {
                nodeCaptions[numericNodeId] = { title: titleVal, caption: captionVal };
            } else {
                delete nodeCaptions[numericNodeId];
            }

            updateNodeStatus(numericNodeId);
            updateNodeDisplay(); // Ensure Associations Table updates immediately
            updateRecentUrl(numericNodeId); // Update link display 
            lastSelectedNode = numericNodeId;
            saveNodeData();
            hideAllModals();
        } catch (e) {
            alert('Please enter a valid URL (e.g., https://google.com)');
            urlInput.focus();
            return;
        }
    } else {
        // If URL is empty, we treat it as clearing the node
        clearUrl();
    }
}

/**
 * Clears the URL for the currently selected node in the modal.
 */
function clearUrl() {
    if (!requireSignedInForSharedRemix('remove nodes from this shared graph')) return;
    if (!nodeSelector) return;
    const nodeId = nodeSelector.value;
    if (nodeId) {
        const numericNodeId = parseInt(nodeId, 10);
        clearUrlForNode(numericNodeId);
        hideAllModals();
    } else {
        alert('Please select a node from the dropdown first.');
    }
}

/**
 * Clears the URL associated with a specific node ID.
 * @param {number} nodeId - The ID of the node whose URL should be cleared.
 */
function clearUrlForNode(nodeId) {
    if (!requireSignedInForSharedRemix('edit nodes in this shared graph')) return;
    // Check if nodeId is valid and exists in nodeUrls
    if (nodeId >= 1 && nodeId <= currentNodeCount && Object.prototype.hasOwnProperty.call(nodeUrls, nodeId)) {
        const hadUrl = nodeUrls[nodeId] !== '';
        const hadCaption = Object.prototype.hasOwnProperty.call(nodeCaptions, nodeId);
        nodeUrls[nodeId] = ''; // Set to empty string instead of deleting key
        delete nodeCaptions[nodeId]; // Also clear any caption for this node
        if (hadUrl || hadCaption) {
            updateNodeStatus(nodeId);
            updateNodeDisplay();
            updateRecentUrl(nodeId); // Update display below address bar
            saveNodeData(); // Save state change
        }
    } else {
        console.warn(`Attempted to clear URL for invalid or non-existent node ID: ${nodeId}`);
    }
}


/**
 * Updates the list display showing node-URL associations.
 */
function updateNodeDisplay() {
    if (!nodeAssociationsDiv) return;
    rebuildSettingsNodePickers();
    const fragment = document.createDocumentFragment();

    for (let i = 1; i <= currentNodeCount; i++) {
        const div = document.createElement('div');
        div.className = 'node-info';

        const nodeLabel = document.createElement('span');
        nodeLabel.textContent = `Node ${i}: `;
        div.appendChild(nodeLabel);

        const url = nodeUrls[i];
        if (url && url.trim() !== '') {
            if (isLocalFileUrl(url)) {
                const meta = parseLocalFileUrl(url);
                const link = document.createElement('a');
                link.href = '#';
                link.textContent = meta && meta.name ? meta.name : 'Local file';
                link.title = displayTextForUrl(url);
                link.addEventListener('click', async (e) => {
                    e.preventDefault();
                    const resolved = await resolveLocalFileToObjectUrl(url);
                    if (!resolved) {
                        alert('That local file is not available in this browser/device.');
                        return;
                    }
                    await openUrlInBestTarget(resolved, { title: `Node ${i}`, nodeId: i });
                });
                div.appendChild(link);
            } else {
                const link = document.createElement('a');
                link.href = url;
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
                // Display a shortened version if too long
                link.textContent = url.length > 60 ? url.substring(0, 57) + '...' : url;
                link.title = url; // Show full URL on hover
                link.addEventListener('click', async (e) => {
                    if (!getDesktopBridge()) return;
                    e.preventDefault();
                    await openUrlInBestTarget(url, { title: `Node ${i}`, nodeId: i });
                });
                div.appendChild(link);
            }
        } else {
            const span = document.createElement('span');
            span.className = 'unconnected-text';
            span.textContent = 'No URL assigned';
            div.appendChild(span);
        }

        // Show caption/title if set.
        const cap = nodeCaptions[i];
        if (cap && ((cap.title && cap.title.trim()) || (cap.caption && cap.caption.trim()))) {
            const capDiv = document.createElement('div');
            capDiv.className = 'node-caption-hint';
            capDiv.style.cssText = 'font-size:11px; color:var(--muted, #888); margin-top:2px; font-style:italic;';
            const parts = [];
            if (cap.title && cap.title.trim()) parts.push(cap.title.trim());
            if (cap.caption && cap.caption.trim()) parts.push(cap.caption.trim());
            capDiv.textContent = parts.join(' — ');
            div.appendChild(capDiv);
        }

        // Add click listener to easily select/edit this node
        div.addEventListener('click', (e) => {
            // Prevent click on link from also triggering modal
            if (e.target.tagName !== 'A') {
                openNodeConfig(i); // Open config modal for this node
            }
            // Alternatively, handleNodeClick(i) could open the URL directly
        });

        fragment.appendChild(div);
    }
    nodeAssociationsDiv.replaceChildren(fragment);
}

/**
 * Updates the position and width of the visual connection line between nodes.
 * @param {number} nodeCount - The current number of nodes.
 */
function updateConnectionLine(nodeCount) {
    // Ensure nodeGraph is available
    if (!nodeGraph) return;

    nodeGraph.querySelectorAll('.connection-line').forEach(line => line.remove());
    const nodes = Array.from(nodeGraph.querySelectorAll('.node'));

    // Guard clause - return if required elements are missing or not enough nodes
    if (nodeCount < 2) {
        return;
    }

    // Ensure addressBar is available
    if (nodes.length < 2 || !addressBar) {
        console.warn("Cannot update connection line: Missing nodes or addressBar.");
        return;
    }

    const containerRect = nodeGraph.getBoundingClientRect();

    for (let i = 0; i < nodes.length - 1; i++) {
        const leftNode = nodes[i];
        const rightNode = nodes[i + 1];

        const leftRect = leftNode.getBoundingClientRect();
        const rightRect = rightNode.getBoundingClientRect();

        if (leftRect.width === 0 || rightRect.width === 0) {
            requestAnimationFrame(() => updateConnectionLine(nodeCount));
            return;
        }

        // Draw only the span between neighboring circles so the connector never runs through a node.
        const startX = leftRect.left - containerRect.left + leftNode.offsetWidth;
        const endX = rightRect.left - containerRect.left;
        const lineWidth = Math.max(0, endX - startX);

        if (lineWidth <= 0) continue;

        const segment = document.createElement('div');
        segment.className = 'connection-line';
        segment.style.left = `${startX}px`;
        segment.style.width = `${lineWidth}px`;
        nodeGraph.appendChild(segment);
    }
}


/**
 * Updates the total number of nodes based on user input.
 */
function updateNodeCount() {
    if (!requireSignedInForSharedRemix('change nodes in this shared graph')) return;
    if (!nodeCountInput) return;

    let newCount = parseInt(nodeCountInput.value, 10);

    // Validate input
    if (isNaN(newCount) || newCount < MIN_NODES) {
        newCount = MIN_NODES;
    } else if (newCount > MAX_NODES) {
        newCount = MAX_NODES;
    }
    nodeCountInput.value = newCount; // Correct input field if needed

    // No change? Exit early.
    if (newCount === currentNodeCount) {
        return;
    }

    // If reducing count, check for data loss
    const currentKeys = Object.keys(nodeUrls).map(Number).filter(id => id > 0 && nodeUrls[id] && nodeUrls[id].trim() !== '');
    const maxCurrentKey = currentKeys.length > 0 ? Math.max(...currentKeys) : 0;

    if (newCount < currentNodeCount && maxCurrentKey > newCount) {
        const shouldProceed = confirm(
            'Reducing the number of nodes will remove URLs assigned to nodes beyond the new count. Continue?'
        );
        if (!shouldProceed) {
            nodeCountInput.value = currentNodeCount; // Revert input field
            return; // Abort the change
        }

        // Remove URLs and captions for nodes that will be deleted
        let changed = false;
        for (let i = newCount + 1; i <= currentNodeCount; i++) {
            if (Object.prototype.hasOwnProperty.call(nodeUrls, i)) {
                delete nodeUrls[i]; // Remove the key entirely
                changed = true;
            }
            if (Object.prototype.hasOwnProperty.call(nodeCaptions, i)) {
                delete nodeCaptions[i];
                changed = true;
            }
        }
        // If data was removed, save changes immediately (though saveNodeData() at end covers it)
        // if (changed) saveNodeData();
    }

    const oldCount = currentNodeCount;
    currentNodeCount = newCount;

    // Update last selected node if it's now out of bounds
    if (lastSelectedNode !== null && lastSelectedNode > currentNodeCount) {
        // Try to select the new last node, or 1 if count is 1, or null if 0
        lastSelectedNode = currentNodeCount >= 1 ? currentNodeCount : null;
    } else if (lastSelectedNode === null && currentNodeCount >= 1) {
        lastSelectedNode = 1; // If no node was selected and we now have nodes, select 1
    }


    // Reinitialize nodes, update displays, and save
    initNodes(currentNodeCount);
    updateNodeDisplay();
    // updateConnectionLine is called by initNodes
    saveNodeData();
    // console.log(`Node count updated from ${oldCount} to ${currentNodeCount}`);
}


/**
 * Opens the URL configuration modal, pre-filled for a specific node.
 * @param {number} nodeId - The ID of the node to configure.
 */
function openNodeConfig(nodeId) {
    if (!requireSignedInForSharedRemix('edit nodes in this shared graph')) return;
    // Ensure modal elements are available
    if (!nodeSelector || !urlInput) return;

    // Check if nodeId is valid for the current count
    if (nodeId < 1 || nodeId > currentNodeCount) {
        console.warn(`Attempted to open config for invalid node ID: ${nodeId}`);
        return;
    }

    nodeSelector.value = nodeId; // Set dropdown
    urlInput.value = nodeUrls[nodeId] || ''; // Set URL input, default empty

    // Populate caption fields from stored data.
    const cap = nodeCaptions[nodeId];
    if (nodeTitleInput) nodeTitleInput.value = (cap && cap.title) ? cap.title : '';
    if (nodeCaptionInput) nodeCaptionInput.value = (cap && cap.caption) ? cap.caption : '';

    showModal('urlForm');
    urlInput.focus(); // Focus the input field
    // Select the text for easy replacement, maybe after a short delay
    setTimeout(() => {
        // Check if element still has focus before selecting
        if (document.activeElement === urlInput) {
            urlInput.select();
        }
    }, 50);
}

/**
 * Opens the URL configuration modal for manual entry.
 * Defaults to the last selected node or the first node.
 */
function openManualEntry() {
    if (!requireSignedInForSharedRemix('add URLs to this shared graph')) return;
    // Ensure modal elements are available
    if (!nodeSelector || !urlInput) return;

    // Determine default node ID, ensuring it's valid
    let defaultNode = 1; // Default to 1 if no nodes or lastSelected is invalid
    if (lastSelectedNode !== null && lastSelectedNode >= 1 && lastSelectedNode <= currentNodeCount) {
        defaultNode = lastSelectedNode;
    } else if (currentNodeCount < 1) {
        alert("Please add nodes first using the 'Set Node Count' control.");
        return;
    }

    nodeSelector.value = defaultNode;
    urlInput.value = nodeUrls[defaultNode] || ''; // Pre-fill if exists
    showModal('urlForm');
    urlInput.focus();
    // Select the text for easy replacement
    setTimeout(() => {
        if (document.activeElement === urlInput) {
            urlInput.select();
        }
    }, 50);
}


/**
 * Displays a modal by its ID and the backdrop.
 * @param {string} modalId - The ID of the modal element to show.
 */
function showModal(modalId) {
    const modal = document.getElementById(modalId);
    // Ensure modalBackdrop is available
    if (!modalBackdrop) {
        console.error("Modal backdrop element not found.");
        return;
    }

    if (modal) {
        modal.style.display = 'block';
        modalBackdrop.style.display = 'block';
        // Add class for potential transition effects after display is set
        requestAnimationFrame(() => {
            modal.classList.add('visible');
            modalBackdrop.classList.add('visible');
            syncModalBodyLock();
        });
    } else {
        console.error(`Modal element not found for ID: ${modalId}`);
    }
}

/**
 * Hides a specific modal by its ID.
 * @param {string} modalId - The ID of the modal element to hide.
 */
function hideModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
        // Remove classes first to trigger transition out
        modal.classList.remove('visible');
        if (modalBackdrop) modalBackdrop.classList.remove('visible');

        // Hide after transition (match CSS transition duration)
        setTimeout(() => {
            modal.style.display = 'none';
            // Hide backdrop only if no other modals are visible
            const otherModalsVisible = document.querySelector('.modal.visible');
            if (!otherModalsVisible && modalBackdrop) {
                modalBackdrop.style.display = 'none';
            }
            syncModalBodyLock();
        }, 300); // Adjust timing based on CSS transition duration (0.3s)
    }
}

/**
 * Hides all currently known modals and the backdrop.
 */
function hideAllModals() {
    // Find all visible modals and hide them
    document.querySelectorAll('.modal.visible').forEach(modal => {
        hideModal(modal.id);
    });
    // Ensure backdrop is hidden even if hideModal logic is interrupted
    if (modalBackdrop) {
        modalBackdrop.classList.remove('visible');
        setTimeout(() => {
            // Double check no modals became visible again during timeout
            const anyModalVisible = document.querySelector('.modal.visible');
            if (!anyModalVisible) {
                modalBackdrop.style.display = 'none';
            }
            syncModalBodyLock();
        }, 300);
    }
}

/**
 * Updates the text display below the address bar showing the current/last selected node's URL.
 * @param {number|null} nodeId - The ID of the node to display, or null to clear.
 * @param {boolean} [isPlayingHighlight=false] - If true, also call highlightPlayingNode.
 */
function updateRecentUrl(nodeId, isPlayingHighlight = false) {
    if (!recentUrlDiv) return;

    let text = 'No node selected';
    let title = '';
    let clickHandler = null;
    let cursor = 'default';

    if (nodeId !== null && nodeId >= 1 && nodeId <= currentNodeCount) {
        const url = getDisplayUrlForNode(nodeId);
        if (url && url.trim() !== '') {
            text = `Node ${nodeId}: ${displayTextForUrl(url)}`;
            title = displayTextForUrl(url); // Full text on hover
            cursor = 'pointer';
            clickHandler = async () => {
                const target = isLocalFileUrl(url) ? await resolveLocalFileToObjectUrl(url) : url;
                if (!target) {
                    alert('That local file is not available in this browser/device.');
                    return;
                }
                await openUrlInBestTarget(target, { title: `Node ${nodeId}`, nodeId });
            };
        } else {
            text = `Node ${nodeId}: No URL assigned`;
        }
    }

    recentUrlDiv.textContent = text;
    recentUrlDiv.title = title;
    recentUrlDiv.style.cursor = cursor;
    // Remove previous listener before adding new one
    recentUrlDiv.onclick = clickHandler;


    if (isPlayingHighlight) {
        // Ensure highlightPlayingNode function exists from play.js
        if (typeof highlightPlayingNode === 'function') {
            highlightPlayingNode(nodeId); // Update visual indicator in the graph
        } else {
            console.warn("highlightPlayingNode function not available.");
        }
    }

    // Keep settings UI in sync with the selected node.
    try { if (typeof updateVoiceSettingsForSelectedNode === 'function') updateVoiceSettingsForSelectedNode(nodeId); } catch (_) { }
}

/**
 * Clears all URL associations from the nodes.
 */
function clearNodeConnectionsInternal({ resetGraph = false } = {}) {
    for (const key of Object.keys(nodeUrls)) delete nodeUrls[key];
    for (const key of Object.keys(nodeCaptions)) delete nodeCaptions[key];
    nodeExtraDelaySecByNode = {};

    if (resetGraph) {
        remoteMedia = { background: null, voiceByNode: {}, filesByNode: {} };
        currentNodeCount = DEFAULT_CLEAR_NODE_COUNT;
        lastSelectedNode = currentNodeCount >= 1 ? 1 : null;
        activeShareCode = null;
        loadedFromSharedGraph = false;
        currentShareAnalyticsContext = null;
        currentSavedShareCode = null;
        currentSavedShareUrl = null;
        graphId = null;
        desktopViewerState = { nodeId: null, url: '', title: '' };
        clearExplicitSaveBaseline();
        setGraphTopicFromExternal('', null);
        updateUpdateSavedButton();

        const scopedGraphIdKey = getScopedKey('graphId');
        const scopedSnapshotKey = getScopedKey('graph_snapshot');
        try { localStorage.removeItem(scopedGraphIdKey); } catch (_) { }
        try { localStorage.removeItem(scopedSnapshotKey); } catch (_) { }
        clearPendingGraphSync(currentUser);
    }

    for (let i = 1; i <= currentNodeCount; i++) {
        nodeUrls[i] = '';
    }

    if (nodeCountInput) nodeCountInput.value = String(currentNodeCount);
    initNodes(currentNodeCount);
    updateNodeDisplay();
    updateRecentUrl(lastSelectedNode);

    if (resetGraph) {
        if (typeof highlightPlayingNode === 'function') highlightPlayingNode(null);
        if (typeof loadUrlInViewer === 'function') {
            try { void loadUrlInViewer('', null); } catch (_) { }
        }
        console.log('Nodegraph reset to a fresh default state.');
    }

    saveNodeData();
}

async function clearNodeConnections() {
    if (!requireSignedInForSharedRemix('clear or remix this shared graph')) return;
    flushPendingGraphTopicInput();

    const hasContent = hasMeaningfulGraphContent();
    const hasUnsavedChanges = hasUnsavedChangesSinceExplicitSave();

    if (hasContent && hasUnsavedChanges) {
        const saveBeforeClear = confirm('This nodegraph has unsaved changes. Press OK to save it before clearing, or Cancel if you want to decide whether to discard it.');
        if (saveBeforeClear) {
            try {
                const saved = await persistCurrentGraphAsSaved({ preferUpdate: true, fallbackTopic: buildUntitledTopicLabel() });
                if (!saved || !saved.ok) {
                    alert('Unable to save this nodegraph before clearing. The graph was left unchanged.');
                    return;
                }
            } catch (error) {
                console.warn('Failed to save before clearing.', error);
                alert('Unable to save this nodegraph before clearing. The graph was left unchanged.');
                return;
            }
        } else {
            const discard = confirm('Clear without saving? This will reset the topic, nodes, preview pane, and node associations back to a fresh 8-node graph.');
            if (!discard) return;
        }
    } else if (hasContent) {
        const message = currentSavedShareCode
            ? 'Clear this editor and start from a fresh 8-node graph? Your saved copy will stay available in Saved Links.'
            : 'Clear this editor and start from a fresh 8-node graph?';
        if (!confirm(message)) return;
    }

    clearNodeConnectionsInternal({ resetGraph: true });
}

function detectBrowserFamily() {
    const ua = String(navigator.userAgent || '');
    if (/Edg\//i.test(ua)) return 'edge';
    if (/Firefox\//i.test(ua)) return 'firefox';
    if (/Chrome\//i.test(ua) || /Chromium\//i.test(ua)) return 'chrome';
    return 'unknown';
}

function getBrowserBridgeApi() {
    if (typeof browser !== 'undefined' && browser && browser.runtime) return browser;
    if (typeof chrome !== 'undefined' && chrome && chrome.runtime) return chrome;
    return null;
}

function isExtensionPageContext() {
    return /^(chrome|moz|ms-browser)-extension:/.test(String(window.location.protocol || ''));
}

function getBrowserImportActionButton(source) {
    if (source === 'tabs') return importTabsBtn;
    if (source === 'bookmarks') return importBookmarksBtn;
    if (source === 'history') return importHistoryBtn;
    return null;
}

function setBrowserImportFeedback(message, tone = 'info') {
    if (!browserImportFeedbackEl) return;
    browserImportFeedbackEl.textContent = message || 'Choose a source to replace the first matching nodes in this graph.';
    browserImportFeedbackEl.className = `browser-import-feedback browser-import-feedback--${tone}`;
}

function describeBrowserBridgeError(rawMessage) {
    const message = String(rawMessage || '').toLowerCase();
    if (!message) return 'Install the Cynode browser extension, then click Detect Extension again.';
    if (message.includes('bridge_timeout')) return 'The page could not reach the extension in time. Reload the page or the extension, then detect again.';
    if (message.includes('runtime_unavailable')) return 'The browser runtime is unavailable in this tab. Open Cynode in a normal browser tab and try again.';
    if (message.includes('receiving end does not exist') || message.includes('could not establish connection')) {
        return 'The extension is not connected to this page yet. Reload the page after installing or enabling the extension.';
    }
    if (message.includes('unsupported_action')) return 'This extension build does not support that import source yet.';
    return `Extension status: ${rawMessage}`;
}

function updateBrowserImportLimitHint() {
    if (!browserImportHintEl) return;

    const totalNodes = currentNodeCount > 0 ? currentNodeCount : MAX_NODES;
    const rawLimit = parseInt(itemLimitInput?.value, 10);
    const requestedLimit = Number.isFinite(rawLimit) ? rawLimit : Math.min(totalNodes, 8);
    const appliedLimit = Math.max(1, Math.min(MAX_NODES, totalNodes, requestedLimit));

    browserImportHintEl.textContent = `Current graph has ${totalNodes} node${totalNodes === 1 ? '' : 's'}. Cynode will replace up to ${appliedLimit} node${appliedLimit === 1 ? '' : 's'} during import.`;
}

function updateBrowserInstallCards() {
    const detected = browserBridgeState.browser || detectBrowserFamily();
    Object.keys(BROWSER_INSTALL_GUIDES).forEach((browserName) => {
        const elementId = `browserInstall${browserName.charAt(0).toUpperCase()}${browserName.slice(1)}`;
        const el = document.getElementById(elementId);
        if (!el) return;
        const isRecommended = detected === browserName;
        const isDetected = browserBridgeState.available && browserBridgeState.browser === browserName;
        el.classList.toggle('is-recommended', isRecommended);
        el.classList.toggle('is-detected', isDetected);

        const actionEl = el.querySelector('.browser-install-action');
        if (!actionEl) return;
        actionEl.textContent = isDetected ? 'Ready' : isRecommended ? 'Recommended' : 'Install';
    });
}

function setBrowserBridgeState(nextState) {
    browserBridgeState = {
        ...browserBridgeState,
        available: typeof nextState?.available === 'boolean' ? nextState.available : browserBridgeState.available,
        browser: Object.prototype.hasOwnProperty.call(nextState || {}, 'browser') ? (nextState?.browser || null) : browserBridgeState.browser,
        capabilities: Array.isArray(nextState?.capabilities) ? nextState.capabilities : browserBridgeState.capabilities,
        via: Object.prototype.hasOwnProperty.call(nextState || {}, 'via') ? (nextState?.via || null) : browserBridgeState.via,
        lastError: Object.prototype.hasOwnProperty.call(nextState || {}, 'lastError') ? (nextState?.lastError || '') : browserBridgeState.lastError,
        detectInFlight: typeof nextState?.detectInFlight === 'boolean' ? nextState.detectInFlight : browserBridgeState.detectInFlight,
        importInFlight: Object.prototype.hasOwnProperty.call(nextState || {}, 'importInFlight') ? (nextState?.importInFlight || null) : browserBridgeState.importInFlight,
    };
    updateBrowserImportUi();
}

function updateBrowserImportUi() {
    if (!browserBridgeStatusEl) return;

    const preferredBrowser = detectBrowserFamily();
    const activeBrowser = browserBridgeState.browser || preferredBrowser;
    const capabilities = browserBridgeState.capabilities.length > 0
        ? browserBridgeState.capabilities.join(', ')
        : 'tabs, bookmarks, history';
    const busySource = browserBridgeState.importInFlight;
    const isBusy = browserBridgeState.detectInFlight || !!busySource;
    const detectedVia = browserBridgeState.via || (isExtensionPageContext() ? 'runtime' : 'content-script');
    let summaryTone = 'browser-bridge-summary--warning';
    let badgeText = 'Not Ready';
    let statusText = '';
    let metaText = '';

    updateBrowserImportLimitHint();

    if (browserBridgeState.detectInFlight) {
        summaryTone = 'browser-bridge-summary--busy';
        badgeText = 'Checking';
        statusText = `Checking for the Cynode bridge in ${activeBrowser !== 'unknown' ? activeBrowser : 'this browser'}...`;
        metaText = 'Keep this modal open while Cynode verifies the extension connection.';
    } else if (busySource) {
        summaryTone = 'browser-bridge-summary--busy';
        badgeText = 'Importing';
        statusText = `Importing ${BROWSER_IMPORT_ACTION_LABELS[busySource] || busySource} from the detected ${activeBrowser} bridge...`;
        metaText = 'Cynode will update the first matching nodes as soon as the extension responds.';
    } else if (browserBridgeState.available) {
        summaryTone = 'browser-bridge-summary--ready';
        badgeText = 'Ready';
        statusText = `Detected the ${activeBrowser} Cynode bridge. Imports available: ${capabilities}.`;
        metaText = `Connected via ${detectedVia}. Choose a source below to replace the first matching nodes in this graph.`;
    } else if (preferredBrowser !== 'unknown') {
        statusText = `No Cynode bridge detected for ${preferredBrowser}. Install the recommended extension below, then click Detect Extension.`;
        metaText = describeBrowserBridgeError(browserBridgeState.lastError);
    } else {
        statusText = 'No Cynode bridge detected. Install the extension for your browser below, then click Detect Extension.';
        metaText = describeBrowserBridgeError(browserBridgeState.lastError);
    }

    browserBridgeStatusEl.textContent = statusText;
    if (browserBridgeMetaEl) browserBridgeMetaEl.textContent = metaText;
    if (browserBridgeBadgeEl) browserBridgeBadgeEl.textContent = badgeText;
    if (browserBridgeSummaryEl) {
        browserBridgeSummaryEl.classList.remove('browser-bridge-summary--ready', 'browser-bridge-summary--warning', 'browser-bridge-summary--busy');
        browserBridgeSummaryEl.classList.add(summaryTone);
    }

    updateBrowserInstallCards();

    ['tabs', 'bookmarks', 'history'].forEach((source) => {
        const button = getBrowserImportActionButton(source);
        if (!button) return;
        const isActive = busySource === source;
        button.disabled = !browserBridgeState.available || isBusy;
        button.textContent = isActive ? `Importing ${BROWSER_IMPORT_ACTION_LABELS[source]}...` : BROWSER_IMPORT_BUTTON_LABELS[source];
        button.title = !browserBridgeState.available
            ? 'Install or detect the browser extension before importing.'
            : isBusy
                ? 'Wait for the current browser action to finish.'
                : `Import ${BROWSER_IMPORT_ACTION_LABELS[source]} into this graph.`;
    });

    if (browserBridgeRefreshBtn) {
        browserBridgeRefreshBtn.disabled = isBusy;
        browserBridgeRefreshBtn.textContent = browserBridgeState.detectInFlight ? 'Detecting...' : busySource ? 'Working...' : 'Detect Extension';
        browserBridgeRefreshBtn.title = isBusy ? 'Wait for the current browser action to finish.' : 'Check whether the Cynode browser extension is available in this tab.';
    }
}

function handleBrowserBridgeAvailabilityMessage(event) {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.type !== EXTENSION_BRIDGE_AVAILABLE_TYPE) return;
    setBrowserBridgeState({
        available: true,
        browser: data.bridge?.browser || detectBrowserFamily(),
        capabilities: data.bridge?.capabilities || ['tabs', 'bookmarks', 'history'],
        via: data.bridge?.via || 'content-script',
        lastError: '',
    });
}

async function sendRuntimeBridgeRequest(action, payload) {
    const api = getBrowserBridgeApi();
    if (!api || !api.runtime || typeof api.runtime.sendMessage !== 'function') {
        throw new Error('runtime_unavailable');
    }

    return await new Promise((resolve, reject) => {
        let settled = false;
        const timeout = window.setTimeout(() => {
            if (settled) return;
            settled = true;
            reject(new Error('bridge_timeout'));
        }, EXTENSION_BRIDGE_TIMEOUT_MS);

        try {
            const maybePromise = api.runtime.sendMessage({
                type: EXTENSION_BRIDGE_MESSAGE_TYPE,
                action,
                payload,
            }, (response) => {
                if (settled) return;
                settled = true;
                window.clearTimeout(timeout);
                const lastError = api.runtime && api.runtime.lastError ? api.runtime.lastError : null;
                if (lastError) {
                    reject(new Error(lastError.message || String(lastError)));
                    return;
                }
                resolve(response || null);
            });

            if (maybePromise && typeof maybePromise.then === 'function') {
                maybePromise.then((response) => {
                    if (settled) return;
                    settled = true;
                    window.clearTimeout(timeout);
                    resolve(response || null);
                }).catch((error) => {
                    if (settled) return;
                    settled = true;
                    window.clearTimeout(timeout);
                    reject(error);
                });
            }
        } catch (error) {
            if (settled) return;
            settled = true;
            window.clearTimeout(timeout);
            reject(error);
        }
    });
}

async function sendPageBridgeRequest(action, payload) {
    return await new Promise((resolve, reject) => {
        const requestId = `bridge-${Date.now()}-${++browserBridgeRequestId}`;
        const timeout = window.setTimeout(() => {
            window.removeEventListener('message', handleResponse);
            reject(new Error('bridge_timeout'));
        }, EXTENSION_BRIDGE_TIMEOUT_MS);

        const handleResponse = (event) => {
            if (event.source !== window) return;
            const data = event.data;
            if (!data || data.type !== EXTENSION_BRIDGE_RESPONSE_TYPE || data.requestId !== requestId) return;
            window.clearTimeout(timeout);
            window.removeEventListener('message', handleResponse);
            resolve(data);
        };

        window.addEventListener('message', handleResponse);
        window.postMessage({
            source: EXTENSION_BRIDGE_SOURCE,
            type: EXTENSION_BRIDGE_MESSAGE_TYPE,
            requestId,
            action,
            payload,
        }, '*');
    });
}

async function requestBrowserBridge(action, payload = {}) {
    try {
        if (typeof window !== 'undefined' && window.cynodeDesktop && window.cynodeDesktop.isElectron) {
            throw new Error('Running in Desktop application. Browser extensions are only available in regular web browsers.');
        }

        const isPWA = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches;
        if (isPWA && !isExtensionPageContext()) {
            console.warn('PWA Mode: Extensions may not communicate properly in standalone PWAs on all browsers.');
        }

        const response = isExtensionPageContext()
            ? await sendRuntimeBridgeRequest(action, payload)
            : await sendPageBridgeRequest(action, payload);

        if (!response || response.ok !== true) {
            const errorMessage = response && response.error ? String(response.error) : 'bridge_unavailable';
            throw new Error(errorMessage);
        }

    setBrowserBridgeState({
        available: true,
        browser: response.bridge?.browser || detectBrowserFamily(),
        capabilities: response.bridge?.capabilities || ['tabs', 'bookmarks', 'history'],
        via: response.bridge?.via || (isExtensionPageContext() ? 'runtime' : 'content-script'),
        lastError: '',
    });
    return response;
    } catch (e) {
        console.warn('Browser Bridge safely aborted:', e);
        throw e;
    }
}

async function refreshBrowserBridgeStatus({ silent = false } = {}) {
    setBrowserBridgeState({
        detectInFlight: true,
        lastError: '',
    });
    if (!silent) {
        setBrowserImportFeedback('Checking for the Cynode bridge in this tab...', 'info');
    }

    try {
        await requestBrowserBridge('ping', {});
        if (!silent) {
            setBrowserImportFeedback('Extension detected. Choose what you want to import into this graph.', 'success');
        }
    } catch (error) {
        setBrowserBridgeState({
            available: false,
            browser: detectBrowserFamily(),
            capabilities: [],
            via: null,
            lastError: error && error.message ? String(error.message) : 'bridge_unavailable',
        });
        setBrowserImportFeedback(describeBrowserBridgeError(error && error.message ? String(error.message) : 'bridge_unavailable'), silent ? 'info' : 'warning');
    } finally {
        setBrowserBridgeState({ detectInFlight: false });
    }
}

function buildImportedCaption(source, url, item) {
    const hostname = (() => {
        try { return new URL(url).hostname || url; } catch (_) { return url; }
    })();
    const prefix = source === 'tabs'
        ? 'Imported from browser tab'
        : source === 'bookmarks'
            ? 'Imported from bookmark'
            : 'Imported from browser history';
    if (item && item.subtitle) return `${prefix}: ${item.subtitle}`;
    return `${prefix}: ${hostname}`;
}

function applyImportedItems(items, source) {
    let firstNodeId = null;
    clearNodeConnectionsInternal();

    items.forEach((item, index) => {
        const nodeId = index + 1;
        if (!item || !item.url || nodeId > currentNodeCount) return;
        nodeUrls[nodeId] = item.url;
        nodeCaptions[nodeId] = {
            title: item.title || `Node ${nodeId}`,
            caption: buildImportedCaption(source, item.url, item),
        };
        updateNodeStatus(nodeId);
        if (firstNodeId === null) firstNodeId = nodeId;
    });

    updateNodeDisplay();
    if (firstNodeId !== null) {
        updateRecentUrl(firstNodeId);
        lastSelectedNode = firstNodeId;
    } else {
        updateRecentUrl(null);
    }
    saveNodeData();
    hideAllModals();
}

async function importFromBrowserSource(source) {
    const actionLabel = BROWSER_IMPORT_ACTION_LABELS[source] || source;
    if (!requireSignedInForSharedRemix(`import ${actionLabel} into this shared graph`)) return;

    const limit = getItemLimit();
    if (limit === 0) {
        setBrowserImportFeedback('Cannot import 0 items. Increase the item count or add nodes to this graph first.', 'warning');
        return;
    }

    try {
        setBrowserBridgeState({
            importInFlight: source,
            lastError: '',
        });
        setBrowserImportFeedback(`Fetching ${actionLabel} from the extension...`, 'info');
        const response = await requestBrowserBridge(source, { limit });
        const items = Array.isArray(response.items) ? response.items.slice(0, limit) : [];
        if (items.length < 1) {
            setBrowserImportFeedback(`No ${actionLabel} were returned by the extension. Try a different source or lower the item count.`, 'warning');
            return;
        }

        if (!confirm(`This will replace existing URLs for the first ${items.length} nodes with ${actionLabel}. Continue?`)) {
            setBrowserImportFeedback('Import canceled. Existing node URLs were kept unchanged.', 'info');
            return;
        }

        setBrowserImportFeedback(`Imported ${items.length} ${actionLabel} into the graph.`, 'success');
        applyImportedItems(items, source);
    } catch (error) {
        console.error(`Error importing ${source}:`, error);
        setBrowserBridgeState({
            available: false,
            browser: detectBrowserFamily(),
            capabilities: [],
            via: null,
            lastError: error && error.message ? String(error.message) : 'bridge_unavailable',
        });
        setBrowserImportFeedback(`Unable to import ${actionLabel}. ${describeBrowserBridgeError(error && error.message ? String(error.message) : 'bridge_unavailable')}`, 'error');
    } finally {
        setBrowserBridgeState({ importInFlight: null });
    }
}


/**
 * Opens the modal for importing URLs from browser sources.
 */
function openBrowserSourcesModal() {
    if (!requireSignedInForSharedRemix('import into this shared graph')) return;
    // Ensure modal elements are available
    if (!itemLimitInput) return;

    // Reset item limit input to a reasonable default or the current node count
    itemLimitInput.value = Math.min(currentNodeCount > 0 ? currentNodeCount : 8, 8); // Default 8, max current count
    updateBrowserImportLimitHint();
    setBrowserImportFeedback('Choose a source to replace the first matching nodes in this graph.', 'info');
    showModal('browserSourceModal');
    updateBrowserImportUi();
    void refreshBrowserBridgeStatus({ silent: true });
}

/**
 * Gets the number of items to import from the input field.
 * Ensures the value is within valid bounds [1, MAX_NODES].
 * @returns {number} The validated limit.
 */
function getItemLimit() {
    if (!itemLimitInput) return 1; // Fallback if input not found

    let limit = parseInt(itemLimitInput.value, 10);
    if (isNaN(limit) || limit < 1) {
        limit = 1;
    } else if (limit > MAX_NODES) { // Limit import to max nodes allowed
        limit = MAX_NODES;
    }
    // Also ensure limit doesn't exceed current node count
    limit = Math.min(limit, currentNodeCount > 0 ? currentNodeCount : MAX_NODES);

    itemLimitInput.value = limit; // Update input field with validated value
    return limit;
}

/**
 * Loads URLs from currently open tabs into the nodes.
 */
async function loadFromOpenTabs() {
    await importFromBrowserSource('tabs');
}

/**
 * Loads URLs from recent bookmarks into the nodes.
 */
async function loadFromBookmarks() {
    await importFromBrowserSource('bookmarks');
}

async function loadFromHistory() {
    await importFromBrowserSource('history');
}

/**
 * Adds a new node when the address bar background is double-clicked.
 * @param {MouseEvent} event - The double-click event.
 */
function addNodeOnDoubleClick(event) {
    if (!requireSignedInForSharedRemix('add nodes to this shared graph')) return;
    // Ensure addressBar is available
    if (!addressBar || !nodeGraph) return;

    // Ensure the double-click is directly on the address bar background or node graph background
    // not on a node, icon, or the connection line itself.
    if (event.target !== addressBar && event.target !== nodeGraph) {
        return;
    }

    if (currentNodeCount >= MAX_NODES) {
        alert(`Maximum number of nodes (${MAX_NODES}) reached.`);
        return;
    }

    currentNodeCount++;
    if (nodeCountInput) nodeCountInput.value = currentNodeCount; // Update input field

    // Add placeholder for the new node's URL
    if (!Object.prototype.hasOwnProperty.call(nodeUrls, currentNodeCount)) {
        nodeUrls[currentNodeCount] = '';
    }

    // Reinitialize nodes and update displays
    initNodes(currentNodeCount);
    updateNodeDisplay();
    // updateConnectionLine(currentNodeCount); // Called by initNodes
    saveNodeData(); // Save the new count and potentially new empty URL slot

    console.log(`Node added via double-click. Count: ${currentNodeCount}`);

    // Optionally, open config for the new node immediately
    // openNodeConfig(currentNodeCount);

    // Optionally, make the new node the last selected
    lastSelectedNode = currentNodeCount;
    updateRecentUrl(lastSelectedNode);
}


// --- Global Access (Needed by play.js) ---
// Instead of window.highlightPlayingNode, play.js gets a callback.
// Keep hasValidUrls accessible if needed, or pass as callback.

/**
 * Checks if there are any valid URLs assigned to nodes.
 * @returns {boolean} True if at least one node has a non-empty URL, false otherwise.
 */
function hasValidUrls() {
    return Object.values(nodeUrls).some(url => url && url.trim() !== '');
}

function startActiveGraphPlayback() {
    const playBtn = document.getElementById('playPauseBtn');
    if (!playBtn || !hasValidUrls()) return false;
    if (typeof startPlaybackInModule === 'function') {
        startPlaybackInModule();
        return true;
    }
    playBtn.click();
    return true;
}

async function restoreLastActiveGraphForSignedInUser() {
    if (!currentUser || !pendingLastActiveGraphRestore) return false;
    if (activeShareCode) return false;

    const restoreTarget = pendingLastActiveGraphRestore;
    pendingLastActiveGraphRestore = null;

    try {
        await loadSavedOrSharedGraphIntoEditor(restoreTarget.code, {
            origin: restoreTarget.origin === 'share' ? 'share' : 'saved',
            enableShareAnalytics: false,
            editableAsShared: false,
            shareUrl: restoreTarget.shareUrl || null,
        });

        if (hasValidUrls()) {
            startActiveGraphPlayback();
        }
        return true;
    } catch (error) {
        console.warn('Unable to restore last active nodegraph for the signed-in user.', error);
        clearLastActiveGraphIfMatches(restoreTarget.code);
        return false;
    }
}

function createSavedGraphUrl(code) {
    const normalizedCode = encodeURIComponent(String(code || '').trim());
    if (!normalizedCode) return window.location.origin;
    const namespace = currentUser && currentUser.handle ? encodeURIComponent(String(currentUser.handle)) : '';
    return namespace
        ? `${window.location.origin}/${namespace}/${normalizedCode}`
        : `${window.location.origin}/s/${normalizedCode}`;
}

function getSelectedQrDownloadSource(container) {
    if (!container) return null;
    const canvas = container.querySelector('canvas');
    if (canvas && typeof canvas.toDataURL === 'function') {
        try { return canvas.toDataURL('image/png'); } catch (_) { }
    }
    const img = container.querySelector('img');
    if (img && img.src) return img.src;
    return null;
}

function renderLocalQrCode(targetUrl) {
    if (!qrDisplayArea) return;
    qrDisplayArea.innerHTML = '';

    if (typeof QRCode === 'undefined') {
        qrDisplayArea.innerHTML = '<div class="auth-error">QR generator unavailable. Reload the page and try again.</div>';
        return;
    }

    const qrMount = document.createElement('div');
    qrMount.className = 'qr-image';
    qrMount.style.display = 'flex';
    qrMount.style.alignItems = 'center';
    qrMount.style.justifyContent = 'center';
    qrDisplayArea.appendChild(qrMount);

    const qr = new QRCode(qrMount, {
        text: targetUrl,
        width: 220,
        height: 220,
        colorDark: '#0f172a',
        colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.M,
    });

    const hint = document.createElement('div');
    hint.className = 'settings-hint';
    hint.style.textAlign = 'center';
    hint.textContent = 'Compact QR generated locally inside Cynode.';
    qrDisplayArea.appendChild(hint);

    const actionContainer = document.createElement('div');
    actionContainer.style.display = 'flex';
    actionContainer.style.gap = '10px';
    actionContainer.style.alignItems = 'center';

    const dl = document.createElement('a');
    dl.className = 'qr-download-link';
    dl.download = `cynode-multi-qr-${Date.now()}.png`;
    dl.innerHTML = '<i class="fas fa-download"></i> Download QR Image';
    actionContainer.appendChild(dl);

    const open = document.createElement('a');
    open.className = 'qr-download-link';
    open.href = targetUrl;
    open.target = '_blank';
    open.rel = 'noopener noreferrer';
    open.textContent = 'Open Nodegraph Link';
    actionContainer.appendChild(open);

    qrDisplayArea.appendChild(actionContainer);

    window.setTimeout(() => {
        const downloadSource = getSelectedQrDownloadSource(qrMount);
        if (downloadSource) {
            dl.href = downloadSource;
        } else {
            dl.removeAttribute('href');
            dl.title = 'Unable to prepare QR image download.';
        }
    }, 0);
}


// --- Initialization ---
document.addEventListener('DOMContentLoaded', async () => {
    setupThemeToggle();
    setupDeviceMode();
    registerServiceWorker();
    setupSidepanel();
    setupVoiceSettings();

    try {
        const t = localStorage.getItem(GRAPH_TOPIC_KEY);
        if (t) graphTopic = t;
        const o = localStorage.getItem(GRAPH_TOPIC_ORIGIN_KEY);
        if (o) graphTopicOrigin = o;
    } catch (_) { }
    setGraphTopicFromExternal(graphTopic, graphTopicOrigin);

    // Cache DOM elements
    nodeGraph = document.getElementById('nodeGraph');
    nodeSelector = document.getElementById('nodeSelector');
    urlInput = document.getElementById('urlInput');
    nodeCountInput = document.getElementById('nodeCount');
    recentUrlDiv = document.getElementById('recentUrl');
    nodeAssociationsDiv = document.getElementById('nodeAssociations');
    urlFormModal = document.getElementById('urlForm');
    browserSourceModal = document.getElementById('browserSourceModal');
    modalBackdrop = document.getElementById('modalBackdrop');
    addressBar = document.getElementById('addressBar');
    // pageViewer is handled by play.js
    itemLimitInput = document.getElementById('itemLimit');
    nodeTitleInput = document.getElementById('nodeTitleInput');
    nodeCaptionInput = document.getElementById('nodeCaptionInput');
    browserBridgeSummaryEl = document.getElementById('browserBridgeSummary');
    browserBridgeBadgeEl = document.getElementById('browserBridgeBadge');
    browserBridgeStatusEl = document.getElementById('browserBridgeStatus');
    browserBridgeMetaEl = document.getElementById('browserBridgeMeta');
    browserBridgeRefreshBtn = document.getElementById('browserBridgeRefreshBtn');
    browserImportHintEl = document.getElementById('browserImportHint');
    browserImportFeedbackEl = document.getElementById('browserImportFeedback');
    importTabsBtn = document.getElementById('importTabsBtn');
    importBookmarksBtn = document.getElementById('importBookmarksBtn');
    importHistoryBtn = document.getElementById('importHistoryBtn');
    splitContentEl = document.getElementById('splitContent');
    previewPaneToggleBtn = document.getElementById('previewPaneToggle');
    nodeAssociationsToggleBtn = document.getElementById('nodeAssociationsToggle');

    const authStatus = document.getElementById('authStatus');
    const signInBtn = document.getElementById('signInBtn');
    const signOutBtn = document.getElementById('signOutBtn');
    const authForm = document.getElementById('authForm');
    const authTabLogin = document.getElementById('authTabLogin');
    const authTabRegister = document.getElementById('authTabRegister');
    const authLoginFields = document.getElementById('authLoginFields');
    const authRegisterFields = document.getElementById('authRegisterFields');
    const authError = document.getElementById('authError');
    const authIdentifier = document.getElementById('authIdentifier');
    const authPassword = document.getElementById('authPassword');
    const authLoginBtn = document.getElementById('authLoginBtn');
    const authHandle = document.getElementById('authHandle');
    const authEmail = document.getElementById('authEmail');
    const authNewPassword = document.getElementById('authNewPassword');
    const authRegisterBtn = document.getElementById('authRegisterBtn');
    authFormEl = authForm;
    signInBtnEl = signInBtn;

    const savedLinks = document.getElementById('savedLinks');
    const saveAsSelect = document.getElementById('saveAsSelect');
    updateSavedBtn = document.getElementById('updateSavedBtn');
    const tierOverview = document.getElementById('tierOverview');
    updateUpdateSavedButton();

    const billingSection = document.getElementById('billingSection');
    const billingOrgSelect = document.getElementById('billingOrgSelect');
    const billingStatus = document.getElementById('billingStatus');
    const billingPlans = document.getElementById('billingPlans');
    const billingManageBtn = document.getElementById('billingManageBtn');
    const billingError = document.getElementById('billingError');

    const dashboardSection = document.getElementById('dashboardSection');
    const dashboardScopeSelect = document.getElementById('dashboardScopeSelect');
    const dashboardList = document.getElementById('dashboardList');
    const dashboardDetail = document.getElementById('dashboardDetail');
    const topicInput = document.getElementById('topicInput');
    topicInput?.addEventListener('input', () => scheduleGraphTopicInput(topicInput.value));
    topicInput?.addEventListener('change', () => setGraphTopicFromInput(topicInput.value));

    // Perform checks *after* trying to get elements
    const requiredElements = {
        nodeGraph, nodeSelector, urlInput, nodeCountInput, recentUrlDiv,
        nodeAssociationsDiv, urlFormModal, browserSourceModal, modalBackdrop,
        addressBar, itemLimitInput
    };
    let missingElement = false;
    for (const key in requiredElements) {
        if (!requiredElements[key]) {
            console.error(`Initialization failed: Essential DOM element #${key} not found.`);
            missingElement = true;
        }
    }
    if (missingElement) {
        document.body.innerHTML = '<p style="color: red; padding: 20px;">Error: Core UI elements failed to load. Please check the HTML structure and element IDs, then reload the extension.</p>';
        return; // Stop execution if essential elements are missing
    }

    const desktopBridge = getDesktopBridge();
    if (desktopBridge && typeof desktopBridge.onViewerNavigation === 'function') {
        desktopBridge.onViewerNavigation((payload) => {
            setDesktopViewerState(payload);
        });
    }

    const openAccountProfilePage = (event) => {
        const destination = new URL('/account', window.location.origin).toString();
        if (event) event.preventDefault();
        window.location.assign(destination);
    };

    const accountLinks = Array.from(document.querySelectorAll('a.account-profile-link, #manageAccountLink a[href="/account"]'));
    accountLinks.forEach((link) => {
        link.href = new URL('/account', window.location.origin).toString();
        link.addEventListener('click', (event) => {
            if (!getDesktopBridge()) return;
            openAccountProfilePage(event);
        });
    });
    initializePreviewPaneToggle();
    updateBrowserImportUi();

    // QR Multi-node generation elements
    qrSavedGraphSelect = document.getElementById('qrSavedGraphSelect');
    generateQrBtn = document.getElementById('generateQrBtn');
    qrDisplayArea = document.getElementById('qrDisplayArea');

    function showAuthError(msg) {
        if (!authError) return;
        authError.textContent = msg;
        authError.style.display = '';
    }
    function clearAuthError() {
        if (!authError) return;
        authError.textContent = '';
        authError.style.display = 'none';
    }
    function setAuthMode(mode) {
        clearAuthError();
        if (!authTabLogin || !authTabRegister || !authLoginFields || !authRegisterFields) return;
        const isLogin = mode === 'login';
        authTabLogin.classList.toggle('auth-tab-active', isLogin);
        authTabRegister.classList.toggle('auth-tab-active', !isLogin);
        authLoginFields.style.display = isLogin ? '' : 'none';
        authRegisterFields.style.display = isLogin ? 'none' : '';
    }

    function renderSavedLinks(items) {
        const renderSignature = buildSavedLinksRenderSignature(items);
        if (renderSignature === savedLinksRenderSignature) return;
        savedLinksRenderSignature = renderSignature;

        // 1. Populate the Multi-node QR Code dropdown (Priority 1)
        const qrSelect = document.getElementById('qrSavedGraphSelect');
        if (qrSelect) {
            const qrFragment = document.createDocumentFragment();
            const placeholder = document.createElement('option');
            placeholder.value = '';
            placeholder.textContent = '-- Select Saved Graph --';
            qrFragment.appendChild(placeholder);
            
            // Add current active graph if shared
            if (currentSavedShareCode) {
                const optCurrent = document.createElement('option');
                optCurrent.value = currentSavedShareUrl || createSavedGraphUrl(currentSavedShareCode);
                optCurrent.textContent = `★ Current: ${graphTopic || currentSavedShareCode}`;
                qrFragment.appendChild(optCurrent);
            }

            // Extract codes/topics from Saved URL Nodes
            if (Array.isArray(items) && items.length > 0) {
                items.forEach(it => {
                    const code = it.code || (it.shareUrl ? it.shareUrl.split('/').pop() : '');
                    if (!code) return;
                    
                    const opt = document.createElement('option');
                    // Ensure full URL for QR scanners
                    opt.value = it.shareUrl || createSavedGraphUrl(code);
                    const ns = it.namespace ? `[${it.namespace}] ` : '';
                    const label = it.topic ? `${it.topic} (${code})` : code;
                    opt.textContent = `${ns}${label}`;
                    qrFragment.appendChild(opt);
                });
                console.log(`[QRGen] Dropdown populated with ${items.length} nodes from profile.`);
            }
            qrSelect.replaceChildren(qrFragment);
        }

        // 2. Render the visible list in sidepanel (Priority 2)
        if (!savedLinks) return;
        const listFragment = document.createDocumentFragment();

        if (!items || items.length === 0) {
            const div = document.createElement('div');
            div.className = 'saved-links-empty';
            div.textContent = 'No saved node sets yet.';
            savedLinks.replaceChildren(div);
            return;
        }
        for (const it of items) {
            const wrap = document.createElement('div');
            wrap.className = 'saved-link-item';
            wrap.tabIndex = 0;
            wrap.title = 'Click this row to load the saved nodegraph into the current editor. Click the link itself to open playback in a new tab.';

            if (it.code) {
                const del = document.createElement('button');
                del.type = 'button';
                del.className = 'saved-link-delete';
                del.textContent = 'x';
                del.title = 'Remove from saved list';
                del.addEventListener('click', async (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    try {
                        await apiJson(`/api/v1/saved/${encodeURIComponent(it.code)}`, { method: 'DELETE' });
                        clearLastActiveGraphIfMatches(it.code);
                        // If the currently displayed topic belongs to this saved/share code, clear it too.
                        if (graphTopicOrigin === `saved:${it.code}` || graphTopicOrigin === `share:${it.code}`) {
                            setGraphTopicFromExternal('', null);
                        }
                        await refreshSavedLinks();
                    } catch (err) {
                        console.warn('Failed to delete saved link', err);
                        alert('Unable to remove saved link.');
                    }
                });
                wrap.appendChild(del);
            }

            const a = document.createElement('a');
            a.className = 'saved-link';
            a.href = it.shareUrl;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            const ns = it.namespace ? `[${it.namespace}] ` : '';
            a.textContent = `${ns}${it.shareUrl}`;
            a.title = it.createdAt ? `Saved: ${it.createdAt}` : it.shareUrl;
            wrap.appendChild(a);

            const hint = document.createElement('div');
            hint.className = 'saved-link-hint';
            hint.innerHTML = '<strong>Row click:</strong> load here. <strong>Link click:</strong> open in new tab.';
            wrap.appendChild(hint);

            wrap.addEventListener('click', async (e) => {
                const target = e.target;
                if (target instanceof HTMLElement && (target.closest('.saved-link') || target.closest('.saved-link-delete'))) {
                    return;
                }
                if (!it.code) return;
                try {
                    await loadSavedOrSharedGraphIntoEditor(it.code, { origin: 'saved', enableShareAnalytics: false, editableAsShared: false, shareUrl: it.shareUrl || null });
                } catch (err) {
                    console.warn('Failed to load saved nodegraph into editor', err);
                    alert('Unable to load that saved nodegraph into the main editor.');
                }
            });
            wrap.addEventListener('keydown', async (e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                const target = e.target;
                if (target instanceof HTMLElement && (target.closest('.saved-link') || target.closest('.saved-link-delete'))) {
                    return;
                }
                e.preventDefault();
                if (!it.code) return;
                try {
                    await loadSavedOrSharedGraphIntoEditor(it.code, { origin: 'saved', enableShareAnalytics: false, editableAsShared: false, shareUrl: it.shareUrl || null });
                } catch (err) {
                    console.warn('Failed to load saved nodegraph into editor', err);
                    alert('Unable to load that saved nodegraph into the main editor.');
                }
            });

            if (it.topic && String(it.topic).trim()) {
                const div = document.createElement('div');
                div.className = 'saved-link-topic';
                div.textContent = String(it.topic).trim();
                wrap.appendChild(div);
            }

            listFragment.appendChild(wrap);
        }
        savedLinks.replaceChildren(listFragment);
    }

    function setBillingError(msg) {
        if (!billingError) return;
        if (msg) {
            billingError.style.display = '';
            billingError.textContent = msg;
        } else {
            billingError.style.display = 'none';
            billingError.textContent = '';
        }
    }

    async function refreshBilling(orgs) {
        if (!billingSection || !billingOrgSelect || !billingPlans || !billingStatus) return;

        // Only org owners can manage billing.
        const ownerOrgs = Array.isArray(orgs) ? orgs.filter((o) => String(o.role || '').toUpperCase() === 'OWNER') : [];
        if (ownerOrgs.length === 0) {
            billingSection.style.display = 'none';
            return;
        }
        billingSection.style.display = '';
        setBillingError('');

        billingOrgSelect.innerHTML = '';
        for (const o of ownerOrgs) {
            const opt = document.createElement('option');
            opt.value = o.id;
            opt.textContent = `${o.slug}`;
            billingOrgSelect.appendChild(opt);
        }

        const loadStatus = async () => {
            const orgId = billingOrgSelect.value;
            if (!orgId) return;
            try {
                const s = await apiJson(`/api/v1/billing/org/${encodeURIComponent(orgId)}`, { method: 'GET' });
                const planKey = s && s.planKey ? String(s.planKey) : 'free';
                const status = s && s.status ? String(s.status) : 'free';
                billingStatus.textContent = `Current plan: ${planKey} (${status})`;
            } catch (e) {
                billingStatus.textContent = '';
                setBillingError('Billing status unavailable (backend not configured).');
            }
        };

        const loadPlans = async () => {
            const orgId = billingOrgSelect.value;
            billingPlans.innerHTML = '';
            try {
                const items = await apiJson('/api/v1/billing/plans', { method: 'GET' });
                const plans = Array.isArray(items) ? items : [];
                for (const p of plans) {
                    const btn = document.createElement('button');
                    btn.type = 'button';
                    btn.className = 'billing-plan-btn';
                    const title = document.createElement('div');
                    title.className = 'billing-plan-title';
                    title.textContent = p.name ? String(p.name) : String(p.key);
                    const desc = document.createElement('div');
                    desc.className = 'billing-plan-desc';
                    desc.textContent = p.description ? String(p.description) : '';
                    btn.appendChild(title);
                    btn.appendChild(desc);

                    const available = !!p.available;
                    btn.disabled = !available;
                    btn.title = available ? 'Select plan' : 'Not configured';
                    btn.addEventListener('click', async () => {
                        setBillingError('');
                        try {
                            const res = await apiJson(`/api/v1/billing/org/${encodeURIComponent(orgId)}/checkout`, {
                                method: 'POST',
                                body: JSON.stringify({ planKey: String(p.key) }),
                            });
                            if (res && res.url) window.location.href = res.url;
                        } catch (e) {
                            console.warn('Billing checkout failed', e);
                            setBillingError('Unable to start checkout. Ensure Stripe is configured.');
                        }
                    });

                    billingPlans.appendChild(btn);
                }
            } catch (e) {
                setBillingError('Billing plans unavailable (backend not configured).');
            }
        };

        billingOrgSelect.addEventListener('change', async () => {
            await loadStatus();
            await loadPlans();
        });

        billingManageBtn?.addEventListener('click', async () => {
            setBillingError('');
            const orgId = billingOrgSelect.value;
            if (!orgId) return;
            try {
                const res = await apiJson(`/api/v1/billing/org/${encodeURIComponent(orgId)}/portal`, { method: 'POST', body: '{}' });
                if (res && res.url) window.location.href = res.url;
            } catch (e) {
                console.warn('Billing portal failed', e);
                setBillingError('Unable to open billing portal. Ensure Stripe is configured.');
            }
        });

        await loadStatus();
        await loadPlans();
    }

    async function refreshDashboard(user, orgs) {
        if (!dashboardSection || !dashboardScopeSelect || !dashboardList || !dashboardDetail) return;
        if (!user) {
            dashboardSection.style.display = 'none';
            return;
        }
        dashboardSection.style.display = '';

        dashboardScopeSelect.innerHTML = '';
        const optMe = document.createElement('option');
        optMe.value = 'me';
        optMe.textContent = `Personal (${user.handle})`;
        dashboardScopeSelect.appendChild(optMe);
        for (const o of (Array.isArray(orgs) ? orgs : [])) {
            const opt = document.createElement('option');
            opt.value = `org:${o.id}`;
            opt.textContent = `Org: ${o.slug}`;
            dashboardScopeSelect.appendChild(opt);
        }

        const load = async () => {
            dashboardList.innerHTML = '';
            dashboardDetail.textContent = 'Loading analytics...';
            const scope = dashboardScopeSelect.value || 'me';
            try {
                const items = scope.startsWith('org:')
                    ? await apiJson(`/api/v1/analytics/org/${encodeURIComponent(scope.slice(4))}`, { method: 'GET' })
                    : await apiJson('/api/v1/analytics/saved', { method: 'GET' });

                const arr = Array.isArray(items) ? items : [];
                if (arr.length === 0) {
                    dashboardDetail.textContent = 'No analytics yet. Open/share a link to start collecting views.';
                    return;
                }
                dashboardDetail.textContent = 'Click a link code for details.';

                for (const it of arr) {
                    const div = document.createElement('div');
                    div.className = 'dash-item';
                    const code = String(it.code || '');
                    const codeDiv = document.createElement('div');
                    codeDiv.className = 'dash-code';
                    codeDiv.textContent = code;
                    const metrics = document.createElement('div');
                    metrics.className = 'dash-metrics';
                    metrics.textContent = `Views: ${Number(it.views || 0)} | Unique: ${Number(it.uniques || 0)} | Previews: ${Number(it.previews || 0)} | Visits: ${Number(it.visits || 0)}`;
                    div.appendChild(codeDiv);
                    div.appendChild(metrics);
                    div.addEventListener('click', async () => {
                        try {
                            const d = await apiJson(`/api/v1/analytics/share/${encodeURIComponent(code)}`, { method: 'GET' });
                            const pv = d && d.previewsByNode ? d.previewsByNode : {};
                            const vv = d && d.visitsByNode ? d.visitsByNode : {};
                            const formatMap = (m) => Object.entries(m || {}).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}:${v}`).join(', ') || 'none';
                            dashboardDetail.innerHTML = `
                                <strong>Totals for ${code}:</strong> views=${d.views}, unique=${d.uniques}<br><br>
                                <strong>Top Previews:</strong> ${formatMap(pv)}<br>
                                <strong>Top Visits:</strong> ${formatMap(vv)}<br>
                                <strong>Devices:</strong> ${formatMap(d.devices)}<br>
                                <strong>Browsers:</strong> ${formatMap(d.browsers)}<br>
                                <strong>OS:</strong> ${formatMap(d.os)}<br>
                                <strong>Top Countries:</strong> ${formatMap(d.countries)}<br>
                                <strong>Referers:</strong> ${formatMap(d.referers)}
                            `;
                        } catch (e) {
                            dashboardDetail.innerHTML = 'Unable to load detail analytics.';
                        }
                    });
                    dashboardList.appendChild(div);
                }
            } catch (_) {
                dashboardDetail.textContent = 'Analytics unavailable (backend not running/configured).';
            }
        };

        dashboardScopeSelect.addEventListener('change', load);
        await load();
    }

    async function refreshSavedLinks() {
        try {
            const items = await apiJson('/api/v1/saved', { method: 'GET' });
            currentSavedLinksCache = Array.isArray(items) ? items : [];
            renderSavedLinks(currentSavedLinksCache);
        } catch (_) {
            currentSavedLinksCache = [];
            renderSavedLinks([]);
        }
        updateAccountProfileCard();
    }
    refreshSavedLinksFn = refreshSavedLinks;

    // Auth UI (optional)
    try {
        const me = await apiJson('/api/v1/me', { method: 'GET' });
        const user = me && me.user ? me.user : null;
        currentUser = user;
        pendingLastActiveGraphRestore = user
            ? (readLastActiveGraphForUser(user) || inferLastActiveGraphFromTopicOrigin())
            : null;
        const orgs = me && Array.isArray(me.organizations) ? me.organizations : [];
        if (user) {
            if (authStatus) authStatus.textContent = me && me.offline ? `Offline mode for ${user.handle}` : `Signed in as ${user.handle}`;
            if (signOutBtn) signOutBtn.style.display = '';
            if (signInBtn) signInBtn.style.display = 'none';
            if (authForm) authForm.style.display = 'none';
            const manageAccountLink = document.getElementById('manageAccountLink');
            if (manageAccountLink) manageAccountLink.style.display = '';
            if (tierOverview) {
                const lines = [];
                const up = me && me.userPlan ? me.userPlan : null;
                const pKey = up && up.planKey ? String(up.planKey) : 'free';
                const pStatus = up && up.status ? String(up.status) : 'free';
                lines.push(`Personal tier: ${pKey} (${pStatus})`);
                for (const o of orgs) {
                    const planKey = o && o.planKey ? String(o.planKey) : 'free';
                    const planStatus = o && o.planStatus ? String(o.planStatus) : 'free';
                    lines.push(`Org ${o.slug}: ${planKey} (${planStatus})`);
                }
                tierOverview.textContent = lines.join(' | ');
            }
            if (saveAsSelect) {
                saveAsSelect.innerHTML = '';
                const optPersonal = document.createElement('option');
                optPersonal.value = '';
                optPersonal.textContent = `Personal (${user.handle})`;
                saveAsSelect.appendChild(optPersonal);

                for (const o of orgs) {
                    const opt = document.createElement('option');
                    opt.value = o.id;
                    opt.textContent = `Org: ${o.slug}`;
                    saveAsSelect.appendChild(opt);
                }
            }
            await refreshBilling(orgs);
            await refreshDashboard(user, orgs);
            await refreshSavedLinks();
            updateAccountProfileCard();
            if (!me || !me.offline) {
                void processPendingCloudSync();
            }
        } else {
            currentUser = null;
            pendingLastActiveGraphRestore = null;
            if (authStatus) authStatus.textContent = 'Not signed in';
            if (signInBtn) signInBtn.style.display = '';
            if (authForm) authForm.style.display = 'none';
            if (tierOverview) tierOverview.textContent = '';
            if (saveAsSelect) saveAsSelect.innerHTML = '';
            renderSavedLinks([]);
            if (billingSection) billingSection.style.display = 'none';
            if (dashboardSection) dashboardSection.style.display = 'none';
            const manageAccountLink = document.getElementById('manageAccountLink');
            if (manageAccountLink) manageAccountLink.style.display = 'none';
            updateAccountProfileCard();
        }
    } catch (e) {
        currentUser = null;
        pendingLastActiveGraphRestore = null;
        // Backend may not expose auth in some deployments; keep UI quiet.
        if (authStatus) authStatus.textContent = '';
        if (signInBtn) signInBtn.style.display = '';
        if (tierOverview) tierOverview.textContent = '';
        if (saveAsSelect) saveAsSelect.innerHTML = '';
        renderSavedLinks([]);
        if (billingSection) billingSection.style.display = 'none';
        if (dashboardSection) dashboardSection.style.display = 'none';
        const manageAccountLink = document.getElementById('manageAccountLink');
        if (manageAccountLink) manageAccountLink.style.display = 'none';
        updateAccountProfileCard();
    }

    signInBtn?.addEventListener('click', () => {
        if (!authForm) return;
        clearAuthError();
        authForm.style.display = (authForm.style.display === 'none' || !authForm.style.display) ? '' : 'none';
        setAuthMode('login');
    });

    signOutBtn?.addEventListener('click', async () => {
        try {
            await apiJson('/api/v1/logout', { method: 'POST', body: '{}' });
        } catch (_) { }
        
        // Explicitly clear memory state
        currentUser = null;
        graphTopicOrigin = null;
        graphTopic = '';
        currentSavedShareCode = null;
        currentSavedShareUrl = null;
        desktopViewerState = { nodeId: null, url: '', title: '' };
        clearExplicitSaveBaseline();
        clearCachedAuthState();

        window.location.reload();
    });

    authTabLogin?.addEventListener('click', () => setAuthMode('login'));
    authTabRegister?.addEventListener('click', () => setAuthMode('register'));

    authLoginBtn?.addEventListener('click', async () => {
        clearAuthError();
        try {
            const identifier = authIdentifier && authIdentifier.value ? authIdentifier.value.trim() : '';
            const password = authPassword && authPassword.value ? authPassword.value : '';
            if (!identifier || !password) {
                showAuthError('Please enter your email/handle and password.');
                return;
            }
            await apiJson('/api/v1/auth/login', {
                method: 'POST',
                body: JSON.stringify({ identifier, password }),
            });
            window.location.reload();
        } catch (e) {
            showAuthError('Sign in failed. Check your credentials and try again.');
            console.warn('Sign in failed', e);
        }
    });

    authRegisterBtn?.addEventListener('click', async () => {
        clearAuthError();
        try {
            const handle = authHandle && authHandle.value ? authHandle.value.trim() : '';
            const email = authEmail && authEmail.value ? authEmail.value.trim() : '';
            const password = authNewPassword && authNewPassword.value ? authNewPassword.value : '';
            if (!handle || !email || !password) {
                showAuthError('Please enter a handle, email, and password.');
                return;
            }
            await apiJson('/api/v1/auth/register', {
                method: 'POST',
                body: JSON.stringify({ handle, email, password }),
            });
            window.location.reload();
        } catch (e) {
            showAuthError('Sign up failed. That handle/email may already be taken.');
            console.warn('Sign up failed', e);
        }
    });

    window.addEventListener('online', () => {
        void processPendingCloudSync();
        void refreshCloudBackedEditorState({ force: true });
    });
    window.addEventListener('focus', () => {
        void refreshCloudBackedEditorState();
    });
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            void refreshCloudBackedEditorState();
        }
    });


    // Load shared data (if present), otherwise load saved data.
    const loadedShare = await tryLoadShareFromUrl();
    if (!loadedShare) {
        await loadSavedNodeData();
    }
    applySharedReadOnlyMode();

    // Set initial value for node count input
    nodeCountInput.value = currentNodeCount;

    // Initialize nodes and display
    initNodes(currentNodeCount);
    updateNodeDisplay();
    if (lastSelectedNode !== null) {
        updateRecentUrl(lastSelectedNode); // Show last selected URL/status initially
    } else if (currentNodeCount > 0) {
        updateRecentUrl(1); // Default to showing status for node 1 if nodes exist
    } else {
        updateRecentUrl(null); // Show 'No node selected' if 0 nodes
    }

    // Setup Playback Module (pass references/callbacks)
    // Check if setupPlay function exists (loaded from play.js)
    if (typeof setupPlay === 'function') {
        setupPlay({
            nodeUrlsRef: nodeUrls, // Pass the object reference (changes will reflect)
            nodeCaptionsRef: nodeCaptions, // Pass caption data for story overlays
            graphTopicRef: () => graphTopic, // Getter for current topic
            isEditingModeRef: () => window._isEditingMode, // Getter for global state
            // !! Pass a getter function for currentNodeCount !!
            getCurrentNodeCountFunc: () => currentNodeCount,
            updateRecentUrlFunc: updateRecentUrl,
            // !! Pass highlightPlayingNode as a callback !!
            highlightPlayingNodeFunc: highlightPlayingNode, // Defined below or in play.js scope
            hasValidUrlsFunc: hasValidUrls,
            resolveUrlForViewerFunc: resolveUrlForViewer,
            getPlaybackDelayMsFunc: getPlaybackDelayMs,
            playVoiceForNodeFunc: playVoiceForNode,
            onPlaybackStartFunc: bgStartPlayback,
            onPlaybackStopFunc: bgStopPlayback,
            onNodeChangedFunc: bgOnNodeChanged,
            analyticsEventFunc: sendAnalyticsEvent
        });
    } else {
        console.error("play.js setup function (setupPlay) not found. Playback features may not work.");
        // Disable play button if setup failed?
        const playBtn = document.getElementById('playPauseBtn');
        if (playBtn) {
            playBtn.disabled = true;
            playBtn.title = "Playback unavailable (script error)";
        }
    }

    if (!loadedShare) {
        const restoredLastGraph = await restoreLastActiveGraphForSignedInUser();
        if (restoredLastGraph && currentUser) {
            await refreshSavedLinks();
        } else if (currentUser && !hasMeaningfulGraphContent() && currentSavedLinksCache.length > 0 && currentSavedLinksCache[0].code) {
            try {
                await loadSavedOrSharedGraphIntoEditor(currentSavedLinksCache[0].code, {
                    origin: 'saved',
                    enableShareAnalytics: false,
                    editableAsShared: false,
                    shareUrl: currentSavedLinksCache[0].shareUrl || null,
                });
            } catch (error) {
                console.warn('Unable to auto-load the most recent saved nodegraph.', error);
            }
        }
    }


    // --- Add Event Listeners ---

    // Controls
    document.getElementById('setNodeCountBtn')?.addEventListener('click', updateNodeCount);
    nodeCountInput?.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        updateNodeCount();
    });
    document.getElementById('setNodeTimerBtn')?.addEventListener('click', () => {
        const input = document.getElementById('nodeTimer');
        if (!input) return;
        const val = Number(input.value);
        if (!Number.isFinite(val) || val < 1) return;
        
        normalPlaybackDelaySec = val;
        
        // UX Enhancement: If they set the normal timer, assume they want to use it
        if (window._isEditingMode) {
            window._isEditingMode = false;
            if (typeof window._updatePlaybackModeUI === 'function') {
                window._updatePlaybackModeUI();
            }
            console.log(`[Settings] Auto-switched to Normal Mode because user updated the main timer.`);
        }

        persistPlaybackSettings();
        console.log(`[Settings] Normal Mode set to ${val}s. Applied to Global Engine.`);
        alert(`Normal mode playback delay set to ${val} seconds.`);
    });
    document.getElementById('nodeTimer')?.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        document.getElementById('setNodeTimerBtn')?.click();
    });
    document.getElementById('addManualBtn')?.addEventListener('click', openManualEntry);
    document.getElementById('addFileBtn')?.addEventListener('click', () => {
        if (!requireSignedInForSharedRemix('attach files to this shared graph')) return;
        const picker = document.getElementById('filePicker');
        if (picker) picker.click();
    });
    document.getElementById('filePicker')?.addEventListener('change', async (ev) => {
        const input = ev && ev.target ? ev.target : null;
        if (!requireSignedInForSharedRemix('attach files to this shared graph')) {
            try { if (input) input.value = ''; } catch (_) { }
            return;
        }
        const files = input && input.files ? Array.from(input.files) : [];
        if (!files.length) return;

        const makeId = () => {
            try { return crypto.randomUUID(); } catch (_) { }
            return `lf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
        };

        const findNextEmptyNode = (preferred) => {
            const start = (preferred && preferred >= 1 && preferred <= currentNodeCount) ? preferred : 1;
            for (let k = 0; k < currentNodeCount; k++) {
                const i = ((start - 1 + k) % currentNodeCount) + 1;
                const u = nodeUrls[i];
                if (!u || !String(u).trim()) return i;
            }
            return null;
        };

        let preferred = (lastSelectedNode && lastSelectedNode >= 1 && lastSelectedNode <= currentNodeCount) ? lastSelectedNode : 1;
        for (const f of files) {
            const targetNode = findNextEmptyNode(preferred);
            if (!targetNode) {
                alert('No empty nodes available. Increase node count or clear a node before adding more files.');
                break;
            }

            const id = makeId();
            const mimeType = (f && f.type) ? String(f.type) : 'application/octet-stream';
            try {
                await filePut(id, {
                    blob: f,
                    name: f.name || 'file',
                    mimeType,
                    sizeBytes: Number(f.size) || 0,
                    lastModified: Number(f.lastModified) || null,
                });
            } catch (e) {
                console.warn('Failed to store local file in IndexedDB:', e);
                alert('Unable to store that file in this browser. Try a smaller file, or a different browser.');
                continue;
            }

            const qp = new URLSearchParams();
            qp.set('name', f.name || 'file');
            qp.set('mime', mimeType);
            qp.set('size', String(Number(f.size) || 0));
            const localUrl = `localfile:${id}?${qp.toString()}`;

            nodeUrls[targetNode] = localUrl;
            updateNodeStatus(targetNode);
            preferred = Math.min(currentNodeCount, targetNode + 1);
            lastSelectedNode = targetNode;
        }

        saveNodeData();
        updateNodeDisplay();
        updateRecentUrl(lastSelectedNode);
        try { if (typeof loadUrlInViewer === 'function' && lastSelectedNode) await loadUrlInViewer(nodeUrls[lastSelectedNode], lastSelectedNode); } catch (_) { }

        // Allow re-selecting the same file later.
        try { input.value = ''; } catch (_) { }
    });
    document.getElementById('importBrowserBtn')?.addEventListener('click', openBrowserSourcesModal);
    document.getElementById('shareBtn')?.addEventListener('click', async () => {
        if (!requireSignedInForSharedRemix('share your own version of this shared nodegraph')) return;
        try {
            flushPendingGraphTopicInput();
            const exportSnapshot = buildNormalizedExportSnapshot();
            if (!exportSnapshot) {
                alert('Add at least one loaded node URL before sharing.');
                return;
            }
            const containsLocalFiles = Object.values(exportSnapshot.nodeUrls || {}).some((value) => isLocalFileUrl(value));
            if (containsLocalFiles) {
                alert('Local files become portable after you Save this nodegraph to your account. Save it first, then share the saved link so other devices can preview those files.');
                return;
            }
            if (!confirmNormalizedExport('Sharing this nodegraph', exportSnapshot)) return;
            const res = await apiJson('/api/v1/shares', {
                method: 'POST',
                body: JSON.stringify({
                    nodeCount: exportSnapshot.nodeCount,
                    lastSelectedNode: exportSnapshot.lastSelectedNode,
                    nodeUrls: exportSnapshot.nodeUrls,
                    nodeCaptions: exportSnapshot.nodeCaptions,
                    nodePauseSecByNode: exportSnapshot.nodePauseSecByNode,
                    topic: graphTopic || undefined,
                }),
            });

            const shareUrl = (res && res.shareUrl) ? res.shareUrl : `${window.location.origin}/s/${res.code}`;
            // Best-effort copy to clipboard, then show it either way.
            try { await navigator.clipboard.writeText(shareUrl); } catch (_) { }
            window.prompt('Share link (copied if supported):', shareUrl);
        } catch (e) {
            console.warn('Failed to create share link.', e);
            alert('Unable to create share link. Make sure the backend is running.');
        }
    });
    document.getElementById('saveBtn')?.addEventListener('click', async () => {
        if (!requireSignedInForSharedRemix('save this shared nodegraph to your account')) return;
        try {
            const exportSnapshot = buildNormalizedExportSnapshot();
            if (!exportSnapshot) {
                alert('Add at least one loaded node URL before saving.');
                return;
            }
            if (!confirmNormalizedExport('Saving this nodegraph', exportSnapshot)) return;
            const saved = await persistCurrentGraphAsSaved({ preferUpdate: false, fallbackTopic: buildUntitledTopicLabel() });
            const res = saved && saved.result ? saved.result : null;
            if (res && res.queued) {
                alert(res.message || 'Saved offline. Cynode will sync it when the backend is reachable again.');
                return;
            }
            if (res && res.shareUrl) {
                try { await navigator.clipboard.writeText(res.shareUrl); } catch (_) { }
                window.prompt('Saved link (copied if supported):', res.shareUrl);
            }
        } catch (e) {
            console.warn('Failed to save node set.', e);
            alert('Unable to save. Please sign in first.');
        }
    });
    updateSavedBtn?.addEventListener('click', async () => {
        if (!requireSignedInForSharedRemix('update or remix this shared nodegraph')) return;
        if (!currentSavedShareCode) return;
        try {
            const exportSnapshot = buildNormalizedExportSnapshot();
            if (!exportSnapshot) {
                alert('Add at least one loaded node URL before updating.');
                return;
            }
            if (!confirmNormalizedExport('Updating this saved nodegraph', exportSnapshot)) return;
            const saved = await persistCurrentGraphAsSaved({ preferUpdate: true, fallbackTopic: buildUntitledTopicLabel() });
            const res = saved && saved.result ? saved.result : null;
            if (res && res.queued) {
                alert(res.message || 'Saved changes queued offline. Cynode will sync them when the backend is reachable again.');
                return;
            }
            if (res && res.shareUrl) {
                try { await navigator.clipboard.writeText(res.shareUrl); } catch (_) { }
                window.prompt('Saved link updated (copied if supported):', res.shareUrl);
            }
        } catch (e) {
            console.warn('Failed to update saved node set.', e);
            alert('Unable to update that saved link. You may need to save it as a new nodegraph instead.');
        }
    });
    document.getElementById('clearAllBtn')?.addEventListener('click', clearNodeConnections);

    // URL Form Modal
    document.getElementById('saveUrlBtn')?.addEventListener('click', saveUrl);
    document.getElementById('clearUrlBtn')?.addEventListener('click', clearUrl);
    document.getElementById('cancelUrlFormBtn')?.addEventListener('click', hideAllModals);

    // Browser Source Modal
    importTabsBtn?.addEventListener('click', loadFromOpenTabs);
    importBookmarksBtn?.addEventListener('click', loadFromBookmarks);
    importHistoryBtn?.addEventListener('click', loadFromHistory);
    browserBridgeRefreshBtn?.addEventListener('click', () => {
        void refreshBrowserBridgeStatus({ silent: false });
    });
    itemLimitInput?.addEventListener('input', updateBrowserImportLimitHint);
    itemLimitInput?.addEventListener('change', () => {
        getItemLimit();
        updateBrowserImportLimitHint();
    });
    document.getElementById('cancelImportBtn')?.addEventListener('click', hideAllModals);

    // General UI
    modalBackdrop?.addEventListener('click', hideAllModals);
    addressBar?.addEventListener('dblclick', addNodeOnDoubleClick);
    window.addEventListener('message', handleBrowserBridgeAvailabilityMessage);

    // Update connection line on resize (debounced)
    let resizeTimeout;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => {
            // No need for requestAnimationFrame here, it's already in timeout
            updateConnectionLine(currentNodeCount);
        }, 150); // Debounce resize events
    });

    // Save data before the user leaves the page (unload is less reliable)
    // Consider using 'visibilitychange' or 'pagehide' for more reliability
    window.addEventListener('pagehide', () => saveNodeData({ flush: true }));
    window.addEventListener('pagehide', () => {
        // Best-effort cleanup for blob: object URLs created from local file nodes.
        try {
            for (const u of localFileObjectUrlById.values()) URL.revokeObjectURL(u);
            localFileObjectUrlById.clear();
        } catch (_) { }
    });
    // Fallback for older browsers or specific cases
    window.addEventListener('beforeunload', () => saveNodeData({ flush: true }));


    // Multi-node QR Code Generation Logic
    generateQrBtn?.addEventListener('click', () => {
        if (!requireSignedInForSharedRemix('generate QR codes for this shared nodegraph')) return;
        if (!qrSavedGraphSelect || !qrDisplayArea) return;
        const targetUrl = qrSavedGraphSelect.value;
        if (!targetUrl) {
            alert("Please select a saved nodegraph from the dropdown above to continue.");
            return;
        }

        qrDisplayArea.innerHTML = '<div class="settings-hint" style="text-align:center; padding: 10px;">Creating Multinode QR...</div>';
        renderLocalQrCode(targetUrl);
        console.log(`[QRGen] Generated local QR for: ${targetUrl}`);
    });

    console.log("Node Graph URL Manager Initialized.");
});

// --- Functions needed by Callbacks (Ensure they are defined) ---

/**
 * Highlights the node currently being played in the sequence.
 * (Moved here from global scope / play.js dependency for clarity)
 * @param {number|null} nodeId - The ID of the node to highlight, or null to remove all highlights.
 */
function highlightPlayingNode(nodeId) {
    if (!nodeGraph) return; // Ensure graph exists

    // Remove 'playing' class from all nodes first
    nodeGraph.querySelectorAll('.node.playing').forEach(node => {
        node.classList.remove('playing');
    });

    // Add 'playing' class to the specified node
    if (nodeId !== null) {
        const node = nodeGraph.querySelector(`.node[data-node-id="${nodeId}"]`);
        if (node) {
            node.classList.add('playing');
        }
    }
}
