// Tests for getMessagesBatched — the chunked batch-fetch function.
//
// Mocks the global `fetch` to drive the function through:
//   - single-batch happy path
//   - multi-batch happy path with order preservation
//   - retry on transient failure
//   - permanent failure (max retries exceeded)
//   - missing IDs in the API response
//   - duplicate IDs in the API response
//   - unexpected IDs returned by the API
//
// All tests use `options.fetch` so we never hit the network.
var api = require("../src/lib/api.js");
var getMessagesBatched = api.getMessagesBatched;

// Build a fake fetch that responds based on a queue of { match, response, status }.
function makeMockFetch(routes) {
  // routes: array of { match: function(bodyObj) -> bool, data: object, status: number, persistent: bool }
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
        if (status >= 200 && status < 300) {
          return Promise.resolve({
            ok: true,
            status: status,
            json: function() { return Promise.resolve(r.data); }
          });
        } else {
          return Promise.resolve({
            ok: false,
            status: status,
            json: function() { return Promise.resolve({ error: "server error" }); }
          });
        }
      }
    }
    return Promise.resolve({
      ok: false,
      status: 599,
      json: function() { return Promise.resolve({ error: "no matching route" }); }
    });
  }
  fakeFetch.callLog = callLog;
  return fakeFetch;
}

function makeMessage(id, content) {
  return {
    id: id,
    role: "assistant",
    content: content || ("body-" + id),
    content_blocks: content ? [] : [{ type: "text", content: "body-" + id }],
    timestamp: 1700000000,
    model: "GLM-5",
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    done: true
  };
}

function run(describe, assert) {
  var tests = [];

  describe("getMessagesBatched — happy paths", function() {
    tests.push({
      name: "single batch, all IDs returned — complete=true",
      fn: async function() {
        var ids = ["a", "b", "c"];
        var mock = makeMockFetch([
          { match: function(b) { return b.ids.length === 3; },
            data: { data: { a: makeMessage("a"), b: makeMessage("b"), c: makeMessage("c") } } }
        ]);
        var result = await getMessagesBatched("token", "chat-1", ids, { fetch: mock, batchSize: 50, maxRetries: 3, retryDelayMs: 1 });
        assert.strictEqual(result.complete, true);
        assert.strictEqual(result.requestedIds.length, 3);
        assert.strictEqual(result.returnedIds.length, 3);
        assert.strictEqual(result.missingIds.length, 0);
        assert.strictEqual(result.errors.length, 0);
        assert.strictEqual(result.duplicateCount, 0);
        assert.strictEqual(result.unexpectedIds.length, 0);
        assert.strictEqual(result.messages.a.id, "a");
      }
    });
    tests.push({
      name: "multi-batch (5 IDs, batch=2) — 3 batches, order preserved",
      fn: async function() {
        var ids = ["m1", "m2", "m3", "m4", "m5"];
        var mock = makeMockFetch([
          { match: function(b) { return b.ids.length === 2 && b.ids[0] === "m1"; },
            data: { data: { m1: makeMessage("m1"), m2: makeMessage("m2") } } },
          { match: function(b) { return b.ids.length === 2 && b.ids[0] === "m3"; },
            data: { data: { m3: makeMessage("m3"), m4: makeMessage("m4") } } },
          { match: function(b) { return b.ids.length === 1 && b.ids[0] === "m5"; },
            data: { data: { m5: makeMessage("m5") } } }
        ]);
        var result = await getMessagesBatched("token", "c", ids, { fetch: mock, batchSize: 2, maxRetries: 1, retryDelayMs: 1 });
        assert.strictEqual(result.complete, true);
        assert.strictEqual(result.requestedIds.length, 5);
        assert.strictEqual(result.returnedIds.length, 5);
        assert.strictEqual(result.missingIds.length, 0);
        // Order: requestedIds must be in input order, regardless of API response order.
        assert.deepStrictEqual(result.requestedIds, ["m1","m2","m3","m4","m5"]);
        // 3 batches requested
        assert.strictEqual(mock.callLog.length, 3);
      }
    });
    tests.push({
      name: "de-duplicates input ID list",
      fn: async function() {
        var ids = ["a", "a", "b", "b", "b"];
        var mock = makeMockFetch([
          { match: function() { return true; },
            data: { data: { a: makeMessage("a"), b: makeMessage("b") } } }
        ]);
        var result = await getMessagesBatched("token", "c", ids, { fetch: mock, batchSize: 50, maxRetries: 1, retryDelayMs: 1 });
        assert.strictEqual(result.requestedIds.length, 2);
        assert.strictEqual(result.complete, true);
      }
    });
    tests.push({
      name: "empty input -> complete=true, no fetches",
      fn: async function() {
        var mock = makeMockFetch([]);
        var result = await getMessagesBatched("token", "c", [], { fetch: mock });
        assert.strictEqual(result.complete, true);
        assert.strictEqual(result.requestedIds.length, 0);
        assert.strictEqual(mock.callLog.length, 0);
      }
    });
    tests.push({
      name: "null/undefined IDs in input are skipped",
      fn: async function() {
        var ids = ["a", null, undefined, "b"];
        var mock = makeMockFetch([
          { match: function() { return true; },
            data: { data: { a: makeMessage("a"), b: makeMessage("b") } } }
        ]);
        var result = await getMessagesBatched("token", "c", ids, { fetch: mock, batchSize: 50, maxRetries: 1, retryDelayMs: 1 });
        assert.deepStrictEqual(result.requestedIds, ["a","b"]);
        assert.strictEqual(result.complete, true);
      }
    });
  });

  describe("getMessagesBatched — retry on failure", function() {
    tests.push({
      name: "one batch fails transiently, retry succeeds",
      fn: async function() {
        var ids = ["a", "b"];
        var callCount = 0;
        var mock = makeMockFetch([
          // First call: HTTP 500
          { match: function() { callCount++; return callCount === 1; },
            data: {}, status: 500 },
          // Second call (retry): HTTP 200 with data
          { match: function() { return true; },
            data: { data: { a: makeMessage("a"), b: makeMessage("b") } } }
        ]);
        var result = await getMessagesBatched("token", "c", ids, { fetch: mock, batchSize: 50, maxRetries: 3, retryDelayMs: 1 });
        assert.strictEqual(result.complete, true);
        assert.strictEqual(result.errors.length, 0);
        // Retry evidence: at least 2 fetch calls were made.
        assert.ok(mock.callLog.length >= 2, "should have called fetch at least twice (retry), got " + mock.callLog.length);
      }
    });
    tests.push({
      name: "batch exhausts retries -> recorded as error, missing IDs computed",
      fn: async function() {
        var ids = ["a", "b"];
        var mock = makeMockFetch([
          { match: function() { return true; }, data: {}, status: 500 }
        ]);
        var result = await getMessagesBatched("token", "c", ids, { fetch: mock, batchSize: 50, maxRetries: 2, retryDelayMs: 1 });
        assert.strictEqual(result.complete, false);
        assert.strictEqual(result.errors.length, 1);
        assert.deepStrictEqual(result.missingIds, ["a","b"]);
      }
    });
    tests.push({
      name: "partial batch failure: batch A ok, batch B fails -> only B's IDs missing",
      fn: async function() {
        var ids = ["a", "b", "c", "d"];
        var callCount = 0;
        var mock = makeMockFetch([
          // Batch 1 (a,b) — always ok
          { match: function(b) { return b.ids.length === 2 && b.ids[0] === "a"; },
            data: { data: { a: makeMessage("a"), b: makeMessage("b") } } },
          // Batch 2 (c,d) — always fails
          { match: function(b) { return b.ids.length === 2 && b.ids[0] === "c"; },
            data: {}, status: 500 }
        ]);
        var result = await getMessagesBatched("token", "c", ids, { fetch: mock, batchSize: 2, maxRetries: 1, retryDelayMs: 1 });
        assert.strictEqual(result.complete, false);
        assert.deepStrictEqual(result.missingIds, ["c","d"]);
        assert.deepStrictEqual(result.returnedIds, ["a","b"]);
        assert.strictEqual(result.errors.length, 1);
      }
    });
  });

  describe("getMessagesBatched — completeness diagnostics", function() {
    tests.push({
      name: "API returns fewer IDs than requested -> missingIds populated",
      fn: async function() {
        var ids = ["a","b","c"];
        var mock = makeMockFetch([
          { match: function() { return true; },
            data: { data: { a: makeMessage("a"), b: makeMessage("b") } } } // missing c
        ]);
        var result = await getMessagesBatched("token", "c", ids, { fetch: mock, batchSize: 50, maxRetries: 1, retryDelayMs: 1 });
        assert.strictEqual(result.complete, false);
        assert.deepStrictEqual(result.missingIds, ["c"]);
      }
    });
    tests.push({
      name: "API returns duplicate IDs -> duplicateCount incremented, only stored once",
      fn: async function() {
        var ids = ["a","b"];
        var mock = makeMockFetch([
          { match: function() { return true; },
            data: { data: {
              a: makeMessage("a"),
              a_dup: makeMessage("a"),   // same .id, different key — dedup by id
              b: makeMessage("b")
            } } }
        ]);
        var result = await getMessagesBatched("token", "c", ids, { fetch: mock, batchSize: 50, maxRetries: 1, retryDelayMs: 1 });
        assert.strictEqual(result.duplicateCount, 1);
        assert.strictEqual(result.returnedIds.length, 2);
      }
    });
    tests.push({
      name: "API returns unexpected ID not in request -> unexpectedIds populated",
      fn: async function() {
        var ids = ["a"];
        var mock = makeMockFetch([
          { match: function() { return true; },
            data: { data: { a: makeMessage("a"), zzz: makeMessage("zzz") } } }
        ]);
        var result = await getMessagesBatched("token", "c", ids, { fetch: mock, batchSize: 50, maxRetries: 1, retryDelayMs: 1 });
        assert.strictEqual(result.complete, false);
        assert.deepStrictEqual(result.unexpectedIds, ["zzz"]);
      }
    });
    tests.push({
      name: "no `data` wrapper (response is the map directly) — still parsed",
      fn: async function() {
        var ids = ["a"];
        var mock = makeMockFetch([
          { match: function() { return true; },
            data: { a: makeMessage("a") } } // note: no {data: ...} wrapper
        ]);
        var result = await getMessagesBatched("token", "c", ids, { fetch: mock, batchSize: 50, maxRetries: 1, retryDelayMs: 1 });
        assert.strictEqual(result.complete, true);
        assert.strictEqual(result.returnedIds.length, 1);
      }
    });
  });

  describe("getMessagesBatched — original ID order preservation", function() {
    tests.push({
      name: "API returns messages in scrambled key order; requestedIds order preserved",
      fn: async function() {
        var ids = ["m1","m2","m3","m4","m5","m6"];
        var mock = makeMockFetch([
          { match: function() { return true; },
            // API returns in arbitrary order
            data: { data: {
              m5: makeMessage("m5"),
              m3: makeMessage("m3"),
              m1: makeMessage("m1"),
              m6: makeMessage("m6"),
              m2: makeMessage("m2"),
              m4: makeMessage("m4")
            } } }
        ]);
        var result = await getMessagesBatched("token", "c", ids, { fetch: mock, batchSize: 50, maxRetries: 1, retryDelayMs: 1 });
        assert.deepStrictEqual(result.requestedIds, ids);
        assert.strictEqual(result.complete, true);
      }
    });
  });

  describe("getMessagesBatched — large/long-conversation stress", function() {
    tests.push({
      name: "200 messages, batch=50, all returned — 4 batches, complete=true",
      fn: async function() {
        var ids = [];
        for (var i = 0; i < 200; i++) ids.push("m" + i);
        var mock = makeMockFetch([
          // persistent: this route matches every batch request, returning the
          // full 200-message map each time (the merging layer dedupes).
          { match: function() { return true; }, persistent: true,
            data: (function() {
              var d = {};
              for (var j = 0; j < 200; j++) d["m" + j] = makeMessage("m" + j);
              return { data: d };
            })() }
        ]);
        var result = await getMessagesBatched("token", "c", ids, { fetch: mock, batchSize: 50, maxRetries: 1, retryDelayMs: 1 });
        assert.strictEqual(result.complete, true);
        assert.strictEqual(result.requestedIds.length, 200);
        assert.strictEqual(result.returnedIds.length, 200);
        // 4 batches requested
        assert.strictEqual(mock.callLog.length, 4);
      }
    });
    tests.push({
      name: "long content_blocks + long reasoning — JSON serializes correctly via parent flow",
      fn: async function() {
        var ids = ["a"];
        var bigText = "x".repeat(100000);
        var mock = makeMockFetch([
          { match: function() { return true; },
            data: { data: {
              a: {
                id: "a", role: "assistant",
                content: null,
                content_blocks: [
                  { type: "reasoning", content: bigText },
                  { type: "text", content: bigText }
                ],
                timestamp: 1700000000,
                model: "GLM-5",
                usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
                done: true
              }
            } } }
        ]);
        var result = await getMessagesBatched("token", "c", ids, { fetch: mock, batchSize: 50, maxRetries: 1, retryDelayMs: 1 });
        assert.strictEqual(result.complete, true);
        var msg = result.messages.a;
        // Sanity: message object survived intact.
        assert.strictEqual(msg.content_blocks.length, 2);
        assert.strictEqual(msg.content_blocks[0].content.length, 100000);
      }
    });
  });

  return tests;
}

module.exports = { run: run };
