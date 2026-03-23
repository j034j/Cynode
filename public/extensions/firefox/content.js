const BRIDGE_BROWSER = 'firefox';
const BRIDGE_CAPABILITIES = ['tabs', 'bookmarks', 'history'];

function postToPage(payload) {
  window.postMessage(payload, '*');
}

function announceAvailability() {
  postToPage({
    type: 'CYNODE_EXTENSION_AVAILABLE',
    bridge: {
      browser: BRIDGE_BROWSER,
      capabilities: BRIDGE_CAPABILITIES,
      via: 'content-script',
    },
  });
}

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.type !== 'CYNODE_EXTENSION_REQUEST' || data.source !== 'cynode-webapp') return;

  chrome.runtime.sendMessage({
    type: 'CYNODE_EXTENSION_REQUEST',
    action: data.action,
    payload: data.payload || {},
  }, (response) => {
    if (chrome.runtime.lastError) {
      postToPage({
        type: 'CYNODE_EXTENSION_RESPONSE',
        requestId: data.requestId,
        ok: false,
        error: chrome.runtime.lastError.message || 'runtime_error',
        bridge: {
          browser: BRIDGE_BROWSER,
          capabilities: BRIDGE_CAPABILITIES,
          via: 'content-script',
        },
      });
      return;
    }

    postToPage({
      type: 'CYNODE_EXTENSION_RESPONSE',
      requestId: data.requestId,
      ...(response || {}),
      bridge: {
        browser: BRIDGE_BROWSER,
        capabilities: BRIDGE_CAPABILITIES,
        via: 'content-script',
        ...((response && response.bridge) || {}),
      },
    });
  });
});

announceAvailability();
