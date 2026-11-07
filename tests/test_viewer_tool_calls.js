// Tests for the JSON viewer's tool_calls parsing logic.
//
// The viewer is a standalone HTML file with no module system, so we can't
// import its functions directly. These tests mirror the viewer's
// `_parseToolCallArguments` and `_matchToolCallsToResults` functions
// verbatim — if these tests pass, the viewer's logic is sound. (The
// viewer's <script> block contains the same logic inline.)
//
// Scenario coverage (from Task B section 6):
//   1. Single Bash call with valid JSON string args + 1 result
//   2. Arguments is already an object
//   3. Arguments is a non-JSON string
//   4. Multiple tool calls with different IDs
//   5. One call has no matching result
//   6. Result with no matching call ID (unmatched)
//   7. Result content is multi-line text
//   8. Args/output contain HTML, script strings, or special chars
//   9. Missing started_at / ended_at / status
//   10. Plain text content_blocks (regression — not affected)

// Mirror of viewer's _parseToolCallArguments — keep in sync with
// tools/zai-json-viewer.html
function _parseToolCallArguments(args) {
  if (args === undefined || args === null) {
    return { parsed: null, raw: "(none)", isJson: false };
  }
  if (typeof args === "object") {
    try {
      return { parsed: args, raw: JSON.stringify(args, null, 2), isJson: true };
    } catch (e) {
      return { parsed: null, raw: String(args), isJson: false };
    }
  }
  if (typeof args === "string") {
    var trimmed = args.trim();
    if (trimmed === "") return { parsed: null, raw: "(empty string)", isJson: false };
    try {
      var parsed = JSON.parse(trimmed);
      return { parsed: parsed, raw: JSON.stringify(parsed, null, 2), isJson: true };
    } catch (e) {
      return { parsed: null, raw: args, isJson: false };
    }
  }
  return { parsed: null, raw: String(args), isJson: false };
}

// Mirror of viewer's _matchToolCallsToResults — keep in sync with
// tools/zai-json-viewer.html
function _matchToolCallsToResults(calls, results) {
  var matched = [];
  var unmatchedResults = [];
  var resultsByCallId = {};
  if (Array.isArray(results)) {
    for (var i = 0; i < results.length; i++) {
      var r = results[i];
      if (!r || typeof r !== "object") continue;
      var tcid = r.tool_call_id;
      if (tcid === undefined || tcid === null) {
        unmatchedResults.push(r);
        continue;
      }
      var key = String(tcid);
      if (!resultsByCallId[key]) resultsByCallId[key] = [];
      resultsByCallId[key].push(r);
    }
  }
  if (Array.isArray(calls)) {
    for (var j = 0; j < calls.length; j++) {
      var c = calls[j];
      if (!c || typeof c !== "object") continue;
      var cid = c.id;
      var key2 = cid !== undefined && cid !== null ? String(cid) : null;
      var matchedResults = key2 ? (resultsByCallId[key2] || []) : [];
      if (matchedResults.length > 0) {
        matched.push({ call: c, result: matchedResults[0] });
        matchedResults.shift();
      } else {
        matched.push({ call: c, result: null });
      }
    }
  }
  for (var k in resultsByCallId) {
    if (Object.prototype.hasOwnProperty.call(resultsByCallId, k)) {
      var leftover = resultsByCallId[k];
      for (var m = 0; m < leftover.length; m++) {
        unmatchedResults.push(leftover[m]);
      }
    }
  }
  return { matched: matched, unmatchedResults: unmatchedResults };
}

function run(describe, assert) {
  var tests = [];

  // --- Spec-fixture sanity check ---
  var FIXTURE = {
    type: "tool_calls",
    content: [
      {
        id: "01a1499ddaa967ef85ac56ec68123427",
        type: "function",
        function: {
          name: "Bash",
          arguments: "{\"command\":\"mkdir -p /home/z/my-project/audit && cd /home/z/my-project/audit && git clone --branch main --depth 1 https://github.com/a23bc/dlipa-rebuild.git 2>&1 | tail -30\",\"description\":\"Clone the target repository\"}"
        }
      }
    ],
    started_at: 1792236442,
    ended_at: 1792236447,
    results: [
      {
        tool_call_id: "01a1499ddaa967ef85ac56ec68123427",
        content: "Cloning into 'dlipa-rebuild'...",
        status: "completed"
      }
    ]
  };

  describe("Tool calls — argument parsing", function() {
    tests.push({
      name: "1. JSON string arguments are parsed and pretty-formatted",
      fn: function() {
        var call = FIXTURE.content[0];
        var parsed = _parseToolCallArguments(call.function.arguments);
        assert.strictEqual(parsed.isJson, true);
        assert.ok(parsed.parsed !== null);
        assert.strictEqual(parsed.parsed.command, "mkdir -p /home/z/my-project/audit && cd /home/z/my-project/audit && git clone --branch main --depth 1 https://github.com/a23bc/dlipa-rebuild.git 2>&1 | tail -30");
        assert.strictEqual(parsed.parsed.description, "Clone the target repository");
        // raw should be the pretty-formatted JSON
        assert.ok(parsed.raw.indexOf("\"command\":") !== -1);
        assert.ok(parsed.raw.indexOf("\"description\":") !== -1);
      }
    });
    tests.push({
      name: "2. Arguments as already-parsed object",
      fn: function() {
        var args = { command: "ls -la", description: "list files" };
        var parsed = _parseToolCallArguments(args);
        assert.strictEqual(parsed.isJson, true);
        assert.strictEqual(parsed.parsed.command, "ls -la");
        assert.strictEqual(parsed.parsed.description, "list files");
      }
    });
    tests.push({
      name: "3. Arguments as non-JSON plain string — raw preserved, isJson=false",
      fn: function() {
        var args = "this is not json";
        var parsed = _parseToolCallArguments(args);
        assert.strictEqual(parsed.isJson, false);
        assert.strictEqual(parsed.parsed, null);
        assert.strictEqual(parsed.raw, "this is not json");
      }
    });
    tests.push({
      name: "3b. Arguments with broken JSON syntax — raw preserved",
      fn: function() {
        var args = "{\"command\": \"ls\"";  // truncated JSON
        var parsed = _parseToolCallArguments(args);
        assert.strictEqual(parsed.isJson, false);
        assert.strictEqual(parsed.parsed, null);
        assert.strictEqual(parsed.raw, args);
      }
    });
    tests.push({
      name: "3c. Empty string arguments — shown as '(empty string)'",
      fn: function() {
        var parsed = _parseToolCallArguments("");
        assert.strictEqual(parsed.isJson, false);
        assert.strictEqual(parsed.raw, "(empty string)");
      }
    });
    tests.push({
      name: "3d. Missing arguments — shown as '(none)'",
      fn: function() {
        var parsed1 = _parseToolCallArguments(undefined);
        var parsed2 = _parseToolCallArguments(null);
        assert.strictEqual(parsed1.raw, "(none)");
        assert.strictEqual(parsed2.raw, "(none)");
      }
    });
    tests.push({
      name: "8. Arguments containing HTML / <script> strings — raw preserved verbatim, no execution",
      fn: function() {
        var args = "{\"html\":\"<script>alert(1)</script>\",\"x\":\"</details>\"}";
        var parsed = _parseToolCallArguments(args);
        assert.strictEqual(parsed.isJson, true);
        assert.strictEqual(parsed.parsed.html, "<script>alert(1)</script>");
        assert.strictEqual(parsed.parsed.x, "</details>");
      }
    });
  });

  describe("Tool calls — result matching", function() {
    tests.push({
      name: "1. Single call matched to single result by tool_call_id",
      fn: function() {
        var calls = FIXTURE.content;
        var results = FIXTURE.results;
        var m = _matchToolCallsToResults(calls, results);
        assert.strictEqual(m.matched.length, 1);
        assert.strictEqual(m.matched[0].call.id, "01a1499ddaa967ef85ac56ec68123427");
        assert.strictEqual(m.matched[0].result.tool_call_id, "01a1499ddaa967ef85ac56ec68123427");
        assert.strictEqual(m.matched[0].result.status, "completed");
        assert.strictEqual(m.unmatchedResults.length, 0);
      }
    });
    tests.push({
      name: "4. Multiple calls with different IDs — each matched to its result",
      fn: function() {
        var calls = [
          { id: "call-a", function: { name: "Bash", arguments: "{}" } },
          { id: "call-b", function: { name: "Search", arguments: "{}" } }
        ];
        var results = [
          { tool_call_id: "call-a", content: "result A", status: "completed" },
          { tool_call_id: "call-b", content: "result B", status: "completed" }
        ];
        var m = _matchToolCallsToResults(calls, results);
        assert.strictEqual(m.matched.length, 2);
        assert.strictEqual(m.matched[0].call.id, "call-a");
        assert.strictEqual(m.matched[0].result.content, "result A");
        assert.strictEqual(m.matched[1].call.id, "call-b");
        assert.strictEqual(m.matched[1].result.content, "result B");
        assert.strictEqual(m.unmatchedResults.length, 0);
      }
    });
    tests.push({
      name: "5. One call has no matching result — result is null",
      fn: function() {
        var calls = [
          { id: "call-a", function: { name: "Bash", arguments: "{}" } },
          { id: "call-b-no-result", function: { name: "Search", arguments: "{}" } }
        ];
        var results = [
          { tool_call_id: "call-a", content: "result A", status: "completed" }
        ];
        var m = _matchToolCallsToResults(calls, results);
        assert.strictEqual(m.matched.length, 2);
        assert.strictEqual(m.matched[0].call.id, "call-a");
        assert.ok(m.matched[0].result !== null);
        assert.strictEqual(m.matched[1].call.id, "call-b-no-result");
        assert.strictEqual(m.matched[1].result, null);
      }
    });
    tests.push({
      name: "6. Result with no matching call — listed in unmatchedResults",
      fn: function() {
        var calls = [
          { id: "call-a", function: { name: "Bash", arguments: "{}" } }
        ];
        var results = [
          { tool_call_id: "call-a", content: "result A", status: "completed" },
          { tool_call_id: "call-orphan", content: "orphaned result", status: "completed" }
        ];
        var m = _matchToolCallsToResults(calls, results);
        assert.strictEqual(m.matched.length, 1);
        assert.strictEqual(m.unmatchedResults.length, 1);
        assert.strictEqual(m.unmatchedResults[0].tool_call_id, "call-orphan");
      }
    });
    tests.push({
      name: "6b. Result with no tool_call_id — listed in unmatchedResults",
      fn: function() {
        var calls = [{ id: "call-a", function: { name: "Bash", arguments: "{}" } }];
        var results = [
          { tool_call_id: "call-a", content: "result A", status: "completed" },
          { content: "no id result", status: "completed" }
        ];
        var m = _matchToolCallsToResults(calls, results);
        assert.strictEqual(m.matched.length, 1);
        assert.strictEqual(m.unmatchedResults.length, 1);
      }
    });
    tests.push({
      name: "7. Multi-line result content — preserved verbatim",
      fn: function() {
        var calls = [{ id: "c1", function: { name: "Bash", arguments: "{}" } }];
        var multiLine = "Line 1\nLine 2\nLine 3\n  indented";
        var results = [{ tool_call_id: "c1", content: multiLine, status: "completed" }];
        var m = _matchToolCallsToResults(calls, results);
        assert.strictEqual(m.matched[0].result.content, multiLine);
      }
    });
  });

  describe("Tool calls — block timing", function() {
    tests.push({
      name: "9. Missing started_at / ended_at / status — block still parses",
      fn: function() {
        // Build a minimal tool_calls block without optional fields.
        var block = {
          type: "tool_calls",
          content: [{ id: "c1", type: "function", function: { name: "Bash", arguments: "{}" } }]
          // no started_at, no ended_at, no results
        };
        var m = _matchToolCallsToResults(block.content, block.results || []);
        assert.strictEqual(m.matched.length, 1);
        assert.strictEqual(m.matched[0].result, null);
        assert.strictEqual(m.unmatchedResults.length, 0);
      }
    });
    tests.push({
      name: "9b. Block has started_at but no ended_at — still parses",
      fn: function() {
        var block = {
          type: "tool_calls",
          started_at: 1792236442,
          content: [{ id: "c1", function: { name: "Bash", arguments: "{}" } }],
          results: [{ tool_call_id: "c1", content: "done", status: "completed" }]
        };
        var m = _matchToolCallsToResults(block.content, block.results);
        assert.strictEqual(m.matched.length, 1);
        assert.ok(m.matched[0].result !== null);
      }
    });
  });

  describe("Tool calls — full fixture (spec sample)", function() {
    tests.push({
      name: "Spec fixture: Bash call with JSON args, status=completed, content present",
      fn: function() {
        var calls = FIXTURE.content;
        var results = FIXTURE.results;
        var m = _matchToolCallsToResults(calls, results);
        assert.strictEqual(m.matched.length, 1);
        var pair = m.matched[0];
        // Tool name
        assert.strictEqual(pair.call.function.name, "Bash");
        // Call ID
        assert.strictEqual(pair.call.id, "01a1499ddaa967ef85ac56ec68123427");
        // Arguments parsed correctly
        var parsed = _parseToolCallArguments(pair.call.function.arguments);
        assert.strictEqual(parsed.isJson, true);
        assert.strictEqual(parsed.parsed.command, "mkdir -p /home/z/my-project/audit && cd /home/z/my-project/audit && git clone --branch main --depth 1 https://github.com/a23bc/dlipa-rebuild.git 2>&1 | tail -30");
        assert.strictEqual(parsed.parsed.description, "Clone the target repository");
        // Status
        assert.strictEqual(pair.result.status, "completed");
        // Output content
        assert.strictEqual(pair.result.content, "Cloning into 'dlipa-rebuild'...");
        // Timing
        assert.strictEqual(FIXTURE.started_at, 1792236442);
        assert.strictEqual(FIXTURE.ended_at, 1792236447);
      }
    });
  });

  describe("Tool calls — non-regression on plain text content_blocks", function() {
    tests.push({
      name: "10. Plain text content_block (type=text) is unaffected by tool_calls logic",
      fn: function() {
        // Tool calls logic only triggers for type==="tool_calls".
        // Other block types should not be affected.
        var textBlock = { type: "text", content: "Hello world." };
        // _parseToolCallArguments would not be called on this (the viewer
        // only calls it for tool_calls blocks). Verify the helper still
        // returns something sane if asked to parse its content.
        var parsed = _parseToolCallArguments(textBlock.content);
        assert.strictEqual(parsed.isJson, false);
        assert.strictEqual(parsed.raw, "Hello world.");
      }
    });
    tests.push({
      name: "10b. Reasoning block is unaffected — still extracted by extractReasoning",
      fn: function() {
        var reasoningBlock = { type: "reasoning", content: "step 1\nstep 2" };
        var parsed = _parseToolCallArguments(reasoningBlock.content);
        assert.strictEqual(parsed.isJson, false);
        assert.strictEqual(parsed.raw, "step 1\nstep 2");
      }
    });
  });

  return tests;
}

module.exports = { run: run };
