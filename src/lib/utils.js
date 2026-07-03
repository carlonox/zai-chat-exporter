function extractChatIdFromUrl(url) {
  if (!url) return null;
  var match = url.match(/\/c\/([a-f0-9-]{36})/i);
  return match ? match[1] : null;
}

function formatTimestamp(timestamp) {
  if (!timestamp) return 'Unknown';
  try {
    var date = typeof timestamp === 'number'
      ? new Date(timestamp * 1000)
      : new Date(timestamp);
    if (isNaN(date.getTime())) return 'Unknown';
    return date.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch (e) {
    return 'Unknown';
  }
}

function sanitizeFilename(name, maxLength) {
  if (maxLength === undefined) maxLength = 60;
  if (!name) return 'export';
  var safe = name
    .replace(/[<>:\"\/\\|?*]/g, '_')
    .replace(/[\x00-\x1f]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .substring(0, maxLength);
  return safe || 'export';
}

function debounce(fn, delay) {
  if (delay === undefined) delay = 300;
  var timer;
  return function() {
    var args = arguments;
    var context = this;
    clearTimeout(timer);
    timer = setTimeout(function() { fn.apply(context, args); }, delay);
  };
}

function isExtensionContext() {
  return typeof chrome !== 'undefined' &&
    (!!chrome.runtime || !!chrome.tabs);
}

export { extractChatIdFromUrl, formatTimestamp, sanitizeFilename, debounce, isExtensionContext };
