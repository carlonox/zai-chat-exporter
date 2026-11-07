// Conversation ordering for the Markdown / Plain Text exporters.
//
// The Z.ai batch endpoint sometimes returns messages in non-chronological
// order (key order, insertion order, internal sort). The JSON exporter
// preserves the raw order it receives so the archive is faithful. The
// Markdown / TXT exporters use buildConversationOrder() here to lay
// messages out in the order a human would actually read them.
//
// Strategy (in priority order):
//   1. parent_id / children_ids traversal — when the API exposes these,
//      we walk the conversation tree from its roots, following the first
//      child of each node. Branches (regenerated answers, alternative
//      turns) are queued and shown after the main chain so nothing is
//      dropped. We pick the first child by (timestamp, original index)
//      so deterministic output is guaranteed even when timestamps tie.
//   2. Timestamp sort — stable, ascending, with the original index used
//      as the tiebreaker. Missing timestamps fall to the end (preserving
//      their relative original order).
//   3. Original array order — last resort, when no ordering signal is
//      available at all.
//
// The function never mutates its input. JSON output is untouched; only
// the order in which messages are *displayed* in Markdown/TXT changes.

// Normalize a timestamp value to a millisecond number for comparison.
// Accepts: Unix seconds (number), Unix milliseconds (number), ISO 8601
// strings, numeric strings. Returns null if the value is unusable.
function _normalizeTimestamp(ts) {
  if (ts === undefined || ts === null || ts === "") return null;
  if (typeof ts === "number") {
    // Heuristic: Z.ai's batch endpoint returns Unix seconds (e.g. 1700000000).
    // If the number is < 10^11 it's almost certainly seconds; if >= 10^11
    // it's almost certainly milliseconds. We convert to ms either way.
    if (ts < 1e11) return ts * 1000;
    return ts;
  }
  if (typeof ts === "string") {
    var trimmed = ts.trim();
    if (trimmed === "") return null;
    // Try ISO 8601 first — this is what popup.js writes after normalizing.
    var d = new Date(trimmed);
    if (!isNaN(d.getTime())) return d.getTime();
    // Try parsing as a number (could be Unix seconds or ms as a string).
    var n = Number(trimmed);
    if (!isNaN(n) && isFinite(n)) {
      if (n < 1e11) return n * 1000;
      return n;
    }
    return null;
  }
  return null;
}

// Walk the conversation tree using parent_id / children_ids.
// Returns null if the input has no usable parent/child structure.
function _orderViaParentChildren(messages) {
  var n = messages.length;
  if (n === 0) return null;

  // Build id-to-first-index map and detect duplicates.
  var idToIndex = {};
  var idSet = {};
  var duplicateIds = [];
  var hasAnyParentField = false;
  var hasAnyChildrenField = false;

  for (var i = 0; i < n; i++) {
    var msg = messages[i];
    if (!msg) continue;
    if (msg.parent_id !== undefined && msg.parent_id !== null) hasAnyParentField = true;
    if (msg.children_ids !== undefined && msg.children_ids !== null) hasAnyChildrenField = true;
    if (msg.id !== undefined && msg.id !== null) {
      var idStr = String(msg.id);
      if (idSet[idStr]) {
        duplicateIds.push(idStr);
      } else {
        idSet[idStr] = true;
        idToIndex[idStr] = i;
      }
    }
  }

  if (!hasAnyParentField && !hasAnyChildrenField) return null;

  // Build children-of map: parent_id_string -> [child indices]
  // Use the parent_id field on each message (the authoritative direction).
  // If a message has no parent_id, it's a root.
  var childrenOf = {};
  var roots = [];
  var missingParents = []; // indices whose parent_id is set but not in our set

  for (var j = 0; j < n; j++) {
    var m = messages[j];
    if (!m) continue;
    // Skip later duplicates — they'll be appended at the very end so the
    // diagnostics flag them, rather than silently dropping or scrambling.
    if (m.id !== undefined && m.id !== null) {
      var mid = String(m.id);
      if (idToIndex[mid] !== j) continue;
    }
    var pid = m.parent_id;
    if (pid === undefined || pid === null || pid === "") {
      roots.push(j);
    } else {
      var pidStr = String(pid);
      if (idSet[pidStr]) {
        if (!childrenOf[pidStr]) childrenOf[pidStr] = [];
        childrenOf[pidStr].push(j);
      } else {
        // parent_id points to a message not in our set — record this as
        // a "missing parent" and treat the message as a root so it still
        // gets visited rather than silently dropped.
        missingParents.push(j);
        roots.push(j);
      }
    }
  }

  // Sort children of each parent by (timestamp asc, original index asc).
  // Sort roots the same way so the traversal starts deterministically.
  function sortByTimestampThenIndex(a, b) {
    var ta = _normalizeTimestamp(messages[a] && messages[a].timestamp);
    var tb = _normalizeTimestamp(messages[b] && messages[b].timestamp);
    if (ta === null && tb === null) return a - b;
    if (ta === null) return 1;
    if (tb === null) return -1;
    if (ta === tb) return a - b;
    return ta - tb;
  }
  for (var k in childrenOf) {
    if (Object.prototype.hasOwnProperty.call(childrenOf, k)) {
      childrenOf[k].sort(sortByTimestampThenIndex);
    }
  }
  roots.sort(sortByTimestampThenIndex);

  var visited = {};
  var ordered = [];
  var branches = []; // [{ branchIndex, parentIndex, parentId }]

  // Iterative DFS so deep conversations don't blow the stack.
  function visit(startIndex) {
    var stack = [startIndex];
    while (stack.length > 0) {
      var idx = stack.pop();
      if (visited[idx]) continue;
      visited[idx] = true;
      ordered.push(idx);
      var current = messages[idx];
      if (!current) continue;
      var currentId = (current.id !== undefined && current.id !== null)
        ? String(current.id)
        : null;
      if (!currentId) continue;
      var kids = childrenOf[currentId] || [];
      if (kids.length === 0) continue;
      // First kid (after sort) continues the main chain; the rest are
      // branches and will be visited after the main chain is done.
      // Push kids in reverse so the first kid is popped first.
      for (var b = kids.length - 1; b >= 1; b--) {
        branches.push({
          branchIndex: kids[b],
          parentIndex: idx,
          parentId: currentId
        });
      }
      stack.push(kids[0]);
    }
  }

  for (var r = 0; r < roots.length; r++) {
    visit(roots[r]);
  }

  // Sort branches by their parent's position in the main chain so a
  // branch that diverged earlier shows up before one that diverged later.
  // Within the same parent (which can't happen here since each parent
  // contributes its own branch entries), the timestamp-sort above already
  // gave us a deterministic order.
  var parentPosition = {};
  for (var p = 0; p < ordered.length; p++) {
    parentPosition[ordered[p]] = p;
  }
  branches.sort(function(a, b) {
    var pa = parentPosition[a.parentIndex] !== undefined ? parentPosition[a.parentIndex] : Infinity;
    var pb = parentPosition[b.parentIndex] !== undefined ? parentPosition[b.parentIndex] : Infinity;
    if (pa === pb) {
      // Same parent — order by the original timestamp sort (already done).
      return a.branchIndex - b.branchIndex;
    }
    return pa - pb;
  });

  for (var bi = 0; bi < branches.length; bi++) {
    visit(branches[bi].branchIndex);
  }

  // Any message we still haven't visited (true duplicates, isolated nodes,
  // or messages whose id field was missing) gets appended at the end in
  // original order so we never silently drop anything.
  for (var di = 0; di < n; di++) {
    if (!visited[di] && messages[di]) {
      ordered.push(di);
      visited[di] = true;
    }
  }

  return {
    ordered: ordered,
    strategy: "parent-children",
    branches: branches,
    missingParents: missingParents,
    duplicateIds: duplicateIds,
    missingTimestamps: 0,         // not computed in this strategy
    duplicateTimestamps: []      // not computed in this strategy
  };
}

// Fallback: stable sort by timestamp, original index as tiebreaker.
function _orderByTimestamp(messages) {
  var n = messages.length;
  if (n === 0) {
    return {
      ordered: [],
      strategy: "empty",
      branches: [],
      missingParents: [],
      duplicateIds: [],
      missingTimestamps: 0,
      duplicateTimestamps: []
    };
  }

  var missingTimestamps = 0;
  var tsGroups = {};   // ts_string -> [indices]
  var duplicateTimestamps = [];
  var duplicateIds = [];
  var idSet = {};

  for (var i = 0; i < n; i++) {
    var m = messages[i];
    if (!m) continue;
    var ts = _normalizeTimestamp(m && m.timestamp);
    if (ts === null) {
      missingTimestamps++;
    } else {
      var key = String(ts);
      if (!tsGroups[key]) tsGroups[key] = [];
      tsGroups[key].push(i);
    }
    if (m.id !== undefined && m.id !== null) {
      var idStr = String(m.id);
      if (idSet[idStr]) duplicateIds.push(idStr);
      else idSet[idStr] = true;
    }
  }
  for (var t in tsGroups) {
    if (Object.prototype.hasOwnProperty.call(tsGroups, t) && tsGroups[t].length > 1) {
      duplicateTimestamps.push(t);
    }
  }

  var indices = [];
  for (var j = 0; j < n; j++) indices.push(j);
  indices.sort(function(a, b) {
    var ta = _normalizeTimestamp(messages[a] && messages[a].timestamp);
    var tb = _normalizeTimestamp(messages[b] && messages[b].timestamp);
    if (ta === null && tb === null) return a - b;       // both missing → original order
    if (ta === null) return 1;                           // missing → after present
    if (tb === null) return -1;
    if (ta === tb) return a - b;                         // tie → original order (stable)
    return ta - tb;
  });

  // If every timestamp is missing, this is effectively "original order".
  var strategy = (missingTimestamps === n) ? "original" : "timestamp";

  return {
    ordered: indices,
    strategy: strategy,
    branches: [],
    missingParents: [],
    duplicateIds: duplicateIds,
    missingTimestamps: missingTimestamps,
    duplicateTimestamps: duplicateTimestamps
  };
}

// Public entry point. Returns the display order plus diagnostic info.
//
// Output shape:
//   {
//     ordered:           [<original-array indices in display order>],
//     strategy:          "parent-children" | "timestamp" | "original" | "empty",
//     branches:          [{ branchIndex, parentIndex, parentId }],
//     missingParents:    [<indices>],
//     missingTimestamps: <int>,
//     duplicateTimestamps: [<timestamp strings>],
//     duplicateIds:      [<id strings>],
//     indexMovementIfSortedByTimestamp: [
//       { originalIndex, sortedIndex, delta }
//     ]
//   }
//
// `indexMovementIfSortedByTimestamp` is always computed (regardless of the
// chosen strategy) so the JSON viewer can show "what would change?" even
// when the chosen strategy was parent/children.
function buildConversationOrder(messages, options) {
  options = options || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return {
      ordered: [],
      strategy: "empty",
      branches: [],
      missingParents: [],
      missingTimestamps: 0,
      duplicateTimestamps: [],
      duplicateIds: [],
      indexMovementIfSortedByTimestamp: []
    };
  }

  // Try parent/children first.
  var pc = _orderViaParentChildren(messages);
  if (pc) {
    pc.indexMovementIfSortedByTimestamp = _computeMovement(messages, pc.ordered);
    return pc;
  }

  // Fallback to timestamp.
  var tsResult = _orderByTimestamp(messages);
  tsResult.indexMovementIfSortedByTimestamp = _computeMovement(messages, tsResult.ordered);
  return tsResult;
}

// Compare the chosen display order against the original array order and
// report which messages would move and by how much. Used by the viewer's
// "what would change if I sorted?" diagnostic.
function _computeMovement(messages, ordered) {
  var movement = [];
  for (var i = 0; i < ordered.length; i++) {
    var origIdx = ordered[i];
    if (origIdx !== i) {
      movement.push({ originalIndex: origIdx, sortedIndex: i, delta: i - origIdx });
    }
  }
  return movement;
}

module.exports = {
  buildConversationOrder: buildConversationOrder,
  _normalizeTimestamp: _normalizeTimestamp   // exported for testing
};
