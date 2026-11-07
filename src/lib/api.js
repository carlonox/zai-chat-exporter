// Z.ai API client.
//
// All endpoints live under https://chat.z.ai/api/v1.
// The auth token is stored in chat.z.ai's localStorage under "token" —
// the content script reads it and passes it here.
//
// We use CommonJS (module.exports) so the modules are natively require()-able
// from Node tests without a bundler. esbuild still bundles these files for
// the browser build (it handles ESM→CJS interop transparently).

var API_BASE = "https://chat.z.ai/api/v1";

// Default tunables for batched message fetching.
// These are conservative defaults — override per-call via options if needed.
var DEFAULT_BATCH_SIZE = 50;
var DEFAULT_MAX_RETRIES = 3;
var DEFAULT_RETRY_DELAY_MS = 500;

function getHeaders(token) {
  return {
    "Authorization": "Bearer " + token,
    "Content-Type": "application/json"
  };
}

// GET /chats/?page=N&type=default — paginated list of conversations.
// Returns summary data (title, dates, IDs). No message content yet.
function getChats(token, page, type) {
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
function getChatDetails(token, chatId) {
  var url = API_BASE + "/chats/" + chatId;
  return fetch(url, { headers: getHeaders(token) }).then(function(r) {
    if (!r.ok) throw new Error("Failed to fetch chat details (HTTP " + r.status + ")");
    return r.json();
  });
}

// POST /chats/{id}/messages/batch — the heavy lifter.
//
// Accepts an array of message IDs, returns full content.
//
// Backward-compatible single-shot wrapper around getMessagesBatched().
// Prefer getMessagesBatched() directly — it returns a structured result with
// missing-ID diagnostics. This wrapper returns the raw data map only, which
// is what older callers expect.
function getMessagesBatch(token, chatId, messageIds) {
  if (!messageIds || messageIds.length === 0) {
    return Promise.resolve({});
  }
  return getMessagesBatched(token, chatId, messageIds).then(function(result) {
    return result.messages || {};
  });
}

// POST /chats/{id}/messages/batch — chunked, with retry + completeness check.
//
// Splits the requested message IDs into batches (default 50 per batch) and
// sends each batch as a separate POST. Failed batches are retried with
// exponential backoff up to maxRetries times. Results from all batches are
// merged into a single map keyed by message ID.
//
// Returns:
//   {
//     messages:        { <messageId>: <messageObject>, ... },
//     requestedIds:    [<id>, ...],           // input order preserved
//     returnedIds:      [<id>, ...],           // unique IDs the API actually returned
//     missingIds:      [<id>, ...],           // requested but never returned
//     duplicateCount:  <int>,                // count of duplicate IDs in responses
//     unexpectedIds:   [<id>, ...],          // returned but not requested
//     errors:          [<Error message>, ...],
//     complete:        <bool>                 // true iff missingIds is empty AND no errors
//   }
//
// "complete" is the authoritative flag. The caller MUST check it before
// claiming a successful export. Never silently returns a partial result as
// if it were complete.
function getMessagesBatched(token, chatId, messageIds, options) {
  options = options || {};
  var batchSize = options.batchSize || DEFAULT_BATCH_SIZE;
  var maxRetries = options.maxRetries !== undefined ? options.maxRetries : DEFAULT_MAX_RETRIES;
  var retryDelayMs = options.retryDelayMs !== undefined ? options.retryDelayMs : DEFAULT_RETRY_DELAY_MS;
  // Optional override for tests; real callers leave this undefined.
  var fetchImpl = options.fetch || fetch;

  // Normalize and de-duplicate the requested ID list upfront so the
  // missing-IDs computation later is correct.
  var seen = {};
  var requestedIds = [];
  if (Array.isArray(messageIds)) {
    for (var i = 0; i < messageIds.length; i++) {
      var id = messageIds[i];
      if (id === undefined || id === null) continue;
      var idStr = String(id);
      if (seen[idStr]) continue;
      seen[idStr] = true;
      requestedIds.push(idStr);
    }
  }

  if (requestedIds.length === 0) {
    return Promise.resolve({
      messages: {},
      requestedIds: [],
      returnedIds: [],
      missingIds: [],
      duplicateCount: 0,
      unexpectedIds: [],
      errors: [],
      complete: true
    });
  }

  // Slice into batches.
  var batches = [];
  for (var b = 0; b < requestedIds.length; b += batchSize) {
    batches.push(requestedIds.slice(b, b + batchSize));
  }

  var merged = {};
  var returnedSeen = {};
  var returnedIds = [];
  var duplicateCount = 0;
  var unexpectedIds = [];
  var errors = [];

  function sleep(ms) {
    return new Promise(function(resolve) { setTimeout(resolve, ms); });
  }

  function fetchBatchWithRetry(batchIds, attempt) {
    var url = API_BASE + "/chats/" + chatId + "/messages/batch";
    var body = JSON.stringify({ ids: batchIds });
    return fetchImpl(url, {
      method: "POST",
      headers: getHeaders(token),
      body: body
    }).then(function(r) {
      if (!r.ok) {
        var err = new Error("Batch HTTP " + r.status + " for " + batchIds.length + " ids");
        err.httpStatus = r.status;
        throw err;
      }
      return r.json();
    }).then(function(d) {
      // The endpoint shape observed in the wild is { data: { <id>: <msg> } }.
      // Be defensive about alternative shapes too.
      var dataObj = null;
      if (d && typeof d === 'object') {
        if (d.data && typeof d.data === 'object') dataObj = d.data;
        else if (!Array.isArray(d)) dataObj = d;
      }
      return dataObj || {};
    }).catch(function(err) {
      if (attempt < maxRetries) {
        // Exponential backoff: base * 2^(attempt-1)
        var delay = retryDelayMs * Math.pow(2, attempt - 1);
        return sleep(delay).then(function() {
          return fetchBatchWithRetry(batchIds, attempt + 1);
        });
      }
      // Out of retries — record the failure and return an empty batch
      // so we can still surface missing IDs in the final result.
      errors.push(err && err.message ? err.message : String(err));
      return {};
    });
  }

  var chain = Promise.resolve();
  batches.forEach(function(batchIds) {
    chain = chain.then(function() {
      return fetchBatchWithRetry(batchIds, 1).then(function(batchData) {
        // Merge results into the global map.
        for (var k in batchData) {
          if (!Object.prototype.hasOwnProperty.call(batchData, k)) continue;
          var msg = batchData[k];
          // Use the message's own .id if available, else the map key.
          var realId = (msg && msg.id !== undefined && msg.id !== null)
            ? String(msg.id)
            : String(k);
          if (returnedSeen[realId]) {
            duplicateCount++;
            continue;
          }
          returnedSeen[realId] = true;
          returnedIds.push(realId);
          merged[realId] = msg;
        }
      });
    });
  });

  return chain.then(function() {
    // Compute missing and unexpected IDs against the original requested set.
    var missingIds = [];
    for (var i = 0; i < requestedIds.length; i++) {
      if (!returnedSeen[requestedIds[i]]) missingIds.push(requestedIds[i]);
    }
    var requestedSet = {};
    for (var j = 0; j < requestedIds.length; j++) requestedSet[requestedIds[j]] = true;
    for (var k = 0; k < returnedIds.length; k++) {
      if (!requestedSet[returnedIds[k]]) unexpectedIds.push(returnedIds[k]);
    }

    return {
      messages: merged,
      requestedIds: requestedIds,
      returnedIds: returnedIds,
      missingIds: missingIds,
      duplicateCount: duplicateCount,
      unexpectedIds: unexpectedIds,
      errors: errors,
      complete: (missingIds.length === 0 && errors.length === 0 && unexpectedIds.length === 0)
    };
  });
}

// Automatically paginates through all pages until limit is reached.
// Uses recursion internally — each page fetches the next.
function getAllChats(token, type, limit) {
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

module.exports = {
  API_BASE: API_BASE,
  getHeaders: getHeaders,
  getChats: getChats,
  getChatDetails: getChatDetails,
  getMessagesBatch: getMessagesBatch,
  getMessagesBatched: getMessagesBatched,
  getAllChats: getAllChats,
  // Expose defaults for testing/introspection.
  DEFAULT_BATCH_SIZE: DEFAULT_BATCH_SIZE,
  DEFAULT_MAX_RETRIES: DEFAULT_MAX_RETRIES,
  DEFAULT_RETRY_DELAY_MS: DEFAULT_RETRY_DELAY_MS
};
