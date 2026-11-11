# Privacy Policy — Text2Curl

Text2Curl does **not** collect, store, sell or send any personal data to its author or any third party chosen by the author.

- Requests and responses captured on a page are kept **only in that tab's memory** and are deleted when the tab is closed or reloaded.
- The extension has no analytics, no tracking and no remote code.
- Copying to the clipboard happens only when you press a Copy button.

## Optional AI search

AI search is **off until you configure it** with your own provider (OpenRouter, OpenAI, a local Ollama, …).

- **API key:** stored only inside the extension. By default it is kept in `chrome.storage.session` (memory only, erased when the browser closes).
  If you tick "Remember", it is kept in `chrome.storage.local` on this computer. It is never synced to your Google account, web pages and
  other extensions cannot read it, and it is sent only to the Base URL you entered, by the extension's background worker.
  "Delete key" removes it at any time.
- **What is sent when you run an AI search:** your question plus short excerpts of the captured responses on that page and their URLs
  (secrets in URLs masked). Request headers and cookies are never sent. Nothing is sent unless you press Enter in AI mode.
- What the provider does with that data is governed by the provider's own privacy policy.

## Stored settings

`chrome.storage.local`: "Hide secrets" switch, code format, AI Base URL, model name, and (only if you chose "Remember") the API key.
`chrome.storage.session`: the API key (default).

## Permissions

- **Access to all sites** (content scripts): needed to see a page's `fetch`/`XMLHttpRequest` calls from the moment it starts loading, so a clicked value can be traced to its request.
- **activeTab, scripting**: to open the picker in the current tab from the toolbar button or shortcut.
- **storage**: to keep the settings above.
- **Optional host permission** (asked only when you set up AI search): to contact the AI provider you chose.

Questions: open an issue at https://github.com/mhmsadegh/text2curl/issues
