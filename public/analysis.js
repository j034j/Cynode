(function () {
    const state = {
        config: null,
        providers: [],
        providerId: null,
        playMode: false,
        currentNodeId: null,
        currentUrl: '',
        currentDisplayText: '',
        currentCaption: null,
        analysesByNode: new Map(),
        jobByNode: new Map(),
        elements: {},
        loading: false,
        pollTimer: null,
    };

    const SOURCE_BUTTON_MODE = {
        page: {
            top: { fileHidden: true, pageHidden: false, pageLabel: 'Analyze Page' },
            pane: { fileHidden: true, pageHidden: false, pageLabel: 'Analyze Page' },
            rerunLabel: 'Analyze Page Again',
        },
        file: {
            top: { fileHidden: false, pageHidden: true, fileLabel: 'Analyze File' },
            pane: { fileHidden: false, pageHidden: true, fileLabel: 'Analyze File' },
            rerunLabel: 'Analyze File Again',
        },
        unknown: {
            top: { fileHidden: false, pageHidden: false, fileLabel: 'Analyze File', pageLabel: 'Analyze Page' },
            pane: { fileHidden: false, pageHidden: false, fileLabel: 'Analyze File', pageLabel: 'Analyze Page' },
            rerunLabel: 'Run Again',
        },
    };

    function byId(id) {
        return document.getElementById(id);
    }

    function escapeHtml(value) {
        return String(value ?? '')
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll("'", '&#39;');
    }

    function clipText(value, maxLength) {
        const text = String(value ?? '').trim();
        if (text.length <= maxLength) return text;
        return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
    }

    function joinClassNames() {
        return Array.from(arguments).filter(Boolean).join(' ');
    }

    function normalizeText(value) {
        return String(value ?? '')
            .replaceAll(/\r/g, '\n')
            .replaceAll(/\t/g, ' ')
            .replaceAll(/[ \f\v]+/g, ' ')
            .replaceAll(/\n{3,}/g, '\n\n')
            .trim();
    }

    function getStoredProviderId() {
        try {
            return localStorage.getItem('cynode.analysis.provider') || '';
        } catch (_) {
            return '';
        }
    }

    function setStoredProviderId(value) {
        try {
            localStorage.setItem('cynode.analysis.provider', value);
        } catch (_) { }
    }

    function getStoredPlayMode() {
        try {
            return localStorage.getItem('cynode.analysis.playMode') === '1';
        } catch (_) {
            return false;
        }
    }

    function setStoredPlayMode(value) {
        try {
            localStorage.setItem('cynode.analysis.playMode', value ? '1' : '0');
        } catch (_) { }
    }

    function inferSourceKind(url) {
        const value = String(url || '').trim();
        if (!value) return 'empty';
        if (state.config && typeof state.config.isLocalFileUrl === 'function' && state.config.isLocalFileUrl(value)) return 'file';
        if (value.startsWith('blob:') || value.startsWith('data:')) return 'file';
        if (/\/m\/[0-9a-f-]{36}$/i.test(value) || /\.(pdf|docx|xlsx|csv|txt|md|json|html?|xml|png|jpe?g|gif|webp|mp4|mp3|wav)$/i.test(value)) return 'file';
        if (/^https?:/i.test(value)) return 'page';
        return 'unknown';
    }

    function getAnalysisKey(nodeId) {
        return Number(nodeId) || 0;
    }

    function getScope(nodeId) {
        const safeNodeId = Number(nodeId) || 0;
        const shareCode = state.config && typeof state.config.getShareCode === 'function'
            ? state.config.getShareCode()
            : null;
        const graphId = state.config && typeof state.config.getGraphId === 'function'
            ? state.config.getGraphId()
            : null;
        const clientGraphKey = state.config && typeof state.config.getClientGraphKey === 'function'
            ? state.config.getClientGraphKey()
            : 'default';
        return {
            nodeId: safeNodeId,
            shareCode: shareCode || undefined,
            graphId: shareCode ? undefined : (graphId || undefined),
            clientGraphKey: shareCode || graphId ? undefined : clientGraphKey,
        };
    }

    function getCurrentProvider() {
        return state.providers.find((provider) => provider.id === state.providerId) || state.providers[0] || { id: 'local', label: 'Local parser' };
    }

    function updateProviderSelect() {
        const select = state.elements.providerSelect;
        if (!select) return;
        const providers = state.providers.length ? state.providers : [{ id: 'local', label: 'Local parser', kind: 'local', isDefault: true }];
        select.innerHTML = providers.map((provider) => `<option value="${escapeHtml(provider.id)}">${escapeHtml(provider.label)}</option>`).join('');
        const selected = providers.some((provider) => provider.id === state.providerId)
            ? state.providerId
            : (providers.find((provider) => provider.isDefault) || providers[0]).id;
        state.providerId = selected;
        select.value = selected;
    }

    function updatePlayModeButton() {
        const button = state.elements.playModeBtn;
        if (!button) return;
        button.textContent = state.playMode ? 'Play Sync On' : 'Play Sync Off';
        button.classList.toggle('is-active', state.playMode);
        button.setAttribute('aria-pressed', state.playMode ? 'true' : 'false');
        button.title = state.playMode
            ? 'Preview Intelligence will follow the nodegraph playback sequence automatically.'
            : 'Preview Intelligence will stay manual until you analyze or switch nodes yourself.';
    }

    function setStatus(message, tone) {
        const el = state.elements.status;
        if (!el) return;
        el.className = joinClassNames('analysis-status', tone ? `analysis-status--${tone}` : '');
        el.textContent = message || '';
    }

    function renderBody(html) {
        if (state.elements.body) state.elements.body.innerHTML = html;
    }

    function configureActionButton(button, options) {
        if (!button) return;
        button.hidden = !!options.hidden;
        button.disabled = !!options.disabled;
        if (options.label) button.textContent = options.label;
        if (options.title !== undefined) button.title = options.title;
        button.setAttribute('aria-hidden', button.hidden ? 'true' : 'false');
    }

    function normalizeRecord(record) {
        if (!record || typeof record !== 'object') return null;
        return {
            ...record,
            status: record.status || 'done',
            error: record.error || null,
            metadata: record.metadata && typeof record.metadata === 'object' ? record.metadata : {},
            keyPoints: Array.isArray(record.keyPoints) ? record.keyPoints : [],
        };
    }

    function cacheRecord(nodeId, record) {
        const normalized = normalizeRecord(record);
        if (!normalized) return null;
        state.analysesByNode.set(getAnalysisKey(nodeId), normalized);
        return normalized;
    }

    function setPendingJob(nodeId, job) {
        if (!job) {
            state.jobByNode.delete(getAnalysisKey(nodeId));
            return;
        }
        state.jobByNode.set(getAnalysisKey(nodeId), job);
    }

    function renderEmptyState(reason) {
        const sourceKind = inferSourceKind(state.currentUrl);
        let title = 'Analysis ready when you are';
        let copy = 'Select a node, then choose Analyze File or Analyze Page to inspect the selected source.';
        if (sourceKind === 'page') {
            title = 'Analyze the selected page';
            copy = 'Use Analyze Page to extract readable content from the selected website and generate a focused summary in this pane.';
        } else if (sourceKind === 'file') {
            title = 'Analyze the selected file';
            copy = 'Use Analyze File to inspect the selected local, saved, or cloud-backed file and show the results beside the preview player.';
        } else if (reason) {
            copy = reason;
        }
        renderBody(`
            <div class="analysis-empty">
                <div class="analysis-empty__eyebrow">Cynode Analysis</div>
                <h4>${escapeHtml(title)}</h4>
                <p>${escapeHtml(copy)}</p>
            </div>
        `);
        setStatus('', 'info');
    }

    function renderLoading(mode, extraMessage) {
        renderBody(`
            <div class="analysis-loading">
                <div class="analysis-spinner" aria-hidden="true"></div>
                <div>
                    <h4>${escapeHtml(mode === 'page' ? 'Analyzing page' : 'Analyzing file')}</h4>
                    <p>${escapeHtml(extraMessage || state.currentDisplayText || state.currentUrl || 'Preparing selected source')}</p>
                </div>
            </div>
        `);
        setStatus(`Running ${getCurrentProvider().label}...`, 'info');
    }

    function renderAnalysis(result) {
        const normalized = normalizeRecord(result);
        if (!normalized) {
            renderEmptyState();
            return;
        }
        const keyPoints = normalized.keyPoints || [];
        const metadata = normalized.metadata && typeof normalized.metadata === 'object' ? normalized.metadata : {};
        const excerpt = clipText(normalized.extractedText || '', 2500);
        const metaItems = [
            normalized.provider ? `${normalized.provider}` : '',
            metadata.wordCount ? `${metadata.wordCount} words` : '',
            metadata.mimeType ? `${metadata.mimeType}` : '',
            metadata.providerFallback ? `fallback from ${metadata.providerFallback}` : '',
            state.playMode ? 'play sync' : '',
        ].filter(Boolean);

        renderBody(`
            <article class="analysis-card">
                <div class="analysis-card__head">
                    <div>
                        <div class="analysis-card__eyebrow">${escapeHtml(normalized.sourceKind === 'page' ? 'Page Analysis' : 'File Analysis')}</div>
                        <h4>${escapeHtml(normalized.title || 'Cynode analysis')}</h4>
                    </div>
                    <div class="analysis-chip-row">
                        ${metaItems.map((item) => `<span class="analysis-chip">${escapeHtml(item)}</span>`).join('')}
                    </div>
                </div>
                <p class="analysis-summary">${escapeHtml(normalized.summary || 'No summary available.')}</p>
                <section class="analysis-section">
                    <h5>Key Points</h5>
                    <ul class="analysis-list">
                        ${(keyPoints.length ? keyPoints : ['No key points were extracted.']).map((item) => `<li>${escapeHtml(item)}</li>`).join('')}
                    </ul>
                </section>
                <section class="analysis-section">
                    <h5>Extracted Content</h5>
                    <pre class="analysis-excerpt">${escapeHtml(excerpt || 'No readable excerpt available for this source.')}</pre>
                </section>
            </article>
        `);
        if (normalized.status === 'error') {
            setStatus(`Analysis failed for Node ${normalized.nodeId}.`, 'error');
        } else if (metadata.providerError) {
            setStatus(`Fell back to local analysis because ${metadata.providerError}.`, 'warning');
        } else {
            setStatus(`Analysis updated for Node ${normalized.nodeId || state.currentNodeId || '–'}.`, 'success');
        }
    }

    function cancelPolling() {
        if (state.pollTimer) {
            clearTimeout(state.pollTimer);
            state.pollTimer = null;
        }
    }

    function schedulePolling(nodeId) {
        cancelPolling();
        state.pollTimer = setTimeout(() => {
            void fetchPersistedState(nodeId, { silent: true });
        }, 1400);
    }

    async function fetchProviders() {
        if (!state.config || typeof state.config.apiJson !== 'function') return;
        try {
            const response = await state.config.apiJson('/api/v1/analysis/providers');
            state.providers = Array.isArray(response && response.providers) ? response.providers : [];
        } catch (_) {
            state.providers = [{ id: 'local', label: 'Local parser', kind: 'local', isDefault: true }];
        }
        const stored = getStoredProviderId();
        const fallback = (state.providers.find((provider) => provider.isDefault) || state.providers[0] || { id: 'local' }).id;
        state.providerId = state.providers.some((provider) => provider.id === stored) ? stored : fallback;
        updateProviderSelect();
    }

    async function extractPdfText(arrayBuffer) {
        if (!window.pdfjsLib || typeof window.pdfjsLib.getDocument !== 'function') {
            return 'PDF text extraction is unavailable because PDF.js did not load.';
        }
        if (!window.pdfjsLib.GlobalWorkerOptions.workerSrc) {
            window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
        }
        const pdf = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        const parts = [];
        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
            const page = await pdf.getPage(pageNumber);
            const content = await page.getTextContent();
            const line = Array.isArray(content.items)
                ? content.items.map((item) => String(item && item.str ? item.str : '')).join(' ')
                : '';
            if (line.trim()) parts.push(line.trim());
        }
        return normalizeText(parts.join('\n\n'));
    }

    async function extractSpreadsheetText(arrayBuffer) {
        if (!window.XLSX || typeof window.XLSX.read !== 'function') {
            return 'Spreadsheet extraction is unavailable because SheetJS did not load.';
        }
        const workbook = window.XLSX.read(arrayBuffer, { type: 'array' });
        const chunks = [];
        (workbook.SheetNames || []).forEach((sheetName) => {
            const worksheet = workbook.Sheets[sheetName];
            const csv = window.XLSX.utils.sheet_to_csv(worksheet);
            if (csv && csv.trim()) {
                chunks.push(`Sheet: ${sheetName}`);
                chunks.push(csv.trim());
            }
        });
        return normalizeText(chunks.join('\n\n'));
    }

    async function extractDocxText(arrayBuffer) {
        if (!window.mammoth || typeof window.mammoth.extractRawText !== 'function') {
            return 'Document extraction is unavailable because Mammoth did not load.';
        }
        const result = await window.mammoth.extractRawText({ arrayBuffer });
        return normalizeText(result && result.value ? result.value : '');
    }

    async function extractImageDescription(blob, fileName) {
        const objectUrl = URL.createObjectURL(blob);
        try {
            const dimensions = await new Promise((resolve) => {
                const image = new Image();
                image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
                image.onerror = () => resolve({ width: 0, height: 0 });
                image.src = objectUrl;
            });
            const details = [];
            if (fileName) details.push(`Image file: ${fileName}`);
            if (dimensions.width && dimensions.height) details.push(`Dimensions: ${dimensions.width} x ${dimensions.height}`);
            if (blob.size) details.push(`Size: ${(blob.size / 1024).toFixed(1)} KB`);
            details.push('Visual OCR is not available locally, so this analysis is based on file metadata unless you route the text through an AI provider.');
            return details.join('\n');
        } finally {
            URL.revokeObjectURL(objectUrl);
        }
    }

    async function extractMediaMetadata(blob, fileName, kind) {
        const objectUrl = URL.createObjectURL(blob);
        try {
            const duration = await new Promise((resolve) => {
                const el = document.createElement(kind === 'audio' ? 'audio' : 'video');
                el.preload = 'metadata';
                el.onloadedmetadata = () => resolve(Number.isFinite(el.duration) ? el.duration : 0);
                el.onerror = () => resolve(0);
                el.src = objectUrl;
            });
            const lines = [];
            if (fileName) lines.push(`${kind === 'audio' ? 'Audio' : 'Video'} file: ${fileName}`);
            if (blob.size) lines.push(`Size: ${(blob.size / 1024 / 1024).toFixed(2)} MB`);
            if (duration) lines.push(`Duration: ${duration.toFixed(1)} seconds`);
            lines.push('Playable media is previewable in Cynode, but deep transcript analysis requires an external speech or vision model.');
            return lines.join('\n');
        } finally {
            URL.revokeObjectURL(objectUrl);
        }
    }

    function guessFileName(url) {
        const value = String(url || '').trim();
        if (!value) return '';
        if (state.config && typeof state.config.parseLocalFileUrl === 'function' && state.config.isLocalFileUrl(value)) {
            const parsed = state.config.parseLocalFileUrl(value);
            return parsed && parsed.name ? parsed.name : 'Local file';
        }
        try {
            const parsed = new URL(value, window.location.origin);
            const segment = parsed.pathname.split('/').filter(Boolean).pop() || '';
            return segment || parsed.hostname || value;
        } catch (_) {
            return value;
        }
    }

    async function extractFilePayload(nodeId, sourceUrl) {
        if (!sourceUrl) throw new Error('no_file_selected');
        let resolved = { kind: 'web', url: sourceUrl, meta: null };
        if (state.config && typeof state.config.resolveUrlForViewer === 'function') {
            resolved = await state.config.resolveUrlForViewer(sourceUrl, nodeId) || resolved;
        }
        const fetchUrl = resolved && resolved.url ? resolved.url : sourceUrl;
        if (!fetchUrl) throw new Error('file_unavailable');

        const response = await fetch(fetchUrl);
        if (!response.ok) throw new Error(`fetch_${response.status}`);
        const blob = await response.blob();
        const meta = resolved && resolved.meta ? resolved.meta : {};
        const mimeType = (blob && blob.type) || meta.mimeType || '';
        const fileName = meta.name || meta.fileName || guessFileName(sourceUrl);
        const lowerName = String(fileName || '').toLowerCase();

        let content = '';
        if (mimeType.startsWith('text/') || /\.(txt|md|json|js|ts|css|html?|xml|csv|yml|yaml|sql)$/i.test(lowerName)) {
            content = normalizeText(await blob.text());
        } else if (mimeType.includes('pdf') || /\.pdf$/i.test(lowerName)) {
            content = await extractPdfText(await blob.arrayBuffer());
        } else if (mimeType.includes('wordprocessingml') || /\.docx$/i.test(lowerName)) {
            content = await extractDocxText(await blob.arrayBuffer());
        } else if (mimeType.includes('spreadsheet') || mimeType.includes('csv') || /\.(xlsx|csv)$/i.test(lowerName)) {
            content = await extractSpreadsheetText(await blob.arrayBuffer());
        } else if (mimeType.startsWith('image/')) {
            content = await extractImageDescription(blob, fileName);
        } else if (mimeType.startsWith('audio/')) {
            content = await extractMediaMetadata(blob, fileName, 'audio');
        } else if (mimeType.startsWith('video/')) {
            content = await extractMediaMetadata(blob, fileName, 'video');
        } else {
            throw new Error('remote_queue_only');
        }

        return {
            content: clipText(content || 'No readable content was extracted from this file.', 120000),
            sourceKind: 'file',
            fileName,
            mimeType: mimeType || 'application/octet-stream',
            sourceUrl,
            title: fileName || guessFileName(sourceUrl) || `Node ${nodeId} file`,
        };
    }

    function buildQueueBody(nodeId, payload) {
        return {
            scope: getScope(nodeId),
            sourceKind: payload.sourceKind,
            sourceUrl: payload.sourceUrl || undefined,
            content: payload.content || undefined,
            title: payload.title || undefined,
            mimeType: payload.mimeType || undefined,
            fileName: payload.fileName || undefined,
            provider: state.providerId || 'local',
        };
    }

    async function queueRequest(body, mode) {
        if (!state.config || typeof state.config.apiJson !== 'function') throw new Error('analysis_unavailable');
        state.loading = true;
        renderLoading(mode, state.currentDisplayText || state.currentUrl);
        const response = await state.config.apiJson('/api/v1/analysis/queue', {
            method: 'POST',
            body: JSON.stringify(body),
        });
        state.loading = false;
        if (response && response.result) {
            const cached = cacheRecord(body.scope.nodeId, response.result);
            if (body.scope.nodeId === state.currentNodeId) renderAnalysis(cached);
        }
        if (response && response.jobId) {
            setPendingJob(body.scope.nodeId, {
                id: response.jobId,
                status: response.status,
            });
            if (!response.result && body.scope.nodeId === state.currentNodeId) {
                renderLoading(mode, response.status === 'processing'
                    ? 'Analysis is processing in the server background.'
                    : 'Analysis is queued in the server background.');
            }
            if (response.status === 'queued' || response.status === 'processing') {
                schedulePolling(body.scope.nodeId);
            }
        }
        return response;
    }

    async function fetchPersistedState(nodeId, { silent = false } = {}) {
        if (!nodeId || !state.config || typeof state.config.apiJson !== 'function') return null;
        const scope = getScope(nodeId);
        const query = new URLSearchParams();
        query.set('nodeId', String(scope.nodeId));
        if (scope.shareCode) query.set('shareCode', scope.shareCode);
        if (scope.graphId) query.set('graphId', scope.graphId);
        if (scope.clientGraphKey) query.set('clientGraphKey', scope.clientGraphKey);
        try {
            const response = await state.config.apiJson(`/api/v1/analysis/state?${query.toString()}`);
            if (response && response.result) {
                const cached = cacheRecord(nodeId, response.result);
                setPendingJob(nodeId, null);
                if (nodeId === state.currentNodeId) renderAnalysis(cached);
                cancelPolling();
                return cached;
            }
            if (response && response.job) {
                setPendingJob(nodeId, response.job);
                if (!silent && nodeId === state.currentNodeId) {
                    renderLoading(inferSourceKind(state.currentUrl) === 'page' ? 'page' : 'file', 'Analysis is queued in the server background.');
                }
                if (response.job.status === 'queued' || response.job.status === 'processing') {
                    schedulePolling(nodeId);
                }
            }
        } catch (_) { }
        return null;
    }

    async function enqueueNodeAnalysisFor(nodeId, sourceUrl, { force = false } = {}) {
        const safeNodeId = Number(nodeId) || 0;
        if (!safeNodeId || !sourceUrl) return null;
        const existing = state.analysesByNode.get(getAnalysisKey(safeNodeId));
        if (!force && existing && existing.status === 'done' && existing.sourceUrl === sourceUrl) {
            return existing;
        }

        const sourceKind = inferSourceKind(sourceUrl);
        if (sourceKind === 'page') {
            return await queueRequest(buildQueueBody(safeNodeId, {
                sourceKind: 'page',
                sourceUrl,
                title: state.currentCaption && state.currentCaption.title ? state.currentCaption.title : guessFileName(sourceUrl),
            }), 'page');
        }

        if (sourceKind !== 'file') return null;

        try {
            const payload = await extractFilePayload(safeNodeId, sourceUrl);
            return await queueRequest(buildQueueBody(safeNodeId, payload), 'file');
        } catch (error) {
            if (error && (error.message === 'remote_queue_only' || /^https?:/i.test(String(sourceUrl || '')))) {
                return await queueRequest(buildQueueBody(safeNodeId, {
                    sourceKind: 'file',
                    sourceUrl,
                    title: guessFileName(sourceUrl),
                    fileName: guessFileName(sourceUrl),
                    mimeType: '',
                }), 'file');
            }
            throw error;
        }
    }

    async function analyzeCurrentPage(force = true) {
        const nodeId = state.currentNodeId;
        const url = state.currentUrl;
        if (!nodeId || !url) {
            renderEmptyState('Select a node with a web URL before analyzing a page.');
            return null;
        }
        if (inferSourceKind(url) !== 'page') {
            renderEmptyState('Analyze Page is intended for web URLs. Use Analyze File for local or attached files.');
            return null;
        }
        try {
            return await enqueueNodeAnalysisFor(nodeId, url, { force });
        } catch (error) {
            state.loading = false;
            const message = error && error.message ? error.message : 'page_analysis_failed';
            setStatus(`Unable to analyze this page: ${message}`, 'error');
            renderEmptyState('The selected page could not be analyzed. The site may block remote fetching, require sign-in, or be unavailable.');
            return null;
        }
    }

    async function analyzeCurrentFile(force = true) {
        const nodeId = state.currentNodeId;
        const url = state.currentUrl;
        if (!nodeId || !url) {
            renderEmptyState('Select a node with a file before analyzing a file.');
            return null;
        }
        const sourceKind = inferSourceKind(url);
        if (sourceKind !== 'file') {
            renderEmptyState('Analyze File works on local files and file-like media links. Use Analyze Page for websites.');
            return null;
        }
        try {
            return await enqueueNodeAnalysisFor(nodeId, url, { force });
        } catch (error) {
            state.loading = false;
            const message = error && error.message ? error.message : 'file_analysis_failed';
            setStatus(`Unable to analyze this file: ${message}`, 'error');
            renderEmptyState('The selected file could not be analyzed on this device. If it is a local file, make sure it is still available in this browser or desktop session.');
            return null;
        }
    }

    function syncActionButtons() {
        const sourceKind = inferSourceKind(state.currentUrl);
        const mode = SOURCE_BUTTON_MODE[sourceKind] || SOURCE_BUTTON_MODE.unknown;
        const hasSource = !!(state.currentNodeId && state.currentUrl);
        const disableFile = !hasSource || sourceKind === 'page';
        const disablePage = !hasSource || sourceKind === 'file';

        configureActionButton(state.elements.toolbarFileBtn, {
            hidden: !!mode.top.fileHidden,
            disabled: disableFile,
            label: mode.top.fileLabel || 'Analyze File',
            title: 'Analyze the selected local or cloud-backed file',
        });
        configureActionButton(state.elements.toolbarPageBtn, {
            hidden: !!mode.top.pageHidden,
            disabled: disablePage,
            label: mode.top.pageLabel || 'Analyze Page',
            title: 'Analyze the selected web page',
        });
        configureActionButton(state.elements.paneFileBtn, {
            hidden: !!mode.pane.fileHidden,
            disabled: disableFile,
            label: mode.pane.fileLabel || 'Analyze File',
            title: 'Analyze the selected local or cloud-backed file',
        });
        configureActionButton(state.elements.panePageBtn, {
            hidden: !!mode.pane.pageHidden,
            disabled: disablePage,
            label: mode.pane.pageLabel || 'Analyze Page',
            title: 'Analyze the selected web page',
        });

        if (state.elements.rerun) {
            state.elements.rerun.textContent = mode.rerunLabel;
            state.elements.rerun.disabled = !hasSource || sourceKind === 'unknown' || sourceKind === 'empty';
        }

        if (state.elements.actions) {
            state.elements.actions.dataset.sourceKind = sourceKind;
        }
    }

    function maybeRenderCachedAnalysis() {
        const cached = state.analysesByNode.get(getAnalysisKey(state.currentNodeId));
        if (cached) {
            renderAnalysis(cached);
            return true;
        }
        return false;
    }

    async function onNodeSelectionChanged(payload) {
        state.currentNodeId = payload && payload.nodeId ? Number(payload.nodeId) : null;
        state.currentUrl = payload && payload.url ? String(payload.url) : '';
        state.currentDisplayText = payload && payload.displayText ? String(payload.displayText) : '';
        state.currentCaption = payload && payload.caption ? payload.caption : null;
        syncActionButtons();
        cancelPolling();
        if (!maybeRenderCachedAnalysis()) {
            renderEmptyState();
        }
        if (state.currentNodeId) {
            void fetchPersistedState(state.currentNodeId, { silent: true });
            if (state.playMode) {
                const sourceKind = inferSourceKind(state.currentUrl);
                if (sourceKind === 'page') {
                    void analyzeCurrentPage(false);
                } else if (sourceKind === 'file') {
                    void analyzeCurrentFile(false);
                }
            }
        }
    }

    function hydratePersistedAnalyses(analysesByNode, { replace = false } = {}) {
        if (replace) {
            state.analysesByNode.clear();
            state.jobByNode.clear();
        }
        if (analysesByNode && typeof analysesByNode === 'object') {
            Object.entries(analysesByNode).forEach(([nodeId, record]) => {
                cacheRecord(Number(nodeId), record);
            });
        }
        if (!maybeRenderCachedAnalysis()) {
            renderEmptyState();
        }
    }

    function getPersistedAnalysesSnapshot() {
        const snapshot = {};
        for (const [nodeId, record] of state.analysesByNode.entries()) {
            if (!record || typeof record !== 'object') continue;
            snapshot[String(nodeId)] = { ...record };
        }
        return snapshot;
    }

    function resetAnalysisState() {
        cancelPolling();
        state.analysesByNode.clear();
        state.jobByNode.clear();
        if (!state.currentNodeId) renderEmptyState();
    }

    async function syncSavedShareAnalyses(code) {
        const shareCode = String(code || '').trim();
        if (!shareCode || !state.config || typeof state.config.apiJson !== 'function') return false;
        const analysesByNode = {};
        for (const [nodeId, record] of state.analysesByNode.entries()) {
            if (!record || record.status !== 'done') continue;
            analysesByNode[String(nodeId)] = record;
        }
        if (Object.keys(analysesByNode).length < 1) return false;
        await state.config.apiJson(`/api/v1/analysis/share/${encodeURIComponent(shareCode)}/sync`, {
            method: 'POST',
            body: JSON.stringify({ analysesByNode }),
        });
        return true;
    }

    async function init(config) {
        state.config = config || {};
        state.playMode = getStoredPlayMode();
        state.elements = {
            pane: byId('analysisPane'),
            status: byId('analysisStatus'),
            body: byId('analysisBody'),
            providerSelect: byId('analysisProviderSelect'),
            actions: byId('analysisActions'),
            rerun: byId('analysisRerunBtn'),
            playModeBtn: byId('analysisPlayModeBtn'),
            paneFileBtn: byId('analysisPaneFileBtn'),
            panePageBtn: byId('analysisPanePageBtn'),
            toolbarFileBtn: byId('analyzeFileBtn'),
            toolbarPageBtn: byId('analyzePageBtn'),
        };
        if (!state.elements.pane || !state.elements.body) return;

        if (state.elements.providerSelect) {
            state.elements.providerSelect.addEventListener('change', (event) => {
                const nextValue = event && event.target ? String(event.target.value || 'local') : 'local';
                state.providerId = nextValue;
                setStoredProviderId(nextValue);
            });
        }

        if (state.elements.playModeBtn) {
            state.elements.playModeBtn.addEventListener('click', () => {
                state.playMode = !state.playMode;
                setStoredPlayMode(state.playMode);
                updatePlayModeButton();
                if (state.playMode && state.currentNodeId) {
                    void onNodeSelectionChanged({
                        nodeId: state.currentNodeId,
                        url: state.currentUrl,
                        displayText: state.currentDisplayText,
                        caption: state.currentCaption,
                    });
                }
            });
        }

        if (state.elements.rerun) {
            state.elements.rerun.addEventListener('click', () => {
                const sourceKind = inferSourceKind(state.currentUrl);
                if (sourceKind === 'page') {
                    void analyzeCurrentPage(true);
                } else if (sourceKind === 'file') {
                    void analyzeCurrentFile(true);
                }
            });
        }

        await fetchProviders();
        updatePlayModeButton();
        syncActionButtons();
        renderEmptyState();
    }

    window.CynodeAnalysis = {
        init,
        onNodeSelectionChanged,
        analyzeCurrentFile,
        analyzeCurrentPage,
        enqueueNodeAnalysisFor,
        hydratePersistedAnalyses,
        getPersistedAnalysesSnapshot,
        resetAnalysisState,
        syncSavedShareAnalyses,
    };
})();
