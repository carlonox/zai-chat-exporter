# Z.ai Chat Exporter — Architecture

## Overview

Z.ai Chat Exporter is a cross-browser extension (Firefox MV2 / Chrome MV3) that lets users export their conversations from [chat.z.ai](https://chat.z.ai) into JSON, Markdown, or Plain Text.

The extension works by calling Z.ai's internal REST API directly from the browser context, authenticated with the user's existing session token stored in localStorage.

---

## Architecture Diagram

```text
┌──────────────┐     ┌──────────────────┐     ┌───────────────┐
│   Popup UI    │────▶│   Background.js   │────▶│  Content.js   │
│  (popup.html) │     │  (MV2 page/MV3   │     │ (injected in  │
│               │     │   service worker) │     │  chat.z.ai)   │
└──────┬───────┘     └──────────────────┘     └───────┬───────┘
       │                                                │
       ▼                                                ▼
┌────────────────┐                           ┌──────────────────┐
│   lib/api.js    │                           │   Z.ai REST API  │
│   lib/exporters │                           │  chat.z.ai/api/v1│
│   lib/utils.js  │                           └──────────────────┘
└────────────────┘
```

---

## Component Breakdown

### 1. Popup (src/popup/)

The popup is the main user interface. It provides:

- **Chat selection**: last, recent 20, all, current, or specific
- **Format selection**: JSON, Markdown, Plain Text
- **Option toggles**: reasoning, metadata, raw data
- **Export button**: triggers the full export pipeline

**Key decisions:**
- We use a native <select> element rather than a custom dropdown to keep the bundle lightweight and accessible.
- The popup imports from lib/api.js directly rather than routing through ackground.js because the API calls need access to the page's localStorage (for the auth token). Since the popup runs in its own extension context, it cannot directly access chat.z.ai's localStorage — that's why the "current chat" option uses chrome.tabs.query to extract the chat ID from the URL.

### 2. Background Script (src/background/)

The background script handles:

- **Install/update lifecycle**: sets default settings on first install, merges new defaults on update
- **Storage management**: reads and writes extension settings via chrome.storage.local
- **Message routing**: relays messages between popup and content script

**Why async/await over raw Promises?** It makes the code flatter and easier to reason about, especially when chaining multiple storage operations.

### 3. Content Script (src/content/)

The content script runs on chat.z.ai pages and:

- Listens for messages from the background/popup scripts
- Extracts the current chat ID from the page URL
- Detects whether a chat container is present on the page

**Why separate pi.js from content scripts?** The API module is designed to work both from the popup (for bulk operations like "all chats") and potentially from the content script. Keeping it isolated makes it testable and reusable.

### 4. Library (src/lib/)

#### pi.js — Z.ai API Client

The API client abstracts Z.ai's REST endpoints with three main functions:

| Function | Endpoint | Purpose |
|----------|----------|---------|
| getChats(page, type) | GET /chats/ | List conversations (paginated) |
| getChatDetails(chatId) | GET /chats/{id} | Get metadata + message IDs |
| getMessagesBatch(chatId, ids) | POST /chats/{id}/messages/batch | Get full message content |

**Design decisions:**
- getAllChats() handles pagination transparently — the caller doesn't need to know about page boundaries.
- The token is fetched fresh on each request rather than cached, so the extension always uses the current session.

#### exporters.js — Format Converters

Three exporters with a consistent interface:

- 	oJSON() — lossless, full data preservation
- 	oMarkdown() — human-readable with formatting
- 	oPlainText() — simple, no formatting

The EXPORTERS map allows the popup to dynamically populate the format selector and dispatch to the correct exporter without a switch statement.

#### utils.js — Utilities

General helpers that are not specific to Z.ai:

- extractChatIdFromUrl() — parses a UUID from the URL path
- ormatTimestamp() — converts Unix timestamps to locale strings
- sanitizeFilename() — produces safe filenames across OS platforms
- debounce() — utility for rate-limiting frequent calls
- isExtensionContext() — feature detection for extension APIs

---

## Data Flow

### Export Flow (e.g., "Export Recent 20 as Markdown")

1. User clicks "Export" in popup
2. popup.js calls getAllChats(1) from pi.js
3. pi.js makes GET /chats/?page=1&type=default with Bearer token
4. Response is parsed and returned as an array of 20 chat objects
5. popup.js applies filters based on checkbox options
6. popup.js calls downloadExport(chats, 'markdown', filename) from exporters.js
7. 	oMarkdown() converts the data to a formatted string
8. A Blob is created and downloaded via a temporary <a> element

### Current Chat Flow

1. Popup calls chrome.tabs.query to get the active tab URL
2. The URL is parsed with a regex to extract the chat UUID
3. getChatDetails(chatId) fetches the conversation metadata
4. Message IDs are extracted from details.chat.history.messages
5. getMessagesBatch(chatId, messageIds) fetches full content
6. Messages are normalized and returned

---


## Why esbuild?

I chose `esbuild` over Webpack because it's faster and simpler for a single-page extension. If you need to add more complex features, Webpack might be a better fit — but for now, esbuild does the job with zero config.

## Why `var` instead of `const`/`let`?

The extension targets Firefox (MV2) and Chrome/Edge (MV3). `var` is the safest choice for maximum cross-browser compatibility without transpilation. If you refactor to `const`/`let`, make sure to test in both browsers.
## Browser Compatibility

| Feature | Firefox (MV2) | Edge/Chrome (MV3) |
|---------|---------------|-------------------|
| Manifest | manifest.firefox.json | manifest.edge.json |
| Background | Persistent page | Service worker |
| Permissions | https://chat.z.ai/* in permissions | https://chat.z.ai/* in host_permissions |
| API | rowser namespace | chrome namespace |

The code uses chrome.* API consistently, which works in both Firefox (via polyfill/compat) and Chromium browsers.

---

## Security Considerations

- The Bearer token is **never** logged or exposed outside the extension
- All API calls use etch() with {credentials: 'omit'} to prevent accidental credential leakage
- The extension requests only the minimum permissions needed: access to chat.z.ai, storage, and downloads
- There is no analytics, telemetry, or external network requests beyond the Z.ai API
