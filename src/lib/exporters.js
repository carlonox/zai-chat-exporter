// Three exporters, three use cases:
// - JSON: lossless backup. Everything goes in here. Messages are kept in
//   their original array order — the archive must reflect what the API
//   actually returned, not a presentation reordering.
// - Markdown: human-readable. Messages are reordered by
//   buildConversationOrder() so the conversation reads top-to-bottom.
// - Plain Text: raw and simple. Same reordering as Markdown.
//
// CommonJS so it can be require()-d from Node tests. esbuild still bundles
// these for the browser build (it handles ESM→CJS interop transparently).

var order = require("./order.js");
var buildConversationOrder = order.buildConversationOrder;

// --- Message body extraction -------------------------------------------------

// Block types we explicitly DO NOT treat as final-answer text.
// Anything not in this list is considered "answer-like" and will be included
// by extractMessageBody(). This is intentionally a small, conservative list —
// when in doubt we err on the side of including text rather than dropping
// content the user wants to see.
var NON_ANSWER_BLOCK_TYPES = {
  // reasoning / chain-of-thought
  "reasoning": true,
  "thinking": true,
  "thought": true,
  "reflection": true,
  "plan": true,
  // tool calls (Anthropic/OpenAI style)
  "tool_use": true,
  "tool_result": true,
  "tool_call": true,
  "function_call": true,
  "function": true,
  // non-text media
  "image": true,
  "image_url": true,
  "file": true,
  "audio": true,
  "video": true,
  // meta / system / errors
  "system": true,
  "error": true,
  "metadata": true
};

// Read a single block's textual payload, tolerating several field shapes.
// Returns "" if no usable string was found.
function _readBlockText(block) {
  if (!block || typeof block !== "object") return "";
  // Common field names seen in various providers' content-block schemas.
  var v = (block.content !== undefined) ? block.content
        : (block.text !== undefined) ? block.text
        : (block.value !== undefined) ? block.value
        : (block.data !== undefined) ? block.data
        : "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    var parts = [];
    for (var i = 0; i < v.length; i++) {
      if (typeof v[i] === "string" && v[i].trim() !== "") {
        parts.push(v[i]);
      } else if (v[i] && typeof v[i] === "object") {
        var sub = _readBlockText(v[i]);
        if (sub) parts.push(sub);
      }
    }
    return parts.join("\n");
  }
  if (v && typeof v === "object") {
    if (typeof v.text === "string" && v.text.trim() !== "") return v.text;
    if (typeof v.content === "string" && v.content.trim() !== "") return v.content;
  }
  return "";
}

// Returns true if a block of the given type should be considered "answer text"
// (as opposed to reasoning, tool calls, images, etc.).
// Undefined/unknown types default to true — we'd rather surface mystery text
// than silently drop it.
function _isAnswerLikeBlock(type) {
  if (type === undefined || type === null) return true;
  var t = String(type).toLowerCase();
  return !NON_ANSWER_BLOCK_TYPES[t];
}

// Unified, defensive message-body extractor.
//
// Priority:
//   1. msg.content as a non-empty string.
//   2. msg.content as an array of parts (strings or {type, text/content}).
//   3. msg.content_blocks — concatenate every answer-like block's text,
//      skipping reasoning/tool/image/etc.
//   4. Truly empty -> return "" (callers decide how to mark this).
//
// IMPORTANT: this function NEVER touches reasoning, content_blocks, model,
// usage, timestamps or any other field on the input object. It is read-only.
// The JSON exporter preserves all original fields; this function only decides
// what text to show in Markdown/TXT.
function extractMessageBody(msg) {
  if (!msg || typeof msg !== "object") return "";

  // 1. msg.content as a string.
  if (typeof msg.content === "string" && msg.content.trim() !== "") {
    return msg.content;
  }

  // 2. msg.content as an array of parts.
  if (Array.isArray(msg.content)) {
    var parts = [];
    for (var i = 0; i < msg.content.length; i++) {
      var part = msg.content[i];
      if (typeof part === "string" && part.trim() !== "") {
        parts.push(part);
      } else if (part && typeof part === "object") {
        if (!_isAnswerLikeBlock(part.type)) continue;
        var t = _readBlockText(part);
        if (t) parts.push(t);
      }
    }
    if (parts.length > 0) return parts.join("\n\n");
  }

  // 3. content_blocks
  if (Array.isArray(msg.content_blocks)) {
    var blocks = msg.content_blocks;
    var texts = [];
    for (var j = 0; j < blocks.length; j++) {
      var block = blocks[j];
      if (!block || typeof block !== "object") continue;
      if (!_isAnswerLikeBlock(block.type)) continue;
      var txt = _readBlockText(block);
      if (txt) texts.push(txt);
    }
    if (texts.length > 0) return texts.join("\n\n");
  }

  // 4. Empty.
  return "";
}

// Extract reasoning text from a message — used by Markdown/TXT exporters as
// a fallback when the caller hasn't pre-populated msg.reasoning (which
// popup.js's normalizeMessage does, but raw message objects from other paths
// may not). Mirrors the normalizeMessage reasoning-extraction logic so both
// code paths agree on what counts as "the reasoning section".
function extractReasoning(msg) {
  if (!msg || typeof msg !== "object") return "";
  if (typeof msg.reasoning === "string" && msg.reasoning.trim() !== "") {
    return msg.reasoning;
  }
  if (Array.isArray(msg.content_blocks)) {
    var parts = [];
    for (var i = 0; i < msg.content_blocks.length; i++) {
      var block = msg.content_blocks[i];
      if (!block || typeof block !== "object") continue;
      var bt = block.type;
      if (bt === "reasoning" || bt === "thinking" || bt === "thought") {
        var txt = _readBlockText(block);
        if (txt) parts.push(txt);
      }
    }
    if (parts.length > 0) return parts.join("\n\n");
  }
  return "";
}

// Build the explicit placeholder shown in Markdown/TXT when a message has
// no recoverable body text. Never used inside the JSON output.
function _emptyPlaceholder(msg) {
  var id = (msg && msg.id !== undefined && msg.id !== null) ? String(msg.id) : "unknown";
  var role = (msg && msg.role !== undefined && msg.role !== null) ? String(msg.role) : "unknown";
  return "[Empty message (id: " + id + ", role: " + role + ")]";
}

// Detect "backslash-escaped HTML close tag" patterns like `\</details>` or
// `\</summary>`. This is the specific bug pattern reported by users: the
// raw API content (either msg.content or a content_block's content)
// contains a backslash immediately before an HTML close tag, producing a
// literal `\</details>` in the exported .md file.
//
// Why this happens (best hypothesis, confirmed against diagnostic tests):
// Z.ai's API (or the model itself) writes `\</tag>` to escape HTML close
// tags inside the model's own text — likely so the model's HTML-looking
// content doesn't get interpreted as structural HTML by downstream
// consumers. The exporter faithfully passes the raw bytes through, which
// is correct (preserving the archive), but the resulting .md file has
// `\</details>` floating in the prose, which looks broken to humans
// reading the raw .md text.
//
// This function returns true when the input contains the pattern, so the
// Markdown exporter can wrap such content in a fenced code block to make
// the boundary between raw model content and exporter-generated HTML
// structure visually unambiguous.
function _hasBackslashEscapedHtml(text) {
  if (typeof text !== "string" || text === "") return false;
  return /\\<\/[a-zA-Z]/.test(text);
}

// Wrap raw model content (body or reasoning) for display inside the
// Markdown export. When the content contains backslash-escaped HTML
// close tags (the bug pattern), wrap it in a fenced code block so the
// raw bytes are clearly "code/raw model content", not confused with the
// exporter's structural HTML (`<details>`, `</details>`).
//
// Plain HTML tags (e.g. the model wrote `<b>bold</b>` for emphasis)
// are NOT wrapped — that's the model's intentional formatting and
// Markdown renderers handle it correctly. Plain text reasoning is also
// not wrapped, preserving its current Markdown rendering.
//
// Returns the content suitable for direct concatenation into the Markdown
// output (with a trailing newline). Caller adds the surrounding `\n\n`.
function _wrapRawContentForMarkdown(text) {
  if (!text) return "";
  if (_hasBackslashEscapedHtml(text)) {
    return "```\n" + text + "\n```";
  }
  return text;
}

// --- Exporters ---------------------------------------------------------------

// JSON preserves all data: messages, reasoning, metadata, token usage.
// Best for: backup, migration, programmatic analysis.
function toJSON(conversations) {
  return JSON.stringify(conversations, null, 2);
}

// Markdown with collapsible <details> for reasoning sections.
// Clean enough to read directly, structured enough to navigate.
//
// Messages are reordered by buildConversationOrder() so the conversation
// reads top-to-bottom in the order a human would expect (parent → child
// traversal, timestamp fallback for ties, branches preserved as
// post-main-chain blocks). The JSON exporter does NOT reorder — the
// archive stays faithful to what the API returned.
function toMarkdown(conversations) {
  if (!conversations || conversations.length === 0) {
    return 'No conversations to export.';
  }

  var output = '';

  for (var c = 0; c < conversations.length; c++) {
    var chat = conversations[c];
    output += '# ' + (chat.title || 'Untitled Chat') + '\n\n';
    output += '**ID:** ' + chat.id + '\n';
    output += '**Created:** ' + (chat.created_at || 'Unknown') + '\n';
    output += '**Updated:** ' + (chat.updated_at || 'Unknown') + '\n';
    output += '**Type:** ' + (chat.type || 'default') + '\n\n';
    output += '---\n\n';

    if (!chat.messages || chat.messages.length === 0) {
      output += '*This conversation has no messages.*\n\n';
      continue;
    }

    // Reorder for display. The returned `ordered` array contains indices
    // into chat.messages; we never mutate chat.messages itself.
    var orderResult = buildConversationOrder(chat.messages);
    var displayOrder = orderResult.ordered;

    // Diagnostic notes — make any non-trivial reordering visible to the
    // reader so they understand why the order doesn't match what they
    // see in chat.z.ai's URL bar (and so the JSON viewer's "what would
    // change" diagnostic has a written counterpart in the Markdown).
    if (orderResult.strategy === 'parent-children') {
      output += '*Ordering: reconstructed from parent_id / children_ids relationships.*\n\n';
    } else if (orderResult.strategy === 'timestamp') {
      output += '*Ordering: sorted by timestamp (no parent/child fields available).*\n\n';
    }
    if (orderResult.branches.length > 0) {
      output += '*' + orderResult.branches.length + ' branch(es) detected — likely regenerated answers. Branches are shown after the main chain and marked with their parent message ID.*\n\n';
    }
    if (orderResult.missingParents.length > 0) {
      output += '*' + orderResult.missingParents.length + ' message(s) referenced a parent_id that is not in this chat; treated as conversation root(s).*\n\n';
    }
    if (orderResult.missingTimestamps > 0 && orderResult.strategy === 'timestamp') {
      output += '*' + orderResult.missingTimestamps + ' message(s) had a missing or unparseable timestamp; kept at the end in original order.*\n\n';
    }
    if (orderResult.duplicateTimestamps.length > 0) {
      output += '*' + orderResult.duplicateTimestamps.length + ' duplicate timestamp value(s) detected; ties broken by original array order.*\n\n';
    }
    if (orderResult.duplicateIds.length > 0) {
      output += '*' + orderResult.duplicateIds.length + ' duplicate message ID(s) detected; later occurrences appended at the end.*\n\n';
    }

    // Map original index -> branch info so we can render a marker at the
    // start of each branch block.
    var branchByStart = {};
    for (var bi = 0; bi < orderResult.branches.length; bi++) {
      branchByStart[orderResult.branches[bi].branchIndex] = orderResult.branches[bi];
    }

    for (var m = 0; m < displayOrder.length; m++) {
      var origIdx = displayOrder[m];
      var msg = chat.messages[origIdx];
      var branchInfo = branchByStart[origIdx];

      // Branch marker — clearly separates a regenerated answer from the
      // main conversation flow.
      if (branchInfo) {
        output += '> *Branch from message ID `' + branchInfo.parentId + '` (regenerated / alternative turn)*\n\n';
      }

      var roleLabel = msg.role === 'user' ? 'User' :
                      msg.role === 'assistant' ? 'Assistant' :
                      msg.role;
      // Include the original array index in the timestamp slot so a reader
      // can correlate the Markdown with the JSON's raw order if needed.
      var timestamp = msg.timestamp ? ' (' + msg.timestamp + ')' : '';
      var indexLabel = ' [#' + origIdx + ']';
      output += '### ' + roleLabel + timestamp + indexLabel + '\n\n';

      if (msg.model) {
        output += '*Model: ' + msg.model + '*\n\n';
      }

      var body = extractMessageBody(msg);
      var bodyText = (body !== '' ? body : _emptyPlaceholder(msg));
      output += _wrapRawContentForMarkdown(bodyText) + '\n\n';

      var reasoning = extractReasoning(msg);
      if (reasoning) {
        output += '<details>\n<summary>Reasoning</summary>\n\n';
        output += _wrapRawContentForMarkdown(reasoning) + '\n\n';
        output += '</details>\n\n';
      }

      if (msg.usage) {
        output += '*Tokens: ' + (msg.usage.prompt_tokens || 0) + ' in, ' + (msg.usage.completion_tokens || 0) + ' out (total ' + (msg.usage.total_tokens || 0) + ')*\n\n';
      }

      output += '---\n\n';
    }

    output += '\n\n';
  }

  return output;
}

// No formatting, no metadata, just messages.
// Useful for quick copy-paste or feeding into another tool.
// Uses the same reordering as Markdown so the two never disagree.
function toPlainText(conversations) {
  if (!conversations || conversations.length === 0) {
    return 'No conversations to export.';
  }

  var output = '';

  for (var c = 0; c < conversations.length; c++) {
    var chat = conversations[c];
    output += '== ' + (chat.title || 'Untitled Chat') + ' ==\n';
    output += 'ID: ' + chat.id + '\n';
    output += 'Created: ' + (chat.created_at || 'Unknown') + '\n';
    output += 'Updated: ' + (chat.updated_at || 'Unknown') + '\n';
    output += 'Type: ' + (chat.type || 'default') + '\n\n';

    if (!chat.messages || chat.messages.length === 0) {
      output += 'No messages.\n\n';
      continue;
    }

    var orderResult2 = buildConversationOrder(chat.messages);
    var displayOrder2 = orderResult2.ordered;
    var branchByStart2 = {};
    for (var bi2 = 0; bi2 < orderResult2.branches.length; bi2++) {
      branchByStart2[orderResult2.branches[bi2].branchIndex] = orderResult2.branches[bi2];
    }

    for (var m = 0; m < displayOrder2.length; m++) {
      var origIdx2 = displayOrder2[m];
      var msg2 = chat.messages[origIdx2];
      var branchInfo2 = branchByStart2[origIdx2];
      if (branchInfo2) {
        output += '  [branch from ' + branchInfo2.parentId + ']\n';
      }
      var roleLabel2 = msg2.role === 'user' ? 'User' :
                      msg2.role === 'assistant' ? 'Assistant' :
                      msg2.role;
      var timestamp2 = msg2.timestamp ? ' [' + msg2.timestamp + ']' : '';
      var indexLabel2 = ' [#' + origIdx2 + ']';
      output += roleLabel2 + timestamp2 + indexLabel2 + ':\n';
      var body2 = extractMessageBody(msg2);
      var body2Text = (body2 !== '' ? body2 : _emptyPlaceholder(msg2));
      output += _wrapRawContentForMarkdown(body2Text) + '\n\n';
    }

    output += '\n\n';
  }

  return output;
}

var EXPORTERS = {
  json: {
    name: 'JSON',
    extension: '.json',
    mimeType: 'application/json',
    exporter: toJSON
  },
  markdown: {
    name: 'Markdown',
    extension: '.md',
    mimeType: 'text/markdown',
    exporter: toMarkdown
  },
  txt: {
    name: 'Plain Text',
    extension: '.txt',
    mimeType: 'text/plain',
    exporter: toPlainText
  }
};

// Creates a Blob, generates a temp link, triggers the download, cleans up.
// The browser handles the actual "Save As" dialog.
function downloadExport(data, format, filename) {
  var exporter = EXPORTERS[format];
  if (!exporter) {
    throw new Error('Unknown format: ' + format);
  }

  var content;
  if (typeof data === 'object' && format === 'json') {
    content = JSON.stringify(data, null, 2);
  } else if (typeof data === 'string') {
    content = data;
  } else {
    content = exporter.exporter(data);
  }

  var blob = new Blob([content], { type: exporter.mimeType });
  var url = URL.createObjectURL(blob);

  var link = document.createElement('a');
  link.href = url;
  link.download = filename + exporter.extension;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

module.exports = {
  toJSON: toJSON,
  toMarkdown: toMarkdown,
  toPlainText: toPlainText,
  extractMessageBody: extractMessageBody,
  extractReasoning: extractReasoning,
  _wrapRawContentForMarkdown: _wrapRawContentForMarkdown,
  _hasBackslashEscapedHtml: _hasBackslashEscapedHtml,
  EXPORTERS: EXPORTERS,
  downloadExport: downloadExport
};
