// Tests for extractMessageBody — the unified body extraction function.
//
// Covers all the message-shape variants we expect to see from Z.ai's batch
// endpoint, plus defensive handling of malformed/empty messages.
var { extractMessageBody } = require("../src/lib/exporters.js");

function run(describe, assert) {
  var tests = [];

  describe("extractMessageBody — content as string", function() {
    tests.push({
      name: "returns string content when msg.content is a non-empty string",
      fn: function() {
        var msg = { content: "hello world" };
        assert.strictEqual(extractMessageBody(msg), "hello world");
      }
    });
    tests.push({
      name: "returns trimmed-only string (does not pad empty strings)",
      fn: function() {
        var msg = { content: "   spaced   " };
        assert.strictEqual(extractMessageBody(msg), "   spaced   ");
      }
    });
    tests.push({
      name: "treats whitespace-only content as empty (falls through to blocks)",
      fn: function() {
        var msg = { content: "   \t\n  ", content_blocks: [{ type: "text", content: "from-block" }] };
        assert.strictEqual(extractMessageBody(msg), "from-block");
      }
    });
  });

  describe("extractMessageBody — Agent mode, content_blocks", function() {
    tests.push({
      name: "Agent: content empty, body in content_blocks[type=text]",
      fn: function() {
        var msg = { content: null, content_blocks: [
          { type: "text", content: "Final answer here" }
        ]};
        assert.strictEqual(extractMessageBody(msg), "Final answer here");
      }
    });
    tests.push({
      name: "Agent: content_blocks use 'text' field instead of 'content'",
      fn: function() {
        var msg = { content: "", content_blocks: [
          { type: "text", text: "answer-via-text-field" }
        ]};
        assert.strictEqual(extractMessageBody(msg), "answer-via-text-field");
      }
    });
    tests.push({
      name: "Agent: multiple text blocks get joined with double-newline",
      fn: function() {
        var msg = { content: null, content_blocks: [
          { type: "text", content: "Para 1" },
          { type: "text", content: "Para 2" }
        ]};
        assert.strictEqual(extractMessageBody(msg), "Para 1\n\nPara 2");
      }
    });
    tests.push({
      name: "Agent: reasoning block is NOT included in body",
      fn: function() {
        var msg = { content: null, content_blocks: [
          { type: "reasoning", content: "thinking..." },
          { type: "text", content: "Final answer" }
        ]};
        assert.strictEqual(extractMessageBody(msg), "Final answer");
      }
    });
    tests.push({
      name: "Agent: reasoning + text + tool_use — only text shown",
      fn: function() {
        var msg = { content: null, content_blocks: [
          { type: "reasoning", content: "let me think" },
          { type: "tool_use", content: "{ \"name\": \"search\" }" },
          { type: "tool_result", content: "search results..." },
          { type: "text", content: "Here is the answer." }
        ]};
        assert.strictEqual(extractMessageBody(msg), "Here is the answer.");
      }
    });
    tests.push({
      name: "Agent: blocks without 'type' field are treated as text (conservative)",
      fn: function() {
        var msg = { content: null, content_blocks: [
          { content: "no type field" }
        ]};
        assert.strictEqual(extractMessageBody(msg), "no type field");
      }
    });
    tests.push({
      name: "Agent: blocks with unknown type are treated as text",
      fn: function() {
        var msg = { content: null, content_blocks: [
          { type: "answer", content: "future-block-type" }
        ]};
        assert.strictEqual(extractMessageBody(msg), "future-block-type");
      }
    });
    tests.push({
      name: "Agent: content array shape (OpenAI-style content parts)",
      fn: function() {
        var msg = { content: [
          { type: "text", text: "Part 1" },
          { type: "text", text: "Part 2" }
        ]};
        assert.strictEqual(extractMessageBody(msg), "Part 1\n\nPart 2");
      }
    });
    tests.push({
      name: "Agent: content array of plain strings",
      fn: function() {
        var msg = { content: ["alpha", "beta"] };
        assert.strictEqual(extractMessageBody(msg), "alpha\n\nbeta");
      }
    });
  });

  describe("extractMessageBody — reasoning + final answer both present", function() {
    tests.push({
      name: "msg.content is set, content_blocks also has reasoning — content wins",
      fn: function() {
        var msg = { content: "the answer", content_blocks: [
          { type: "reasoning", content: "thinking" }
        ]};
        assert.strictEqual(extractMessageBody(msg), "the answer");
      }
    });
    tests.push({
      name: "msg.content is null, content_blocks has reasoning + answer — only answer extracted",
      fn: function() {
        var msg = { content: null, content_blocks: [
          { type: "reasoning", content: "step 1: ..." },
          { type: "reasoning", content: "step 2: ..." },
          { type: "text", content: "Final answer" }
        ]};
        assert.strictEqual(extractMessageBody(msg), "Final answer");
      }
    });
  });

  describe("extractMessageBody — truly empty messages", function() {
    tests.push({
      name: "empty object returns empty string",
      fn: function() {
        assert.strictEqual(extractMessageBody({}), "");
      }
    });
    tests.push({
      name: "null returns empty string",
      fn: function() {
        assert.strictEqual(extractMessageBody(null), "");
      }
    });
    tests.push({
      name: "content null + empty content_blocks returns empty string",
      fn: function() {
        assert.strictEqual(extractMessageBody({ content: null, content_blocks: [] }), "");
      }
    });
    tests.push({
      name: "content_blocks contains only reasoning blocks returns empty string",
      fn: function() {
        var msg = { content: null, content_blocks: [
          { type: "reasoning", content: "only thinking" }
        ]};
        assert.strictEqual(extractMessageBody(msg), "");
      }
    });
    tests.push({
      name: "content_blocks contains only tool calls returns empty string",
      fn: function() {
        var msg = { content: null, content_blocks: [
          { type: "tool_use", content: "{}" },
          { type: "tool_result", content: "result" }
        ]};
        assert.strictEqual(extractMessageBody(msg), "");
      }
    });
    tests.push({
      name: "does NOT mutate the input message",
      fn: function() {
        var msg = { content: null, content_blocks: [
          { type: "reasoning", content: "thinking" },
          { type: "text", content: "answer" }
        ]};
        var snapshot = JSON.stringify(msg);
        extractMessageBody(msg);
        assert.strictEqual(JSON.stringify(msg), snapshot);
      }
    });
  });

  describe("extractMessageBody — malformed/edge cases", function() {
    tests.push({
      name: "content_blocks with non-object items (skip silently)",
      fn: function() {
        var msg = { content: null, content_blocks: [null, "stray", 42, { type: "text", content: "ok" }] };
        assert.strictEqual(extractMessageBody(msg), "ok");
      }
    });
    tests.push({
      name: "content_blocks with deeply nested content arrays",
      fn: function() {
        var msg = { content: null, content_blocks: [
          { type: "text", content: ["a", "b", "c"] }
        ]};
        assert.strictEqual(extractMessageBody(msg), "a\nb\nc");
      }
    });
    tests.push({
      name: "content_blocks with nested {text: ...} shape",
      fn: function() {
        var msg = { content: null, content_blocks: [
          { type: "text", content: { text: "nested-text-field" } }
        ]};
        assert.strictEqual(extractMessageBody(msg), "nested-text-field");
      }
    });
    tests.push({
      name: "image blocks are excluded",
      fn: function() {
        var msg = { content: null, content_blocks: [
          { type: "image_url", content: "http://example.com/x.png" },
          { type: "text", content: "with image" }
        ]};
        assert.strictEqual(extractMessageBody(msg), "with image");
      }
    });
    tests.push({
      name: "handles content_blocks where .content is a number (not string)",
      fn: function() {
        var msg = { content: null, content_blocks: [
          { type: "text", content: 42 }
        ]};
        assert.strictEqual(extractMessageBody(msg), "");
      }
    });
  });

  return tests;
}

module.exports = { run: run };
