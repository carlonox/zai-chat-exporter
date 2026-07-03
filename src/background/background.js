var STORAGE_DEFAULTS = {
  includeReasoning: true,
  includeMetadata: true,
  includeRaw: true,
  lastFormat: 'json'
};

chrome.runtime.onInstalled.addListener(function(details) {
  var reason = details.reason;

  if (reason === 'install') {
    chrome.storage.local.set(STORAGE_DEFAULTS, function() {
      console.log('[Z.ai Exporter] Default settings initialized');
    });
    var welcomeUrl = chrome.runtime.getURL('popup.html');
    console.log('[Z.ai Exporter] Extension installed. Welcome:', welcomeUrl);
  } else if (reason === 'update') {
    var prevVersion = details.previousVersion;
    console.log('[Z.ai Exporter] Updated from ' + prevVersion + ' to ' + chrome.runtime.getManifest().version);
    chrome.storage.local.get(Object.keys(STORAGE_DEFAULTS), function(stored) {
      var merged = {};
      for (var key in STORAGE_DEFAULTS) {
        if (stored.hasOwnProperty(key) && stored[key] !== undefined) {
          merged[key] = stored[key];
        } else {
          merged[key] = STORAGE_DEFAULTS[key];
        }
      }
      chrome.storage.local.set(merged);
    });
  }
});

chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
  switch (message.action) {
    case 'contentScriptReady':
      console.log('[Z.ai Exporter] Content script ready on:', message.url);
      sendResponse({ received: true });
      break;

    case 'getSettings':
      chrome.storage.local.get(Object.keys(STORAGE_DEFAULTS), function(settings) {
        sendResponse(settings);
      });
      return true;

    case 'saveSettings':
      chrome.storage.local.set(message.settings, function() {
        sendResponse({ saved: true });
      });
      return true;

    default:
      console.warn('[Z.ai Exporter] Unknown message:', message.action);
      sendResponse({ error: 'Unknown action' });
  }
});
