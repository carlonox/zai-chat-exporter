// Tests that the actual Markdown output reflects conversation ordering.
// (These complement test_order.js, which tests the helper in isolation.)
//
// Per spec: "测试应验证实际生成的 Markdown，而不只是测试单独的排序函数。"
var { toMarkdown, toPlainText, toJSON } = require("../src/lib/exporters.js");

function run(describe, assert) {
  var tests = [];

  describe("toMarkdown — actual output reflects conversation order", function() {
    tests.push({
      name: "Scenario 1: reverse-order input — Markdown shows timeline order",
      fn: function() {
        // Array order is latest-first; timestamps say otherwise.
        var chats = [{
          id: "c1", title: "Reverse test",
          created_at: null, updated_at: null,
          messages: [
            { id: "m3", role: "assistant", content: "third (latest)",  timestamp: "2023-11-14T22:13:23.000Z" },
            { id: "m2", role: "assistant", content: "second (mid)",    timestamp: "2023-11-14T22:13:22.000Z" },
            { id: "m1", role: "user",      content: "first (earliest)", timestamp: "2023-11-14T22:13:21.000Z" }
          ]
        }];
        var md = toMarkdown(chats);
        // The first message body in the Markdown must be "first (earliest)"
        var firstBodyPos = md.indexOf("first (earliest)");
        var lastBodyPos = md.indexOf("third (latest)");
        assert.ok(firstBodyPos < lastBodyPos, "earliest message should appear before latest in Markdown, got:\n" + md);
      }
    });

    tests.push({
      name: "Scenario 2: 3-round conversation with parent_id chain — Markdown shows correct order",
      fn: function() {
        var chats = [{
          id: "c1", title: "3-round",
          created_at: null, updated_at: null,
          messages: [
            { id: "u3", role: "user",      content: "Q3", parent_id: "a2", timestamp: 1700000005 },
            { id: "a2", role: "assistant", content: "A2", parent_id: "u2", timestamp: 1700000004 },
            { id: "u2", role: "user",      content: "Q2", parent_id: "a1", timestamp: 1700000003 },
            { id: "a1", role: "assistant", content: "A1", parent_id: "u1", timestamp: 1700000002 },
            { id: "u1", role: "user",      content: "Q1", parent_id: null, timestamp: 1700000001 }
          ]
        }];
        var md = toMarkdown(chats);
        // Expected output order: Q1 A1 Q2 A2 Q3
        var q1 = md.indexOf("Q1");
        var a1 = md.indexOf("A1");
        var q2 = md.indexOf("Q2");
        var a2 = md.indexOf("A2");
        var q3 = md.indexOf("Q3");
        assert.ok(q1 < a1, "Q1 before A1");
        assert.ok(a1 < q2, "A1 before Q2");
        assert.ok(q2 < a2, "Q2 before A2");
        assert.ok(a2 < q3, "A2 before Q3");
      }
    });

    tests.push({
      name: "Scenario 3: duplicate timestamps — Markdown preserves original order as tiebreaker",
      fn: function() {
        var sameTs = "2023-11-14T22:13:22.000Z";
        var chats = [{
          id: "c1", title: "Dup TS",
          created_at: null, updated_at: null,
          messages: [
            { id: "a", role: "user",      content: "ALPHA", timestamp: sameTs },
            { id: "b", role: "assistant", content: "BETA",  timestamp: sameTs }
          ]
        }];
        var md = toMarkdown(chats);
        assert.ok(md.indexOf("ALPHA") < md.indexOf("BETA"));
        // Diagnostic note about duplicate timestamps is included
        assert.ok(md.indexOf("duplicate timestamp value") !== -1, "Markdown should mention duplicate timestamps in a diagnostic note");
      }
    });

    tests.push({
      name: "Scenario 4: missing timestamps — Markdown keeps messages without timestamps at end",
      fn: function() {
        var chats = [{
          id: "c1", title: "Missing TS",
          created_at: null, updated_at: null,
          messages: [
            { id: "a", role: "user",      content: "HAS-TS-1", timestamp: 1700000010 },
            { id: "b", role: "assistant", content: "NO-TS" /* no ts */ },
            { id: "c", role: "user",      content: "HAS-TS-2", timestamp: 1700000005 }
          ]
        }];
        var md = toMarkdown(chats);
        var pos1 = md.indexOf("HAS-TS-2"); // earlier ts -> first
        var pos2 = md.indexOf("HAS-TS-1"); // later ts -> second
        var pos3 = md.indexOf("NO-TS");    // missing -> last
        assert.ok(pos1 < pos2, "earlier ts should appear first");
        assert.ok(pos2 < pos3, "missing-ts message should be at end");
      }
    });

    tests.push({
      name: "Scenario 5: parent/children walk — Markdown shows root-to-leaf order",
      fn: function() {
        var chats = [{
          id: "c1", title: "Walk",
          created_at: null, updated_at: null,
          messages: [
            { id: "r",  role: "user",      content: "ROOT", parent_id: null },
            { id: "c1", role: "assistant", content: "CHILD1", parent_id: "r"  },
            { id: "c2", role: "user",      content: "CHILD2", parent_id: "c1" }
          ]
        }];
        var md = toMarkdown(chats);
        var p1 = md.indexOf("ROOT");
        var p2 = md.indexOf("CHILD1");
        var p3 = md.indexOf("CHILD2");
        assert.ok(p1 < p2 && p2 < p3);
        // Markdown should mention the ordering strategy used.
        assert.ok(md.indexOf("Ordering: reconstructed from parent_id / children_ids") !== -1);
      }
    });

    tests.push({
      name: "Scenario 6: branch (regenerated answer) — Markdown shows main chain then branch marker",
      fn: function() {
        var chats = [{
          id: "c1", title: "Branch",
          created_at: null, updated_at: null,
          messages: [
            { id: "u1",  role: "user",      content: "Q1",            parent_id: null,  timestamp: 1700000001 },
            { id: "a1a", role: "assistant", content: "A1-first",     parent_id: "u1",  timestamp: 1700000002 },
            { id: "a1b", role: "assistant", content: "A1-second",    parent_id: "u1",  timestamp: 1700000003 },
            { id: "u2",  role: "user",      content: "Q2",           parent_id: "a1a", timestamp: 1700000004 }
          ]
        }];
        var md = toMarkdown(chats);
        var q1 = md.indexOf("Q1");
        var a1a = md.indexOf("A1-first");
        var q2 = md.indexOf("Q2");
        var a1b = md.indexOf("A1-second");
        // Main chain: Q1 -> A1-first -> Q2
        assert.ok(q1 < a1a && a1a < q2, "main chain order Q1->A1-first->Q2");
        // Branch A1-second appears AFTER the main chain
        assert.ok(q2 < a1b, "branch (A1-second) should appear after main chain");
        // Branch marker present
        assert.ok(md.indexOf("Branch from message ID") !== -1, "should include branch marker");
      }
    });

    tests.push({
      name: "Scenario 7: missing parent — Markdown still shows the orphan message",
      fn: function() {
        var chats = [{
          id: "c1", title: "Orphan",
          created_at: null, updated_at: null,
          messages: [
            { id: "a", role: "user", content: "ORPHAN", parent_id: "does-not-exist" },
            { id: "b", role: "assistant", content: "NORMAL", parent_id: "a" }
          ]
        }];
        var md = toMarkdown(chats);
        assert.ok(md.indexOf("ORPHAN") !== -1, "orphan message must be present in Markdown (not silently dropped)");
        assert.ok(md.indexOf("referenced a parent_id that is not in this chat") !== -1, "diagnostic note about missing parent should be present");
      }
    });

    tests.push({
      name: "Scenario 8: no message lost or duplicated in Markdown output",
      fn: function() {
        var chats = [{
          id: "c1", title: "Lossless",
          created_at: null, updated_at: null,
          messages: [
            { id: "u1", role: "user", content: "Q1-UNIQUE-MARKER", parent_id: null, timestamp: 1 },
            { id: "a1", role: "assistant", content: "A1-UNIQUE-MARKER", parent_id: "u1", timestamp: 2 },
            { id: "a1r", role: "assistant", content: "A1-REGEN-UNIQUE-MARKER", parent_id: "u1", timestamp: 3 },
            { id: "u2", role: "user", content: "Q2-UNIQUE-MARKER", parent_id: "a1", timestamp: 4 }
          ]
        }];
        var md = toMarkdown(chats);
        // Each body must appear exactly once. Using unique markers avoids
        // false-positive substring matches (e.g. "A1" matching inside "A1-regen").
        ["Q1-UNIQUE-MARKER", "A1-UNIQUE-MARKER", "A1-REGEN-UNIQUE-MARKER", "Q2-UNIQUE-MARKER"].forEach(function(body) {
          var firstIdx = md.indexOf(body);
          var lastIdx = md.lastIndexOf(body);
          assert.ok(firstIdx !== -1, "body '" + body + "' must appear at least once");
          assert.strictEqual(firstIdx, lastIdx, "body '" + body + "' must appear exactly once (no duplication)");
        });
      }
    });
  });

  describe("toPlainText — same ordering as Markdown", function() {
    tests.push({
      name: "TXT also reorders by parent/children",
      fn: function() {
        var chats = [{
          id: "c1", title: "TXT",
          created_at: null, updated_at: null,
          messages: [
            { id: "u3", role: "user", content: "Q3", parent_id: "a2" },
            { id: "a2", role: "assistant", content: "A2", parent_id: "u2" },
            { id: "u2", role: "user", content: "Q2", parent_id: "a1" },
            { id: "a1", role: "assistant", content: "A1", parent_id: "u1" },
            { id: "u1", role: "user", content: "Q1", parent_id: null }
          ]
        }];
        var txt = toPlainText(chats);
        var q1 = txt.indexOf("Q1");
        var a1 = txt.indexOf("A1");
        var q2 = txt.indexOf("Q2");
        var a2 = txt.indexOf("A2");
        var q3 = txt.indexOf("Q3");
        assert.ok(q1 < a1 && a1 < q2 && q2 < a2 && a2 < q3);
      }
    });
  });

  describe("toJSON — preserves original array order, NOT reordered", function() {
    tests.push({
      name: "JSON keeps original array order even when timestamps would sort differently",
      fn: function() {
        var chats = [{
          id: "c1", title: "Preserve",
          created_at: null, updated_at: null,
          messages: [
            { id: "late", role: "user", content: "LATEST", timestamp: "2023-11-14T22:13:23.000Z" },
            { id: "early", role: "user", content: "EARLIEST", timestamp: "2023-11-14T22:13:21.000Z" }
          ]
        }];
        var json = toJSON(chats);
        var parsed = JSON.parse(json);
        // Original order preserved: "late" comes first in JSON, even though
        // it has a later timestamp.
        assert.strictEqual(parsed[0].messages[0].id, "late");
        assert.strictEqual(parsed[0].messages[1].id, "early");
      }
    });
    tests.push({
      name: "JSON preserves parent_id / children_ids when present (so order can be reconstructed)",
      fn: function() {
        var chats = [{
          id: "c1", title: "Fields",
          created_at: null, updated_at: null,
          messages: [
            { id: "u1", role: "user", content: "Q1", parent_id: null, children_ids: ["a1"] },
            { id: "a1", role: "assistant", content: "A1", parent_id: "u1", children_ids: [] }
          ]
        }];
        var json = toJSON(chats);
        var parsed = JSON.parse(json);
        assert.strictEqual(parsed[0].messages[0].parent_id, null);
        assert.deepStrictEqual(parsed[0].messages[0].children_ids, ["a1"]);
        assert.strictEqual(parsed[0].messages[1].parent_id, "u1");
      }
    });
  });

  return tests;
}

module.exports = { run: run };
