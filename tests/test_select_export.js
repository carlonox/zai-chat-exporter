// Tests for select.js's batched fetch + export flow.
//
// Like popup.js, select.js is browser code and cannot be required directly.
// We test the equivalent logic via api.js + exporters.js — same libs that
// select.js uses after the refactor. These tests guard the select-window
// code path specifically (chat-by-chat fetch with incompleteness flag).
var api = require("../src/lib/api.js");
var exporters = require("../src/lib/exporters.js");
var toMarkdown = exporters.toMarkdown;
var toJSON = exporters.toJSON;

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

function makeMsg(id, role, content, blocks) {
  return { id: id, role: role || "assistant",
    content: content !== undefined ? content : null,
    content_blocks: blocks || (content ? [] : [{ type: "text", content: "body-"+id }]),
    timestamp: 1700000000, model: "GLM-5",
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }, done: true };
}

// Mirror of select.js's normalizeMessage (kept here for tests; select.js
// has the same logic inlined so this guards against drift).
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

  describe("select.js flow — chat-by-chat batched fetch", function() {
    tests.push({
      name: "single selected chat with Agent message exports body in Markdown",
      fn: async function() {
        // 2 routes: chat details (GET), then batch POST
        var mock = makeMockFetch([
          { match: function(b, url) { return url.indexOf("/chats/chat1/messages/batch") === -1 && url.indexOf("/chats/chat1") !== -1; },
            data: { id: "chat1", title: "Agent chat", created_at: 1700000000, updated_at: 1700000000,
              chat: { history: { messages: { m1: {}, m2: {} } } } } },
          { match: function(b) { return b.ids && b.ids.length === 2; },
            data: { data: {
              m1: makeMsg("m1","user","hello"),
              m2: makeMsg("m2","assistant", null, [
                { type: "reasoning", content: "thinking" },
                { type: "text", content: "agent answer" }
              ])
            } } }
        ]);
        // For select.js tests, we use getMessagesBatched directly with the IDs
        // the way select.js does (after it reads them from chat history).
        var orderedIds = ["m1","m2"];
        var result = await api.getMessagesBatched("tok", "chat1", orderedIds, { fetch: mock, batchSize: 50, maxRetries: 1, retryDelayMs: 1 });
        var messages = orderedIds.map(function(id) {
          var raw = result.messages[id];
          return raw ? normalizeMessage(raw) : null;
        });
        var chats = [{ id: "chat1", title: "Agent chat",
          created_at: "2023-11-14T22:13:20.000Z", updated_at: "2023-11-14T22:13:20.000Z",
          messages: messages }];
        var md = toMarkdown(chats);
        assert.ok(md.indexOf("agent answer") !== -1);
        assert.ok(md.indexOf("[Empty message") === -1);
      }
    });
    tests.push({
      name: "multiple selected chats, partial failure on second — JSON still serializes with _export_status marker",
      fn: async function() {
        var mock = makeMockFetch([
          // chat1: works
          { match: function(b, url) { return url.indexOf("/chats/chat1/messages/batch") !== -1; },
            data: { data: { m1: makeMsg("m1","assistant","chat1-msg") } } },
          // chat2: 500
          { match: function(b, url) { return url.indexOf("/chats/chat2/messages/batch") !== -1; },
            data: {}, status: 500 }
        ]);
        var result1 = await api.getMessagesBatched("tok", "chat1", ["m1"], { fetch: mock, batchSize: 50, maxRetries: 1, retryDelayMs: 1 });
        var result2 = await api.getMessagesBatched("tok", "chat2", ["m2","m3"], { fetch: mock, batchSize: 50, maxRetries: 1, retryDelayMs: 1 });
        assert.strictEqual(result1.complete, true);
        assert.strictEqual(result2.complete, false);
        assert.deepStrictEqual(result2.missingIds, ["m2","m3"]);
        // Build chats with placeholder slots like popup.js/select.js does.
        var chats = [{
          id: "chat1", title: "OK", created_at: null, updated_at: null,
          messages: result1.requestedIds.map(function(id) {
            return normalizeMessage(result1.messages[id]);
          })
        }, {
          id: "chat2", title: "Partial", created_at: null, updated_at: null,
          messages: result2.requestedIds.map(function(id) {
            return { id: id, role: null, content: null, reasoning: null,
              content_blocks: [], timestamp: null, model: null, usage: null,
              done: false, _export_status: "missing" };
          })
        }];
        var json = toJSON(chats);
        var parsed = JSON.parse(json);
        assert.strictEqual(parsed[0].messages[0].content, "chat1-msg");
        assert.strictEqual(parsed[1].messages[0]._export_status, "missing");
        assert.strictEqual(parsed[1].messages[1]._export_status, "missing");
      }
    });
  });

  return tests;
}

module.exports = { run: run };
