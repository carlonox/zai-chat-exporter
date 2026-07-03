// Three exporters, three use cases:
// - JSON: lossless backup. Everything goes in here.
// - Markdown: human-readable. Great for sharing on GitHub or Notion.
// - Plain Text: raw and simple. Works everywhere.
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

      output += (msg.content || '[Empty message]') + '\n\n';

      if (msg.reasoning) {
        output += '<details>\n<summary>Reasoning</summary>\n\n';
        output += msg.reasoning + '\n\n';
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
      output += (msg.content || '[Empty message]') + '\n\n';
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

export { toJSON, toMarkdown, toPlainText, EXPORTERS, downloadExport };
