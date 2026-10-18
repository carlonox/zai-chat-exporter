# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.2] - 2026-10-18

### Fixed
- **Agent mode empty Markdown replies**: when a Z.ai Agent message stored its
  final answer in `content_blocks` (with `msg.content` empty/null), the
  Markdown and Plain Text exporters fell back to `[Empty message]` even
  though the answer was present in the JSON. A new unified
  `extractMessageBody()` function now reads the body from `content_blocks`
  (and from OpenAI-style array `content`) when `msg.content` is empty.
- **Markdown/TXT reasoning missing on raw messages**: when the caller passed
  a raw message whose `reasoning` field had not been pre-populated, the
  Markdown `<details>` block was dropped. `extractReasoning()` now reads
  reasoning from `content_blocks` (type `reasoning`/`thinking`/`thought`)
  as a fallback. JSON output is unchanged.
- **Long-conversation JSON truncation**: the original `getMessagesBatch()`
  sent all message IDs in a single POST body, risking server-side body-size
  limits, gateway timeouts, and silent partial responses. The new
  `getMessagesBatched()` chunks IDs (default 50 per batch), retries failed
  batches with exponential backoff (max 3 attempts), and reports missing /
  duplicate / unexpected IDs. popup.js and select.js now use the new
  function and rebuild the messages array in the **original** ID order
  (instead of relying on `Object.values()` key-order).
- **Silent partial exports**: a chat that comes back incomplete now
  surfaces an explicit error in the popup status ("BUT N chat(s) had M
  missing message(s)"), logs the missing IDs to the console, and — if the
  user still chooses to download — fills the missing slots with explicit
  `{ _export_status: "missing" }` markers in the JSON so the holes are
  visible rather than silently dropped.

### Added
- `extractMessageBody()` / `extractReasoning()` unified helpers in
  `src/lib/exporters.js`. Markdown and Plain Text now share a single body
  extraction code path so they can never disagree.
- `getMessagesBatched()` in `src/lib/api.js` with chunking, retry,
  dedup, ordering, and missing-ID diagnostics. The original
  `getMessagesBatch()` is preserved as a backward-compatible wrapper.
- New `tests/` directory with a lightweight, dependency-free test runner
  (`tests/run.js`) plus 73 tests covering all 10 required scenarios:
  short chats, Agent body in content_blocks, reasoning + final answer,
  batched fetching, order preservation, retry-then-success,
  permanent failure with incomplete report, missing/duplicate IDs,
  empty/malformed messages, and long-message JSON serialization.
- `npm test` script.

### Changed
- `src/lib/api.js`, `src/lib/exporters.js`, `src/lib/utils.js` converted
  from ESM `export` syntax to CommonJS `module.exports` so they can be
  unit-tested under plain Node without a bundler. esbuild still bundles
  them transparently for the browser build (it handles ESM→CJS interop).
- `src/popup/popup.js` and `src/select/select.js` refactored to use the
  shared lib functions instead of inlining their own copy of the
  Markdown/TXT/normalization logic. select.js no longer ships a duplicate
  toMarkdown/toPlainText implementation, eliminating drift between the two
  export paths.

### Notes
- JSON exports remain structurally identical to 1.0.1 — no fields are
  renamed, dropped, or added except for an optional `_export_status`
  field on messages that could not be fetched. All original metadata
  (reasoning, content_blocks, timestamps, model, usage, done) is
  preserved.

## [1.0.0] - 2026-07-03

### Added
- Initial release
- Export to JSON, Markdown, and Plain Text
- Chat selection: last conversation, recent N (configurable), all conversations, current open chat, and specific selection with checkboxes
- Options to include/exclude reasoning, metadata, and raw data
- Search and filter in the selection window
- Firefox and Edge/Chrome support
- Full API integration with Z.ai's internal endpoints
- User-friendly popup interface

### Known issues
- Exporting "all conversations" may take a while for users with hundreds of chats
- The "current open chat" option requires the page to be fully loaded
