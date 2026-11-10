# Privacy Policy — Text2Curl

Text2Curl does **not** collect, store, sell or send any personal data.

- Requests and responses captured on a page are kept **only in that tab's memory** and are deleted when the tab is closed or reloaded.
- Nothing is sent to any server. The extension has no analytics, tracking or remote code.
- The only stored data is two display settings (the "Hide secrets" switch and the chosen code format), saved locally with `chrome.storage.local`.
- Copying to the clipboard happens only when you press a Copy button.

Permissions:
- **Access to all sites** (content scripts): needed to see a page's `fetch`/`XMLHttpRequest` calls from the moment it starts loading, so a clicked value can be traced to its request.
- **activeTab, scripting**: to open the picker in the current tab from the toolbar button or shortcut.
- **storage**: to remember the two settings above.

Questions: open an issue at https://github.com/mhmsadegh/text2curl-extention/issues
