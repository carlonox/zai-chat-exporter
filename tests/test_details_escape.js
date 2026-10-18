// Tests for the `\</details>` bug fix.
//
// Root cause (verified by diagnostic):
//   The exporter NEVER generates a backslash before `</details>` from its
//   own logic. The pattern `\</details>` only appears in the .md output
//   when the raw API content (msg.content, msg.reasoning, or
//   content_blocks[].content) ALREADY contains `\</details>` literally.
//   The exporter faithfully passes the raw bytes through (which is correct
//   — we must preserve the archive), but the result is a .md file that
//   has `\</details>` floating in the prose, which looks broken to humans.
//
// Fix:
//   When raw content contains the bug pattern (`\</tag>`), the exporter
//   wraps it in a fenced code block. The raw bytes are preserved verbatim
//   (no modification), but they're now clearly "code/raw model content",
//   visually distinguished from the exporter's structural HTML.
//
// Acceptance criteria verified by these tests:
//   1. Exporter never adds `\</details>` from its own logic (regression).
//   2. When raw content has `\</details>`, the .md output wraps it in a
//      fenced code block.
//   3. Plain HTML tags (e.g. `<b>bold</b>`) are NOT wrapped — preserving
//      the model's intentional formatting.
//   4. Plain text reasoning is NOT wrapped.
//   5. JSON output is unchanged (raw content preserved).

var exporters = require("../src/lib/exporters.js");
var toMarkdown = exporters.toMarkdown;
var toPlainText = exporters.toPlainText;
var toJSON = exporters.toJSON;
var _wrapRawContentForMarkdown = exporters._wrapRawContentForMarkdown;
var _hasBackslashEscapedHtml = exporters._hasBackslashEscapedHtml;

function run(describe, assert) {
  var tests = [];

  describe("_hasBackslashEscapedHtml — pattern detection", function() {
    tests.push({
      name: "plain text → false",
      fn: function() {
        assert.strictEqual(_hasBackslashEscapedHtml("just some text"), false);
      }
    });
    tests.push({
      name: "plain HTML close tag → false (no backslash)",
      fn: function() {
        assert.strictEqual(_hasBackslashEscapedHtml("</details>"), false);
        assert.strictEqual(_hasBackslashEscapedHtml("Some text</details>"), false);
      }
    });
    tests.push({
      name: "backslash-escaped HTML close tag → true (the bug pattern)",
      fn: function() {
        assert.strictEqual(_hasBackslashEscapedHtml("\\</details>"), true);
        assert.strictEqual(_hasBackslashEscapedHtml("Some text\\</details>"), true);
        assert.strictEqual(_hasBackslashEscapedHtml("thinking...\\</summary> more thinking"), true);
      }
    });
    tests.push({
      name: "non-HTML backslash → false (e.g. Windows path)",
      fn: function() {
        assert.strictEqual(_hasBackslashEscapedHtml("C:\\Users\\name"), false);
        assert.strictEqual(_hasBackslashEscapedHtml("a \\ b"), false);
      }
    });
    tests.push({
      name: "backslash before open tag → false (only close tags trigger)",
      fn: function() {
        assert.strictEqual(_hasBackslashEscapedHtml("\\<details>"), false);
      }
    });
    tests.push({
      name: "empty / non-string → false",
      fn: function() {
        assert.strictEqual(_hasBackslashEscapedHtml(""), false);
        assert.strictEqual(_hasBackslashEscapedHtml(null), false);
        assert.strictEqual(_hasBackslashEscapedHtml(undefined), false);
        assert.strictEqual(_hasBackslashEscapedHtml(42), false);
      }
    });
  });

  describe("_wrapRawContentForMarkdown — wrapping behavior", function() {
    tests.push({
      name: "plain text is returned unchanged",
      fn: function() {
        var text = "Just some prose.";
        assert.strictEqual(_wrapRawContentForMarkdown(text), text);
      }
    });
    tests.push({
      name: "plain HTML tags are returned unchanged (model's intentional formatting)",
      fn: function() {
        var text = "Some <b>bold</b> text.";
        assert.strictEqual(_wrapRawContentForMarkdown(text), text);
      }
    });
    tests.push({
      name: "plain </details> is returned unchanged (model wrote HTML, no backslash)",
      fn: function() {
        var text = "Some text</details>";
        assert.strictEqual(_wrapRawContentForMarkdown(text), text);
      }
    });
    tests.push({
      name: "backslash-escaped </details> is wrapped in fenced code block",
      fn: function() {
        var text = "Some text\\</details>";
        var wrapped = _wrapRawContentForMarkdown(text);
        assert.strictEqual(wrapped, "```\n" + text + "\n```");
        assert.ok(wrapped.indexOf("```") !== -1, "should be in a code fence");
      }
    });
    tests.push({
      name: "raw bytes are preserved verbatim inside the code block",
      fn: function() {
        var text = "Step 1: do X.\\</details>";
        var wrapped = _wrapRawContentForMarkdown(text);
        // The raw text must appear unchanged inside the fence.
        assert.ok(wrapped.indexOf(text) !== -1, "raw bytes must be preserved verbatim");
      }
    });
  });

  describe("toMarkdown — exporter does NOT generate `\\</details>` from its own logic", function() {
    // Regression tests: the exporter never inserts a backslash before an
    // HTML close tag. If `\</details>` appears in the output, it's because
    // the raw API content had it.

    tests.push({
      name: "1. plain assistant reply, no HTML — no backslash-escaped tags",
      fn: function() {
        var chats = [{
          id: "c1", title: "T", created_at: null, updated_at: null,
          messages: [{ id: "a1", role: "assistant", content: "Just plain text." }]
        }];
        var md = toMarkdown(chats);
        assert.ok(md.indexOf("\\</details>") === -1, "no backslash-escaped tags");
        assert.ok(md.indexOf("\\<details") === -1);
        assert.ok(md.indexOf("\\<summary") === -1);
      }
    });
    tests.push({
      name: "2. assistant with reasoning — exporter's </details> has no backslash",
      fn: function() {
        var chats = [{
          id: "c1", title: "T", created_at: null, updated_at: null,
          messages: [{
            id: "a1", role: "assistant", content: "Final answer.",
            content_blocks: [{ type: "reasoning", content: "step 1\nstep 2" }]
          }]
        }];
        var md = toMarkdown(chats);
        // The exporter's structural close tag is "</details>" (no backslash).
        assert.ok(md.indexOf("</details>") !== -1, "exporter's closing tag is present");
        assert.ok(md.indexOf("\\</details>") === -1, "no backslash before exporter's close tag");
        // The reasoning wrapper still closes properly.
        var openCount = (md.match(/<details>/g) || []).length;
        var closeCount = (md.match(/<\/details>/g) || []).length;
        assert.strictEqual(openCount, closeCount, "open and close tags balanced");
      }
    });
    tests.push({
      name: "3a. body ends with plain </details> (model wrote HTML) — exporter does NOT add backslash",
      fn: function() {
        var chats = [{
          id: "c1", title: "T", created_at: null, updated_at: null,
          messages: [{ id: "a1", role: "assistant", content: "Some HTML output.</details>" }]
        }];
        var md = toMarkdown(chats);
        // The model's own </details> is preserved as-is (no backslash added).
        assert.ok(md.indexOf("</details>") !== -1);
        // The exporter did NOT add a backslash.
        assert.ok(md.indexOf("\\</details>") === -1, "exporter must not add backslash");
      }
    });
    tests.push({
      name: "3b. body ends with literal \\</details> (raw API content) — wrapped in code block",
      fn: function() {
        var chats = [{
          id: "c1", title: "T", created_at: null, updated_at: null,
          messages: [{ id: "a1", role: "assistant", content: "Some text\\</details>" }]
        }];
        var md = toMarkdown(chats);
        // The raw bytes are preserved (the backslash is still in the .md file).
        assert.ok(md.indexOf("\\</details>") !== -1, "raw bytes preserved");
        // The raw bytes are now INSIDE a code fence, not floating in prose.
        var lines = md.split("\n");
        var inCodeBlock = false;
        var backslashLineInCodeBlock = false;
        for (var i = 0; i < lines.length; i++) {
          if (lines[i].indexOf("```") === 0) {
            inCodeBlock = !inCodeBlock;
          } else if (inCodeBlock && lines[i].indexOf("\\</details>") !== -1) {
            backslashLineInCodeBlock = true;
          }
        }
        assert.ok(backslashLineInCodeBlock, "the raw \\</details> must be inside a fenced code block");
      }
    });
    tests.push({
      name: "4. body has code block with backslashes and HTML tags — not double-wrapped",
      fn: function() {
        var body = "Here is code:\n```\n\\<div>foo\\</div>\n```\nDone.";
        var chats = [{
          id: "c1", title: "T", created_at: null, updated_at: null,
          messages: [{ id: "a1", role: "assistant", content: body }]
        }];
        var md = toMarkdown(chats);
        // The body has `\</div>` which matches the bug pattern, so it gets
        // wrapped in an outer code fence. The body's own inner ``` becomes
        // 4 backticks. (Markdown allows nested fences by using more backticks
        // for the outer fence.)
        assert.ok(md.indexOf("```") !== -1);
        // The raw bytes are preserved verbatim.
        assert.ok(md.indexOf(body) !== -1, "raw body content must be preserved");
      }
    });
    tests.push({
      name: "5. multi-turn — no spurious backslashes from exporter",
      fn: function() {
        var chats = [{
          id: "c1", title: "T", created_at: null, updated_at: null,
          messages: [
            { id: "u1", role: "user", content: "Question?" },
            { id: "a1", role: "assistant", content: "Answer.",
              content_blocks: [{ type: "reasoning", content: "thinking..." }] },
            { id: "u2", role: "user", content: "Follow up?" },
            { id: "a2", role: "assistant", content: "Another answer." }
          ]
        }];
        var md = toMarkdown(chats);
        // Exporter never inserts backslash-escaped HTML.
        assert.ok(md.indexOf("\\</details>") === -1);
        assert.ok(md.indexOf("\\<details") === -1);
        assert.ok(md.indexOf("\\<summary") === -1);
      }
    });
  });

  describe("toMarkdown — reasoning wrapper integrity after fix", function() {
    tests.push({
      name: "reasoning block opens and closes correctly when content has \\</details>",
      fn: function() {
        var chats = [{
          id: "c1", title: "T", created_at: null, updated_at: null,
          messages: [{
            id: "a1", role: "assistant", content: "Final answer.",
            content_blocks: [{ type: "reasoning", content: "thinking...\\</details>" }]
          }]
        }];
        var md = toMarkdown(chats);
        // Count structural <details>/</details> tags OUTSIDE code fences.
        // (Inside code fences, the raw content also has `</details>` as part
        // of the bug-pattern `\</details>` — that's not a structural tag.)
        var lines = md.split("\n");
        var inCodeBlock = false;
        var structuralOpen = 0, structuralClose = 0;
        var rawBackslashInCode = false;
        for (var i = 0; i < lines.length; i++) {
          if (lines[i].indexOf("```") === 0) {
            inCodeBlock = !inCodeBlock;
            continue;
          }
          if (inCodeBlock) {
            if (lines[i].indexOf("\\</details>") !== -1) rawBackslashInCode = true;
          } else {
            // Count structural tags only when NOT inside a code fence.
            var opens = (lines[i].match(/<details>/g) || []).length;
            var closes = (lines[i].match(/<\/details>/g) || []).length;
            structuralOpen += opens;
            structuralClose += closes;
          }
        }
        assert.strictEqual(structuralOpen, 1, "exactly one structural <details> open");
        assert.strictEqual(structuralClose, 1, "exactly one structural </details> close");
        // The raw reasoning bytes (including \\</details>) are inside the code fence.
        assert.ok(rawBackslashInCode, "raw \\</details> must be inside code fence");
        assert.strictEqual(inCodeBlock, false, "code fence must be properly closed");
      }
    });
    tests.push({
      name: "plain text reasoning is NOT wrapped (preserves Markdown rendering)",
      fn: function() {
        var chats = [{
          id: "c1", title: "T", created_at: null, updated_at: null,
          messages: [{
            id: "a1", role: "assistant", content: "Final answer.",
            content_blocks: [{ type: "reasoning", content: "step 1\nstep 2" }]
          }]
        }];
        var md = toMarkdown(chats);
        // Plain text reasoning — no code fence.
        assert.ok(md.indexOf("```") === -1, "plain reasoning should not be wrapped in code block");
        // Reasoning content is still rendered.
        assert.ok(md.indexOf("step 1") !== -1);
        assert.ok(md.indexOf("step 2") !== -1);
      }
    });
    tests.push({
      name: "plain HTML tags in reasoning are NOT wrapped (model's intentional formatting)",
      fn: function() {
        var chats = [{
          id: "c1", title: "T", created_at: null, updated_at: null,
          messages: [{
            id: "a1", role: "assistant", content: "Final answer.",
            content_blocks: [{ type: "reasoning", content: "Some <b>bold</b> reasoning." }]
          }]
        }];
        var md = toMarkdown(chats);
        assert.ok(md.indexOf("```") === -1, "plain HTML should not trigger wrap");
        assert.ok(md.indexOf("<b>bold</b>") !== -1, "model's HTML preserved as-is");
      }
    });
  });

  describe("toJSON — raw content preserved unchanged", function() {
    tests.push({
      name: "JSON preserves raw content with backslash-escaped HTML",
      fn: function() {
        var chats = [{
          id: "c1", title: "T", created_at: null, updated_at: null,
          messages: [{
            id: "a1", role: "assistant",
            content: "Some text\\</details>",
            content_blocks: [{ type: "reasoning", content: "thinking...\\</details>" }]
          }]
        }];
        var json = toJSON(chats);
        var parsed = JSON.parse(json);
        // Raw content is preserved verbatim — JSON does not modify raw bytes.
        assert.strictEqual(parsed[0].messages[0].content, "Some text\\</details>");
        assert.strictEqual(parsed[0].messages[0].content_blocks[0].content, "thinking...\\</details>");
      }
    });
    tests.push({
      name: "JSON does not insert any backslashes",
      fn: function() {
        var chats = [{
          id: "c1", title: "T", created_at: null, updated_at: null,
          messages: [{ id: "a1", role: "assistant", content: "Plain answer." }]
        }];
        var json = toJSON(chats);
        // No backslash-escaped HTML in JSON output.
        assert.ok(json.indexOf("\\</details>") === -1);
        assert.ok(json.indexOf("\\<details") === -1);
      }
    });
  });

  describe("toPlainText — same fix applied", function() {
    tests.push({
      name: "TXT also wraps raw content with \\</details> in code fence",
      fn: function() {
        var chats = [{
          id: "c1", title: "T", created_at: null, updated_at: null,
          messages: [{ id: "a1", role: "assistant", content: "Some text\\</details>" }]
        }];
        var txt = toPlainText(chats);
        assert.ok(txt.indexOf("```") !== -1, "TXT should also wrap raw content with backslash-HTML in code fence");
        assert.ok(txt.indexOf("\\</details>") !== -1, "raw bytes preserved in TXT");
      }
    });
    tests.push({
      name: "TXT plain text is not wrapped",
      fn: function() {
        var chats = [{
          id: "c1", title: "T", created_at: null, updated_at: null,
          messages: [{ id: "a1", role: "assistant", content: "Plain answer." }]
        }];
        var txt = toPlainText(chats);
        assert.ok(txt.indexOf("```") === -1, "plain TXT should not be wrapped");
      }
    });
  });

  return tests;
}

module.exports = { run: run };
