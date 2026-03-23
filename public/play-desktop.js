// =====================================================================
// play-desktop.js — Electron Synchronization Adapter
// =====================================================================

(function () {
    /**
     * listents for 'cynode-node-changed' events emitted by play.js
     * and forwards the target URL to the Electron Desktop Viewer window.
     */
    function handleNodeChange(event) {
        // Strict isolation: Only run if we are explicitly inside an Electron environment
        // This ensures the web app playback engine is 100% decoupled from desktop listeners.
        if (typeof window === 'undefined' || !window.cynodeDesktop || !window.cynodeDesktop.isElectron) {
            return;
        }

        const bridge = window.cynodeDesktop;

        if (!bridge) return;

        const data = event.detail;
        if (!data || !data.url) return;

        // Perform the sync call to the desktop bridge
        try {
            console.log(`[DesktopSync] Syncing Node ${data.nodeId} to Viewer: ${data.url}`);
            void bridge.openInAppViewer(data.url, { title: data.title || 'Cynode View' });
        } catch (err) {
            console.error('[DesktopSync] Failed to sync with desktop viewer:', err);
        }
    }

    // Register interest in playback transitions
    window.addEventListener('cynode-node-changed', handleNodeChange);

    console.log("Desktop Playback Sync Adapter initialized.");
})();
