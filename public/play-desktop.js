// =====================================================================
// play-desktop.js — Electron Synchronization Adapter
// =====================================================================

(function () {
    // Intentionally do not auto-open the desktop viewer from playback transitions.
    // The embedded preview continues to follow playback, while the full desktop viewer
    // is now reserved for explicit user actions such as clicking a node or URL.
    console.log('[DesktopSync] Playback-to-viewer auto-sync disabled. Full viewer now opens only from manual actions.');
})();
