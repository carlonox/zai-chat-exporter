console.log("[Z.ai Exporter] Content script loaded");

chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
  switch (request.action) {
    case "getChatId": {
      var match = window.location.pathname.match(/\/c\/([a-f0-9-]{36})/i);
      if (match) { sendResponse({ success: true, chatId: match[1] }); return true; }
      var el = document.querySelector("[data-chat-id]");
      if (el) { sendResponse({ success: true, chatId: el.dataset.chatId }); return true; }
      sendResponse({ success: false });
      return true;
    }
    case "getCurrentChatId": {
      sendResponse({ chatId: extractChatIdFromPage() });
      break;
    }
    case "getToken": {
      try {
        var token = localStorage.getItem("token");
        if (token) {
          sendResponse({ success: true, token: token });
        } else {
          sendResponse({ success: false, error: "Token not found in localStorage. Please log in to Z.ai." });
        }
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
      return true;
    }
    case "getPageInfo": {
      sendResponse({
        url: window.location.href,
        title: document.title,
        hasChatContainer: !!(document.querySelector("[class*=chat], [class*=conversation]"))
      });
      break;
    }
    default:
      sendResponse({ error: "Unknown action" });
  }
  return true;
});

function extractChatIdFromPage() {
  var match = window.location.pathname.match(/\/c\/([a-f0-9-]{36})/i);
  return match ? match[1] : null;
}

chrome.runtime.sendMessage({ action: "contentScriptReady", url: window.location.href });
