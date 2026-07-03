// The popup can't access chat.z.ai's localStorage directly — it runs in its own extension context.
// So we ask the content script (injected into the page) to read the token for us.
// This function wraps that request in a Promise.
import { getAllChats, getChatDetails, getMessagesBatch } from "../lib/api.js";
import { EXPORTERS, downloadExport } from "../lib/exporters.js";

// Ask the content script to grab the auth token from the page localStorage.
// Falls through chrome.tabs.sendMessage — if the content script is not loaded,
// the error message tells the user to open chat.z.ai first.
function getAuthTokenFromPage() {
  return new Promise(function(resolve, reject) {
    chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
      if (!tabs || tabs.length === 0) {
        reject(new Error("No active tab found"));
        return;
      }
      chrome.tabs.sendMessage(tabs[0].id, { action: "getToken" }, function(response) {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (response && response.success) {
          resolve(response.token);
        } else {
          reject(new Error((response && response.error) || "Failed to get token"));
        }
      });
    });
  });
}

document.addEventListener("DOMContentLoaded", function() {
  var exportBtn = document.getElementById("exportBtn");
  var statusEl = document.getElementById("status");
  var chatSelect = document.getElementById("chatSelection");
  var formatSelect = document.getElementById("formatSelection");
  var recentWrapper = document.getElementById("recentCountWrapper");
  var recentInput = document.getElementById("recentCount");

  chatSelect.addEventListener("change", function() {
    recentWrapper.style.display = chatSelect.value === "recent" ? "block" : "none";
  });

  function setStatus(msg, type) {
    if (type === undefined) type = "info";
    statusEl.textContent = msg;
    statusEl.className = "status " + type;
  }
  function clearStatus() {
    statusEl.className = "status"; statusEl.textContent = "";
  }

  exportBtn.addEventListener("click", async function() {
    clearStatus();
    exportBtn.disabled = true;
    try {
      setStatus("Obtaining authentication...", "info");
      var token = await getAuthTokenFromPage();
      var format = formatSelect.value;
      if (!EXPORTERS[format]) throw new Error("Unsupported format: " + format);
      var selection = chatSelect.value;
      var chats = [];

      // "Select specific" opens a separate window with a checklist.
      // The token is passed via URL parameter so select.js doesn't need to
// re-query the content script (which wouldn't work from a different window).
      if (selection === "select") {
        var selectUrl = chrome.runtime.getURL("select/select.html") + "?token=" + encodeURIComponent(token);
        chrome.windows.create({
          url: selectUrl,
          type: "popup", width: 620, height: 680, focused: true
        });
        setStatus("Select window opened", "success");
        exportBtn.disabled = false;
        return;
      }

      switch (selection) {
        // getAllChats() returns only summary data. We need getChatDetails + getMessagesBatch
        // to get the actual message content. These two calls do the heavy lifting.
        case "last": {
          var recentList = await getAllChats(token, "default", 1);
          if (recentList.length === 0) throw new Error("No conversations found.");
          var summary = recentList[0];
          var det = await getChatDetails(token, summary.id);
          var msgMap = det.chat && det.chat.history && det.chat.history.messages ? det.chat.history.messages : {};
          var mIds = Object.keys(msgMap);
          var batch = await getMessagesBatch(token, summary.id, mIds);
          var msgs = Object.values(batch);
          chats = [{
            id: det.id, title: det.title || "Untitled",
            created_at: det.created_at ? new Date(det.created_at*1000).toISOString() : null,
            updated_at: det.updated_at ? new Date(det.updated_at*1000).toISOString() : null,
            messages: msgs.map(function(msg) {
              var blocks = msg.content_blocks || [];
              var rBlock = null;
              for (var b = 0; b < blocks.length; b++) { if (blocks[b].type === "reasoning") { rBlock = blocks[b]; break; } }
              return {
                id: msg.id, role: msg.role, content: msg.content,
                reasoning: rBlock ? rBlock.content : null,
                content_blocks: blocks,
                timestamp: msg.timestamp ? new Date(msg.timestamp*1000).toISOString() : null,
                model: msg.model || null, usage: msg.usage || null, done: msg.done || false
              };
            })
          }];
          break;
        }
        case "recent": {
          var count = parseInt(recentInput.value) || 20;
          setStatus("Fetching " + count + " recent conversations...", "info");
          var recentList = await getAllChats(token, "default", count);
          if (recentList.length === 0) throw new Error("No conversations found.");
          chats = [];
          for (var r = 0; r < recentList.length; r++) {
            try {
              var det = await getChatDetails(token, recentList[r].id);
              var msgMap = det.chat && det.chat.history && det.chat.history.messages ? det.chat.history.messages : {};
              var mIds = Object.keys(msgMap);
              var batch = await getMessagesBatch(token, recentList[r].id, mIds);
              var msgs = Object.values(batch);
              chats.push({
                id: det.id, title: det.title || "Untitled",
                created_at: det.created_at ? new Date(det.created_at*1000).toISOString() : null,
                updated_at: det.updated_at ? new Date(det.updated_at*1000).toISOString() : null,
                messages: msgs.map(function(msg) {
                  var blocks = msg.content_blocks || [];
                  var rBlock = null;
                  for (var b = 0; b < blocks.length; b++) { if (blocks[b].type === "reasoning") { rBlock = blocks[b]; break; } }
                  return {
                    id: msg.id, role: msg.role, content: msg.content,
                    reasoning: rBlock ? rBlock.content : null,
                    content_blocks: blocks,
                    timestamp: msg.timestamp ? new Date(msg.timestamp*1000).toISOString() : null,
                    model: msg.model || null, usage: msg.usage || null, done: msg.done || false
                  };
                })
              });
            } catch (e) { console.warn("Failed to fetch messages for " + recentList[r].id, e); }
          }
          if (chats.length === 0) throw new Error("No valid chats could be fetched.");
          break;
        }
        case "all": {
          setStatus("Fetching all conversations... this may take a moment.", "info");
          var allList = await getAllChats(token, "default");
          if (allList.length === 0) throw new Error("No conversations found.");
          chats = [];
          for (var a = 0; a < allList.length; a++) {
            try {
              var det = await getChatDetails(token, allList[a].id);
              var msgMap = det.chat && det.chat.history && det.chat.history.messages ? det.chat.history.messages : {};
              var mIds = Object.keys(msgMap);
              var batch = await getMessagesBatch(token, allList[a].id, mIds);
              var msgs = Object.values(batch);
              chats.push({
                id: det.id, title: det.title || "Untitled",
                created_at: det.created_at ? new Date(det.created_at*1000).toISOString() : null,
                updated_at: det.updated_at ? new Date(det.updated_at*1000).toISOString() : null,
                messages: msgs.map(function(msg) {
                  var blocks = msg.content_blocks || [];
                  var rBlock = null;
                  for (var b = 0; b < blocks.length; b++) { if (blocks[b].type === "reasoning") { rBlock = blocks[b]; break; } }
                  return {
                    id: msg.id, role: msg.role, content: msg.content,
                    reasoning: rBlock ? rBlock.content : null,
                    content_blocks: blocks,
                    timestamp: msg.timestamp ? new Date(msg.timestamp*1000).toISOString() : null,
                    model: msg.model || null, usage: msg.usage || null, done: msg.done || false
                  };
                })
              });
            } catch (e) { console.warn("Failed to fetch messages for " + allList[a].id, e); }
          }
          if (chats.length === 0) throw new Error("No valid chats could be fetched.");
          break;
        }
        // For the currently open chat, we extract the ID from the tab URL,
        // then fetch details + messages. Same pattern as "last", but the ID
// comes from the browser tab instead of the API.
        case "current": {
          var chatId = await getCurrentChatIdFromTab();
          if (!chatId) throw new Error("No chat currently open.");
          var details = await getChatDetails(token, chatId);
          var msgMap = details.chat && details.chat.history && details.chat.history.messages
            ? details.chat.history.messages : {};
          var messageIds = Object.keys(msgMap);
          var batchData = await getMessagesBatch(token, chatId, messageIds);
          var messages = Object.values(batchData);
          chats = [{
            id: details.id,
            title: details.title || "Untitled",
            created_at: details.created_at ? new Date(details.created_at*1000).toISOString() : null,
            updated_at: details.updated_at ? new Date(details.updated_at*1000).toISOString() : null,
            messages: messages.map(function(msg) {
              var blocks = msg.content_blocks || [];
              var rBlock = null;
              for (var b = 0; b < blocks.length; b++) {
                if (blocks[b].type === "reasoning") { rBlock = blocks[b]; break; }
              }
              return {
                id: msg.id, role: msg.role, content: msg.content,
                reasoning: rBlock ? rBlock.content : null,
                content_blocks: blocks,
                timestamp: msg.timestamp ? new Date(msg.timestamp*1000).toISOString() : null,
                model: msg.model || null, usage: msg.usage || null, done: msg.done || false
              };
            })
          }];
          break;
        }
        default: throw new Error("Invalid selection.");
      }

      var incReason = document.getElementById("includeReasoning").checked;
      var incMeta = document.getElementById("includeMetadata").checked;
      var incRaw = document.getElementById("includeRaw").checked;

      if (!incReason) {
        for (var c = 0; c < chats.length; c++) {
          for (var m = 0; m < chats[c].messages.length; m++) {
            delete chats[c].messages[m].reasoning;
            if (chats[c].messages[m].content_blocks) {
              chats[c].messages[m].content_blocks = chats[c].messages[m].content_blocks.filter(function(b) { return b.type !== "reasoning"; });
            }
          }
        }
      }
      if (!incMeta) {
        for (var c = 0; c < chats.length; c++) {
          delete chats[c].created_at; delete chats[c].updated_at; delete chats[c].type; delete chats[c].im_context;
          for (var m = 0; m < chats[c].messages.length; m++) {
            delete chats[c].messages[m].timestamp; delete chats[c].messages[m].model;
            delete chats[c].messages[m].usage; delete chats[c].messages[m].parent_id;
            delete chats[c].messages[m].children_ids;
          }
        }
      }
      if (!incRaw) {
        for (var c = 0; c < chats.length; c++) { delete chats[c].raw; }
      }

      var now = new Date();
      var fn = "zai_export_" + now.getFullYear() + "-" + String(now.getMonth()+1).padStart(2,"0") + "-" + String(now.getDate()).padStart(2,"0");
      downloadExport(chats, format, fn);
      setStatus("Exported " + chats.length + " conversation(s) as " + format.toUpperCase() + " \u2705", "success");
    } catch (err) {
      setStatus("\u274C " + err.message, "error");
      console.error("Export error:", err);
    } finally { exportBtn.disabled = false; }
  });
});

async function getCurrentChatIdFromTab() {
  var tab;
  try {
    var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = tabs[0];
  } catch (e) {
    try {
      var tabs = await browser.tabs.query({ active: true, currentWindow: true });
      tab = tabs[0];
    } catch (err) {
      throw new Error("Could not query tabs");
    }
  }
  var url = tab.url;
  if (url && url.indexOf("/c/") !== -1) {
    var match = url.match(/\/c\/([a-f0-9-]+)/);
    if (match) return match[1];
  }
  try {
    var response = await chrome.tabs.sendMessage(tab.id, { action: "getChatId" });
    if (response && response.success) return response.chatId;
  } catch (e) {}
  throw new Error("No chat currently open. Please open a conversation.");
}
