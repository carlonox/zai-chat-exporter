// select.js — window for picking specific chats to export.
//
// Refactored to use the shared lib/ modules so the markdown / plain-text /
// JSON formatting logic is identical to popup.js. This was previously a
// second copy of the same code with the same "msg.content || '[Empty]'"
// bug — fixing both sites centrally prevents future drift.
//
// select.js stays ESM (uses `import`) so esbuild's IIFE bundler treats it
// as a proper entry point. The lib files (api.js, exporters.js) are CommonJS
// — esbuild handles the ESM→CJS interop transparently when bundling.
import { toMarkdown, toPlainText } from "../lib/exporters.js";

var API_BASE = "https://chat.z.ai/api/v1";
var allChats = [];
var selectedIds = {};
var authToken = null;

function getAuthToken() {
  return new Promise(function(resolve, reject) {
    chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
      if (!tabs || tabs.length === 0) { reject(new Error("No active tab")); return; }
      chrome.tabs.sendMessage(tabs[0].id, { action: "getToken" }, function(rsp) {
        if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
        if (rsp && rsp.success) resolve(rsp.token);
        else reject(new Error((rsp && rsp.error) || "Failed to get token"));
      });
    });
  });
}

function formatDate(ts) {
  if (!ts) return "";
  var d = typeof ts === "number" ? new Date(ts * 1000) : new Date(ts);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function renderChats(filter) {
  var list = document.getElementById("chatList");
  if (!filter) filter = "";
  filter = filter.toLowerCase().trim();
  list.innerHTML = "";
  var visibleCount = 0;
  var fragment = document.createDocumentFragment();
  for (var i = 0; i < allChats.length; i++) {
    var chat = allChats[i];
    var title = chat.title || "Untitled";
    if (filter && title.toLowerCase().indexOf(filter) === -1) continue;
    var checked = selectedIds[chat.id] ? true : false;
    var div = document.createElement("div");
    div.className = "chat-item";
    div.setAttribute("data-id", chat.id);
    var cb = document.createElement("input");
    cb.type = "checkbox";
    if (checked) cb.checked = true;
    div.appendChild(cb);
    var titleSpan = document.createElement("span");
    titleSpan.className = "chat-title";
    titleSpan.textContent = title;
    div.appendChild(titleSpan);
    var dateSpan = document.createElement("span");
    dateSpan.className = "chat-date";
    dateSpan.textContent = formatDate(chat.created_at);
    div.appendChild(dateSpan);
    fragment.appendChild(div);
    visibleCount++;
  }
  if (visibleCount === 0) {
    var noResults = document.createElement("div");
    noResults.className = "no-results";
    noResults.textContent = "No conversations found" + (filter ? " matching \"" + filter + "\"" : "") + ".";
    fragment.appendChild(noResults);
  }
  list.appendChild(fragment);
  updateCount();
  attachCheckboxListeners();
}

function escapeHtml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function attachCheckboxListeners() {
  var items = document.querySelectorAll(".chat-item");

  for (var i = 0; i < items.length; i++) {
    (function(item) {
      var cb = item.querySelector("input[type=checkbox]");
      if (!cb) return;
      cb.addEventListener("change", function() {
        var id = item.getAttribute("data-id");
        if (cb.checked) selectedIds[id] = true;
        else delete selectedIds[id];
        updateCount();
      });
      item.addEventListener("click", function(e) {
        if (e.target === cb) return;
        cb.checked = !cb.checked;
        var evt = new Event("change"); cb.dispatchEvent(evt);
      });
    })(items[i]);
  }
}

function updateCount() {
  var count = Object.keys(selectedIds).length;
  document.getElementById("selectedCount").textContent = count + " selected";
  var btn = document.getElementById("exportSelectedBtn");
  btn.disabled = count === 0;
  btn.textContent = "Export Selected (" + count + ")";
}

// Helpers shared with popup.js. Kept here for the bundled select.js context.
// (esbuild inlines these into the IIFE — no cross-window globals needed.)
function normalizeMessage(msg) {
  if (!msg || typeof msg !== "object") return null;
  var blocks = Array.isArray(msg.content_blocks) ? msg.content_blocks : [];
  var rBlock = null;
  for (var b = 0; b < blocks.length; b++) {
    if (blocks[b] && blocks[b].type === "reasoning") { rBlock = blocks[b]; break; }
  }
  var normalized = {
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
  // Preserve order-reconstruction fields so the JSON archive + Markdown
  // exporter can reconstruct the conversation timeline later.
  if (msg.parent_id !== undefined) normalized.parent_id = msg.parent_id;
  if (msg.children_ids !== undefined) normalized.children_ids = msg.children_ids;
  return normalized;
}

// Fetch + normalize one chat, with chunked batch fetching and missing-ID
// reporting. Mirrors popup.js's fetchChatConversation but reports per-chat
// incompleteness back to the select window UI so the user can retry or
// abort rather than silently accept a partial export.
function fetchChatConversation(token, chatSummary) {
  return fetch(API_BASE + "/chats/" + chatSummary.id, {
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }
  }).then(function(r) {
    if (!r.ok) throw new Error("Chat details HTTP " + r.status);
    return r.json();
  }).then(function(det) {
    var msgMap = (det && det.chat && det.chat.history && det.chat.history.messages)
      ? det.chat.history.messages
      : {};
    var orderedIds = Object.keys(msgMap);
    if (orderedIds.length === 0) {
      return {
        id: det.id !== undefined ? det.id : chatSummary.id,
        title: det.title || chatSummary.title || "Untitled",
        created_at: det.created_at ? new Date(det.created_at * 1000).toISOString() : null,
        updated_at: det.updated_at ? new Date(det.updated_at * 1000).toISOString() : null,
        messages: [],
        _incomplete: false
      };
    }

    // Chunk the IDs to avoid sending one huge POST body.
    var BATCH_SIZE = 50;
    var MAX_RETRIES = 3;
    var merged = {};
    var missingIds = [];
    var batchErrors = [];
    var returnedSeen = {};

    function fetchBatch(batchIds, attempt) {
      return fetch(API_BASE + "/chats/" + chatSummary.id + "/messages/batch", {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({ ids: batchIds })
      }).then(function(r) {
        if (!r.ok) {
          var err = new Error("Batch HTTP " + r.status);
          throw err;
        }
        return r.json();
      }).then(function(d) {
        return (d && d.data && typeof d.data === "object") ? d.data : (d || {});
      }).catch(function(err) {
        if (attempt < MAX_RETRIES) {
          var delay = 500 * Math.pow(2, attempt - 1);
          return new Promise(function(res) { setTimeout(res, delay); })
            .then(function() { return fetchBatch(batchIds, attempt + 1); });
        }
        batchErrors.push(err && err.message ? err.message : String(err));
        return {};
      });
    }

    var chain = Promise.resolve();
    for (var i = 0; i < orderedIds.length; i += BATCH_SIZE) {
      (function(batchIds) {
        chain = chain.then(function() {
          return fetchBatch(batchIds, 1).then(function(batchData) {
            for (var k in batchData) {
              if (!Object.prototype.hasOwnProperty.call(batchData, k)) continue;
              var msg = batchData[k];
              var realId = (msg && msg.id !== undefined && msg.id !== null)
                ? String(msg.id)
                : String(k);
              if (returnedSeen[realId]) continue;
              returnedSeen[realId] = true;
              merged[realId] = msg;
            }
          });
        });
      })(orderedIds.slice(i, i + BATCH_SIZE));
    }

    return chain.then(function() {
      for (var j = 0; j < orderedIds.length; j++) {
        if (!returnedSeen[orderedIds[j]]) missingIds.push(orderedIds[j]);
      }
      var incomplete = (missingIds.length > 0 || batchErrors.length > 0);

      var messages = [];
      for (var m = 0; m < orderedIds.length; m++) {
        var id = orderedIds[m];
        var raw = merged[id];
        if (raw === undefined) {
          messages.push({
            id: id, role: null, content: null, reasoning: null,
            content_blocks: [], timestamp: null, model: null, usage: null,
            done: false, _export_status: "missing"
          });
        } else {
          var norm = normalizeMessage(raw);
          if (norm) messages.push(norm);
        }
      }

      return {
        id: det.id !== undefined ? det.id : chatSummary.id,
        title: det.title || chatSummary.title || "Untitled",
        created_at: det.created_at ? new Date(det.created_at * 1000).toISOString() : null,
        updated_at: det.updated_at ? new Date(det.updated_at * 1000).toISOString() : null,
        messages: messages,
        _incomplete: incomplete,
        _missingIds: missingIds,
        _batchErrors: batchErrors
      };
    });
  });
}

document.addEventListener("DOMContentLoaded", function() {
  var searchInput = document.getElementById("searchInput");
  var selectAllBtn = document.getElementById("selectAllBtn");
  var deselectAllBtn = document.getElementById("deselectAllBtn");
  var exportBtn = document.getElementById("exportSelectedBtn");
  var formatSelect = document.getElementById("selectFormat");
  var statusEl = document.getElementById("status");

  function setStatus(msg, type) {
    if (type === undefined) type = "info";
    statusEl.textContent = msg;
    statusEl.className = "status " + type;
  }

  var params = new URLSearchParams(window.location.search);
  var token = params.get("token");

  if (token) {
    authToken = token;
    fetchAllChats(token).then(function(chats) {
      allChats = chats;
      renderChats("");
    }).catch(function(err) {
      setStatus("Error: " + err.message, "error");
    });
  } else {
    getAuthToken().then(function(t) {
      authToken = t;
      return fetchAllChats(t);
    }).then(function(chats) {
      allChats = chats;
      renderChats("");
    }).catch(function(err) {
      setStatus("Error: " + err.message, "error");
    });
  }

  function fetchAllChats(token) {
    var result = [];
    var page = 1;
    var hasMore = true;
    function next() {
      if (!hasMore) return Promise.resolve(result);
      return fetch(API_BASE + "/chats/?page=" + page + "&type=default", {
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }
      }).then(function(r) { return r.json(); }).then(function(chats) {
        if (!chats || chats.length === 0) { hasMore = false; return result; }
        result = result.concat(chats);
        if (chats.length < 20) { hasMore = false; } else { page++; }
        return next();
      });
    }
    return next();
  }

  searchInput.addEventListener("input", function() {
    renderChats(searchInput.value);
  });

  selectAllBtn.addEventListener("click", function() {
    var filter = searchInput.value.toLowerCase().trim();
    for (var i = 0; i < allChats.length; i++) {
      var t = (allChats[i].title || "").toLowerCase();
      if (!filter || t.indexOf(filter) !== -1) {
        selectedIds[allChats[i].id] = true;
      }
    }
    renderChats(searchInput.value);
  });

  deselectAllBtn.addEventListener("click", function() {
    selectedIds = {};
    renderChats(searchInput.value);
  });

  exportBtn.addEventListener("click", function() {
    var ids = Object.keys(selectedIds);
    if (ids.length === 0) return;
    var format = formatSelect.value;
    setStatus("Fetching " + ids.length + " conversations...", "info");
    exportBtn.disabled = true;

    var chatPromises = ids.map(function(id) {
      return fetchChatConversation(authToken, { id: id });
    });

    Promise.all(chatPromises).then(function(chats) {
      var incomplete = chats.filter(function(c) { return c._incomplete; });
      for (var i = 0; i < chats.length; i++) {
        // Strip the internal diagnostic fields from the final JSON output
        // unless incomplete — the user doesn't need them otherwise.
        if (!chats[i]._incomplete) {
          delete chats[i]._incomplete;
          delete chats[i]._missingIds;
          delete chats[i]._batchErrors;
        }
      }

      var content;
      if (format === "json") {
        content = JSON.stringify(chats, null, 2);
      } else if (format === "markdown") {
        content = toMarkdown(chats);
      } else {
        content = toPlainText(chats);
      }
      var ext = format === "json" ? ".json" : format === "markdown" ? ".md" : ".txt";
      var mime = format === "json" ? "application/json"
        : format === "markdown" ? "text/markdown" : "text/plain";
      var now = new Date();
      var fname = "zai_export_"
        + now.getFullYear() + "-" + String(now.getMonth()+1).padStart(2,"0")
        + "-" + String(now.getDate()).padStart(2,"0") + ext;
      var blob = new Blob([content], { type: mime });
      var url = URL.createObjectURL(blob);
      var link = document.createElement("a");
      link.href = url; link.download = fname;
      document.body.appendChild(link); link.click(); document.body.removeChild(link);
      URL.revokeObjectURL(url);

      if (incomplete.length > 0) {
        var totalMissing = 0;
        for (var ix = 0; ix < incomplete.length; ix++) {
          totalMissing += (incomplete[ix]._missingIds || []).length;
        }
        setStatus(
          "Exported " + chats.length + " conversations as " + format.toUpperCase() +
            " BUT " + incomplete.length + " chat(s) had " + totalMissing +
            " missing message(s). See JSON _export_status fields.",
          "error"
        );
      } else {
        setStatus("Exported " + chats.length + " conversations as " + format.toUpperCase(), "success");
      }
    }).catch(function(err) {
      setStatus("Export failed: " + err.message, "error");
    }).finally(function() {
      exportBtn.disabled = false;
    });
  });
});
