// Tests for the Markdown, Plain Text, and JSON exporters.
//
// Verifies that all three use the same unified extractMessageBody() function,
// so the same message produces consistent body text in Markdown and TXT.
// Verifies that the JSON exporter does NOT insert `[Empty message]` or any
// other placeholder — it preserves the original message object untouched.
var exporters = require("../src/lib/exporters.js");
var toMarkdown = exporters.toMarkdown;
var toPlainText = exporters.toPlainText;
var toJSON = exporters.toJSON;
var extractMessageBody = exporters.extractMessageBody;

function run(describe, assert) {
  var tests = [];

  describe("toMarkdown — Agent mode (regression for empty body bug)", function() {
    tests.push({
      name: "Agent final answer in content_blocks renders body in Markdown",
      fn: function() {
        var chats = [{
          id: "c1", title: "Agent test",
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
          type: "agent",
          messages: [
            { id: "m1", role: "user", content: "do something", content_blocks: [] },
            { id: "m2", role: "assistant", content: null, content_blocks: [
              { type: "reasoning", content: "thinking..." },
              { type: "text", content: "Here is the answer." }
            ]}
          ]
        }];
        var md = toMarkdown(chats);
        // Body must be present (NOT '[Empty message]')
        assert.ok(md.indexOf("Here is the answer.") !== -1, "expected answer text in markdown, got: " + md);
        assert.ok(md.indexOf("[Empty message") === -1, "should not contain '[Empty message]' placeholder for the assistant");
        // Reasoning must still be in a <details> block
        assert.ok(md.indexOf("<details>") !== -1, "reasoning should be in a <details> block");
        assert.ok(md.indexOf("thinking...") !== -1, "reasoning text should be present");
      }
    });
    tests.push({
      name: "Plain chat short conversation — full body present",
      fn: function() {
        var chats = [{
          id: "c1", title: "Simple",
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
          messages: [
            { id: "u1", role: "user", content: "hi" },
            { id: "a1", role: "assistant", content: "hello" }
          ]
        }];
        var md = toMarkdown(chats);
        assert.ok(md.indexOf("### User") !== -1);
        assert.ok(md.indexOf("### Assistant") !== -1);
        assert.ok(md.indexOf("hi") !== -1);
        assert.ok(md.indexOf("hello") !== -1);
      }
    });
    tests.push({
      name: "reasoning + final answer both visible (markdown)",
      fn: function() {
        var chats = [{
          id: "c1", title: "R+A",
          created_at: null, updated_at: null,
          messages: [{
            id: "m1", role: "assistant",
            content: "Direct final answer",
            content_blocks: [
              { type: "reasoning", content: "internal reasoning text" }
            ]
          }]
        }];
        var md = toMarkdown(chats);
        assert.ok(md.indexOf("Direct final answer") !== -1);
        assert.ok(md.indexOf("internal reasoning text") !== -1);
      }
    });
  });

  describe("toPlainText — uses same body extraction as Markdown", function() {
    tests.push({
      name: "Agent body shows in TXT (consistent with MD)",
      fn: function() {
        var chats = [{
          id: "c1", title: "Agent test",
          created_at: null, updated_at: null,
          messages: [
            { id: "m2", role: "assistant", content: null, content_blocks: [
              { type: "reasoning", content: "thinking..." },
              { type: "text", content: "Final answer via block." }
            ]}
          ]
        }];
        var txt = toPlainText(chats);
        assert.ok(txt.indexOf("Final answer via block.") !== -1);
        assert.ok(txt.indexOf("[Empty message") === -1);
      }
    });
    tests.push({
      name: "TXT and MD produce identical body text for the same message",
      fn: function() {
        var msg = { id: "m1", role: "assistant", content: null, content_blocks: [
          { type: "reasoning", content: "skip me" },
          { type: "text", content: "shared body" }
        ]};
        assert.strictEqual(extractMessageBody(msg), "shared body");
        var chats = [{ id: "c", title: "T", created_at: null, updated_at: null, messages: [msg] }];
        var md = toMarkdown(chats);
        var txt = toPlainText(chats);
        assert.ok(md.indexOf("shared body") !== -1);
        assert.ok(txt.indexOf("shared body") !== -1);
      }
    });
  });

  describe("toJSON — preserves all fields, no placeholder injection", function() {
    tests.push({
      name: "JSON contains content_blocks, reasoning, model, usage, timestamp unchanged",
      fn: function() {
        var chats = [{
          id: "c1", title: "agent",
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
          messages: [{
            id: "m1", role: "assistant",
            content: null,
            reasoning: "the reasoning",
            content_blocks: [
              { type: "reasoning", content: "the reasoning" },
              { type: "text", content: "the answer" }
            ],
            timestamp: "2026-01-01T00:00:00.000Z",
            model: "GLM-5",
            usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
            done: true
          }]
        }];
        var json = toJSON(chats);
        var parsed = JSON.parse(json);
        var m = parsed[0].messages[0];
        assert.strictEqual(m.content, null, "content must remain null (not rewritten)");
        assert.strictEqual(m.reasoning, "the reasoning");
        assert.strictEqual(m.model, "GLM-5");
        assert.deepStrictEqual(m.usage, { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 });
        assert.strictEqual(m.done, true);
        assert.strictEqual(m.content_blocks.length, 2);
        assert.strictEqual(m.timestamp, "2026-01-01T00:00:00.000Z");
        // No placeholder text should be injected anywhere
        assert.ok(json.indexOf("[Empty message") === -1, "JSON must not contain '[Empty message]' placeholder");
      }
    });
    tests.push({
      name: "JSON preserves raw message with missing fields (no rewriting)",
      fn: function() {
        var chats = [{
          id: "c1", title: "t",
          created_at: null, updated_at: null,
          messages: [{ id: "x1", role: "user", content: "hi" }]
        }];
        var json = toJSON(chats);
        var parsed = JSON.parse(json);
        assert.deepStrictEqual(parsed[0].messages[0], { id: "x1", role: "user", content: "hi" });
      }
    });
  });

  describe("Markdown / TXT — explicit empty marker", function() {
    tests.push({
      name: "Markdown marks empty message with explicit id/role placeholder",
      fn: function() {
        var chats = [{
          id: "c1", title: "EmptyTest",
          created_at: null, updated_at: null,
          messages: [
            { id: "miss-1", role: "assistant", content: null, content_blocks: [] }
          ]
        }];
        var md = toMarkdown(chats);
        assert.ok(md.indexOf("[Empty message (id: miss-1, role: assistant)]") !== -1, "expected explicit empty placeholder, got: " + md);
      }
    });
    tests.push({
      name: "TXT marks empty message with explicit id/role placeholder",
      fn: function() {
        var chats = [{
          id: "c1", title: "EmptyTest",
          created_at: null, updated_at: null,
          messages: [
            { id: "miss-2", role: "user", content: null, content_blocks: [] }
          ]
        }];
        var txt = toPlainText(chats);
        assert.ok(txt.indexOf("[Empty message (id: miss-2, role: user)]") !== -1, "expected explicit empty placeholder, got: " + txt);
      }
    });
  });

  return tests;
}

module.exports = { run: run };
