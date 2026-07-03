# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
