// =====================================================================
// play.js — Story Mode / Guided Tour Playback Engine
// =====================================================================

// --- State ---
let isPlaying = false;
let currentPlayingIndex = 1;
let playTimer = null;
let _playCycleId = 0; // State tracker to prevent race conditions in async recursion
const PLAY_DELAY = 7000;

// --- DOM Elements ---
let pageViewerContainer;
let viewerFrame;
let playPauseBtn;
let playIcon;
let pauseIcon;
let playIconSvg;
let pauseIconSvg;
let storyProgressEl;
let storyCounterEl;
let storyCaptionEl;
let storyCaptionTitleEl;
let storyCaptionTextEl;
let storyCaptionUrlEl;
let storyVoiceEl;
let storyTopicEl;
let storyNavPrevEl;
let storyNavNextEl;
let immersiveToggleEl;
let immersiveExitEl;
let previewContainerEl;

// --- Shared Callbacks (set by script.js via setupPlay) ---
let _nodeUrls = {};
let _nodeCaptions = {};
let _graphTopic = '';
let _getCurrentNodeCountCallback = () => 0;
let _updateRecentUrlCallback = () => {};
let _highlightPlayingNodeCallback = () => {};
let _hasValidUrlsCallback = () => false;
let _getPlaybackDelayMsCallback = null;
let _playVoiceForNodeCallback = null;
let _onPlaybackStartCallback = null;
let _onPlaybackStopCallback = null;
let _onNodeChangedCallback = null;
let _analyticsEventCallback = null;
let _resolveUrlForViewerCallback = null;

// --- Metadata Cache ---
let failedFaviconDomains = new Set();
const metadataCache = new Map();
const metadataRequestCache = new Map();
let previewLoadToken = 0;

// --- Immersive State ---
let _isImmersive = false;

// --- Story Mode Helpers ---
/** Build ordered list of node indices that have URLs. */
function getLoadedNodes() {
    const count = _getCurrentNodeCountCallback();
    const loaded = [];
    for (let i = 1; i <= count; i++) {
        if (_nodeUrls[i] && String(_nodeUrls[i]).trim()) loaded.push(i);
    }
    return loaded;
}

// --- Escaping ---
function escapeHtml(value) {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function escapeAttr(value) { return escapeHtml(String(value).trim()); }

function escapeJsString(value) {
    return String(value).replaceAll('\\', '\\\\').replaceAll("'", "\\'");
}

function isHttpUrl(value) {
    try { const u = new URL(String(value)); return u.protocol === 'http:' || u.protocol === 'https:'; } catch (_) { return false; }
}

function safeHostname(value) {
    try { return new URL(String(value)).hostname || ''; } catch (_) { return ''; }
}

function isBlobOrDataUrl(value) {
    const s = String(value || '').trim();
    return s.startsWith('blob:') || s.startsWith('data:');
}

// =====================================================================
//  INITIALIZATION
// =====================================================================

function setupPlay(config) {
    pageViewerContainer = document.getElementById('pageViewer');
    playPauseBtn = document.getElementById('playPauseBtn');
    playIcon = document.getElementById('playIcon');
    pauseIcon = document.getElementById('pauseIcon');
    playIconSvg = document.getElementById('playIconSvg');
    pauseIconSvg = document.getElementById('pauseIconSvg');
    previewContainerEl = document.getElementById('previewContainer');

    // Story mode DOM
    storyProgressEl = document.getElementById('storyProgress');
    storyCounterEl = document.getElementById('storyCounter');
    storyCaptionEl = document.getElementById('storyCaption');
    storyCaptionTitleEl = document.getElementById('storyCaptionTitle');
    storyCaptionTextEl = document.getElementById('storyCaptionText');
    storyCaptionUrlEl = document.getElementById('storyCaptionUrl');
    storyVoiceEl = document.getElementById('storyVoice');
    storyTopicEl = document.getElementById('storyTopic');
    storyNavPrevEl = document.getElementById('storyNavPrev');
    storyNavNextEl = document.getElementById('storyNavNext');
    immersiveToggleEl = document.getElementById('immersiveToggle');
    immersiveExitEl = document.getElementById('immersiveExit');

    if (!pageViewerContainer || !playPauseBtn || !playIcon || !pauseIcon) {
        console.error('Play module UI initialization failed: Required DOM elements not found.');
        if (playPauseBtn) playPauseBtn.disabled = true;
        return;
    }

    _nodeUrls = config.nodeUrlsRef;
    _nodeCaptions = config.nodeCaptionsRef || {};
    _graphTopic = config.graphTopicRef || '';
    _isEditingMode = config.isEditingModeRef || (() => false);
    _getCurrentNodeCountCallback = config.getCurrentNodeCountFunc;
    _updateRecentUrlCallback = config.updateRecentUrlFunc;
    _highlightPlayingNodeCallback = config.highlightPlayingNodeFunc;
    _hasValidUrlsCallback = config.hasValidUrlsFunc;
    _getPlaybackDelayMsCallback = typeof config.getPlaybackDelayMsFunc === 'function' ? config.getPlaybackDelayMsFunc : null;
    _playVoiceForNodeCallback = typeof config.playVoiceForNodeFunc === 'function' ? config.playVoiceForNodeFunc : null;
    _onPlaybackStartCallback = typeof config.onPlaybackStartFunc === 'function' ? config.onPlaybackStartFunc : null;
    _onPlaybackStopCallback = typeof config.onPlaybackStopFunc === 'function' ? config.onPlaybackStopFunc : null;
    _onNodeChangedCallback = typeof config.onNodeChangedFunc === 'function' ? config.onNodeChangedFunc : null;
    _analyticsEventCallback = typeof config.analyticsEventFunc === 'function' ? config.analyticsEventFunc : null;
    _resolveUrlForViewerCallback = typeof config.resolveUrlForViewerFunc === 'function' ? config.resolveUrlForViewerFunc : null;

    createViewerContainer();

    // postMessage handler for "Visit Website" links in preview iframe
    window.addEventListener('message', (ev) => {
        const d = ev && ev.data ? ev.data : null;
        if (!d) return;
        
        if (d.t === 'cynode_favicon_error' && d.host) {
            failedFaviconDomains.add(d.host);
            return;
        }

        if (d.t !== 'nodex_visit') return;
        const nodeIndex = Number(d.nodeId);
        const url = typeof d.url === 'string' ? d.url : null;
        if (_analyticsEventCallback && Number.isFinite(nodeIndex)) {
            try { void _analyticsEventCallback('node_visit', nodeIndex, url || undefined); } catch (_) {}
        }
    });

    // Play/pause button
    playPauseBtn.addEventListener('click', () => {
        if (!_hasValidUrlsCallback()) {
            alert('Please add some URLs to the nodes before playing.');
            return;
        }
        togglePlay();
    });

    // Navigation tap zones
    storyNavPrevEl?.addEventListener('click', (e) => { 
        if (isPlaying) {
            e.stopPropagation();
            skipToDirection(-1); 
        }
    });
    storyNavNextEl?.addEventListener('click', (e) => { 
        if (isPlaying) {
            e.stopPropagation();
            skipToDirection(1); 
        }
    });

    // Keyboard navigation (arrows)
    document.addEventListener('keydown', (e) => {
        if (!isPlaying) return;
        if (e.key === 'ArrowLeft') { e.preventDefault(); skipToDirection(-1); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); skipToDirection(1); }
        else if (e.key === 'Escape' && _isImmersive) { e.preventDefault(); exitImmersive(); }
    });

    // Immersive mode
    immersiveToggleEl?.addEventListener('click', () => toggleImmersive());
    immersiveExitEl?.addEventListener('click', () => exitImmersive());

    console.log("Playback module initialized (Story Mode).");
}


// =====================================================================
//  VIEWER / IFRAME
// =====================================================================

function createViewerContainer() {
    if (!pageViewerContainer) {
        console.error("pageViewer container element not found. Cannot create iframe.");
        return;
    }
    if (!viewerFrame) {
        const iframe = document.createElement('iframe');
        iframe.id = 'viewerFrame';
        iframe.sandbox = "allow-scripts allow-popups";
        iframe.srcdoc = '<p style="text-align: center; padding: 40px 20px; color: #666; font-family: -apple-system, BlinkMacSystemFont, \'Segoe UI\', Roboto, Arial, sans-serif;">Preview will load here when playing or selecting a node.</p>';
        viewerFrame = iframe;
        // Insert iframe at the beginning (before overlay elements)
        pageViewerContainer.insertBefore(viewerFrame, pageViewerContainer.firstChild);

        viewerFrame.onerror = () => {
            console.error("Error loading content into viewer frame (srcdoc).");
            viewerFrame.srcdoc = '<p style="text-align: center; color: red; padding: 20px;">Error loading preview content.</p>';
        };
    }
}


// =====================================================================
//  STORY-MODE UI MANAGEMENT
// =====================================================================

function showStoryUI() {
    const loaded = getLoadedNodes();
    if (storyProgressEl) storyProgressEl.classList.add('active');
    if (storyCounterEl) storyCounterEl.classList.add('active');
    if (storyNavPrevEl) storyNavPrevEl.classList.add('active');
    if (storyNavNextEl) storyNavNextEl.classList.add('active');
    if (immersiveToggleEl) immersiveToggleEl.classList.add('active');

    // Show topic badge if set
    const topic = typeof _graphTopic === 'function' ? _graphTopic() : String(_graphTopic || '');
    if (storyTopicEl) {
        if (topic.trim()) {
            storyTopicEl.textContent = topic.trim();
            storyTopicEl.classList.add('active');
        } else {
            storyTopicEl.classList.remove('active');
        }
    }

    buildProgressSegments(loaded);
}

function hideStoryUI() {
    if (storyProgressEl) storyProgressEl.classList.remove('active');
    if (storyCounterEl) storyCounterEl.classList.remove('active');
    if (storyCaptionEl) storyCaptionEl.classList.remove('visible');
    if (storyVoiceEl) storyVoiceEl.classList.remove('active');
    if (storyTopicEl) storyTopicEl.classList.remove('active');
    if (storyNavPrevEl) storyNavPrevEl.classList.remove('active');
    if (storyNavNextEl) storyNavNextEl.classList.remove('active');
    if (immersiveToggleEl) immersiveToggleEl.classList.remove('active');
}

function buildProgressSegments(loaded) {
    if (!storyProgressEl) return;
    storyProgressEl.innerHTML = '';
    for (let i = 0; i < loaded.length; i++) {
        const seg = document.createElement('div');
        seg.className = 'story-seg future';
        seg.dataset.index = i;
        seg.dataset.nodeId = loaded[i];
        const fill = document.createElement('div');
        fill.className = 'story-seg-fill';
        seg.appendChild(fill);
        seg.addEventListener('click', () => {
            if (isPlaying) jumpToNode(loaded[i]);
        });
        storyProgressEl.appendChild(seg);
    }
}

function updateProgressForNode(nodeId, delayMs) {
    if (!storyProgressEl) return;
    const loaded = getLoadedNodes();
    const idx = loaded.indexOf(nodeId);
    const segs = storyProgressEl.querySelectorAll('.story-seg');
    segs.forEach((seg, i) => {
        seg.classList.remove('past', 'active-seg', 'future');
        if (i < idx) seg.classList.add('past');
        else if (i === idx) {
            seg.classList.add('active-seg');
            seg.style.setProperty('--story-dur', `${Math.max(0.3, (delayMs || PLAY_DELAY) / 1000)}s`);
        }
        else seg.classList.add('future');
    });
}

function updateCounter(nodeId) {
    if (!storyCounterEl) return;
    const loaded = getLoadedNodes();
    const idx = loaded.indexOf(nodeId);
    storyCounterEl.textContent = `${idx + 1} of ${loaded.length}`;
}

function showCaption(nodeId, url) {
    if (!storyCaptionEl) return;
    const cap = _nodeCaptions[nodeId];
    const hasTitle = cap && cap.title && cap.title.trim();
    const hasCaption = cap && cap.caption && cap.caption.trim();
    const hasUrl = url && isHttpUrl(url);

    if (!hasTitle && !hasCaption && !hasUrl) {
        storyCaptionEl.classList.remove('visible');
        return;
    }

    // Force a re-trigger of the slide-up animation
    storyCaptionEl.classList.remove('visible');
    // Trigger reflow so removing and re-adding the class actually replays the transition
    void storyCaptionEl.offsetWidth;

    if (storyCaptionTitleEl) storyCaptionTitleEl.textContent = hasTitle ? cap.title.trim() : '';
    if (storyCaptionTextEl) storyCaptionTextEl.textContent = hasCaption ? cap.caption.trim() : '';
    if (storyCaptionUrlEl) {
        if (hasUrl) {
            const host = safeHostname(url) || url;
            storyCaptionUrlEl.textContent = host;
            storyCaptionUrlEl.href = url;
            storyCaptionUrlEl.style.display = '';
        } else {
            storyCaptionUrlEl.style.display = 'none';
            storyCaptionUrlEl.href = '#';
            storyCaptionUrlEl.textContent = '';
        }
    }

    storyCaptionEl.classList.add('visible');
}

function showVoiceIndicator(show) {
    if (!storyVoiceEl) return;
    if (show) storyVoiceEl.classList.add('active');
    else storyVoiceEl.classList.remove('active');
}


// =====================================================================
//  IMMERSIVE MODE
// =====================================================================

function toggleImmersive() {
    if (_isImmersive) exitImmersive();
    else enterImmersive();
}

function enterImmersive() {
    if (!previewContainerEl) return;
    _isImmersive = true;
    previewContainerEl.classList.add('immersive');
    if (immersiveExitEl) {
        immersiveExitEl.hidden = false;
        immersiveExitEl.setAttribute('aria-hidden', 'false');
        immersiveExitEl.classList.add('visible');
    }
    if (immersiveToggleEl) immersiveToggleEl.textContent = '⛶';
}

function exitImmersive() {
    if (!previewContainerEl) return;
    _isImmersive = false;
    previewContainerEl.classList.remove('immersive');
    if (immersiveExitEl) {
        immersiveExitEl.classList.remove('visible');
        immersiveExitEl.hidden = true;
        immersiveExitEl.setAttribute('aria-hidden', 'true');
    }
    if (immersiveToggleEl) immersiveToggleEl.textContent = '⛶';
}


// =====================================================================
//  NAVIGATION (skip forward/back during playback)
// =====================================================================

function skipToDirection(direction) {
    if (!isPlaying) return;
    const loaded = getLoadedNodes();
    if (loaded.length === 0) return;
    const curIdx = loaded.indexOf(currentPlayingIndex);
    let nextIdx = curIdx + direction;
    if (nextIdx < 0) nextIdx = loaded.length - 1;
    if (nextIdx >= loaded.length) nextIdx = 0;
    jumpToNode(loaded[nextIdx]);
}

function jumpToNode(nodeId) {
    if (!isPlaying) return;
    // Cancel current timer and play the target node immediately.
    _playCycleId++; // New thread of execution
    currentPlayingIndex = nodeId;
    void playNodeInSequence(nodeId, _playCycleId);
}


// =====================================================================
//  TOGGLE / PLAY / STOP
// =====================================================================

function togglePlay() {
    if (!playPauseBtn) return;

    if (!isPlaying) {
        isPlaying = true;
        _playCycleId++; // Start a new sequence "thread"
        if (playIcon) playIcon.style.display = 'none';
        if (pauseIcon) pauseIcon.style.display = 'inline-block';
        if (playIconSvg) playIconSvg.style.display = 'none';
        if (pauseIconSvg) pauseIconSvg.style.display = 'inline-block';
        playPauseBtn.title = "Pause sequence";
        startPlaySequence();
    } else {
        isPlaying = false;
        _playCycleId++; // Cancel active recursive calls via ID mismatch
        if (playIcon) playIcon.style.display = 'inline-block';
        if (pauseIcon) pauseIcon.style.display = 'none';
        if (playIconSvg) playIconSvg.style.display = 'inline-block';
        if (pauseIconSvg) pauseIconSvg.style.display = 'none';
        playPauseBtn.title = "Play sequence";
        stopPlaySequence();
    }
}

function isPlayingInModule() {
    return !!isPlaying;
}

function startPlaybackInModule() {
    if (!isPlaying) togglePlay();
}

function startPlaySequence() {
    if (playTimer) { clearTimeout(playTimer); playTimer = null; }

    // Resolve the first node to play (starts from current if valid, else finds next loaded)
    let firstNode = findNextLoadedNodeIndex(currentPlayingIndex);
    if (firstNode === 0) {
        console.warn("No URLs loaded to play.");
        stopPlaySequence();
        return;
    }

    if (_onPlaybackStartCallback) {
        try { void _onPlaybackStartCallback(); } catch (_) {}
    }
    if (_analyticsEventCallback) {
        try { void _analyticsEventCallback('play_start'); } catch (_) {}
    }

    showStoryUI();
    // Start the first node. We don't increment _playCycleId here because togglePlay already did.
    void playNodeInSequence(firstNode, _playCycleId);
}

async function playNodeInSequence(nodeId, cycleId) {
    if (!isPlaying || cycleId !== _playCycleId) return;

    // Outer wrapper to ensure a failure in one node doesn't kill the entire loop
    try {
        if (!nodeId) {
            console.debug("No valid nodeId to play, stopping sequence.");
            stopPlaySequence();
            return;
        }

        const startTime = Date.now();
        currentPlayingIndex = Number(nodeId); // FORCE NUMBER to prevent string concat bugs ('1'+1='11')
        const url = _nodeUrls[currentPlayingIndex];

        // 1. Initial UI updates
        updateCounter(currentPlayingIndex);
        showCaption(currentPlayingIndex, url);
        _updateRecentUrlCallback(currentPlayingIndex, true);

        // 2. Load the URL Content
        const editing = typeof _isEditingMode === 'function' ? _isEditingMode() : !!_isEditingMode;
        
        try {
            if (!editing) {
                // strict interval mode: Don't block the timer, just start loading.
                void loadUrlInViewer(url, currentPlayingIndex);
            } else {
                // editing mode: Wait for load so voice alignment is perfect.
                await loadUrlInViewer(url, currentPlayingIndex);
            }
        } catch (loadErr) {
            console.error(`Preview load failed for Node ${currentPlayingIndex}:`, loadErr);
        }

        // Safety check: User might have paused or skipped
        if (!isPlaying || cycleId !== _playCycleId) return;

        // 3. Narrative logic (Voice)
        let voiceMs = 0;
        
        if (editing && _playVoiceForNodeCallback) {
            showVoiceIndicator(true);
            try {
                voiceMs = (await _playVoiceForNodeCallback(currentPlayingIndex)) || 0;
            } catch (vErr) {
                console.warn(`Voice error on Node ${nodeId}:`, vErr);
                voiceMs = 0;
            }
            showVoiceIndicator(false);
        } else {
            showVoiceIndicator(false);
        }

        // Final safety check after all awaits
        if (!isPlaying || cycleId !== _playCycleId) return;

        // 4. Determine Timing
        // getPlaybackDelayMs handles the Normal (simple) vs Editing (complex) logic
        const totalNodeDelayMs = _getPlaybackDelayMsCallback 
            ? _getPlaybackDelayMsCallback(currentPlayingIndex, voiceMs)
            : Math.max(PLAY_DELAY || 7000, voiceMs);

        // 5. Calculate Loop Progression (prevent '1' + 1 = '11' bug)
        let nextNode = findNextLoadedNodeIndex(Number(currentPlayingIndex) + 1);
        
        // Safety wrap
        if (!nextNode) {
            nextNode = findNextLoadedNodeIndex(1); 
        }

        // 6. Schedule Next Node
        const timeSpentAlready = Date.now() - startTime;
        let targetMs = Number(totalNodeDelayMs);
        if (!Number.isFinite(targetMs) || targetMs < 100) targetMs = 7000;

        // If not editing, use strict interval. If editing, ensure we don't negative-delay.
        let remainingDelay = targetMs;
        if (editing) {
            remainingDelay = Math.max(1500, targetMs - timeSpentAlready);
        } else {
            // Strict timer for Normal mode - subtract what little time UI updates took
            remainingDelay = Math.max(500, targetMs - timeSpentAlready);
        }
        
        console.log(`[Playback] Node ${currentPlayingIndex} -> Next ${nextNode || 'STOP'}. Load block: ${timeSpentAlready}ms. Sleep: ${remainingDelay}ms (Target: ${targetMs}ms).`);

        updateProgressForNode(currentPlayingIndex, remainingDelay);

        if (playTimer) clearTimeout(playTimer);
        playTimer = setTimeout(() => {
            if (!isPlaying || cycleId !== _playCycleId) return;
            // If we have a next node, go!
            if (nextNode && (nextNode !== nodeId || getLoadedNodes().length === 1)) {
                void playNodeInSequence(nextNode, cycleId);
            } else {
                console.warn("[Playback] No valid next node found. Stopping sequence.");
                stopPlaySequence();
            }
        }, remainingDelay);

    } catch (criticalErr) {
        console.error("Critical error in playback loop:", criticalErr);
        // Recovery: Wait 3s and try to skip to node 1 if possible
        if (playTimer) clearTimeout(playTimer);
        playTimer = setTimeout(() => {
            if (!isPlaying || cycleId !== _playCycleId) return;
            const fallbackNode = findNextLoadedNodeIndex(1);
            if (fallbackNode) {
                void playNodeInSequence(fallbackNode, cycleId);
            } else {
                stopPlaySequence();
            }
        }, 3000);
    }
}

function stopPlaySequence() {
    if (playTimer) { clearTimeout(playTimer); playTimer = null; }
    if (isPlaying) {
        isPlaying = false;
        if (playPauseBtn) {
            if (playIcon) playIcon.style.display = 'inline-block';
            if (pauseIcon) pauseIcon.style.display = 'none';
            if (playIconSvg) playIconSvg.style.display = 'inline-block';
            if (pauseIconSvg) pauseIconSvg.style.display = 'none';
            playPauseBtn.title = "Play sequence";
        }
    }
    hideStoryUI();
    if (_isImmersive) exitImmersive();
    if (_onPlaybackStopCallback) {
        try { _onPlaybackStopCallback(); } catch (_) {}
    }
    if (_analyticsEventCallback) {
        try { void _analyticsEventCallback('play_stop'); } catch (_) {}
    }
    _highlightPlayingNodeCallback(null);
}


// =====================================================================
//  VIEWER / PREVIEW RENDERING
// =====================================================================

async function fetchUrlMetadata(url) {
    if (!url) return null;
    const cacheKey = `metadata_${url}`;
    if (metadataCache.has(cacheKey)) return metadataCache.get(cacheKey);
    if (metadataRequestCache.has(cacheKey)) return metadataRequestCache.get(cacheKey);
    const apiUrl = `https://api.microlink.io/?url=${encodeURIComponent(url)}&palette=true&audio=false&video=false`;

    const request = (async () => {
        // Add a 3s timeout to metadata fetch to avoid blocking playback timing
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000);

        try {
            const response = await fetch(apiUrl, { signal: controller.signal });
            clearTimeout(timeoutId);
            if (!response.ok) {
                const msg = `Microlink preview unavailable for ${url}: ${response.status}`;
                if (response.status >= 400 && response.status < 500) {
                    // Use debug level for 4xx to keep console clean for common blocked sites
                    console.debug(msg);
                } else {
                    console.error(msg);
                }
                metadataCache.set(cacheKey, null);
                return null;
            }
            const data = await response.json();
            if (data.status === 'success' && data.data) {
                metadataCache.set(cacheKey, data.data);
                return data.data;
            } else {
                console.warn(`Microlink API returned '${data.status}' for ${url}.`);
                metadataCache.set(cacheKey, null);
                return null;
            }
        } catch (error) {
            console.warn(`Network error fetching metadata for ${url}:`, error);
            metadataCache.set(cacheKey, null);
            return null;
        } finally {
            metadataRequestCache.delete(cacheKey);
        }
    })();

    metadataRequestCache.set(cacheKey, request);
    return request;
}

async function renderRichFilePreview(url, meta, nodeId, loadToken) {
    if (!url || !viewerFrame) return false;
    
    const mime = (meta && meta.mimeType) ? String(meta.mimeType).toLowerCase() : '';
    const name = (meta && meta.name) ? String(meta.name) : 'File';
    const size = (meta && meta.sizeBytes) ? Number(meta.sizeBytes) : 0;

    // Helper for large file warning
    const isTooLarge = size > 15 * 1024 * 1024; // 15MB limit for rich browser-side processing

    // 1. Text / Code (Highlight.js)
    const isCode = mime.startsWith('text/') || 
                   mime === 'application/json' || 
                   mime === 'application/javascript' || 
                   mime === 'application/xml' ||
                   (name.match(/\.(js|ts|py|go|rs|c|cpp|h|java|sh|md|txt|yaml|yml|json|css|html|sql|xml|csv)$/i) && !mime.includes('image'));

    if (isCode && !isTooLarge) {
        try {
            const resp = await fetch(url);
            const text = await resp.text();
            if (loadToken !== previewLoadToken) return true;
            
            const escaped = escapeHtml(text);
            const style = `
                body { margin: 0; background: #fafafa; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; }
                pre { padding: 20px; margin: 0; font-size: 13px; line-height: 1.5; white-space: pre-wrap; word-wrap: break-word; }
                .filename-bar { background: #f1f5f9; padding: 8px 20px; border-bottom: 1px solid #e2e8f0; font-size: 11px; font-family: sans-serif; color: #64748b; font-weight: 500; display: flex; justify-content: space-between; }
            `;
            viewerFrame.srcdoc = `
                <style>${style}</style>
                <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css">
                <div class="filename-bar">
                    <span>${escapeHtml(name)}</span>
                    <span>${(size / 1024).toFixed(1)} KB</span>
                </div>
                <pre><code class="hljs">${escaped}</code></pre>
                <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
                <script>setTimeout(() => { try { hljs.highlightAll(); } catch(e) {} }, 50);</script>
            `;
            return true;
        } catch (e) { console.warn("Rich text preview failed", e); }
    }

    // 2. Word (.docx) via Mammoth
    const isDocx = name.toLowerCase().endsWith('.docx') || 
                   mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

    if (isDocx && !isTooLarge && typeof mammoth !== 'undefined') {
        try {
            const arrayBuffer = await (await fetch(url)).arrayBuffer();
            if (loadToken !== previewLoadToken) return true;
            const result = await mammoth.convertToHtml({ arrayBuffer });
            const html = result.value;
            viewerFrame.srcdoc = `
                <style>
                    body { font-family: 'Segoe UI', serif; padding: 40px; line-height: 1.6; color: #333; background: #fff; max-width: 800px; margin: 0 auto; box-shadow: 0 0 20px rgba(0,0,0,0.05); min-height: 100vh; }
                    img { max-width: 100%; height: auto; }
                    h1, h2, h3 { color: #2c3e50; }
                    .docx-header { border-bottom: 1px solid #eee; margin-bottom: 30px; padding-bottom: 10px; font-family: sans-serif; font-size: 12px; color: #999; }
                </style>
                <div class="docx-header">Snapshot of ${escapeHtml(name)}</div>
                <div class="word-preview">${html}</div>
            `;
            return true;
        } catch (e) { console.warn("Docx preview failed", e); }
    }

    // 3. Excel (.xlsx) via SheetJS
    const isExcel = name.toLowerCase().endsWith('.xlsx') || 
                    name.toLowerCase().endsWith('.csv') || 
                    mime.includes('spreadsheet') ||
                    mime.includes('csv');

    if (isExcel && !isTooLarge && typeof XLSX !== 'undefined') {
        try {
            const arrayBuffer = await (await fetch(url)).arrayBuffer();
            if (loadToken !== previewLoadToken) return true;
            const workbook = XLSX.read(arrayBuffer);
            const firstSheetName = workbook.SheetNames[0];
            const worksheet = workbook.Sheets[firstSheetName];
            const html = XLSX.utils.sheet_to_html(worksheet);
            viewerFrame.srcdoc = `
                <style>
                    body { font-family: -apple-system, system-ui, sans-serif; padding: 0; background: #f8fafc; margin: 0; }
                    .excel-container { padding: 20px; }
                    h3 { font-size: 14px; color: #1e293b; margin: 0 0 12px 0; font-weight: 600; }
                    table { border-collapse: collapse; background: white; border: 1px solid #cbd5e1; font-size: 12px; min-width: 100%; }
                    td, th { border: 1px solid #e2e8f0; padding: 6px 10px; text-align: left; }
                    tr:nth-child(even) { background-color: #f8fafc; }
                    th { background: #f1f5f9; font-weight: 600; color: #475569; position: sticky; top: 0; }
                    .sheet-tabs { background: #fff; border-top: 1px solid #e2e8f0; padding: 4px 20px; position: sticky; bottom: 0; font-size: 11px; color: #0b5fff; font-weight: bold; }
                </style>
                <div class="excel-container">
                    <h3>${escapeHtml(name)}</h3>
                    <div style="overflow-x: auto;">${html}</div>
                </div>
                <div class="sheet-tabs">Sheet: ${escapeHtml(firstSheetName)}</div>
            `;
            return true;
        } catch (e) { console.warn("Excel preview failed", e); }
    }

    // 4. Fallback to native (Images, PDF, Video)
    if (mime.startsWith('image/') || mime === 'application/pdf' || mime.startsWith('video/')) {
        try { viewerFrame.sandbox = "allow-scripts allow-popups allow-same-origin"; } catch (_) {}
        try { viewerFrame.srcdoc = ''; } catch (_) {}
        viewerFrame.src = url;
        return true;
    }

    // 5. Generic File Card
    viewerFrame.srcdoc = `
        <style>
            body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; background: #f8fafc; color: #475569; }
            .card { background: white; padding: 32px; border-radius: 16px; border: 1px solid #e2e8f0; text-align: center; max-width: 320px; box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.05); }
            .icon { font-size: 48px; margin-bottom: 16px; display: inline-block; filter: grayscale(0.2); }
            .name { font-weight: 700; color: #0f172a; margin-bottom: 8px; word-break: break-all; line-height: 1.3; }
            .meta { font-size: 13px; color: #94a3b8; margin-bottom: 24px; }
            .btn { display: inline-block; background: #0b5fff; color: white; padding: 10px 24px; border-radius: 8px; text-decoration: none; font-size: 14px; font-weight: 600; border: none; cursor: pointer; }
        </style>
        <div class="card">
            <div class="icon">${isTooLarge ? '🐘' : '📄'}</div>
            <div class="name">${escapeHtml(name)}</div>
            <div class="meta">${(size / 1024 / 1024).toFixed(2)} MB • ${escapeHtml(mime || 'Binary file')}</div>
            <a href="${url}" download="${escapeHtml(name)}" class="btn">Download to View</a>
            ${isTooLarge ? `<div style="font-size:11px; margin-top:10px; color:#94a3b8;">File is too large for in-browser snapshot.</div>` : ''}
        </div>
    `;
    return true;
}

async function loadUrlInViewer(url, nodeId) {
    if (!viewerFrame) {
        console.error('Viewer frame not found, cannot load URL.');
        createViewerContainer();
        if (!viewerFrame) return;
    }

    const loadToken = ++previewLoadToken;

    if (!url || !String(url).trim()) {
        try { viewerFrame.sandbox = "allow-scripts allow-popups"; } catch (_) {}
        viewerFrame.src = 'about:blank';
        viewerFrame.srcdoc = '<p style="text-align: center; padding: 40px 20px; color: #666; font-family: -apple-system, BlinkMacSystemFont, \'Segoe UI\', Roboto, Arial, sans-serif;">Preview will load here when playing or selecting a node.</p>';
        return;
    }

    // Resolve localfile: to blob:
    let resolved = null;
    if (_resolveUrlForViewerCallback) {
        try { resolved = await _resolveUrlForViewerCallback(url, nodeId); } catch (_) { resolved = null; }
    }
    if (loadToken !== previewLoadToken) return;

    if (resolved && resolved.kind === 'localfile') {
        if (!resolved.url) {
            const name = resolved.meta && resolved.meta.name ? String(resolved.meta.name) : 'Local file';
            try { viewerFrame.sandbox = "allow-scripts allow-popups"; } catch (_) {}
            viewerFrame.src = 'about:blank';
            viewerFrame.srcdoc = `<p style="text-align: center; padding: 40px 20px; color: #666; font-family: Arial, sans-serif;">Local file unavailable on this device: ${escapeHtml(name)}</p>`;
            return;
        }

        const handled = await renderRichFilePreview(resolved.url, resolved.meta, nodeId, loadToken);
        if (loadToken !== previewLoadToken) return;
        if (handled) return;

        // Fallback for cases where rich preview wasn't applicable
        try { viewerFrame.sandbox = "allow-scripts allow-popups allow-same-origin"; } catch (_) {}
        try { viewerFrame.srcdoc = ''; } catch (_) {}
        viewerFrame.src = String(resolved.url);
        return;
    }

    const finalUrl = resolved && resolved.url ? String(resolved.url) : String(url || '');
    
    // Check if the remote URL is actually a directly viewable binary file (blob/data)
    if (isBlobOrDataUrl(finalUrl)) {
        const handled = await renderRichFilePreview(finalUrl, resolved ? resolved.meta : null, nodeId, loadToken);
        if (loadToken !== previewLoadToken) return;
        if (handled) return;
    }

    try { viewerFrame.sandbox = "allow-scripts allow-popups"; } catch (_) {}

    // Loading state
    viewerFrame.src = 'about:blank';
    viewerFrame.srcdoc = `<p style="text-align: center; padding: 40px 20px; color: #666; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">Loading preview for Node ${nodeId}...</p>`;

    // Non-web URLs
    if (!isHttpUrl(finalUrl)) {
        const safeUrl = escapeAttr(finalUrl);
        viewerFrame.srcdoc = `
        <style>
            body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; padding: 28px 20px; text-align: center; line-height: 1.6; }
            a { color: #007bff; }
            .box { background-color: #f8f9fa; border: 1px solid #dee2e6; border-radius: 10px; padding: 18px; max-width: 520px; margin: 10px auto; }
        </style>
        <body>
            <div class="box">
                <h3>Preview unavailable</h3>
                <p>This link type cannot be previewed here.</p>
                <p><a href="${safeUrl}" target="_blank" rel="noopener noreferrer">Open link</a></p>
            </div>
        </body>`;
        return;
    }

    const domain = finalUrl.split('/')[2] || finalUrl;
    const safeInitialUrl = escapeAttr(finalUrl);
    const safeInitialUrlJs = escapeJsString(finalUrl);
    const safeInitialDomain = escapeHtml(domain);
    viewerFrame.srcdoc = `
    <style>
        body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; padding: 36px 20px; text-align: center; line-height: 1.6; color: #445; background: #f8fafc; }
        .quick-card { background: #fff; border: 1px solid #e2e8f0; border-radius: 14px; padding: 26px 22px; max-width: 520px; margin: 0 auto; box-shadow: 0 10px 30px rgba(15, 23, 42, 0.06); }
        .quick-domain { font-size: 1.05rem; font-weight: 700; color: #0f172a; margin-bottom: 10px; word-break: break-word; }
        .quick-copy { font-size: 0.95rem; color: #64748b; margin-bottom: 18px; }
        .quick-action { display: inline-block; background: #0b5fff; color: #fff; padding: 10px 18px; border-radius: 8px; font-size: 0.92rem; text-decoration: none; }
    </style>
    <body>
        <div class="quick-card">
            <div class="quick-domain">${safeInitialDomain}</div>
            <div class="quick-copy">Preparing a richer preview. You can already open the live page now.</div>
            <a href="${safeInitialUrl}" target="_blank" rel="noopener noreferrer" class="quick-action"
               onclick="try{parent.postMessage({t:'nodex_visit',nodeId:${nodeId},url:'${safeInitialUrlJs}'},'*')}catch(e){}">Open Website</a>
        </div>
    </body>`;

    // Fetch metadata (async)
    const metadata = await fetchUrlMetadata(finalUrl);
    if (loadToken !== previewLoadToken) return;
    let previewHtml;

    if (metadata) {
        const bgColor = metadata.background_color || '#ffffff';
        const isDarkBg = bgColor.startsWith('#') && parseInt(bgColor.substring(1), 16) < 0xAAAAAA;
        const textColor = metadata.color || (isDarkBg ? '#ffffff' : '#333333');
        const title = metadata.title || finalUrl.split('/')[2] || finalUrl;
        const description = metadata.description || 'No description available.';
        const imageUrl = metadata.image?.url;
        const logoUrl = metadata.logo?.url;

        const host = safeHostname(finalUrl) || finalUrl.split('/')[2] || finalUrl;
        const useFavicon = !failedFaviconDomains.has(host);
        const fallbackFaviconUrl = useFavicon ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32` : '';

        const safeTitle = escapeHtml(title);
        const safeDescription = escapeHtml(description);
        const safeUrl = escapeAttr(finalUrl);
        const safeUrlJs = escapeJsString(finalUrl);
        const safeLogoUrl = isHttpUrl(logoUrl) ? escapeAttr(logoUrl) : (fallbackFaviconUrl ? escapeAttr(fallbackFaviconUrl) : '');
        const safeImageUrl = isHttpUrl(imageUrl) ? escapeAttr(imageUrl) : '';

        previewHtml = `
        <style>
            body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background-color: ${bgColor}; color: ${textColor}; padding: 20px; line-height: 1.5; }
            .preview-content { max-width: 600px; margin: 0 auto; }
            img.preview-image { max-width: 100%; height: auto; max-height: 250px; object-fit: contain; margin-bottom: 15px; border-radius: 4px; box-shadow: 0 2px 5px rgba(0,0,0,0.1); display: block; margin-left: auto; margin-right: auto; }
            h2 { font-size: 1.2em; margin: 0 0 10px 0; display: flex; align-items: center; gap: 8px; font-weight: 600;}
            p { font-size: 0.95em; margin: 0 0 15px 0; }
            a.visit-button { background-color: #007bff; color: white; padding: 10px 15px; text-decoration: none; border-radius: 4px; display: inline-block; font-size: 0.9em; transition: background-color 0.2s; border: none; }
            a.visit-button:hover { background-color: #0056b3; }
            .favicon { width: 20px; height: 20px; vertical-align: middle; flex-shrink: 0; }
        </style>
        <body>
            <div class="preview-content">
                ${safeImageUrl ? `<img src="${safeImageUrl}" class="preview-image" alt="Preview image" onerror="this.style.display='none'">` : ''}
                 <h2> ${safeLogoUrl ? `<img src="${safeLogoUrl}" class="favicon" alt="" onerror="this.style.display='none'; parent.postMessage({t:'cynode_favicon_error', host:'${escapeJsString(host)}'}, '*')">` : ''} <span>${safeTitle}</span> </h2>
                <p>${safeDescription}</p>
                <a href="${safeUrl}" target="_blank" rel="noopener noreferrer" class="visit-button"
                   onclick="try{parent.postMessage({t:'nodex_visit',nodeId:${nodeId},url:'${safeUrlJs}'},'*')}catch(e){}">Visit Website</a>
            </div>
        </body>`;
    } else {
        const domain = finalUrl.split('/')[2] || finalUrl;
        const safeUrl = escapeAttr(finalUrl);
        const safeUrlJs = escapeJsString(finalUrl);
        const safeDomain = escapeHtml(domain);
        const host = safeHostname(finalUrl) || domain;
        const useFavicon = !failedFaviconDomains.has(host);
        const safeFavicon = useFavicon ? escapeAttr(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`) : '';
        previewHtml = `
        <style>
            body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; padding: 40px 20px; text-align: center; line-height: 1.6; color: #444; }
             a { color: #007bff; text-decoration: none; font-weight: 500; }
             a:hover { text-decoration: underline; }
             .favicon { width: 18px; height: 18px; vertical-align: middle; margin-right: 6px; border-radius: 2px; }
             .error-box { background-color: #ffffff; border: 1px solid #e0e0e0; border-radius: 12px; padding: 32px 24px; max-width: 480px; margin: 20px auto; box-shadow: 0 4px 12px rgba(0,0,0,0.05); }
             h3 { margin-top: 0; color: #222; font-size: 1.25rem; }
             p { font-size: 0.95rem; color: #666; margin: 12px 0 20px; }
             .visit-action { display: inline-block; background: #007bff; color: #fff; padding: 10px 20px; border-radius: 6px; font-size: 0.9rem; transition: background 0.2s; }
             .visit-action:hover { background: #0056b3; text-decoration: none; }
        </style>
        <body>
             <div class="error-box">
                ${safeFavicon ? `<img src="${safeFavicon}" class="favicon" alt="" onerror="this.style.display='none'; parent.postMessage({t:'cynode_favicon_error', host:'${escapeJsString(host)}'}, '*')">` : ''}
                <h3>Preview Unavailable</h3>
                <p>We couldn't generate a preview for <strong>${safeDomain}</strong>. The website might be private, require a login, or block automated previews.</p>
                <a href="${safeUrl}" target="_blank" rel="noopener noreferrer" class="visit-action"
                    onclick="try{parent.postMessage({t:'nodex_visit',nodeId:${nodeId},url:'${safeUrlJs}'},'*')}catch(e){}">
                    Open Website
                </a>
             </div>
        </body>`;
    }

    try {
        if (viewerFrame && viewerFrame.contentWindow) {
            viewerFrame.srcdoc = previewHtml;
        }
    } catch (e) {
        console.error("Error setting viewerFrame.srcdoc with final content:", e);
    }
}


// =====================================================================
//  HELPERS (findNextLoadedNodeIndex kept for backward compat)
// =====================================================================

function findLastLoadedNodeIndex() {
    const count = _getCurrentNodeCountCallback();
    for (let i = count; i >= 1; i--) {
        if (_nodeUrls[i] && _nodeUrls[i].trim() !== '') { return i; }
    }
    return 0;
}

function findNextLoadedNodeIndex(startIndex) {
    const count = _getCurrentNodeCountCallback();
    if (count <= 0) return 0;

    // 1. Normalize the start index (if we are at the end, start from 1)
    let cur = startIndex;
    if (cur > count) cur = 1;
    if (cur < 1) cur = 1;

    // 2. Loop through all nodes starting from 'cur' to find one with a URL
    // This will correctly wrap around back to 'cur' - 1
    for (let i = 0; i < count; i++) {
        // Modular math ensures we visit id 1 after id {count}
        const id = ((cur - 1 + i) % count) + 1;
        const u = _nodeUrls[id];
        if (u && String(u).trim()) {
            return id;
        }
    }

    return 0; // No nodes with URLs found
}
