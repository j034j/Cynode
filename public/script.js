// --- State ---
let currentNodeCount = 8; // Default
let nodeUrls = {}; // Stores URL for each node ID { 1: "url1", 2: "url2", ... }
let nodeCaptions = {}; // Stores { title: string, caption: string } for each node ID
let lastSelectedNode = null; // Track the most recently interacted node ID
let currentUser = null;
let loadedFromSharedGraph = false;
let currentShareAnalyticsContext = null;
let currentSavedShareCode = null;

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
    const apply = () => {
        const html = document.documentElement;
        html.dataset.device = isLikelyMobileDevice() ? 'mobile' : 'desktop';
    };
    apply();
    window.addEventListener('resize', () => apply());
    window.addEventListener('orientationchange', () => apply());
}

function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    // Best-effort; failures should not impact core UI.
    navigator.serviceWorker.register('/sw.js').catch(() => { });
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
        previewPaneExpanded = localStorage.getItem(PREVIEW_EXPANDED_KEY) === '1';
    } catch (_) {
        previewPaneExpanded = false;
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
const GRAPH_TOPIC_ORIGIN_KEY = 'graphTopicOrigin'; // 'draft' | `share:${code}` | `saved:${code}`
let graphTopic = '';
let graphTopicOrigin = null;

// Playback media state

// Remote media loaded from a share code (public URLs served by backend).
let remoteMedia = { background: null, voiceByNode: {} };
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
    remoteMedia = { background: null, voiceByNode: {} };
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
    if (!sidepanel || !resizer || !toggle) return;

    const root = document.documentElement;

    const setToggleGlyph = () => {
        // When panel is open, show << to indicate "close". When collapsed, show >> to indicate "open".
        toggle.textContent = sidepanel.classList.contains('collapsed') ? '>>' : '<<';
    };

    const savedCollapsed = localStorage.getItem(SIDEPANEL_COLLAPSED_KEY);
    if (savedCollapsed === '1') {
        sidepanel.classList.add('collapsed');
    }
    setToggleGlyph();

    const savedWidth = parseInt(localStorage.getItem(SIDEPANEL_WIDTH_KEY) || '', 10);
    if (!isNaN(savedWidth) && savedWidth >= 160 && savedWidth <= 800) {
        root.style.setProperty('--sidepanel-width', `${savedWidth}px`);
    }

    toggle.addEventListener('click', () => {
        const collapsed = sidepanel.classList.toggle('collapsed');
        localStorage.setItem(SIDEPANEL_COLLAPSED_KEY, collapsed ? '1' : '0');
        setToggleGlyph();
    });

    let dragging = false;
    let startX = 0;
    let startWidth = 0;

    const onMove = (e) => {
        if (!dragging) return;
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
        if (sidepanel.classList.contains('collapsed')) return;
        dragging = true;
        startX = e.clientX;
        startWidth = parseInt(getComputedStyle(sidepanel).width, 10) || 280;
        document.body.style.userSelect = 'none';
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    });
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

async function apiJson(path, options) {
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

    const res = await fetch(path, init);
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`API ${res.status} ${res.statusText}${text ? `: ${text}` : ''}`);
    }
    return res.json();
}

async function apiUpload(path, formData) {
    const res = await fetch(path, {
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
        await fetch('/api/v1/analytics/event', {
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

async function uploadSavedMedia(code, exportSnapshot) {
    if (!code) return;
    const nodeIndexMap = exportSnapshot && exportSnapshot.nodeIndexMap ? exportSnapshot.nodeIndexMap : {};

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
                        nodeUrls[oldNodeId] = res.url; // Immediately swap it locally
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
}

function setGraphTopicFromInput(value) {
    // Do not trim the live input value, otherwise typing a space (as a trailing char) gets immediately removed.
    graphTopic = String(value || '');
    const trimmed = graphTopic.trim();
    graphTopicOrigin = 'draft';
    currentSavedShareCode = null;
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

function readJson(value, fallback) {
    try { return JSON.parse(value); } catch (_) { return fallback; }
}

function persistPlaybackSettings() {
    try {
        localStorage.setItem(PLAYBACK_MODE_KEY, isEditingMode ? 'editing' : 'normal');
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

function loadPlaybackSettings() {
    try {
        // ALWAYS default to Normal Mode on refresh to ensure predictable viewer experience.
        window._isEditingMode = false;

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

function renderSettingsMiniNodeGraph(activeNodeId) {
    if (!settingsMiniNodeGraph) return;
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

function rebuildSettingsNodePickers() {
    const selected = getSelectedNodeIdForSettings();
    buildNodePickerOptions(settingsNodePicker, selected);
    buildNodePickerOptions(voiceNodePicker, selected);
    syncSettingsNodePicker(selected);
    if (settingsNodePickerSummary) {
        settingsNodePickerSummary.textContent = currentNodeCount > 0
            ? `Current graph copy in this panel: ${currentNodeCount} node${currentNodeCount === 1 ? '' : 's'} with the same node order and URL associations as the active nodegraph.`
            : 'No nodes are available in the current graph yet.';
    }
    updateSettingsNodeContext(selected);
    renderSettingsMiniNodeGraph(selected);
}

function renderNodePauseOverridesList(activeNodeId) {
    if (!nodePauseOverridesList) return;
    rebuildSettingsNodePickers();
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
        renderSettingsMiniNodeGraph(getSelectedNodeIdForSettings());
        return;
    }
    const blob = await voiceGetBlobForNode(nodeId);
    if (!blob) {
        voiceStatusEl.textContent = `Node ${nodeId}: no voice annotation recorded.`;
        renderSettingsMiniNodeGraph(nodeId);
        return;
    }
    voiceStatusEl.textContent = `Node ${nodeId}: voice annotation recorded.`;
    renderSettingsMiniNodeGraph(nodeId);
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
                renderNodePauseOverridesList(selected);
                await updateVoiceStatus(selected);
                await updateVoiceSettingsForSelectedNode(selected);
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

    const syncBaseDelay = (sec) => {
        const next = Math.min(12, Math.max(0.5, Number(sec) || 3));
        playbackBaseDelaySec = next;
        if (playbackBaseDelayRange) playbackBaseDelayRange.value = String(next);
        if (playbackBaseDelayNum) playbackBaseDelayNum.value = String(next);
        persistPlaybackSettings();
        renderNodePauseOverridesList(getSelectedNodeIdForSettings());
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
    playbackBaseDelayNum?.addEventListener('input', () => syncBaseDelay(playbackBaseDelayNum.value));

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

    const syncBgVol = (v) => {
        const next = Math.max(0, Math.min(1, Number(v)));
        if (!Number.isFinite(next)) return;
        bgSetVolume(next);
        if (bgAudioVolumeEl) bgAudioVolumeEl.value = String(next);
        if (bgAudioVolumeNumEl) bgAudioVolumeNumEl.value = String(next);
        persistPlaybackSettings();
    };
    bgAudioVolumeEl?.addEventListener('input', () => syncBgVol(bgAudioVolumeEl.value));
    bgAudioVolumeNumEl?.addEventListener('input', () => syncBgVol(bgAudioVolumeNumEl.value));

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
        if (!isEditingMode) {
            isEditingMode = true;
            window._updatePlaybackModeUI?.();
        }

        persistPlaybackSettings();
        renderNodePauseOverridesList(nodeId);
        void updateVoiceSettingsForSelectedNode(nodeId);
    });

    clearNodePauseOverrideBtn?.addEventListener('click', () => {
        const nodeId = getSelectedNodeIdForSettings();
        if (!nodeId) return;
        delete nodeExtraDelaySecByNode[nodeId];
        persistPlaybackSettings();
        renderNodePauseOverridesList(nodeId);
        void updateVoiceSettingsForSelectedNode(nodeId);
    });

    voiceRecBtn?.addEventListener('click', async () => {
        const nodeId = getSelectedNodeIdForSettings();
        if (!nodeId) return;

        // Start recording implies editing intent.
        if (!isEditingMode) {
            isEditingMode = true;
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
    renderNodePauseOverridesList(getSelectedNodeIdForSettings());
    updateVoiceSettingsForSelectedNode(getSelectedNodeIdForSettings());
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
async function updateVoiceSettingsForSelectedNode(nodeId) {
    syncSettingsNodePicker(nodeId);
    if (playbackSelectedNodeHint) {
        playbackSelectedNodeHint.textContent = nodeId ? `Recording and pause changes here only affect Node ${nodeId}.` : 'Selected node: none';
    }
    updateSettingsNodeContext(nodeId);
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
    renderNodePauseOverridesList(nodeId);
    await updateVoiceStatus(nodeId);
}

async function ensureGraphId() {
    if (graphId) return graphId;
    const existing = localStorage.getItem(GRAPH_ID_KEY);
    if (existing) {
        graphId = existing;
        return graphId;
    }
    try {
        const created = await apiJson('/api/v1/graphs', { method: 'POST', body: '{}' });
        if (created && created.id) {
            graphId = created.id;
            localStorage.setItem(GRAPH_ID_KEY, graphId);
            return graphId;
        }
    } catch (e) {
        console.warn('Backend unavailable; falling back to localStorage persistence.', e);
    }
    return null;
}

async function tryLoadShareFromUrl() {
    const url = new URL(window.location.href);
    const code = url.searchParams.get('share');
    if (!code) return false;

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

        // Clean up URL so refresh doesn't repeatedly import.
        url.searchParams.delete('share');
        const nextUrl = url.pathname + (url.search ? url.search : '') + url.hash;
        window.history.replaceState({}, document.title, nextUrl);

        return true;
    } catch (e) {
        console.warn('Failed to load share code; falling back to saved state.', e);
        return false;
    }
}

async function loadSavedOrSharedGraphIntoEditor(code, { origin = 'saved', enableShareAnalytics = false, editableAsShared = false } = {}) {
    const shared = await apiJson(`/api/v1/shares/${encodeURIComponent(code)}`, { method: 'GET' });
    activeShareCode = enableShareAnalytics ? code : null;
    loadedFromSharedGraph = !!editableAsShared;
    currentSavedShareCode = origin === 'saved' ? code : null;
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

    if (shared && typeof shared.topic === 'string') {
        setGraphTopicFromExternal(shared.topic, `${origin}:${code}`);
    }

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

    // --- Intelligent Mode Sensing (Decoupling) ---
    // If the loaded graph has overrides (Voice, Custom Pauses, Captions), 
    // force Editing Mode so they take precedence. Otherwise, force Normal Mode.
    const hasOverrides = 
        Object.keys(nodeExtraDelaySecByNode).length > 0 || 
        Object.keys(nodeCaptions).length > 0 || 
        (shared.media && shared.media.voiceByNode && Object.keys(shared.media.voiceByNode).length > 0);

    window._isEditingMode = !!hasOverrides;
    persistPlaybackSettings();
    if (typeof window._updatePlaybackModeUI === 'function') window._updatePlaybackModeUI();
    console.log(`[PlaybackEngine] Graph loaded. Auto-sensed overrides: ${hasOverrides}. Mode forced to: ${isEditingMode ? 'Editing' : 'Normal'}.`);
}

function scheduleApiSave({ flush = false } = {}) {
    if (pendingSaveTimer) {
        clearTimeout(pendingSaveTimer);
        pendingSaveTimer = null;
    }

    const doSave = async () => {
        const id = await ensureGraphId();
        if (!id) {
            saveNodeDataLegacy();
            return;
        }
        try {
            await apiJson(`/api/v1/graphs/${id}`, {
                method: 'PUT',
                body: JSON.stringify({
                    nodeCount: currentNodeCount,
                    lastSelectedNode: lastSelectedNode,
                    nodeUrls: nodeUrls,
                    nodeCaptions: nodeCaptions,
                    nodePauseSecByNode: nodeExtraDelaySecByNode,
                }),
                keepalive: flush === true,
            });
        } catch (e) {
            console.warn('Backend save failed; keeping localStorage as fallback.', e);
            saveNodeDataLegacy();
        }
    };

    if (flush) {
        void doSave();
        return;
    }

    pendingSaveTimer = setTimeout(() => void doSave(), 250);
}

function saveNodeData(options) {
    scheduleApiSave(options);
}

/**
 * Loads saved state from backend (preferred), or localStorage fallback.
 */
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

                // --- Intelligent Mode Sensing (Personal Graph) ---
                // If loaded data has overrides, default to Editing Mode.
                const hasOverrides = 
                    Object.keys(nodeExtraDelaySecByNode).length > 0 || 
                    Object.keys(nodeCaptions).length > 0 ||
                    (graph.media && graph.media.voiceByNode && Object.keys(graph.media.voiceByNode).length > 0);

                if (hasOverrides) {
                    isEditingMode = true;
                } else {
                    isEditingMode = false;
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
    
    // --- Intelligent Mode Sensing (Final Pass) ---
    // If loaded data has overrides (voice and captions), default to Editing Mode.
    const hasOverrides = 
        Object.keys(nodeExtraDelaySecByNode || {}).length > 0 || 
        Object.keys(nodeCaptions || {}).length > 0 ||
        (remoteMedia?.voiceByNode && Object.keys(remoteMedia.voiceByNode).length > 0);
        
    window._isEditingMode = !!hasOverrides;
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

    nodeGraph.innerHTML = ''; // Clear existing nodes
    nodeSelector.innerHTML = ''; // Clear existing options

    // Create nodes and selector options
    for (let i = 1; i <= count; i++) {
        // Create Node Element
        const node = document.createElement('div');
        node.className = 'node';
        node.setAttribute('data-node-id', i);
        node.addEventListener('click', () => handleNodeClick(i)); // Use specific handler
        nodeGraph.appendChild(node);

        // Ensure URL entry exists, default to empty string
        if (!Object.prototype.hasOwnProperty.call(nodeUrls, i)) {
            nodeUrls[i] = '';
        }

        // Update visual status (connected/disconnected)
        updateNodeStatus(i);

        // Create Selector Option
        const option = document.createElement('option');
        option.value = i;
        option.textContent = `Node ${i}`;
        nodeSelector.appendChild(option);

    }

    // Update connection line position after nodes are rendered
    // Use requestAnimationFrame to ensure layout is calculated
    requestAnimationFrame(() => updateConnectionLine(count));
    rebuildSettingsNodePickers();
    syncSettingsNodePicker(getSelectedNodeIdForSettings());
    renderNodePauseOverridesList(getSelectedNodeIdForSettings());
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

        // Just load the preview
        if (typeof loadUrlInViewer === 'function') {
            try { await loadUrlInViewer(url, nodeId); } catch (_) { }
        } else {
            console.warn("loadUrlInViewer function not available.");
        }
        // Also open in best target
        try { await openUrlInBestTarget(target, { title: `Node ${nodeId}` }); } catch (_) { }
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
    nodeAssociationsDiv.innerHTML = ''; // Clear previous list

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
                    await openUrlInBestTarget(resolved, { title: 'Local file preview' });
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

        nodeAssociationsDiv.appendChild(div);
    }
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
        const url = nodeUrls[nodeId];
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
                await openUrlInBestTarget(target, { title: `Node ${nodeId}` });
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
function clearNodeConnectionsInternal() {
    let changed = false;
    for (let i = 1; i <= currentNodeCount; i++) {
        if (Object.prototype.hasOwnProperty.call(nodeUrls, i) && nodeUrls[i] !== '') {
            nodeUrls[i] = '';
            updateNodeStatus(i);
            changed = true;
        } else if (!Object.prototype.hasOwnProperty.call(nodeUrls, i)) {
            nodeUrls[i] = '';
        }
        if (Object.prototype.hasOwnProperty.call(nodeCaptions, i)) {
            delete nodeCaptions[i];
            changed = true;
        }
    }

    if (changed) {
        updateNodeDisplay();
        updateRecentUrl(lastSelectedNode);
        saveNodeData();
        console.log('All node connections cleared.');
    } else {
        console.log('No connections to clear.');
    }
}

function clearNodeConnections() {
    if (!requireSignedInForSharedRemix('clear or remix this shared graph')) return;
    if (confirm('Are you sure you want to clear all URL connections? This cannot be undone.')) {
        clearNodeConnectionsInternal();
    }
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

function updateBrowserInstallCards() {
    const detected = browserBridgeState.browser || detectBrowserFamily();
    Object.keys(BROWSER_INSTALL_GUIDES).forEach((browserName) => {
        const elementId = `browserInstall${browserName.charAt(0).toUpperCase()}${browserName.slice(1)}`;
        const el = document.getElementById(elementId);
        if (!el) return;
        el.classList.toggle('is-recommended', detected === browserName);
        el.classList.toggle('is-detected', browserBridgeState.available && browserBridgeState.browser === browserName);
    });
}

function setBrowserBridgeState(nextState) {
    browserBridgeState = {
        available: !!nextState?.available,
        browser: nextState?.browser || null,
        capabilities: Array.isArray(nextState?.capabilities) ? nextState.capabilities : [],
        via: nextState?.via || null,
        lastError: nextState?.lastError || '',
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

    if (browserBridgeState.available) {
        browserBridgeStatusEl.textContent = `Detected the ${activeBrowser} Cynode bridge. Imports available: ${capabilities}.`;
    } else if (preferredBrowser !== 'unknown') {
        browserBridgeStatusEl.textContent = `No Cynode bridge detected for ${preferredBrowser}. Install the recommended extension below, then click Detect Extension.`;
    } else {
        browserBridgeStatusEl.textContent = 'No Cynode bridge detected. Install the extension for your browser below, then click Detect Extension.';
    }

    updateBrowserInstallCards();

    const canImport = browserBridgeState.available === true;
    if (importTabsBtn) importTabsBtn.disabled = !canImport;
    if (importBookmarksBtn) importBookmarksBtn.disabled = !canImport;
    if (importHistoryBtn) importHistoryBtn.disabled = !canImport;
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
}

async function refreshBrowserBridgeStatus({ silent = false } = {}) {
    try {
        await requestBrowserBridge('ping', {});
    } catch (error) {
        setBrowserBridgeState({
            available: false,
            browser: detectBrowserFamily(),
            capabilities: [],
            via: null,
            lastError: error && error.message ? String(error.message) : 'bridge_unavailable',
        });
        if (!silent) {
            alert('The browser extension was not detected. Install the matching extension for this browser, then click Detect Extension again.');
        }
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
        alert('Cannot import 0 items. Ensure node count is greater than 0.');
        return;
    }

    try {
        const response = await requestBrowserBridge(source, { limit });
        const items = Array.isArray(response.items) ? response.items.slice(0, limit) : [];
        if (items.length < 1) {
            alert(`No ${actionLabel} were returned by the extension.`);
            return;
        }

        if (!confirm(`This will replace existing URLs for the first ${items.length} nodes with ${actionLabel}. Continue?`)) {
            return;
        }

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
        alert(`Unable to import ${actionLabel}. Install or refresh the Cynode browser extension for this browser, then try again.`);
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
    browserBridgeStatusEl = document.getElementById('browserBridgeStatus');
    browserBridgeRefreshBtn = document.getElementById('browserBridgeRefreshBtn');
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
    topicInput?.addEventListener('input', () => setGraphTopicFromInput(topicInput.value));

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
        // 1. Populate the Multi-node QR Code dropdown (Priority 1)
        const qrSelect = document.getElementById('qrSavedGraphSelect');
        if (qrSelect) {
            qrSelect.innerHTML = '<option value="">-- Select Saved Graph --</option>';
            
            // Add current active graph if shared
            if (currentSavedShareCode) {
                const optCurrent = document.createElement('option');
                optCurrent.value = `https://${window.location.host}/v/${currentSavedShareCode}`;
                optCurrent.textContent = `★ Current: ${graphTopic || currentSavedShareCode}`;
                qrSelect.appendChild(optCurrent);
            }

            // Extract codes/topics from Saved URL Nodes
            if (Array.isArray(items) && items.length > 0) {
                items.forEach(it => {
                    const code = it.code || (it.shareUrl ? it.shareUrl.split('/').pop() : '');
                    if (!code) return;
                    
                    const opt = document.createElement('option');
                    // Ensure full URL for QR scanners
                    opt.value = it.shareUrl || `https://${window.location.host}/v/${code}`;
                    const ns = it.namespace ? `[${it.namespace}] ` : '';
                    const label = it.topic ? `${it.topic} (${code})` : code;
                    opt.textContent = `${ns}${label}`;
                    qrSelect.appendChild(opt);
                });
                console.log(`[QRGen] Dropdown populated with ${items.length} nodes from profile.`);
            }
        }

        // 2. Render the visible list in sidepanel (Priority 2)
        if (!savedLinks) return;
        savedLinks.innerHTML = '';

        if (!items || items.length === 0) {
            const div = document.createElement('div');
            div.className = 'saved-links-empty';
            div.textContent = 'No saved node sets yet.';
            savedLinks.appendChild(div);
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
                    await loadSavedOrSharedGraphIntoEditor(it.code, { origin: 'saved', enableShareAnalytics: false, editableAsShared: false });
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
                    await loadSavedOrSharedGraphIntoEditor(it.code, { origin: 'saved', enableShareAnalytics: false, editableAsShared: false });
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

            savedLinks.appendChild(wrap);
        }
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
            renderSavedLinks(Array.isArray(items) ? items : []);
        } catch (_) {
            renderSavedLinks([]);
        }
    }

    // Auth UI (optional)
    try {
        const me = await apiJson('/api/v1/me', { method: 'GET' });
        const user = me && me.user ? me.user : null;
        currentUser = user;
        const orgs = me && Array.isArray(me.organizations) ? me.organizations : [];
        if (user) {
            if (authStatus) authStatus.textContent = `Signed in as ${user.handle}`;
            if (signOutBtn) signOutBtn.style.display = '';
            if (signInBtn) signInBtn.style.display = 'none';
            if (authForm) authForm.style.display = 'none';
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
        } else {
            currentUser = null;
            if (authStatus) authStatus.textContent = 'Not signed in';
            if (signInBtn) signInBtn.style.display = '';
            if (authForm) authForm.style.display = 'none';
            if (tierOverview) tierOverview.textContent = '';
            if (saveAsSelect) saveAsSelect.innerHTML = '';
            renderSavedLinks([]);
            if (billingSection) billingSection.style.display = 'none';
            if (dashboardSection) dashboardSection.style.display = 'none';
        }
    } catch (e) {
        currentUser = null;
        // Backend may not expose auth in some deployments; keep UI quiet.
        if (authStatus) authStatus.textContent = '';
        if (signInBtn) signInBtn.style.display = '';
        if (tierOverview) tierOverview.textContent = '';
        if (saveAsSelect) saveAsSelect.innerHTML = '';
        renderSavedLinks([]);
        if (billingSection) billingSection.style.display = 'none';
        if (dashboardSection) dashboardSection.style.display = 'none';
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


    // Load shared data (if present), otherwise load saved data.
    const loadedShare = await tryLoadShareFromUrl();
    if (!loadedShare) {
        await loadSavedNodeData();
    }

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


    // --- Add Event Listeners ---

    // Controls
    document.getElementById('setNodeCountBtn')?.addEventListener('click', updateNodeCount);
    document.getElementById('setNodeTimerBtn')?.addEventListener('click', () => {
        const input = document.getElementById('nodeTimer');
        if (!input) return;
        const val = Number(input.value);
        if (!Number.isFinite(val) || val < 1) return;
        
        normalPlaybackDelaySec = val;
        
        // UX Enhancement: If they set the normal timer, assume they want to use it
        if (isEditingMode) {
            isEditingMode = false;
            if (typeof window._updatePlaybackModeUI === 'function') {
                window._updatePlaybackModeUI();
            }
            console.log(`[Settings] Auto-switched to Normal Mode because user updated the main timer.`);
        }

        persistPlaybackSettings();
        console.log(`[Settings] Normal Mode set to ${val}s. Applied to Global Engine.`);
        alert(`Normal mode playback delay set to ${val} seconds.`);
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
        try {
            const exportSnapshot = buildNormalizedExportSnapshot();
            if (!exportSnapshot) {
                alert('Add at least one loaded node URL before sharing.');
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
        try {
            const exportSnapshot = buildNormalizedExportSnapshot();
            if (!exportSnapshot) {
                alert('Add at least one loaded node URL before saving.');
                return;
            }
            if (!confirmNormalizedExport('Saving this nodegraph', exportSnapshot)) return;
            const organizationId = saveAsSelect && saveAsSelect.value ? saveAsSelect.value : undefined;
            const res = await apiJson('/api/v1/saved', {
                method: 'POST',
                body: JSON.stringify({
                    nodeCount: exportSnapshot.nodeCount,
                    lastSelectedNode: exportSnapshot.lastSelectedNode,
                    nodeUrls: exportSnapshot.nodeUrls,
                    nodeCaptions: exportSnapshot.nodeCaptions,
                    nodePauseSecByNode: exportSnapshot.nodePauseSecByNode,
                    organizationId,
                    topic: graphTopic || undefined,
                }),
            });
            if (res && res.shareUrl) {
                // Bind the current topic to this saved code so deleting it can clear the topic display.
                if (res.code && typeof res.code === 'string') {
                    graphTopicOrigin = `saved:${res.code}`;
                    try { localStorage.setItem(GRAPH_TOPIC_ORIGIN_KEY, graphTopicOrigin); } catch (_) { }
                    currentSavedShareCode = res.code;
                    updateUpdateSavedButton();
                }

                // Best-effort: publish any voice/background audio to the saved short code so it works for anyone opening it.
                if (res.code) {
                    try { await uploadSavedMedia(res.code, exportSnapshot); } catch (_) { }
                }

                // Prepend to the list.
                const existing = savedLinks ? Array.from(savedLinks.querySelectorAll('a.saved-link')).map(a => a.href) : [];
                if (!existing.includes(res.shareUrl)) {
                    await refreshSavedLinks();
                }
                try { await navigator.clipboard.writeText(res.shareUrl); } catch (_) { }
                window.prompt('Saved link (copied if supported):', res.shareUrl);
            }
        } catch (e) {
            console.warn('Failed to save node set.', e);
            alert('Unable to save. Please sign in first.');
        }
    });
    updateSavedBtn?.addEventListener('click', async () => {
        if (!currentSavedShareCode) return;
        try {
            const exportSnapshot = buildNormalizedExportSnapshot();
            if (!exportSnapshot) {
                alert('Add at least one loaded node URL before updating.');
                return;
            }
            if (!confirmNormalizedExport('Updating this saved nodegraph', exportSnapshot)) return;
            const res = await apiJson(`/api/v1/saved/${encodeURIComponent(currentSavedShareCode)}`, {
                method: 'PUT',
                body: JSON.stringify({
                    nodeCount: exportSnapshot.nodeCount,
                    lastSelectedNode: exportSnapshot.lastSelectedNode,
                    nodeUrls: exportSnapshot.nodeUrls,
                    nodeCaptions: exportSnapshot.nodeCaptions,
                    nodePauseSecByNode: exportSnapshot.nodePauseSecByNode,
                    topic: graphTopic || undefined,
                }),
            });
            try { await uploadSavedMedia(currentSavedShareCode, exportSnapshot); } catch (_) { }
            if (res && res.shareUrl) {
                await refreshSavedLinks();
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
        if (!qrSavedGraphSelect || !qrDisplayArea) return;
        const targetUrl = qrSavedGraphSelect.value;
        if (!targetUrl) {
            alert("Please select a saved nodegraph from the dropdown above to continue.");
            return;
        }

        // Show loading state
        qrDisplayArea.innerHTML = '<div class="settings-hint" style="text-align:center; padding: 10px;">Creating Multinode QR...</div>';
        
        // Use QRServer API for high-res generation
        const qrSize = 400; 
        const qrApi = `https://api.qrserver.com/v1/create-qr-code/?size=${qrSize}x${qrSize}&data=${encodeURIComponent(targetUrl)}&margin=10&format=png`;
        
        const img = new Image();
        img.className = 'qr-image';
        img.alt = 'Multinode QR Code';
        img.style.width = '160px'; // Visual size in panel
        img.onload = () => {
            qrDisplayArea.innerHTML = '';
            qrDisplayArea.appendChild(img);
            
            const actionContainer = document.createElement('div');
            actionContainer.style.marginTop = '10px';
            actionContainer.style.display = 'flex';
            actionContainer.style.flexDirection = 'column';
            actionContainer.style.alignItems = 'center';
            actionContainer.style.gap = '6px';

            const dl = document.createElement('a');
            dl.className = 'qr-download-link';
            dl.href = qrApi;
            dl.download = `cynode-multi-qr-${Date.now()}.png`;
            dl.target = '_blank';
            dl.innerHTML = '<i class="fas fa-download"></i> Download QR Image';
            actionContainer.appendChild(dl);

            const hint = document.createElement('div');
            hint.className = 'settings-hint';
            hint.style.fontSize = '10px';
            hint.style.textAlign = 'center';
            hint.textContent = "Scanners will follow your multi-link path.";
            actionContainer.appendChild(hint);

            qrDisplayArea.appendChild(actionContainer);
            console.log(`[QRGen] Generated QR for: ${targetUrl}`);
        };
        img.onerror = () => {
            qrDisplayArea.innerHTML = '<div class="auth-error">Failed to generate QR code. Service may be down.</div>';
        };
        img.src = qrApi;
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
