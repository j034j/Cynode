const BRIDGE_BROWSER = 'firefox';
const BRIDGE_CAPABILITIES = ['tabs', 'bookmarks', 'history'];

function respond(sendResponse, payload) {
  try {
    sendResponse(payload);
  } catch (_) {}
}

function formatTimestamp(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return '';
  try {
    return new Date(num).toLocaleString();
  } catch (_) {
    return '';
  }
}

function normalizeItems(source, items, limit) {
  const seen = new Set();
  const out = [];

  for (const item of Array.isArray(items) ? items : []) {
    const url = typeof item?.url === 'string' ? item.url.trim() : '';
    if (!/^https?:\/\//i.test(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);

    const title = typeof item?.title === 'string' && item.title.trim() ? item.title.trim() : url;
    let subtitle = '';
    if (source === 'bookmarks') {
      subtitle = formatTimestamp(item?.dateAdded);
      subtitle = subtitle ? `Bookmarked ${subtitle}` : 'Bookmarked in browser';
    } else if (source === 'history') {
      subtitle = formatTimestamp(item?.lastVisitTime);
      subtitle = subtitle ? `Visited ${subtitle}` : 'Visited in browser history';
    } else {
      subtitle = 'Open browser tab';
    }

    out.push({ url, title, subtitle, source });
    if (out.length >= limit) break;
  }

  return out;
}

function handleBridgeRequest(request, sendResponse) {
  if (!request || request.type !== 'CYNODE_EXTENSION_REQUEST') {
    return false;
  }

  const action = request.action;
  const payload = request.payload || {};
  const limit = Math.max(1, Math.min(20, Number(payload.limit) || 8));

  if (action === 'ping') {
    respond(sendResponse, {
      ok: true,
      action,
      items: [],
      bridge: { browser: BRIDGE_BROWSER, capabilities: BRIDGE_CAPABILITIES, via: 'runtime' },
    });
    return false;
  }

  if (action === 'tabs') {
    try {
      chrome.tabs.query({ currentWindow: true, url: ['http://*/*', 'https://*/*'] }, (tabs) => {
        if (chrome.runtime.lastError) {
          respond(sendResponse, { ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        respond(sendResponse, {
          ok: true,
          action,
          items: normalizeItems('tabs', tabs, limit),
          bridge: { browser: BRIDGE_BROWSER, capabilities: BRIDGE_CAPABILITIES, via: 'runtime' },
        });
      });
    } catch (err) {
      respond(sendResponse, { ok: false, error: String(err) });
    }
    return true;
  }

  if (action === 'bookmarks') {
    try {
      chrome.bookmarks.getRecent(Math.max(limit * 3, limit), (bookmarks) => {
        if (chrome.runtime.lastError) {
          respond(sendResponse, { ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        respond(sendResponse, {
          ok: true,
          action,
          items: normalizeItems('bookmarks', bookmarks, limit),
          bridge: { browser: BRIDGE_BROWSER, capabilities: BRIDGE_CAPABILITIES, via: 'runtime' },
        });
      });
    } catch (err) {
      respond(sendResponse, { ok: false, error: String(err) });
    }
    return true;
  }

  if (action === 'history') {
    try {
      chrome.history.search({ text: '', startTime: 0, maxResults: Math.max(limit * 4, limit) }, (historyItems) => {
        if (chrome.runtime.lastError) {
          respond(sendResponse, { ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        respond(sendResponse, {
          ok: true,
          action,
          items: normalizeItems('history', historyItems, limit),
          bridge: { browser: BRIDGE_BROWSER, capabilities: BRIDGE_CAPABILITIES, via: 'runtime' },
        });
      });
    } catch (err) {
      respond(sendResponse, { ok: false, error: String(err) });
    }
    return true;
  }

  respond(sendResponse, {
    ok: false,
    error: 'unsupported_action',
    bridge: { browser: BRIDGE_BROWSER, capabilities: BRIDGE_CAPABILITIES, via: 'runtime' },
  });
  return false;
}

chrome.runtime.onInstalled.addListener(() => {
  console.log(`Cynode ${BRIDGE_BROWSER} bridge installed.`);
});

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  const result = handleBridgeRequest(request, sendResponse);
  if (result === true) return true;
  return false;
});
