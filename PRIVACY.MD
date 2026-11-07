# Privacy Policy — Z.ai Chat Exporter

Last updated: 2026-11-06

Z.ai Chat Exporter is a browser extension that saves your own conversations from
chat.z.ai to your device. This policy states exactly what the extension reads,
what it stores, and what it does not do.

## What the extension reads

- **Conversation content.** The messages of the conversation you choose to
  export, read from the chat.z.ai page or its API using the session you already
  have open on that site.
- **Your session token on chat.z.ai.** The extension reads the token that
  chat.z.ai stores in the page's `localStorage` and sends it as an
  authorization header to chat.z.ai only. The token is used in memory for those
  requests. It is never stored by the extension, never logged, and never sent to
  any other host.
- **Your export preferences.** Four values: whether to include reasoning,
  whether to include metadata, whether to include the raw payload, and the last
  format you used. They are saved with the browser's local storage on your
  device so the popup remembers them between sessions.

## What the extension does not do

- It does not send any data to the developer or to any third party.
- It does not run analytics, telemetry, crash reporting, or advertising.
- It does not sell, share, transfer, or disclose user data to anyone.
- It does not use user data to determine creditworthiness or for lending
  purposes.
- It does not read pages other than `https://chat.z.ai/*`.
- It does not execute remote code: everything is bundled inside the package.

## Where the data goes

Exported files are written to your device through the browser's normal download
mechanism. Their location and retention are yours to control; the extension
keeps no copy.

Removing the extension clears the four stored preferences. Your exported files
remain wherever you saved them.

## Permissions

- `storage`: keep the four preferences above.
- `https://chat.z.ai/*`: read the conversation you ask to export.

No other host or permission is requested.

## Third parties

None. The extension does not integrate with any external service, server, or
analytics provider. Your conversations never leave your browser and your device
except as files you download yourself.

## Children

The extension is not directed at children and collects no personal data from
anyone.

## Changes

If a future version changes what is read or stored, this page will be updated
before that version is published, and the change will be noted in the release
notes.

## Contact

Questions about this policy or the extension: open an issue at
https://github.com/carlonox/zai-chat-exporter/issues or write to
cjcuervob@gmail.com.
