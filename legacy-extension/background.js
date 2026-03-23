// Listen for the extension installation or update
chrome.runtime.onInstalled.addListener(() => {
  console.log('Node Graph URL Manager installed/updated.');
  // You could potentially set default settings here using chrome.storage.local
});

/*
// If you prefer a POPUP window instead of overriding the new tab page:
// 1. Remove the "chrome_url_overrides" section from manifest.json
// 2. Uncomment the code below:

chrome.action.onClicked.addListener((tab) => {
  // Check if a window with the extension URL is already open
  chrome.tabs.query({ url: chrome.runtime.getURL("index.html") }, (tabs) => {
    if (tabs.length > 0) {
      // If found, focus the window and tab
      chrome.windows.update(tabs[0].windowId, { focused: true });
      chrome.tabs.update(tabs[0].id, { active: true });
    } else {
      // Otherwise, create a new popup window
      chrome.windows.create({
        url: 'index.html',
        type: 'popup',
        width: 1024,
        height: 768
      });
    }
  });
});

*/