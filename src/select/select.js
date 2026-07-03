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
      return fetch(API_BASE + "/chats/" + id, {
        headers: { Authorization: "Bearer " + authToken, "Content-Type": "application/json" }
      }).then(function(r) { return r.json(); }).then(function(detail) {
        var msgIds = Object.keys(detail.chat && detail.chat.history && detail.chat.history.messages
          ? detail.chat.history.messages : {});
        if (msgIds.length === 0) {
          return { id: id, title: detail.title || "Untitled", messages: [] };
        }
        return fetch(API_BASE + "/chats/" + id + "/messages/batch", {
          method: "POST",
          headers: { Authorization: "Bearer " + authToken, "Content-Type": "application/json" },
          body: JSON.stringify({ ids: msgIds })
        }).then(function(r) { return r.json(); }).then(function(batch) {
          var msgs = batch.data || {};
          return {
            id: id,
            title: detail.title || "Untitled",
            created_at: detail.created_at ? new Date(detail.created_at * 1000).toISOString() : null,
            updated_at: detail.updated_at ? new Date(detail.updated_at * 1000).toISOString() : null,
            messages: Object.values(msgs).map(function(m) {
              var blocks = m.content_blocks || [];
              var rBlock = null;
              for (var b = 0; b < blocks.length; b++) {
                if (blocks[b].type === "reasoning") { rBlock = blocks[b]; break; }
              }
              return {
                id: m.id, role: m.role, content: m.content,
                reasoning: rBlock ? rBlock.content : null,
                content_blocks: blocks,
                timestamp: m.timestamp ? new Date(m.timestamp * 1000).toISOString() : null,
                model: m.model || null, usage: m.usage || null
              };
            })
          };
        });
      });
    });

    Promise.all(chatPromises).then(function(chats) {
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
      setStatus("Exported " + chats.length + " conversations as " + format.toUpperCase(), "success");
    }).catch(function(err) {
      setStatus("Export failed: " + err.message, "error");
    }).finally(function() {
      exportBtn.disabled = false;
    });
  });
});

function toMarkdown(chats) {
  var out = "";
  for (var c = 0; c < chats.length; c++) {
    var chat = chats[c];
    out += "# " + (chat.title || "Untitled Chat") + "\n\n";
    out += "**ID:** `" + chat.id + "`\n";
    out += "**Created:** " + (chat.created_at || "Unknown") + "\n\n---\n\n";
    if (!chat.messages || chat.messages.length === 0) { out += "*No messages.*\n\n"; continue; }
    for (var m = 0; m < chat.messages.length; m++) {
      var msg = chat.messages[m];
      var role = msg.role === "user" ? "User" : msg.role === "assistant" ? "Assistant" : msg.role;
      out += "### " + role + (msg.timestamp ? " (" + msg.timestamp + ")" : "") + "\n\n";
      if (msg.model) out += "*Model: " + msg.model + "*\n\n";
      out += (msg.content || "[Empty message]") + "\n\n";
      if (msg.reasoning) out += "<details><summary>Reasoning</summary>\n\n" + msg.reasoning + "\n\n</details>\n\n";
      out += "---\n\n";
    }
  }
  return out;
}

function toPlainText(chats) {
  var out = "";
  for (var c = 0; c < chats.length; c++) {
    var chat = chats[c];
    out += "== " + (chat.title || "Untitled Chat") + " ==\n";
    out += "ID: " + chat.id + "\n";
    out += "Created: " + (chat.created_at || "Unknown") + "\n\n";
    if (!chat.messages || chat.messages.length === 0) { out += "No messages.\n\n"; continue; }
    for (var m = 0; m < chat.messages.length; m++) {
      var msg = chat.messages[m];
      var role = msg.role === "user" ? "User" : msg.role === "assistant" ? "Assistant" : msg.role;
      out += role + (msg.timestamp ? " [" + msg.timestamp + "]" : "") + ":\n";
      out += (msg.content || "[Empty message]") + "\n\n";
    }
  }
  return out;
}
