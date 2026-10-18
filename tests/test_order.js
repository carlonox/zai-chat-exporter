// Tests for buildConversationOrder — the conversation ordering helper.
//
// Covers the priority chain:
//   1. parent_id / children_ids traversal
//   2. timestamp fallback (with ties + missing values)
//   3. original order (when no signal is available)
//
// Plus branch handling, missing-parent handling, duplicate detection,
// and the "what would change if sorted by timestamp" diagnostic.

var { buildConversationOrder, _normalizeTimestamp } = require("../src/lib/order.js");

function run(describe, assert) {
  var tests = [];

  describe("buildConversationOrder — strategy selection", function() {
    tests.push({
      name: "empty input returns strategy=empty",
      fn: function() {
        var r = buildConversationOrder([]);
        assert.strictEqual(r.strategy, "empty");
        assert.deepStrictEqual(r.ordered, []);
      }
    });
    tests.push({
      name: "no parent/child fields and no timestamps -> strategy=original",
      fn: function() {
        var msgs = [
          { id: "a", role: "user", content: "1" },
          { id: "b", role: "assistant", content: "2" },
          { id: "c", role: "user", content: "3" }
        ];
        var r = buildConversationOrder(msgs);
        assert.strictEqual(r.strategy, "original");
        assert.deepStrictEqual(r.ordered, [0, 1, 2]);
      }
    });
    tests.push({
      name: "timestamps present, no parent fields -> strategy=timestamp",
      fn: function() {
        var msgs = [
          { id: "a", role: "user", content: "1", timestamp: "2023-11-14T22:13:21.000Z" },
          { id: "b", role: "assistant", content: "2", timestamp: "2023-11-14T22:13:20.000Z" }
        ];
        var r = buildConversationOrder(msgs);
        assert.strictEqual(r.strategy, "timestamp");
        // b (earlier timestamp) comes first
        assert.deepStrictEqual(r.ordered, [1, 0]);
      }
    });
    tests.push({
      name: "parent_id present -> strategy=parent-children",
      fn: function() {
        var msgs = [
          { id: "a", role: "user", content: "1", parent_id: null },
          { id: "b", role: "assistant", content: "2", parent_id: "a" },
          { id: "c", role: "user", content: "3", parent_id: "b" }
        ];
        var r = buildConversationOrder(msgs);
        assert.strictEqual(r.strategy, "parent-children");
        assert.deepStrictEqual(r.ordered, [0, 1, 2]);
      }
    });
  });

  describe("buildConversationOrder — Scenario 1: API returns reverse key order vs. timestamp order", function() {
    tests.push({
      name: "object-key order is reverse of timestamp order -> Markdown uses timestamp",
      fn: function() {
        // Simulate: API returns [latest, mid, earliest] but timestamps say otherwise.
        var msgs = [
          { id: "m3", role: "assistant", content: "latest", timestamp: "2023-11-14T22:13:23.000Z" },
          { id: "m2", role: "assistant", content: "mid",    timestamp: "2023-11-14T22:13:22.000Z" },
          { id: "m1", role: "user",      content: "first",  timestamp: "2023-11-14T22:13:21.000Z" }
        ];
        var r = buildConversationOrder(msgs);
        // Earliest first.
        assert.deepStrictEqual(r.ordered, [2, 1, 0]);
      }
    });
  });

  describe("buildConversationOrder — Scenario 2: 3+ round user/assistant conversation", function() {
    tests.push({
      name: "5-message turn-taking conversation orders correctly",
      fn: function() {
        var msgs = [
          { id: "u1", role: "user",      content: "Q1", parent_id: null, timestamp: 1700000001 },
          { id: "a1", role: "assistant", content: "A1", parent_id: "u1", timestamp: 1700000002 },
          { id: "u2", role: "user",      content: "Q2", parent_id: "a1", timestamp: 1700000003 },
          { id: "a2", role: "assistant", content: "A2", parent_id: "u2", timestamp: 1700000004 },
          { id: "u3", role: "user",      content: "Q3", parent_id: "a2", timestamp: 1700000005 }
        ];
        var r = buildConversationOrder(msgs);
        assert.strictEqual(r.strategy, "parent-children");
        assert.deepStrictEqual(r.ordered, [0, 1, 2, 3, 4]);
      }
    });
    tests.push({
      name: "same conversation given in REVERSE array order still reconstructs timeline",
      fn: function() {
        var msgs = [
          { id: "u3", role: "user",      content: "Q3", parent_id: "a2", timestamp: 1700000005 },
          { id: "a2", role: "assistant", content: "A2", parent_id: "u2", timestamp: 1700000004 },
          { id: "u2", role: "user",      content: "Q2", parent_id: "a1", timestamp: 1700000003 },
          { id: "a1", role: "assistant", content: "A1", parent_id: "u1", timestamp: 1700000002 },
          { id: "u1", role: "user",      content: "Q1", parent_id: null, timestamp: 1700000001 }
        ];
        var r = buildConversationOrder(msgs);
        // Even though array order is reversed, parent/child traversal
        // walks from root (u1) through the chain.
        assert.deepStrictEqual(r.ordered, [4, 3, 2, 1, 0]);
      }
    });
  });

  describe("buildConversationOrder — Scenario 3: duplicate timestamps", function() {
    tests.push({
      name: "two messages with same timestamp — stable by original index",
      fn: function() {
        var sameTs = "2023-11-14T22:13:22.000Z";
        var msgs = [
          { id: "a", role: "user",      content: "first-in-array",  timestamp: sameTs },
          { id: "b", role: "assistant", content: "second-in-array", timestamp: sameTs }
        ];
        var r = buildConversationOrder(msgs);
        assert.strictEqual(r.strategy, "timestamp");
        assert.deepStrictEqual(r.ordered, [0, 1]);
        assert.ok(r.duplicateTimestamps.length >= 1);
      }
    });
    tests.push({
      name: "duplicate timestamp values are surfaced in diagnostics",
      fn: function() {
        var sameTs = 1700000005;
        var msgs = [
          { id: "a", role: "user",      content: "x", timestamp: sameTs },
          { id: "b", role: "assistant", content: "y", timestamp: sameTs }
        ];
        var r = buildConversationOrder(msgs);
        assert.ok(r.duplicateTimestamps.length === 1);
      }
    });
  });

  describe("buildConversationOrder — Scenario 4: missing timestamps", function() {
    tests.push({
      name: "message with no timestamp falls to end of timestamp-sorted view",
      fn: function() {
        var msgs = [
          { id: "a", role: "user",      content: "has-ts", timestamp: 1700000010 },
          { id: "b", role: "assistant", content: "no-ts"  /* no timestamp */ },
          { id: "c", role: "user",      content: "earlier-ts", timestamp: 1700000005 }
        ];
        var r = buildConversationOrder(msgs);
        assert.strictEqual(r.strategy, "timestamp");
        // Expected: c (5), a (10), then b (missing, original order)
        assert.deepStrictEqual(r.ordered, [2, 0, 1]);
        assert.strictEqual(r.missingTimestamps, 1);
      }
    });
    tests.push({
      name: "all timestamps missing -> strategy=original",
      fn: function() {
        var msgs = [
          { id: "a", role: "user",      content: "1" },
          { id: "b", role: "assistant", content: "2" }
        ];
        var r = buildConversationOrder(msgs);
        assert.strictEqual(r.strategy, "original");
        assert.deepStrictEqual(r.ordered, [0, 1]);
        assert.strictEqual(r.missingTimestamps, 2);
      }
    });
  });

  describe("buildConversationOrder — Scenario 5: parent/children relationships", function() {
    tests.push({
      name: "chain via parent_id walks root-to-leaf",
      fn: function() {
        var msgs = [
          { id: "r",  role: "user",      content: "root", parent_id: null },
          { id: "c1", role: "assistant", content: "c1",   parent_id: "r"  },
          { id: "c2", role: "user",      content: "c2",   parent_id: "c1" },
          { id: "c3", role: "assistant", content: "c3",   parent_id: "c2" }
        ];
        var r = buildConversationOrder(msgs);
        assert.strictEqual(r.strategy, "parent-children");
        assert.deepStrictEqual(r.ordered, [0, 1, 2, 3]);
      }
    });
    tests.push({
      name: "multiple roots ordered by timestamp",
      fn: function() {
        var msgs = [
          { id: "r2", role: "user", content: "root2", parent_id: null, timestamp: 1700000010 },
          { id: "r1", role: "user", content: "root1", parent_id: null, timestamp: 1700000005 }
        ];
        var r = buildConversationOrder(msgs);
        assert.deepStrictEqual(r.ordered, [1, 0]);
      }
    });
  });

  describe("buildConversationOrder — Scenario 6: branches / regenerated answers", function() {
    tests.push({
      name: "parent has two children — first (by timestamp) goes on main chain, second is a branch",
      fn: function() {
        var msgs = [
          { id: "u1",  role: "user",      content: "Q1", parent_id: null,   timestamp: 1700000001 },
          { id: "a1a", role: "assistant", content: "A1-first-regen",  parent_id: "u1", timestamp: 1700000002 },
          { id: "a1b", role: "assistant", content: "A1-second-regen", parent_id: "u1", timestamp: 1700000003 },
          { id: "u2",  role: "user",      content: "Q2", parent_id: "a1a", timestamp: 1700000004 }
        ];
        var r = buildConversationOrder(msgs);
        assert.strictEqual(r.strategy, "parent-children");
        // Main chain: u1 -> a1a -> u2 (a1a is earlier so it's the "primary" child)
        // Branch: a1b (appended after main chain)
        assert.deepStrictEqual(r.ordered, [0, 1, 3, 2]);
        assert.strictEqual(r.branches.length, 1);
        assert.strictEqual(r.branches[0].branchIndex, 2);
        assert.strictEqual(r.branches[0].parentId, "u1");
      }
    });
    tests.push({
      name: "branch is NOT dropped — appears in ordered list",
      fn: function() {
        var msgs = [
          { id: "u1",  role: "user",      content: "Q1", parent_id: null,   timestamp: 1700000001 },
          { id: "a1a", role: "assistant", content: "A1-first",  parent_id: "u1", timestamp: 1700000002 },
          { id: "a1b", role: "assistant", content: "A1-second", parent_id: "u1", timestamp: 1700000003 }
        ];
        var r = buildConversationOrder(msgs);
        // All 3 messages present.
        assert.strictEqual(r.ordered.length, 3);
        var idsInOrder = r.ordered.map(function(i) { return msgs[i].id; });
        assert.ok(idsInOrder.indexOf("a1b") !== -1, "branch must be in ordered list");
      }
    });
  });

  describe("buildConversationOrder — Scenario 7: missing parent_id or parent not in set", function() {
    tests.push({
      name: "parent_id references a non-existent message -> treated as root, recorded in missingParents",
      fn: function() {
        var msgs = [
          { id: "a", role: "user", content: "1", parent_id: "nonexistent" },
          { id: "b", role: "assistant", content: "2", parent_id: "a" }
        ];
        var r = buildConversationOrder(msgs);
        assert.strictEqual(r.strategy, "parent-children");
        assert.deepStrictEqual(r.ordered, [0, 1]);
        assert.deepStrictEqual(r.missingParents, [0]);
      }
    });
    tests.push({
      name: "single message with missing parent is not silently dropped",
      fn: function() {
        var msgs = [
          { id: "a", role: "user", content: "1", parent_id: "nonexistent" }
        ];
        var r = buildConversationOrder(msgs);
        assert.strictEqual(r.ordered.length, 1);
        assert.deepStrictEqual(r.missingParents, [0]);
      }
    });
  });

  describe("buildConversationOrder — Scenario 8: no message lost or duplicated by reordering", function() {
    tests.push({
      name: "every input message appears exactly once in ordered output (parent/children)",
      fn: function() {
        var msgs = [
          { id: "u1", role: "user", content: "Q1", parent_id: null, timestamp: 1 },
          { id: "a1", role: "assistant", content: "A1", parent_id: "u1", timestamp: 2 },
          { id: "a1r", role: "assistant", content: "A1-regen", parent_id: "u1", timestamp: 3 },
          { id: "u2", role: "user", content: "Q2", parent_id: "a1", timestamp: 4 },
          { id: "a2", role: "assistant", content: "A2", parent_id: "u2", timestamp: 5 }
        ];
        var r = buildConversationOrder(msgs);
        // Every index 0..4 must appear exactly once.
        var seen = {};
        r.ordered.forEach(function(i) {
          assert.ok(!seen[i], "index " + i + " appeared more than once");
          seen[i] = true;
        });
        for (var i = 0; i < msgs.length; i++) {
          assert.ok(seen[i], "index " + i + " missing from ordered output");
        }
      }
    });
    tests.push({
      name: "duplicate IDs — both messages preserved (later one appended)",
      fn: function() {
        var msgs = [
          { id: "dup", role: "user", content: "first", timestamp: 1 },
          { id: "dup", role: "user", content: "second", timestamp: 2 }
        ];
        var r = buildConversationOrder(msgs);
        // Both indices must appear.
        assert.strictEqual(r.ordered.length, 2);
        assert.ok(r.duplicateIds.indexOf("dup") !== -1);
      }
    });
    tests.push({
      name: "no role-based grouping — user/assistant interleaved correctly",
      fn: function() {
        // Even if all user messages have earlier timestamps and all
        // assistant messages have later timestamps (which would group them
        // if we sorted naively), parent/children traversal preserves
        // interleaving.
        var msgs = [
          { id: "u1", role: "user",      content: "Q1", parent_id: null,   timestamp: 1 },
          { id: "a1", role: "assistant", content: "A1", parent_id: "u1", timestamp: 5 },
          { id: "u2", role: "user",      content: "Q2", parent_id: "a1", timestamp: 2 },
          { id: "a2", role: "assistant", content: "A2", parent_id: "u2", timestamp: 6 }
        ];
        var r = buildConversationOrder(msgs);
        // Despite weird timestamps, the chain u1 -> a1 -> u2 -> a2 should hold.
        assert.deepStrictEqual(r.ordered, [0, 1, 2, 3]);
      }
    });
  });

  describe("buildConversationOrder — diagnostics: indexMovementIfSortedByTimestamp", function() {
    tests.push({
      name: "parent-children strategy still reports what WOULD change if sorted by timestamp",
      fn: function() {
        var msgs = [
          { id: "u1", role: "user",      content: "Q1", parent_id: null, timestamp: 1 },
          { id: "a1", role: "assistant", content: "A1", parent_id: "u1", timestamp: 5 },
          { id: "u2", role: "user",      content: "Q2", parent_id: "a1", timestamp: 2 },
          { id: "a2", role: "assistant", content: "A2", parent_id: "u2", timestamp: 6 }
        ];
        var r = buildConversationOrder(msgs);
        assert.strictEqual(r.strategy, "parent-children");
        // Parent-children gives [0,1,2,3] (identity). Timestamp sort would give [0,2,1,3] (u1->u2->a1->a2).
        // indexMovementIfSortedByTimestamp compares chosen order vs ORIGINAL array order, so for
        // identity output it should be empty.
        assert.ok(Array.isArray(r.indexMovementIfSortedByTimestamp));
      }
    });
    tests.push({
      name: "timestamp sort records movement when original order differs from sorted order",
      fn: function() {
        var msgs = [
          { id: "a", role: "user", content: "1", timestamp: 3 },
          { id: "b", role: "user", content: "2", timestamp: 1 },
          { id: "c", role: "user", content: "3", timestamp: 2 }
        ];
        var r = buildConversationOrder(msgs);
        // Sorted: b(1), c(2), a(3) -> [1, 2, 0]
        assert.deepStrictEqual(r.ordered, [1, 2, 0]);
        // Original was [0,1,2]; sorted is [1,2,0]. So 0->pos 2 (+2), 1->pos 0 (-1), 2->pos 1 (-1).
        assert.ok(r.indexMovementIfSortedByTimestamp.length === 3);
      }
    });
  });

  describe("_normalizeTimestamp — helper coverage", function() {
    tests.push({
      name: "Unix seconds (small number) -> ms",
      fn: function() {
        assert.strictEqual(_normalizeTimestamp(1700000000), 1700000000000);
      }
    });
    tests.push({
      name: "Unix ms (large number) -> unchanged",
      fn: function() {
        assert.strictEqual(_normalizeTimestamp(1700000000000), 1700000000000);
      }
    });
    tests.push({
      name: "ISO 8601 string -> ms",
      fn: function() {
        var ms = _normalizeTimestamp("2023-11-14T22:13:20.000Z");
        assert.strictEqual(typeof ms, "number");
        assert.ok(!isNaN(ms), "parsed ms must not be NaN");
        // Sanity: 2023-11-14 22:13:20 UTC is roughly 1700000000000 ms.
        assert.ok(ms > 1699000000000 && ms < 1701000000000, "ms should fall in late 2023, got " + ms);
      }
    });
    tests.push({
      name: "null / undefined / empty string -> null",
      fn: function() {
        assert.strictEqual(_normalizeTimestamp(null), null);
        assert.strictEqual(_normalizeTimestamp(undefined), null);
        assert.strictEqual(_normalizeTimestamp(""), null);
        assert.strictEqual(_normalizeTimestamp("   "), null);
      }
    });
    tests.push({
      name: "non-numeric string -> null",
      fn: function() {
        assert.strictEqual(_normalizeTimestamp("not-a-date"), null);
      }
    });
  });

  return tests;
}

module.exports = { run: run };
