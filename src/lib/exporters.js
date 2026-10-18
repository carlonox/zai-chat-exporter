// Three exporters, three use cases:
// - JSON: lossless backup. Everything goes in here.
// - Markdown: human-readable. Great for sharing on GitHub or Notion.
// - Plain Text: raw and simple. Works everywhere.
//
// CommonJS so it can be require()-d from Node tests. esbuild still bundles
// these for the browser build (it handles ESM→CJS interop transparently).

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

// --- Exporters ---------------------------------------------------------------

// JSON preserves all data: messages, reasoning, metadata, token usage.
// Best for: backup, migration, programmatic analysis.
function toJSON(conversations) {
  return JSON.stringify(conversations, null, 2);
}

// Markdown with collapsible <details> for reasoning sections.
// Clean enough to read directly, structured enough to navigate.
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

    for (var m = 0; m < chat.messages.length; m++) {
      var msg = chat.messages[m];
      var roleLabel = msg.role === 'user' ? 'User' :
                      msg.role === 'assistant' ? 'Assistant' :
                      msg.role;
      var timestamp = msg.timestamp ? ' (' + msg.timestamp + ')' : '';
      output += '### ' + roleLabel + timestamp + '\n\n';

      if (msg.model) {
        output += '*Model: ' + msg.model + '*\n\n';
      }

      var body = extractMessageBody(msg);
      output += (body !== '' ? body : _emptyPlaceholder(msg)) + '\n\n';

      var reasoning = extractReasoning(msg);
      if (reasoning) {
        output += '<details>\n<summary>Reasoning</summary>\n\n';
        output += reasoning + '\n\n';
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

    for (var m = 0; m < chat.messages.length; m++) {
      var msg = chat.messages[m];
      var roleLabel = msg.role === 'user' ? 'User' :
                      msg.role === 'assistant' ? 'Assistant' :
                      msg.role;
      var timestamp = msg.timestamp ? ' [' + msg.timestamp + ']' : '';
      output += roleLabel + timestamp + ':\n';
      var body2 = extractMessageBody(msg);
      output += (body2 !== '' ? body2 : _emptyPlaceholder(msg)) + '\n\n';
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
  EXPORTERS: EXPORTERS,
  downloadExport: downloadExport
};
