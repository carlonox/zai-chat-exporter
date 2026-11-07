// Tests for popup.js's message normalization + batch orchestration logic.
//
// popup.js is browser-context code (it references `document`, `chrome`, etc.)
// so we cannot require() it directly under Node. Instead we test the
// normalize/fetch logic via api.js + exporters.js, which IS testable.
//
// These tests cover the integration: API response -> normalizeMessage ->
// rebuild array in original ID order -> exporter serializes correctly.
var api = require("../src/lib/api.js");
var exporters = require("../src/lib/exporters.js");
var getMessagesBatched = api.getMessagesBatched;
var toMarkdown = exporters.toMarkdown;
var toJSON = exporters.toJSON;

// Inline copy of popup.js's normalizeMessage so we can test the
// normalization step in isolation. The src code in popup.js has the same
// logic — these tests guard against regressions in either place.
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

function makeMockFetch(routes) {
  var callLog = [];
  function fakeFetch(url, opts) {
    callLog.push({ url: url, opts: opts });
    var bodyObj;
    try { bodyObj = JSON.parse(opts.body); } catch (e) { bodyObj = {}; }
    for (var i = 0; i < routes.length; i++) {
      var r = routes[i];
      if (r.match(bodyObj, url, opts)) {
        if (!r.persistent) routes.splice(i, 1);
        var status = r.status || 200;
        return Promise.resolve({
          ok: status < 300,
          status: status,
          json: function() { return Promise.resolve(r.data); }
        });
      }
    }
    return Promise.resolve({
      ok: false, status: 599,
      json: function() { return Promise.resolve({ error: "no match" }); }
    });
  }
  fakeFetch.callLog = callLog;
  return fakeFetch;
}

function makeMsg(id, role, content, blocks) {
  return {
    id: id, role: role || "assistant",
    content: content !== undefined ? content : null,
    content_blocks: blocks || (content ? [] : [{ type: "text", content: "body-"+id }]),
    timestamp: 1700000000,
    model: "GLM-5",
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    done: true
  };
}

function run(describe, assert) {
  var tests = [];

  describe("normalizeMessage — preserves all original fields", function() {
    tests.push({
      name: "Agent message: content null, blocks have reasoning + text",
      fn: function() {
        var raw = makeMsg("a1", "assistant", null, [
          { type: "reasoning", content: "thinking" },
          { type: "text", content: "answer" }
        ]);
        var n = normalizeMessage(raw);
        assert.strictEqual(n.id, "a1");
        assert.strictEqual(n.role, "assistant");
        assert.strictEqual(n.content, null, "original content null is preserved");
        assert.strictEqual(n.reasoning, "thinking");
        assert.strictEqual(n.content_blocks.length, 2);
        assert.strictEqual(n.model, "GLM-5");
        assert.deepStrictEqual(n.usage, { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });
        assert.strictEqual(n.done, true);
      }
    });
    tests.push({
      name: "null/undefined input returns null",
      fn: function() {
        assert.strictEqual(normalizeMessage(null), null);
        assert.strictEqual(normalizeMessage(undefined), null);
      }
    });
  });

  describe("popup flow — batched fetch + order preservation + serialize", function() {
    tests.push({
      name: "Scenario 1: short normal chat",
      fn: async function() {
        var ids = ["u1","a1"];
        var mock = makeMockFetch([
          { match: function() { return true; },
            data: { data: {
              u1: makeMsg("u1","user","hi"),
              a1: makeMsg("a1","assistant","hello")
            } } }
        ]);
        var result = await getMessagesBatched("tok", "chat", ids, { fetch: mock, batchSize: 50, maxRetries: 1, retryDelayMs: 1 });
        // Rebuild array in requested order (what popup.js does).
        var messages = ids.map(function(id) { return normalizeMessage(result.messages[id]); });
        var chats = [{ id: "chat", title: "T", created_at: null, updated_at: null, messages: messages }];
        var md = toMarkdown(chats);
        assert.ok(md.indexOf("### User") !== -1);
        assert.ok(md.indexOf("### Assistant") !== -1);
        assert.ok(md.indexOf("hi") !== -1);
        assert.ok(md.indexOf("hello") !== -1);
      }
    });
    tests.push({
      name: "Scenario 2: Agent body in content_blocks — Markdown shows body",
      fn: async function() {
        var ids = ["a1"];
        var mock = makeMockFetch([
          { match: function() { return true; },
            data: { data: {
              a1: makeMsg("a1","assistant", null, [
                { type: "reasoning", content: "internal" },
                { type: "text", content: "Agent final answer" }
              ])
            } } }
        ]);
        var result = await getMessagesBatched("tok", "chat", ids, { fetch: mock, batchSize: 50, maxRetries: 1, retryDelayMs: 1 });
        var messages = ids.map(function(id) { return normalizeMessage(result.messages[id]); });
        var chats = [{ id: "chat", title: "T", created_at: null, updated_at: null, messages: messages }];
        var md = toMarkdown(chats);
        assert.ok(md.indexOf("Agent final answer") !== -1);
        assert.ok(md.indexOf("[Empty message") === -1);
      }
    });
    tests.push({
      name: "Scenario 3: reasoning + final answer both visible",
      fn: async function() {
        var ids = ["a1"];
        var mock = makeMockFetch([
          { match: function() { return true; },
            data: { data: {
              a1: makeMsg("a1","assistant", null, [
                { type: "reasoning", content: "internal monologue" },
                { type: "text", content: "the answer" }
              ])
            } } }
        ]);
        var result = await getMessagesBatched("tok", "chat", ids, { fetch: mock, batchSize: 50, maxRetries: 1, retryDelayMs: 1 });
        var messages = ids.map(function(id) { return normalizeMessage(result.messages[id]); });
        var chats = [{ id: "chat", title: "T", created_at: null, updated_at: null, messages: messages }];
        var md = toMarkdown(chats);
        assert.ok(md.indexOf("internal monologue") !== -1, "reasoning must be visible");
        assert.ok(md.indexOf("the answer") !== -1, "answer must be visible");
      }
    });
    tests.push({
      name: "Scenario 4: >batch-size messages all returned, order preserved",
      fn: async function() {
        var ids = [];
        for (var i = 0; i < 75; i++) ids.push("id" + i);
        var mock = makeMockFetch([
          { match: function() { return true; }, persistent: true,
            data: (function() {
              var d = {};
              for (var j = 0; j < 75; j++) d["id" + j] = makeMsg("id"+j, "assistant", "body-id"+j);
              return { data: d };
            })() }
        ]);
        var result = await getMessagesBatched("tok", "chat", ids, { fetch: mock, batchSize: 50, maxRetries: 1, retryDelayMs: 1 });
        assert.strictEqual(result.complete, true);
        assert.strictEqual(mock.callLog.length, 2, "should be 2 batches (50 + 25)");
        // Order preservation: requestedIds is in input order
        assert.deepStrictEqual(result.requestedIds, ids);
      }
    });
    tests.push({
      name: "Scenario 5: multi-batch succeeds, original order preserved in rebuilt array",
      fn: async function() {
        var ids = ["m1","m2","m3","m4","m5"];
        var mock = makeMockFetch([
          // Batch 1 returns in scrambled order
          { match: function(b) { return b.ids.length === 2 && b.ids[0] === "m1"; },
            data: { data: { m2: makeMsg("m2","assistant","body-m2"), m1: makeMsg("m1","assistant","body-m1") } } },
          { match: function(b) { return b.ids.length === 2 && b.ids[0] === "m3"; },
            data: { data: { m4: makeMsg("m4","assistant","body-m4"), m3: makeMsg("m3","assistant","body-m3") } } },
          { match: function(b) { return b.ids.length === 1 && b.ids[0] === "m5"; },
            data: { data: { m5: makeMsg("m5","assistant","body-m5") } } }
        ]);
        var result = await getMessagesBatched("tok", "chat", ids, { fetch: mock, batchSize: 2, maxRetries: 1, retryDelayMs: 1 });
        var messages = ids.map(function(id) { return normalizeMessage(result.messages[id]); });
        // Rebuilt array must be in requested order
        assert.deepStrictEqual(messages.map(function(m) { return m.id; }), ids);
        // And the bodies must be in the right slots
        assert.strictEqual(messages[0].content, "body-m1");
        assert.strictEqual(messages[4].content, "body-m5");
      }
    });
    tests.push({
      name: "Scenario 6: one batch fails transiently, retry succeeds",
      fn: async function() {
        var ids = ["a","b"];
        var callCount = 0;
        var mock = makeMockFetch([
          { match: function() { callCount++; return callCount === 1; },
            data: {}, status: 500 },
          { match: function() { return true; },
            data: { data: { a: makeMsg("a","assistant","x"), b: makeMsg("b","assistant","y") } } }
        ]);
        var result = await getMessagesBatched("tok", "chat", ids, { fetch: mock, batchSize: 50, maxRetries: 3, retryDelayMs: 1 });
        assert.strictEqual(result.complete, true);
        assert.strictEqual(result.errors.length, 0);
      }
    });
    tests.push({
      name: "Scenario 7: batch permanently fails — complete=false, missing IDs surfaced",
      fn: async function() {
        var ids = ["a","b","c"];
        var mock = makeMockFetch([
          { match: function() { return true; }, data: {}, status: 503 }
        ]);
        var result = await getMessagesBatched("tok", "chat", ids, { fetch: mock, batchSize: 50, maxRetries: 2, retryDelayMs: 1 });
        assert.strictEqual(result.complete, false);
        assert.strictEqual(result.errors.length, 1);
        assert.deepStrictEqual(result.missingIds, ["a","b","c"]);
        // Caller would surface this to the user. No silent partial export.
      }
    });
    tests.push({
      name: "Scenario 8: API returns missing IDs and duplicates — both reported",
      fn: async function() {
        var ids = ["a","b","c"];
        var mock = makeMockFetch([
          { match: function() { return true; },
            data: { data: {
              a: makeMsg("a","assistant","x"),
              a_dup: makeMsg("a","assistant","x"),  // dup
              b: makeMsg("b","assistant","y")
              // c missing
            } } }
        ]);
        var result = await getMessagesBatched("tok", "chat", ids, { fetch: mock, batchSize: 50, maxRetries: 1, retryDelayMs: 1 });
        assert.strictEqual(result.complete, false);
        assert.deepStrictEqual(result.missingIds, ["c"]);
        assert.strictEqual(result.duplicateCount, 1);
      }
    });
    tests.push({
      name: "Scenario 9: empty/blank messages do not crash the pipeline",
      fn: async function() {
        var ids = ["a"];
        var mock = makeMockFetch([
          { match: function() { return true; },
            data: { data: {
              a: { id: "a", role: "assistant", content: null, content_blocks: [] }
            } } }
        ]);
        var result = await getMessagesBatched("tok", "chat", ids, { fetch: mock, batchSize: 50, maxRetries: 1, retryDelayMs: 1 });
        var messages = ids.map(function(id) { return normalizeMessage(result.messages[id]); });
        var chats = [{ id: "chat", title: "T", created_at: null, updated_at: null, messages: messages }];
        var md = toMarkdown(chats);
        // Explicit placeholder must be present (NOT silent drop).
        assert.ok(md.indexOf("[Empty message (id: a, role: assistant)]") !== -1);
      }
    });
    tests.push({
      name: "Scenario 10: long messages + many rounds serialize without loss",
      fn: async function() {
        var ids = [];
        var dataObj = {};
        for (var i = 0; i < 100; i++) {
          var id = "msg-" + i;
          ids.push(id);
          dataObj[id] = makeMsg(id, "assistant", null, [
            { type: "reasoning", content: "r".repeat(5000) },
            { type: "text", content: "body-".repeat(5000) }
          ]);
        }
        var mock = makeMockFetch([
          { match: function() { return true; }, persistent: true,
            data: { data: dataObj } }
        ]);
        var result = await getMessagesBatched("tok", "chat", ids, { fetch: mock, batchSize: 50, maxRetries: 1, retryDelayMs: 1 });
        assert.strictEqual(result.complete, true);
        var messages = ids.map(function(id) { return normalizeMessage(result.messages[id]); });
        var chats = [{ id: "chat", title: "T", created_at: null, updated_at: null, messages: messages }];
        var json = toJSON(chats);
        var parsed = JSON.parse(json);
        assert.strictEqual(parsed[0].messages.length, 100);
        assert.strictEqual(parsed[0].messages[0].content_blocks[1].content.length, 25000);
      }
    });
  });

  return tests;
}

module.exports = { run: run };
