// The popup can't access chat.z.ai's localStorage directly — it runs in its own extension context.
// So we ask the content script (injected into the page) to read the token for us.
// This function wraps that request in a Promise.
//
// popup.js stays ESM (uses `import`) so esbuild's IIFE bundler treats it as a
// proper entry point. The lib files (api.js, exporters.js) are CommonJS —
// esbuild handles the ESM→CJS interop transparently when bundling.
import { getAllChats, getChatDetails, getMessagesBatched } from "../lib/api.js";
import { EXPORTERS, downloadExport } from "../lib/exporters.js";

// Normalizes one raw message object from the Z.ai batch endpoint into the
// shape we serialize. This shape is what the JSON export preserves — we
// intentionally keep content_blocks, reasoning, model, usage, etc.
//
// NOTE: we do NOT mutate or rewrite the raw `content` field. The JSON output
// keeps the original `content` exactly as the API returned it. The
// Markdown/TXT exporters independently use extractMessageBody() to find the
// body text, which falls back to content_blocks when `content` is empty.
function normalizeMessage(msg) {
  if (!msg || typeof msg !== "object") return null;
  var blocks = Array.isArray(msg.content_blocks) ? msg.content_blocks : [];
  var rBlock = null;
  for (var b = 0; b < blocks.length; b++) {
    if (blocks[b] && blocks[b].type === "reasoning") { rBlock = blocks[b]; break; }
  }
  return {
    id: msg.id !== undefined ? msg.id : null,
    role: msg.role !== undefined ? msg.role : null,
    content: msg.content !== undefined ? msg.content : null,
    reasoning: rBlock ? rBlock.content : null,
    content_blocks: blocks,
    timestamp: msg.timestamp ? new Date(msg.timestamp * 1000).toISOString() : null,
    model: msg.model || null,
    usage: msg.usage || null,
    done: msg.done || false
  };
}

// Rebuild the messages array in the ORIGINAL ID order from
// `details.chat.history.messages`. This is critical: the batch endpoint may
// return messages in a different order (key order, insertion order, sorted by
// some internal index), and Object.values(batchData) would silently scramble
// the conversation. We must iterate the requested ID list and look each one
// up in the returned map.
//
// Throws an ExportError when the batch result is incomplete (missing IDs,
// retry-exhausted batches, or unexpected IDs). The caller MUST NOT swallow
// this and pretend the export was successful.
function ExportError(message, details) {
  var err = new Error(message);
  err.name = "ExportError";
  err.details = details || {};
  return err;
}

function fetchChatConversation(token, chatSummary) {
  return getChatDetails(token, chatSummary.id).then(function(det) {
    var msgMap = (det && det.chat && det.chat.history && det.chat.history.messages)
      ? det.chat.history.messages
      : {};
    var mIds = Object.keys(msgMap);

    // Preserve original order for downstream consumers.
    var orderedIds = mIds.slice();

    // Empty chat — return a chat with no messages rather than failing.
    if (orderedIds.length === 0) {
      return {
        id: det.id !== undefined ? det.id : chatSummary.id,
        title: det.title || chatSummary.title || "Untitled",
        created_at: det.created_at ? new Date(det.created_at * 1000).toISOString() : null,
        updated_at: det.updated_at ? new Date(det.updated_at * 1000).toISOString() : null,
        messages: []
      };
    }

    return getMessagesBatched(token, chatSummary.id, orderedIds).then(function(result) {
      // Rebuild messages in the ORIGINAL requested ID order.
      var messages = [];
      for (var i = 0; i < orderedIds.length; i++) {
        var id = orderedIds[i];
        var raw = result.messages[id];
        if (raw === undefined) {
          // Missing message — record a clearly-marked placeholder so the
          // export never silently drops a slot from the conversation order.
          messages.push({
            id: id,
            role: null,
            content: null,
            reasoning: null,
            content_blocks: [],
            timestamp: null,
            model: null,
            usage: null,
            done: false,
            _export_status: "missing"
          });
        } else {
          var norm = normalizeMessage(raw);
          if (norm) messages.push(norm);
        }
      }

      if (!result.complete) {
        var details = {
          chatId: chatSummary.id,
          chatTitle: det.title || chatSummary.title || "Untitled",
          requestedCount: orderedIds.length,
          returnedCount: result.returnedIds.length,
          missingIds: result.missingIds,
          unexpectedIds: result.unexpectedIds,
          duplicateCount: result.duplicateCount,
          errors: result.errors
        };
        throw new ExportError(
          "Incomplete message batch for chat " + chatSummary.id +
            " (" + result.missingIds.length + " missing, " +
            result.errors.length + " batch errors)",
          details
        );
      }

      return {
        id: det.id !== undefined ? det.id : chatSummary.id,
        title: det.title || chatSummary.title || "Untitled",
        created_at: det.created_at ? new Date(det.created_at * 1000).toISOString() : null,
        updated_at: det.updated_at ? new Date(det.updated_at * 1000).toISOString() : null,
        messages: messages
      };
    });
  });
}

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

      // Accumulator for incomplete chats — we still produce a download but
      // surface a clear warning to the user (and the JSON includes the
      // diagnostic info per message via _export_status).
      var incomplete = [];

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
        case "last": {
          var recentList = await getAllChats(token, "default", 1);
          if (recentList.length === 0) throw new Error("No conversations found.");
          var summary = recentList[0];
          try {
            chats = [await fetchChatConversation(token, summary)];
          } catch (e) {
            if (e && e.name === "ExportError") {
              incomplete.push(e.details);
              // Re-build the chat from the partial data so the user still
              // gets a downloadable artifact with explicit missing slots.
              chats = [await _rebuildPartialChat(token, summary, e.details)];
            } else {
              throw e;
            }
          }
          break;
        }
        case "recent": {
          var count = parseInt(recentInput.value) || 20;
          setStatus("Fetching " + count + " recent conversations...", "info");
          var recentList2 = await getAllChats(token, "default", count);
          if (recentList2.length === 0) throw new Error("No conversations found.");
          chats = [];
          for (var r = 0; r < recentList2.length; r++) {
            try {
              chats.push(await fetchChatConversation(token, recentList2[r]));
            } catch (e) {
              if (e && e.name === "ExportError") {
                incomplete.push(e.details);
                chats.push(await _rebuildPartialChat(token, recentList2[r], e.details));
              } else {
                // Different error — log and skip this chat but keep going,
                // like the original behavior. Don't abort the entire export.
                console.warn("Failed to fetch messages for " + recentList2[r].id, e);
              }
            }
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
              chats.push(await fetchChatConversation(token, allList[a]));
            } catch (e) {
              if (e && e.name === "ExportError") {
                incomplete.push(e.details);
                chats.push(await _rebuildPartialChat(token, allList[a], e.details));
              } else {
                console.warn("Failed to fetch messages for " + allList[a].id, e);
              }
            }
          }
          if (chats.length === 0) throw new Error("No valid chats could be fetched.");
          break;
        }
        case "current": {
          var chatId = await getCurrentChatIdFromTab();
          if (!chatId) throw new Error("No chat currently open.");
          var summary2 = { id: chatId, title: "Current chat" };
          try {
            chats = [await fetchChatConversation(token, summary2)];
          } catch (e) {
            if (e && e.name === "ExportError") {
              incomplete.push(e.details);
              chats = [await _rebuildPartialChat(token, summary2, e.details)];
            } else {
              throw e;
            }
          }
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
        for (var c2 = 0; c2 < chats.length; c2++) {
          delete chats[c2].created_at; delete chats[c2].updated_at; delete chats[c2].type; delete chats[c2].im_context;
          for (var m2 = 0; m2 < chats[c2].messages.length; m2++) {
            delete chats[c2].messages[m2].timestamp; delete chats[c2].messages[m2].model;
            delete chats[c2].messages[m2].usage; delete chats[c2].messages[m2].parent_id;
            delete chats[c2].messages[m2].children_ids;
          }
        }
      }
      if (!incRaw) {
        for (var c3 = 0; c3 < chats.length; c3++) { delete chats[c3].raw; }
      }

      var now = new Date();
      var fn = "zai_export_" + now.getFullYear() + "-" + String(now.getMonth()+1).padStart(2,"0") + "-" + String(now.getDate()).padStart(2,"0");
      downloadExport(chats, format, fn);
      if (incomplete.length > 0) {
        var totalMissing = 0;
        for (var ix = 0; ix < incomplete.length; ix++) {
          totalMissing += (incomplete[ix].missingIds || []).length;
        }
        setStatus(
          "Exported " + chats.length + " conversation(s) as " + format.toUpperCase() +
            " \u2705 BUT " + incomplete.length + " chat(s) had " + totalMissing +
            " missing message(s) — see console for details.",
          "error"
        );
        console.warn("Export incomplete. Details:", incomplete);
      } else {
        setStatus("Exported " + chats.length + " conversation(s) as " + format.toUpperCase() + " \u2705", "success");
      }
    } catch (err) {
      setStatus("\u274C " + err.message, "error");
      console.error("Export error:", err);
    } finally { exportBtn.disabled = false; }
  });
});

// Re-fetch a chat's details + batch result and reconstruct a partial chat
// object, leaving clearly-marked placeholder slots for any missing messages.
// Used when getMessagesBatched returned incomplete data — we still want to
// hand the user a downloadable artifact so they can see what survived.
function _rebuildPartialChat(token, summary, details) {
  // We already have the diagnostic details; we need the chat metadata too.
  return getChatDetails(token, summary.id).then(function(det) {
    var msgMap = (det && det.chat && det.chat.history && det.chat.history.messages)
      ? det.chat.history.messages
      : {};
    var orderedIds = Object.keys(msgMap);
    var missingSet = {};
    for (var i = 0; i < (details.missingIds || []).length; i++) {
      missingSet[details.missingIds[i]] = true;
    }
    // We don't have the full messages map here (the original error path
    // didn't keep it). Re-fetch only the IDs that we know are present.
    var presentIds = orderedIds.filter(function(id) { return !missingSet[id]; });
    return getMessagesBatched(token, summary.id, presentIds, { maxRetries: 0 }).then(function(result) {
      var messages = [];
      for (var j = 0; j < orderedIds.length; j++) {
        var id = orderedIds[j];
        if (missingSet[id]) {
          messages.push({
            id: id, role: null, content: null, reasoning: null,
            content_blocks: [], timestamp: null, model: null, usage: null,
            done: false, _export_status: "missing"
          });
        } else {
          var raw = result.messages[id];
          if (raw) {
            var norm = normalizeMessage(raw);
            if (norm) messages.push(norm);
          }
        }
      }
      return {
        id: det.id !== undefined ? det.id : summary.id,
        title: det.title || summary.title || "Untitled",
        created_at: det.created_at ? new Date(det.created_at * 1000).toISOString() : null,
        updated_at: det.updated_at ? new Date(det.updated_at * 1000).toISOString() : null,
        messages: messages
      };
    }).catch(function() {
      // Last-resort: at least return the chat skeleton so the user gets
      // SOMETHING with explicit missing markers.
      var messages2 = orderedIds.map(function(id) {
        return {
          id: id, role: null, content: null, reasoning: null,
          content_blocks: [], timestamp: null, model: null, usage: null,
          done: false, _export_status: "missing"
        };
      });
      return {
        id: det.id !== undefined ? det.id : summary.id,
        title: det.title || summary.title || "Untitled",
        created_at: det.created_at ? new Date(det.created_at * 1000).toISOString() : null,
        updated_at: det.updated_at ? new Date(det.updated_at * 1000).toISOString() : null,
        messages: messages2
      };
    });
  });
}

async function getCurrentChatIdFromTab() {
  var tab;
  try {
    var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = tabs[0];
  } catch (e) {
    try {
      var tabs2 = await browser.tabs.query({ active: true, currentWindow: true });
      tab = tabs2[0];
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
