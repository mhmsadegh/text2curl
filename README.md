<p align="center"><img src="icons/logo512.png" width="112" alt="Text2Curl logo"></p>

<h1 align="center">Text2Curl</h1>

<p align="center">
<b>Click any text or image on a web page and get the API request behind it: as cURL, JavaScript or Python, with the full response.</b><br>
<sub>Chrome extension · Manifest V3 · no servers, no tracking</sub>
</p>

<p align="center"><img src="docs/screenshot.jpg" width="440" alt="Text2Curl panel showing a matched request, its cURL and the response"></p>

---

## Why

Finding which API call produced a value on a page usually means digging through the DevTools
**Network** tab: opening request after request and searching responses by hand.
Text2Curl does that for you. Click the value, get the request.

## Features

| | |
|---|---|
| ⌖ **Pick element** | Hover highlights elements; click a text or image to find the request whose response contains it. |
| ▶ **Watch action** | Click a button, link or filter; see every request it sends. Great for "what does *Save* call?". |
| 🔍 **Search** | Type a value and find which response contains it, even if it is not shown on the page. |
| `</>` **Code** | Copy as **cURL**, **JavaScript** (`fetch`) or **Python** (`requests`). |
| 📄 **Response** | Pretty-printed response with the matched value highlighted; copy it in one click. |
| 🧭 **JSON path** | Exactly where the value lives, e.g. `$.users[0].name`. |
| 🔒 **Hide secrets** | On by default: masks `Authorization`, cookies, tokens, API keys and passwords before you copy or share. |
| ⏱ **Timing & errors** | Status and response time for every request; an **Errors** view for 4xx/5xx and network failures. |
| 🌐 **Smart matching** | Ignores case and spacing; `1,250,000` = `1250000`; understands Persian/Arabic digits; ranks results by match quality. |

Everything stays in your browser. Text2Curl has no server, no analytics and no remote code. See [PRIVACY.md](PRIVACY.md).

---

## Install (Developer Mode)

Text2Curl is not on the Chrome Web Store yet, so you install it as an *unpacked* extension.
It takes about one minute.

### Step 1: Download the code

**Option A: ZIP (no tools needed)**
1. On this GitHub page click the green **Code** button → **Download ZIP**.
2. Unzip it. You get a folder such as `text2curl-extention-main`.
3. Move that folder somewhere permanent (e.g. `Documents/Extensions/`).
   The browser loads the extension **from this folder**, so do not delete or move it later.

**Option B: Git**
```bash
git clone https://github.com/mhmsadegh/text2curl-extention.git
```

### Step 2: Load it in your browser

<details open>
<summary><b>Google Chrome</b></summary>

1. Open a new tab and go to `chrome://extensions`
   (or menu ⋮ → **Extensions** → **Manage Extensions**).
2. Turn on **Developer mode** (switch in the top-right corner).
3. Click **Load unpacked** (top-left).
4. Select the folder from Step 1: the one that contains `manifest.json`.
5. Text2Curl appears in the list. Make sure its switch is **on**.
6. Pin it: click the puzzle icon 🧩 in the toolbar → click the pin 📌 next to **Text2Curl**.
</details>

<details>
<summary><b>Microsoft Edge</b></summary>

1. Go to `edge://extensions`.
2. Turn on **Developer mode** (left sidebar, bottom).
3. Click **Load unpacked** and select the folder that contains `manifest.json`.
4. Pin it from the puzzle icon in the toolbar.
</details>

<details>
<summary><b>Brave, Opera, Vivaldi, Arc and other Chromium browsers</b></summary>

- Brave: `brave://extensions`
- Opera: `opera://extensions`
- Vivaldi: `vivaldi://extensions`
- Arc: `arc://extensions`

Turn on **Developer mode**, click **Load unpacked**, select the folder that contains `manifest.json`.
</details>

> Firefox and Safari are not supported.

### Step 3: Try it

1. Open any website and **reload the page** (Text2Curl only sees requests made after the page starts loading).
2. Press **`Alt+Shift+C`** or click the Text2Curl icon.
3. Click a text or image. The panel shows the matching request.

### Updating

- **ZIP:** download the new ZIP, replace the files in the same folder, then on `chrome://extensions` click the
  ↻ **reload** icon on the Text2Curl card.
- **Git:** run `git pull` in the folder, then click ↻ **reload** on the Text2Curl card.

Reload open tabs afterwards so the new version is injected.

### Uninstall

`chrome://extensions` → **Remove** on the Text2Curl card. You can then delete the folder.

### Install troubleshooting

| Problem | Fix |
|---|---|
| "Manifest file is missing or unreadable" | You selected the wrong folder. Pick the folder that directly contains `manifest.json` (unzipping sometimes creates a folder inside a folder). |
| Nothing happens on `Alt+Shift+C` | Another extension may use the shortcut. Set your own at `chrome://extensions/shortcuts`, or click the toolbar icon. |
| "No requests captured yet" | Reload the page after installing or enabling the extension. |
| It does not work on `chrome://` pages or the Chrome Web Store | Browsers block extensions there. This is expected. |
| Chrome shows "Disable developer mode extensions" on start-up | Normal for unpacked extensions. Click ✕ to keep it. |
| Company-managed browser does not allow Developer mode | Your admin policy blocks unpacked extensions. |

---

## How to use

| Action | How |
|---|---|
| Open the picker | `Alt+Shift+C` or the toolbar icon |
| Find the API of a text / image | **⌖ Pick element** → click it |
| Find what a button calls | **▶ Watch action** → click the button (the click works normally) |
| Find a value not on screen | Type it in the search box |
| See failing calls | **⚠ Errors** |
| See everything captured | **All** |
| Switch code language | **cURL / JavaScript / Python** tabs (remembered) |
| Show / copy the response | **Show response**, **Copy response** |
| Cancel or close | `Esc` |

### Hide secrets

With **Hide secrets** on (default), values whose names look sensitive are replaced by `<REDACTED>`:
headers such as `Authorization`, `Cookie`, `X-API-Key`, `X-CSRF-Token`; URL parameters such as `api_key`, `token`;
and JSON or form fields such as `password`, `access_token`. Turn it off when you want to run the request yourself.

### Cookies

Page scripts cannot read `HttpOnly` cookies. When a request would normally send cookies, the code contains
`Cookie: <PASTE_COOKIES_FROM_DEVTOOLS>`. If the API needs a login, copy the cookie from DevTools
(**Application → Cookies**, or the request's `Cookie` header) and paste it in. Remove the line if it is not needed.

### When nothing is found

- The value is in the **server-rendered HTML**, not loaded by an API.
- The page was opened **before** the extension was enabled. Reload it.
- It came over a **WebSocket**, Server-Sent Events or a Service Worker cache.
- The page **changed the value** before showing it (date formats, translations, rounding). Try the search box with part of the value.

---

## How it works

| File | Role |
|------|------|
| `inject.js` | Runs in the page's own JavaScript world at `document_start`. Wraps `fetch` and `XMLHttpRequest` and records method, URL, request headers, body, status, timing and response text (text/JSON up to 2 MB). |
| `content.js` | Keeps the last 500 requests, runs the picker, action watcher and search, generates code and draws the panel inside a Shadow DOM (page styles cannot break it). |
| `background.js` | Opens the picker from the toolbar icon and the keyboard shortcut. |
| `manifest.json` | Manifest V3 configuration. |

### Limitations

- Headers added by the browser itself (`User-Agent`, `Referer`, `Cookie`, `Origin`) are invisible to page scripts, so they are only in the code if the page set them.
- WebSockets, Service-Worker requests and requests made by other extensions are not captured.
- Binary responses (images, files) are listed but not searched.

## Development

A sample page with `fetch`, `XMLHttpRequest`, an image from JSON, a click action, a hidden value and a 404 is included:

```bash
python test/serve.py 8765
```

Open `http://127.0.0.1:8765/test/index.html` with the extension loaded.
`test/harness.html` loads the scripts directly, so you can test without installing the extension.

See [CHANGELOG.md](CHANGELOG.md) for versions.

## License

[MIT](LICENSE)
