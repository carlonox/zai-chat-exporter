// Z.ai stores the auth token in localStorage under "token".
// We grab it from the content script (which runs on chat.z.ai)
// and pass it to every API call. No token = no data.
var API_BASE = "https://chat.z.ai/api/v1";

export function getHeaders(token) {
  return {
    "Authorization": "Bearer " + token,
    "Content-Type": "application/json"
  };
}

// GET /chats/?page=N&type=default — paginated list of conversations.
// Returns summary data (title, dates, IDs). No message content yet.
export function getChats(token, page, type) {
  if (page === undefined) page = 1;
  if (type === undefined) type = "default";
  var url = API_BASE + "/chats/?page=" + page + "&type=" + type;
  return fetch(url, { headers: getHeaders(token) }).then(function(r) {
    if (!r.ok) throw new Error("Failed to fetch chats (HTTP " + r.status + ")");
    return r.json();
  });
}

// GET /chats/{id} — full metadata for one conversation.
// Also returns message IDs, which we need for the batch endpoint.
export function getChatDetails(token, chatId) {
  var url = API_BASE + "/chats/" + chatId;
  return fetch(url, { headers: getHeaders(token) }).then(function(r) {
    if (!r.ok) throw new Error("Failed to fetch chat details (HTTP " + r.status + ")");
    return r.json();
  });
}

// POST /chats/{id}/messages/batch — the heavy lifter.
// Accepts an array of message IDs, returns full content.
// This is where the actual message text, reasoning, and metadata come from.
export function getMessagesBatch(token, chatId, messageIds) {
  if (!messageIds || messageIds.length === 0) {
    return Promise.resolve({});
  }
  var url = API_BASE + "/chats/" + chatId + "/messages/batch";
  return fetch(url, {
    method: "POST",
    headers: getHeaders(token),
    body: JSON.stringify({ ids: messageIds })
  }).then(function(r) {
    if (!r.ok) throw new Error("Failed to fetch messages batch (HTTP " + r.status + ")");
    return r.json().then(function(d) { return d.data || {}; });
  });
}

// Automatically paginates through all pages until limit is reached.
// Uses recursion internally — each page fetches the next.
export function getAllChats(token, type, limit) {
  if (type === undefined) type = "default";
  if (limit === undefined) limit = Infinity;
  var allChats = [];
  var page = 1;
  var hasMore = true;
  function fetchPage() {
    if (!hasMore || allChats.length >= limit) return Promise.resolve(allChats);
    return getChats(token, page, type).then(function(chats) {
      if (!chats || chats.length === 0) { hasMore = false; return allChats; }
      allChats = allChats.concat(chats);
      if (chats.length < 20) { hasMore = false; } else { page++; }
      if (allChats.length > limit) allChats = allChats.slice(0, limit);
      return fetchPage();
    });
  }
  return fetchPage();
}
