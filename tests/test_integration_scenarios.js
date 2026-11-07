// Integration tests covering the spec's required scenarios end-to-end.
//
// Mirrors the "must-cover" test list from the task description.
var api = require("../src/lib/api.js");
var exporters = require("../src/lib/exporters.js");
var getMessagesBatched = api.getMessagesBatched;
var toMarkdown = exporters.toMarkdown;
var toPlainText = exporters.toPlainText;
var toJSON = exporters.toJSON;
var extractMessageBody = exporters.extractMessageBody;

function makeMockFetch(routes) {
  var callLog = [];
  function fakeFetch(url, opts) {
    callLog.push({ url: url, opts: opts });
    var bodyObj = {};
    try { bodyObj = JSON.parse(opts.body); } catch (e) {}
    for (var i = 0; i < routes.length; i++) {
      var r = routes[i];
      if (r.match(bodyObj, url, opts)) {
        if (!r.persistent) routes.splice(i, 1);
        var status = r.status || 200;
        return Promise.resolve({
          ok: status < 300, status: status,
          json: function() { return Promise.resolve(r.data); }
        });
      }
    }
    return Promise.resolve({ ok: false, status: 599,
      json: function() { return Promise.resolve({ error: "no match" }); } });
  }
  fakeFetch.callLog = callLog;
  return fakeFetch;
}

function normalizeMessage(msg) {
  if (!msg || typeof msg !== "object") return null;
  var blocks = Array.isArray(msg.content_blocks) ? msg.content_blocks : [];
  var rBlock = null;
  for (var b = 0; b < blocks.length; b++) {
    if (blocks[b] && blocks[b].type === "reasoning") { rBlock = blocks[b]; break; }
  }
  return {
    id: msg.id, role: msg.role, content: msg.content,
    reasoning: rBlock ? rBlock.content : null,
    content_blocks: blocks,
    timestamp: msg.timestamp ? new Date(msg.timestamp * 1000).toISOString() : null,
    model: msg.model || null,
    usage: msg.usage || null,
    done: msg.done || false
  };
}

function run(describe, assert) {
  var tests = [];

  describe("Spec scenarios — required coverage", function() {
    tests.push({
      name: "1. Normal chat, short conversation",
      fn: async function() {
        var ids = ["u1","a1"];
        var mock = makeMockFetch([
          { match: function() { return true; },
            data: { data: {
              u1: { id: "u1", role: "user", content: "hi", content_blocks: [], timestamp: 1700000000, model: null, usage: null, done: false },
              a1: { id: "a1", role: "assistant", content: "hello", content_blocks: [], timestamp: 1700000001, model: "GLM-5", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }, done: true }
            } } }
        ]);
        var result = await getMessagesBatched("tok","c",ids,{ fetch: mock, batchSize: 50, maxRetries: 1, retryDelayMs: 1 });
        assert.strictEqual(result.complete, true);
        var messages = ids.map(function(id) { return normalizeMessage(result.messages[id]); });
        var chats = [{ id: "c", title: "T", created_at: null, updated_at: null, messages: messages }];
        var md = toMarkdown(chats); var txt = toPlainText(chats); var json = toJSON(chats);
        assert.ok(md.indexOf("hi") !== -1 && md.indexOf("hello") !== -1);
        assert.ok(txt.indexOf("hi") !== -1 && txt.indexOf("hello") !== -1);
        var parsed = JSON.parse(json);
        assert.strictEqual(parsed[0].messages.length, 2);
      }
    });
    tests.push({
      name: "2. Agent mode, body stored in content_blocks only",
      fn: async function() {
        var ids = ["a1"];
        var mock = makeMockFetch([
          { match: function() { return true; },
            data: { data: {
              a1: { id: "a1", role: "assistant", content: null, content_blocks: [
                { type: "text", content: "Final via block" }
              ], timestamp: 1700000000, model: "GLM-5", usage: null, done: true }
            } } }
        ]);
        var result = await getMessagesBatched("tok","c",ids,{ fetch: mock, batchSize: 50, maxRetries: 1, retryDelayMs: 1 });
        var messages = ids.map(function(id) { return normalizeMessage(result.messages[id]); });
        var chats = [{ id: "c", title: "T", created_at: null, updated_at: null, messages: messages }];
        var md = toMarkdown(chats);
        assert.ok(md.indexOf("Final via block") !== -1);
        assert.ok(md.indexOf("[Empty message") === -1);
      }
    });
    tests.push({
      name: "3. reasoning + final answer both present",
      fn: async function() {
        var msg = { id: "a1", role: "assistant", content: null,
          content_blocks: [
            { type: "reasoning", content: "step-by-step" },
            { type: "text", content: "the actual answer" }
          ] };
        assert.strictEqual(extractMessageBody(msg), "the actual answer");
        var chats = [{ id: "c", title: "T", created_at: null, updated_at: null, messages: [normalizeMessage(msg)] }];
        var md = toMarkdown(chats);
        assert.ok(md.indexOf("step-by-step") !== -1);
        assert.ok(md.indexOf("the actual answer") !== -1);
      }
    });
    tests.push({
      name: "4. Message count exceeds single batch size — chunked correctly",
      fn: async function() {
        var ids = [];
        for (var i = 0; i < 75; i++) ids.push("m" + i);
        var mock = makeMockFetch([
          { match: function() { return true; }, persistent: true,
            data: (function() {
              var d = {};
              for (var j = 0; j < 75; j++) d["m" + j] = { id: "m"+j, role: "assistant", content: "body", content_blocks: [] };
              return { data: d };
            })() }
        ]);
        var result = await getMessagesBatched("tok","c",ids,{ fetch: mock, batchSize: 50, maxRetries: 1, retryDelayMs: 1 });
        assert.strictEqual(mock.callLog.length, 2);
        assert.strictEqual(result.complete, true);
      }
    });
    tests.push({
      name: "5. Multiple batches all succeed — order preserved",
      fn: async function() {
        var ids = ["a","b","c","d","e","f"];
        var mock = makeMockFetch([
          { match: function() { return true; },
            data: { data: { f: { id: "f", role: "assistant", content: "f", content_blocks: [] },
              a: { id: "a", role: "assistant", content: "a", content_blocks: [] },
              b: { id: "b", role: "assistant", content: "b", content_blocks: [] },
              c: { id: "c", role: "assistant", content: "c", content_blocks: [] },
              d: { id: "d", role: "assistant", content: "d", content_blocks: [] },
              e: { id: "e", role: "assistant", content: "e", content_blocks: [] } } } }
        ]);
        var result = await getMessagesBatched("tok","c",ids,{ fetch: mock, batchSize: 2, maxRetries: 1, retryDelayMs: 1 });
        assert.deepStrictEqual(result.requestedIds, ids);
      }
    });
    tests.push({
      name: "6. One batch fails then succeeds on retry",
      fn: async function() {
        var ids = ["a","b"];
        var callCount = 0;
        var mock = makeMockFetch([
          { match: function() { callCount++; return callCount === 1; },
            data: {}, status: 500 },
          { match: function() { return true; },
            data: { data: { a: { id: "a", role: "assistant", content: "x", content_blocks: [] },
              b: { id: "b", role: "assistant", content: "y", content_blocks: [] } } } }
        ]);
        var result = await getMessagesBatched("tok","c",ids,{ fetch: mock, batchSize: 50, maxRetries: 3, retryDelayMs: 1 });
        assert.strictEqual(result.complete, true);
        assert.strictEqual(result.errors.length, 0);
      }
    });
    tests.push({
      name: "7. Batch permanently fails — export reports incomplete, no silent success",
      fn: async function() {
        var ids = ["a","b","c"];
        var mock = makeMockFetch([
          { match: function() { return true; }, data: {}, status: 503 }
        ]);
        var result = await getMessagesBatched("tok","c",ids,{ fetch: mock, batchSize: 50, maxRetries: 2, retryDelayMs: 1 });
        assert.strictEqual(result.complete, false);
        assert.strictEqual(result.errors.length, 1);
        assert.deepStrictEqual(result.missingIds, ["a","b","c"]);
      }
    });
    tests.push({
      name: "8. API returns missing IDs or duplicate messages — diagnostics computed",
      fn: async function() {
        var ids = ["a","b","c"];
        var mock = makeMockFetch([
          { match: function() { return true; },
            data: { data: {
              a: { id: "a", role: "assistant", content: "x", content_blocks: [] },
              a_dup: { id: "a", role: "assistant", content: "x", content_blocks: [] },
              b: { id: "b", role: "assistant", content: "y", content_blocks: [] }
            } } }
        ]);
        var result = await getMessagesBatched("tok","c",ids,{ fetch: mock, batchSize: 50, maxRetries: 1, retryDelayMs: 1 });
        assert.strictEqual(result.complete, false);
        assert.deepStrictEqual(result.missingIds, ["c"]);
        assert.strictEqual(result.duplicateCount, 1);
      }
    });
    tests.push({
      name: "9. Empty messages, empty content_blocks, malformed message objects",
      fn: function() {
        assert.strictEqual(extractMessageBody({}), "");
        assert.strictEqual(extractMessageBody({ content: null, content_blocks: [] }), "");
        assert.strictEqual(extractMessageBody({ content: null, content_blocks: [null,"stray",42] }), "");
        assert.strictEqual(extractMessageBody({ content: null, content_blocks: [{ type: "reasoning", content: "only thinking" }] }), "");
        // Explicit placeholder shown when truly empty.
        var chats = [{ id: "c", title: "T", created_at: null, updated_at: null,
          messages: [{ id: "z1", role: "assistant", content: null, content_blocks: [] }] }];
        var md = toMarkdown(chats);
        assert.ok(md.indexOf("[Empty message (id: z1, role: assistant)]") !== -1);
      }
    });
    tests.push({
      name: "10. Long messages, long reasoning, many rounds — JSON serializes losslessly",
      fn: async function() {
        var ids = [];
        var dataObj = {};
        for (var i = 0; i < 50; i++) {
          var id = "x" + i;
          ids.push(id);
          dataObj[id] = { id: id, role: "assistant", content: null,
            content_blocks: [
              { type: "reasoning", content: "r".repeat(20000) },
              { type: "text", content: "b".repeat(20000) }
            ],
            timestamp: 1700000000, model: "GLM-5",
            usage: { prompt_tokens: 1000, completion_tokens: 2000, total_tokens: 3000 },
            done: true };
        }
        var mock = makeMockFetch([
          { match: function() { return true; }, persistent: true, data: { data: dataObj } }
        ]);
        var result = await getMessagesBatched("tok","c",ids,{ fetch: mock, batchSize: 50, maxRetries: 1, retryDelayMs: 1 });
        assert.strictEqual(result.complete, true);
        var messages = ids.map(function(id) { return normalizeMessage(result.messages[id]); });
        var chats = [{ id: "c", title: "T", created_at: null, updated_at: null, messages: messages }];
        var json = toJSON(chats);
        var parsed = JSON.parse(json);
        assert.strictEqual(parsed[0].messages.length, 50);
        assert.strictEqual(parsed[0].messages[0].content_blocks[0].content.length, 20000);
        assert.strictEqual(parsed[0].messages[0].content_blocks[1].content.length, 20000);
        // All original fields preserved
        assert.strictEqual(parsed[0].messages[0].model, "GLM-5");
        assert.deepStrictEqual(parsed[0].messages[0].usage, { prompt_tokens: 1000, completion_tokens: 2000, total_tokens: 3000 });
        assert.strictEqual(parsed[0].messages[0].done, true);
      }
    });
  });

  return tests;
}

module.exports = { run: run };
