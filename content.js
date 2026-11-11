// Text2Curl content script (isolated world).
// Stores requests captured by inject.js, runs the picker / action watcher / search,
// and draws the panel inside a Shadow DOM.
(() => {
  if (window.__t2cContent) return;
  window.__t2cContent = true;

  const MAX_RECORDS = 500;
  const ACTION_WINDOW_MS = 2500;
  const records = [];
  const settings = { redact: true, format: 'curl', searchMode: 'bm25' };

  // ---------- settings (chrome.storage when available) ----------
  const hasChrome = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id;
  if (hasChrome && chrome.storage) {
    chrome.storage.local.get(['redact', 'format', 'searchMode'], (v) => {
      if (typeof v.redact === 'boolean') settings.redact = v.redact;
      if (v.format) settings.format = v.format;
      if (v.searchMode) settings.searchMode = v.searchMode;
    });
  }
  const saveSettings = () => { if (hasChrome && chrome.storage) chrome.storage.local.set(settings); };

  // ---------- capture ----------
  const listeners = [];
  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || ev.data.__aci !== true) return;
    const rec = ev.data.rec;
    // Never list Text2Curl's own AI calls (only possible in the test harness).
    if (typeof rec.body === 'string' && /You search captured HTTP API responses|You turn a user's question/.test(rec.body)) return;
    try { rec.json = rec.response ? JSON.parse(rec.response) : undefined; } catch (e) { rec.json = undefined; }
    rec.id = records.length ? records[records.length - 1].id + 1 : 1;
    records.push(rec);
    if (records.length > MAX_RECORDS) records.shift();
    listeners.forEach((fn) => fn(rec));
  });

  // ---------- normalisation & search ----------
  const norm = (s) => String(s).normalize('NFKC').toLowerCase()
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06F0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/(\d)[,٬،](?=\d{3})/g, '$1')
    .replace(/\s+/g, ' ').trim();

  function leaves(v, path, out) {
    if (out.length > 20000) return out;
    if (v === null || typeof v !== 'object') {
      if (v !== null && v !== undefined && v !== '') out.push({ path, value: String(v) });
      return out;
    }
    if (Array.isArray(v)) v.forEach((x, i) => leaves(x, path + '[' + i + ']', out));
    else Object.keys(v).forEach((k) => leaves(v[k], path + (/^[A-Za-z_$][\w$]*$/.test(k) ? '.' + k : '[' + JSON.stringify(k) + ']'), out));
    return out;
  }

  function imageUrls(el) {
    const urls = [];
    const push = (u) => { if (u && !/^data:/.test(u)) urls.push(u); };
    if (el.tagName === 'IMG') { push(el.currentSrc || el.src); push(el.getAttribute('src')); }
    if (el.tagName === 'SOURCE' || el.tagName === 'VIDEO') push(el.src || el.getAttribute('poster'));
    const bg = getComputedStyle(el).backgroundImage;
    const m = bg && bg.match(/url\(["']?(.*?)["']?\)/);
    if (m) push(m[1]);
    const img = !urls.length && el.querySelector && el.querySelector('img');
    if (img) push(img.currentSrc || img.src);
    return urls;
  }

  function candidateTexts(el) {
    const set = new Set();
    const add = (t) => { t = norm(t || ''); if (t.length >= 1 && t.length <= 500) set.add(t); };
    add(el.innerText || el.textContent);
    el.childNodes.forEach((n) => { if (n.nodeType === 3) add(n.textContent); });
    if (el.value) add(el.value);
    ['title', 'alt', 'placeholder', 'aria-label', 'href'].forEach((a) => el.getAttribute && add(el.getAttribute(a)));
    const images = imageUrls(el);
    images.forEach((u) => {
      add(u);
      try {
        const url = new URL(u, location.href);
        add(url.pathname);
        const file = url.pathname.split('/').pop();
        if (file && file.length >= 5) add(decodeURIComponent(file));
      } catch (e) {}
    });
    String(el.innerText || '').split('\n').forEach((l) => { l = norm(l); if (l.length >= 2 && l.length <= 300) set.add(l); });
    const near = new Set();
    if (el.parentElement) {
      Array.from(el.parentElement.children).forEach((s) => {
        if (s === el) return;
        const t = norm(s.innerText || '');
        if (t && t.length <= 200 && !set.has(t)) near.add(t);
      });
    }
    return { main: [...set], near: [...near], images };
  }

  function scoreValue(val, texts, weight) {
    let best = 0;
    for (const t of texts) {
      if (!t) continue;
      if (val === t) best = Math.max(best, 100 * weight);
      else if (t.length >= 3 && val.includes(t)) best = Math.max(best, (60 + 30 * t.length / val.length) * weight);
      else if (val.length >= 3 && t.includes(val)) best = Math.max(best, (40 + 40 * val.length / t.length) * weight);
    }
    return best;
  }

  function searchTexts(main, near) {
    const results = [];
    records.forEach((rec) => {
      if (rec.binary || !rec.response) return;
      let best = { score: 0, path: null, value: null };
      if (rec.json !== undefined) {
        if (!rec._leaves) rec._leaves = leaves(rec.json, '$', []).map((l) => ({ ...l, n: norm(l.value) }));
        for (const l of rec._leaves) {
          // Nearby text only adds a small bonus; it never makes a match by itself.
          const m = scoreValue(l.n, main, 1);
          const s = m ? m + scoreValue(l.n, near, 0.05) : 0;
          if (s > best.score) best = { score: s, path: l.path, value: l.value };
        }
      } else {
        if (!rec._norm) rec._norm = norm(rec.response.replace(/<[^>]+>/g, ' '));
        for (const t of main) {
          if (t.length >= 3 && rec._norm.includes(t)) {
            const s = 50 + Math.min(30, t.length / 3);
            if (s > best.score) best = { score: s, path: '(raw text)', value: t };
          }
        }
      }
      if (best.score >= 40) results.push({ rec, ...best });
    });
    results.sort((a, b) => b.score - a.score || b.rec.id - a.rec.id);
    return results.slice(0, 10);
  }

  // ---------- secrets ----------
  const SECRET_KEY = /(authorization|cookie|token|api[-_]?key|apikey|secret|session|sess|csrf|xsrf|password|passwd|pwd|auth|signature|sig|access[-_]?key|bearer|jwt)/i;
  const MASK = '<REDACTED>';
  function redactUrl(u) {
    try {
      const url = new URL(u);
      url.searchParams.forEach((v, k) => { if (SECRET_KEY.test(k)) url.searchParams.set(k, MASK); });
      if (url.password) url.password = MASK;
      return url.href.replace(/%3CREDACTED%3E/g, MASK);
    } catch (e) { return u; }
  }
  function redactBody(b) {
    if (typeof b !== 'string') return b;
    try {
      const walk = (o) => {
        if (o && typeof o === 'object') Object.keys(o).forEach((k) => {
          if (SECRET_KEY.test(k) && (typeof o[k] !== 'object' || o[k] === null)) o[k] = MASK; else walk(o[k]);
        });
        return o;
      };
      return JSON.stringify(walk(JSON.parse(b)));
    } catch (e) {
      if (/^[^=&\s]+=[^&]*(&[^=&\s]+=[^&]*)*$/.test(b)) {
        return b.split('&').map((p) => { const k = p.split('=')[0]; return SECRET_KEY.test(decodeURIComponent(k)) ? k + '=' + MASK : p; }).join('&');
      }
      return b;
    }
  }
  function prepared(rec) {
    const SKIP = /^(content-length|host|connection|accept-encoding)$/i;
    const headers = {};
    Object.keys(rec.headers || {}).forEach((k) => {
      if (SKIP.test(k)) return;
      headers[k] = settings.redact && SECRET_KEY.test(k) ? MASK : rec.headers[k];
    });
    let sameOrigin = false;
    try { sameOrigin = new URL(rec.url).origin === location.origin; } catch (e) {}
    const needsCookie = rec.credentials === 'include' || (rec.credentials !== 'omit' && sameOrigin);
    return {
      method: rec.method,
      url: settings.redact ? redactUrl(rec.url) : rec.url,
      headers,
      needsCookie,
      body: rec.body == null ? null : (settings.redact ? redactBody(rec.body) : rec.body),
    };
  }

  // ---------- code generators ----------
  const sq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
  const COOKIE = '<PASTE_COOKIES_FROM_DEVTOOLS>';
  function toCurl(rec) {
    const p = prepared(rec);
    const parts = ['curl ' + sq(p.url)];
    if (p.method !== 'GET' || p.body != null) parts.push('-X ' + p.method);
    Object.keys(p.headers).forEach((k) => parts.push('-H ' + sq(k + ': ' + p.headers[k])));
    if (p.needsCookie) parts.push('-H ' + sq('Cookie: ' + COOKIE));
    if (p.body != null) {
      if (typeof p.body === 'object' && p.body.formData) p.body.formData.forEach((f) => parts.push('-F ' + sq(f)));
      else parts.push('--data-raw ' + sq(p.body));
    }
    parts.push('--compressed');
    return parts.join(' \\\n  ');
  }
  function toFetch(rec) {
    const p = prepared(rec);
    const opts = { method: p.method, headers: p.headers };
    if (p.body != null && typeof p.body === 'string') opts.body = p.body;
    if (p.needsCookie) opts.credentials = 'include';
    let code = `const res = await fetch(${JSON.stringify(p.url)}, ${JSON.stringify(opts, null, 2)});\n`;
    code += /json/i.test(rec.contentType || '') ? 'const data = await res.json();\nconsole.log(data);' : 'const text = await res.text();\nconsole.log(text);';
    if (p.body && typeof p.body === 'object') code = '// Original body was FormData: ' + p.body.formData.join(', ') + '\n' + code;
    return code;
  }
  function toPython(rec) {
    const p = prepared(rec);
    const py = (v) => JSON.stringify(v, null, 4).replace(/\btrue\b/g, 'True').replace(/\bfalse\b/g, 'False').replace(/\bnull\b/g, 'None');
    const headers = Object.assign({}, p.headers);
    if (p.needsCookie) headers.Cookie = COOKIE;
    let code = 'import requests\n\n';
    code += `url = ${JSON.stringify(p.url)}\nheaders = ${py(headers)}\n`;
    let extra = '';
    if (typeof p.body === 'string') {
      let parsed;
      try { parsed = JSON.parse(p.body); } catch (e) {}
      if (parsed !== undefined && /json/i.test(JSON.stringify(headers))) { code += `payload = ${py(parsed)}\n`; extra = ', json=payload'; }
      else { code += `data = ${JSON.stringify(p.body)}\n`; extra = ', data=data'; }
    } else if (p.body && p.body.formData) {
      const o = {}; p.body.formData.forEach((f) => { const i = f.indexOf('='); o[f.slice(0, i)] = f.slice(i + 1); });
      code += `files = {k: (None, v) for k, v in ${py(o)}.items()}\n`; extra = ', files=files';
    }
    code += `\nresponse = requests.request(${JSON.stringify(p.method)}, url, headers=headers${extra})\n`;
    code += /json/i.test(rec.contentType || '') ? 'print(response.status_code)\nprint(response.json())' : 'print(response.status_code)\nprint(response.text)';
    return code;
  }
  const FORMATS = { curl: ['cURL', toCurl], fetch: ['JavaScript', toFetch], python: ['Python', toPython] };

  // ---------- UI ----------
  let host, shadow, $panel, $hl, $tip, $body, $status;
  let mode = 'idle';          // idle | pick | action
  let current = [];           // current result list [{rec, score, path, value}]
  let currentTitle = '';
  let aiBusy = false;

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const CSS = `
  :host{all:initial;--accent:#e8590c}
  *{box-sizing:border-box}
  .hl{position:fixed;border:2px solid var(--accent);background:rgba(232,89,12,.10);pointer-events:none;border-radius:4px;display:none;transition:all .06s}
  .hl.action{border-color:#4dabf7;background:rgba(77,171,247,.12)}
  .tip{position:fixed;top:12px;left:50%;transform:translateX(-50%);background:#111;color:#fff;padding:8px 14px;border-radius:999px;
    font:500 13px/1.3 system-ui,-apple-system,Segoe UI,sans-serif;display:none;box-shadow:0 4px 16px rgba(0,0,0,.3);pointer-events:none}
  .tip kbd{background:#333;border-radius:4px;padding:1px 6px;font:12px Consolas,monospace}
  .panel{--accent:#e8590c;--bg:#18181b;--bg2:#232326;--bg3:#0f0f11;--line:#2e2e33;--fg:#ececf1;--mut:#9a9aa5;
    position:fixed;right:16px;bottom:16px;width:min(720px,calc(100vw - 32px));max-height:min(78vh,820px);display:none;flex-direction:column;
    background:var(--bg);color:var(--fg);font:13px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;border:1px solid var(--line);
    border-radius:14px;box-shadow:0 20px 50px rgba(0,0,0,.45);pointer-events:auto;overflow:hidden}
  .hd{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--line);background:var(--bg2)}
  .logo{width:22px;height:22px;border-radius:6px;background:var(--accent);color:#fff;display:grid;place-items:center;font:700 12px Consolas,monospace}
  .brand{font-weight:650;margin-right:auto;white-space:nowrap}
  .brand small{color:var(--mut);font-weight:400;margin-left:6px}
  .bar{display:flex;gap:8px;padding:10px 12px;border-bottom:1px solid var(--line);flex-wrap:wrap;align-items:center}
  .search{flex:1;min-width:150px;background:var(--bg3);border:1px solid var(--line);color:var(--fg);border-radius:8px;padding:7px 10px;font:inherit;outline:none}
  .search:focus{border-color:var(--accent)}
  button{font:500 12.5px/1 system-ui,-apple-system,Segoe UI,sans-serif;border-radius:8px;border:1px solid var(--line);background:var(--bg2);
    color:var(--fg);padding:7px 10px;cursor:pointer;white-space:nowrap}
  button:hover{border-color:#55555f}
  button.pri{background:var(--accent);border-color:var(--accent);color:#fff}
  button.pri:hover{filter:brightness(1.08)}
  button.on{border-color:var(--accent);color:#ffb38a}
  button.icon{padding:6px 8px;background:transparent;border-color:transparent;color:var(--mut);font-size:15px}
  button.icon:hover{color:var(--fg)}
  .switch{display:flex;align-items:center;gap:6px;color:var(--mut);font-size:12px;cursor:pointer;user-select:none}
  .switch input{accent-color:var(--accent)}
  .status{padding:8px 12px;color:var(--mut);font-size:12px;border-bottom:1px solid var(--line)}
  .status b{color:var(--fg)}
  .body{overflow:auto;padding:4px 12px 12px}
  .card{border:1px solid var(--line);border-radius:10px;margin-top:10px;background:var(--bg2);overflow:hidden}
  .ch{display:flex;gap:8px;align-items:flex-start;padding:10px 12px 6px}
  .m{flex:none;font:700 11px/1 Consolas,monospace;padding:4px 6px;border-radius:5px;background:#2b8a3e;color:#fff}
  .m.POST{background:#1971c2}.m.PUT,.m.PATCH{background:#9c36b5}.m.DELETE{background:#c92a2a}
  .url{font:12.5px/1.45 Consolas,monospace;word-break:break-all;color:#a5d8ff}
  .chips{display:flex;flex-wrap:wrap;gap:6px;padding:0 12px 8px}
  .chip{font-size:11.5px;color:var(--mut);background:var(--bg3);border:1px solid var(--line);border-radius:999px;padding:2px 8px}
  .chip.ok{color:#8ce99a}.chip.bad{color:#ffa8a8;border-color:#5c2b2b}.chip.slow{color:#ffd43b}
  .chip.score{color:#ffb38a}
  .match{padding:0 12px 8px;font-size:12px;color:var(--mut)}
  .match code{color:#ffd43b;font-family:Consolas,monospace}
  .tabs{display:flex;gap:2px;padding:0 12px}
  .tab{background:transparent;border:0;border-bottom:2px solid transparent;border-radius:0;color:var(--mut);padding:7px 8px}
  .tab.sel{color:var(--fg);border-bottom-color:var(--accent)}
  pre{margin:0;background:var(--bg3);padding:10px 12px;white-space:pre-wrap;word-break:break-all;
    font:12px/1.5 Consolas,ui-monospace,monospace;max-height:240px;overflow:auto;border-top:1px solid var(--line)}
  pre.resp{max-height:340px}
  .acts{display:flex;gap:6px;padding:8px 12px;border-top:1px solid var(--line);flex-wrap:wrap}
  mark{background:#ffd43b;color:#000;border-radius:2px}
  .sbox{flex:1;min-width:260px;display:flex;border:1px solid var(--line);border-radius:8px;background:var(--bg3);overflow:hidden}
  .sbox:focus-within{border-color:var(--accent)}
  .sbox.ai{border-color:#7048e8}
  .sbox .search{border:0;border-radius:0;background:transparent;min-width:80px}
  .smode{background:var(--bg2);color:var(--fg);border:0;border-right:1px solid var(--line);padding:0 6px;font:500 12px system-ui,sans-serif;cursor:pointer;outline:none}
  .gobtn{border:0;border-left:1px solid var(--line);border-radius:0;background:var(--bg2)}
  .sbox.ai .gobtn{background:linear-gradient(135deg,#7048e8,#e8590c);color:#fff}
  .terms{padding:0 12px 8px;font-size:11.5px;color:var(--mut)}
  .terms span{display:inline-block;background:var(--bg3);border:1px solid var(--line);border-radius:999px;padding:1px 7px;margin:2px 3px 0 0}
  .terms span.syn{border-style:dashed}
  .match.ai{color:#d0bfff}
  .empty{padding:16px 4px;color:var(--mut)}
  .empty h4{margin:0 0 6px;color:#ffd8a8;font-size:14px}
  .empty ul{margin:6px 0 0;padding-left:18px}
  .rtl{direction:rtl;text-align:right;margin-top:8px}
  .spin{display:inline-block;width:10px;height:10px;border:2px solid #4dabf7;border-right-color:transparent;border-radius:50%;animation:s .7s linear infinite;vertical-align:-1px;margin-right:6px}
  @keyframes s{to{transform:rotate(360deg)}}
  `;

  function ensureUI() {
    if (host) return;
    host = document.createElement('div');
    host.id = '__t2c_host';
    host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
    shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>${CSS}</style>
      <div class="hl"></div>
      <div class="tip"></div>
      <div class="panel" role="dialog" aria-label="Text2Curl">
        <div class="hd"><div class="logo">{}</div><div class="brand">Text2Curl<small></small></div>
          <label class="switch" title="Replace tokens, cookies, API keys and passwords with <REDACTED>"><input type="checkbox" data-k="redact"> Hide secrets</label>
          <button class="icon" data-act="close" title="Close (Esc)">✕</button></div>
        <div class="bar">
          <button class="pri" data-act="pick" title="Click a text or image (Alt+Shift+C)">⌖ Pick element</button>
          <button data-act="action" title="Click a button/filter on the page and see the requests it sends">▶ Watch action</button>
          <div class="sbox">
            <select class="smode" aria-label="Search mode" title="Exact: the value as typed · BM25: ranked keyword search, local and free · AI: rewrites your question, retrieves with BM25, then a model decides">
              <option value="exact">Exact</option><option value="bm25">BM25</option><option value="ai">✨ AI</option></select>
            <input class="search" type="search" aria-label="Search responses">
            <button data-act="go" class="gobtn" title="Search (Enter)">Search</button>
          </div>
          <button data-act="errors" title="Requests with status 4xx/5xx or network errors">⚠ Errors</button>
          <button data-act="all" title="All captured requests, newest first">All</button>
        </div>
        <div class="status"></div>
        <div class="body"></div>
      </div>`;
    $panel = shadow.querySelector('.panel');
    $hl = shadow.querySelector('.hl');
    $tip = shadow.querySelector('.tip');
    $body = shadow.querySelector('.body');
    $status = shadow.querySelector('.status');
    (document.documentElement || document.body).appendChild(host);

    const redact = shadow.querySelector('[data-k="redact"]');
    redact.checked = settings.redact;
    redact.addEventListener('change', () => { settings.redact = redact.checked; saveSettings(); renderList(); });

    const search = shadow.querySelector('.search');
    let timer;
    const smode = shadow.querySelector('.smode');
    smode.value = settings.searchMode;
    smode.addEventListener('change', () => { setSearchMode(smode.value); });
    setSearchMode(settings.searchMode, true);
    search.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(timer); runSearch(); } });
    search.addEventListener('input', () => {
      if (settings.searchMode === 'ai') return;   // AI runs only on Enter / Search (it costs tokens)
      clearTimeout(timer);
      timer = setTimeout(runSearch, 250);
    });
    // Keep page shortcuts from firing while typing in the panel.
    ['keydown', 'keyup', 'keypress'].forEach((t) => search.addEventListener(t, (e) => { if (e.key !== 'Escape') e.stopPropagation(); }));

    $panel.addEventListener('click', onPanelClick);
    updateCount();
  }

  function updateCount() {
    if (!shadow) return;
    const errs = records.filter(isError).length;
    shadow.querySelector('.brand small').textContent = `${records.length} request${records.length === 1 ? '' : 's'} captured`;
    shadow.querySelector('[data-act="errors"]').textContent = `⚠ Errors${errs ? ' (' + errs + ')' : ''}`;
  }
  listeners.push(() => updateCount());

  const isError = (r) => r.status === 0 || r.status >= 400;
  function setStatus(html) { $status.innerHTML = html; }
  function showPanel() { ensureUI(); $panel.style.display = 'flex'; }
  function hidePanel() { if ($panel) $panel.style.display = 'none'; stopMode(); }

  // ---------- modes ----------
  function onMove(e) {
    if (e.target === host) return;
    const r = e.target.getBoundingClientRect();
    Object.assign($hl.style, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
  }
  const block = (e) => { if (e.target !== host) { e.preventDefault(); e.stopPropagation(); } };
  function onPickClick(e) {
    if (e.target === host) return;
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    const el = e.target;
    stopMode();
    showForElement(el);
  }
  function onActionClick(e) {
    if (e.target === host) return;
    // Let the click reach the page; collect requests that start from now on.
    const el = e.target;
    const label = norm(el.innerText || el.value || el.getAttribute('aria-label') || el.tagName).slice(0, 60);
    const t0 = Date.now() - 50;
    stopMode();
    showPanel();
    currentTitle = `After clicking “${esc(label)}”`;
    current = [];
    setStatus(`<span class="spin"></span>${currentTitle}: watching requests for ${ACTION_WINDOW_MS / 1000}s…`);
    renderList();
    const onRec = (rec) => { if (rec.time >= t0) { current.push({ rec }); renderList(); } };
    listeners.push(onRec);
    setTimeout(() => {
      listeners.splice(listeners.indexOf(onRec), 1);
      // Late responses for requests that started inside the window are still caught here.
      current = records.filter((r) => r.time >= t0 && r.time <= t0 + ACTION_WINDOW_MS).map((rec) => ({ rec }));
      setStatus(`${currentTitle}: <b>${current.length}</b> request(s) sent.`);
      renderList(current.length ? null : 'action');
    }, ACTION_WINDOW_MS);
  }
  function onKey(e) {
    if (e.key !== 'Escape') return;
    if (mode !== 'idle') stopMode(); else hidePanel();
  }

  function startMode(m) {
    ensureUI();
    stopMode();
    mode = m;
    $panel.style.display = 'none';
    $hl.classList.toggle('action', m === 'action');
    $tip.innerHTML = m === 'pick'
      ? 'Click a text or image to find its API &nbsp;<kbd>Esc</kbd> cancel'
      : 'Click a button, link or filter. Text2Curl will list the requests it sends &nbsp;<kbd>Esc</kbd> cancel';
    $tip.style.display = 'block';
    document.addEventListener('mousemove', onMove, true);
    if (m === 'pick') {
      document.addEventListener('click', onPickClick, true);
      document.addEventListener('mousedown', block, true);
      document.addEventListener('mouseup', block, true);
    } else {
      document.addEventListener('click', onActionClick, true);
    }
  }
  function stopMode() {
    if (!shadow) return;
    mode = 'idle';
    $tip.style.display = 'none';
    $hl.style.display = 'none';
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onPickClick, true);
    document.removeEventListener('click', onActionClick, true);
    document.removeEventListener('mousedown', block, true);
    document.removeEventListener('mouseup', block, true);
  }
  document.addEventListener('keydown', onKey, true);

  function showForElement(el) {
    showPanel();
    const { main, near, images } = candidateTexts(el);
    current = searchTexts(main, near);
    const what = images.length && !norm(el.innerText || '') ? 'image ' + images[0].split('/').pop().slice(0, 60) : (main[0] || el.tagName.toLowerCase()).slice(0, 80);
    currentTitle = `Clicked “${esc(what)}”`;
    setStatus(`${currentTitle}: <b>${current.length}</b> matching request(s).`);
    renderList(current.length ? null : (images.length ? 'image' : 'text'), images);
  }

  // ---------- rendering ----------
  function chipStatus(r) {
    if (r.status === 0) return `<span class="chip bad">${esc(r.error || 'failed')}</span>`;
    return `<span class="chip ${r.status >= 400 ? 'bad' : 'ok'}">${r.status}</span>`;
  }
  function renderList(emptyKind, images) {
    if (!current.length) {
      if (emptyKind === 'action') {
        $body.innerHTML = `<div class="empty"><h4>No requests were sent after this click.</h4>
          The action may be handled entirely in the page, or it reloaded the page (requests during a reload are lost).</div>`;
      } else if (emptyKind === 'text' || emptyKind === 'image') {
        $body.innerHTML = `<div class="empty"><h4>No captured API response contains this ${emptyKind}.</h4>
          Possible reasons:<ul>
          <li>It is in the server-rendered HTML, not loaded by an API.</li>
          <li>The page was open before Text2Curl was enabled. Reload the page and try again.</li>
          <li>It came over a WebSocket, or the page changed the value before showing it.</li></ul>
          ${images && images.length ? `<div style="margin-top:8px">Image URL: <span class="url">${esc(images[0])}</span></div>` : ''}
          <div class="rtl">هیچ پاسخ API این مقدار را ندارد. شاید مستقیم در HTML صفحه است. صفحه را رفرش کنید و دوباره امتحان کنید.</div></div>`;
      } else if (!records.length) {
        $body.innerHTML = `<div class="empty"><h4>No requests captured yet.</h4>Reload the page so Text2Curl can see its API calls from the start.</div>`;
      } else {
        $body.innerHTML = `<div class="empty">Use <b>Pick element</b>, <b>Watch action</b> or search.</div>`;
      }
      return;
    }
    $body.innerHTML = current.map((r, i) => {
      const rec = r.rec;
      const slow = rec.duration >= 1000;
      const fmt = settings.format;
      return `<div class="card" data-i="${i}">
        <div class="ch"><span class="m ${esc(rec.method)}">${esc(rec.method)}</span><span class="url">${esc(settings.redact ? redactUrl(rec.url) : rec.url)}</span></div>
        <div class="chips">${chipStatus(rec)}
          ${rec.duration != null ? `<span class="chip ${slow ? 'slow' : ''}">${rec.duration} ms</span>` : ''}
          <span class="chip">${esc(rec.kind)}</span>
          ${rec.contentType ? `<span class="chip">${esc(rec.contentType.split(';')[0])}</span>` : ''}
          ${r.score != null ? `<span class="chip score" title="${r.ai ? 'AI relevance' : r.bm25 ? 'BM25 score relative to the best result' : 'How well the value matches (100 = exact)'}">${r.ai ? '✨ ' : r.bm25 ? 'BM25 ' : 'match '}${Math.round(r.score)}%</span>` : ''}
          ${r.ai && r.bm != null ? `<span class="chip" title="Keyword (BM25) rank of this response before the AI decision">BM25 ${r.bm}%</span>` : ''}</div>
        ${r.matched && r.matched.length ? `<div class="terms">Matched: ${r.matched.slice(0, 12).map((t) => `<span>${esc(t)}</span>`).join('')}</div>` : ''}
        ${r.reason ? `<div class="match ai">✨ ${esc(r.reason)}</div>` : ''}
        ${r.path ? `<div class="match">${r.ai ? 'Evidence at' : 'Found at'} <code>${esc(r.path)}</code> = “${esc(String(r.value).slice(0, 120))}”</div>` : ''}
        <div class="tabs">${Object.keys(FORMATS).map((k) => `<button class="tab ${k === fmt ? 'sel' : ''}" data-fmt="${k}">${FORMATS[k][0]}</button>`).join('')}</div>
        <pre class="code">${esc(FORMATS[fmt][1](rec))}</pre>
        <pre class="resp" style="display:none"></pre>
        <div class="acts"><button class="pri" data-act="copy">Copy ${FORMATS[fmt][0]}</button>
          ${rec.binary ? '<span class="chip">binary response</span>' : `<button data-act="resp">Show response</button><button data-act="copyresp">Copy response</button>`}
          ${r.path ? '<button data-act="copypath">Copy JSON path</button>' : ''}</div>
      </div>`;
    }).join('');
  }

  function prettyResponse(rec) { return rec.json !== undefined ? JSON.stringify(rec.json, null, 2) : rec.response; }
  function renderResponse(r) {
    const full = prettyResponse(r.rec);
    const text = full.length > 300000 ? full.slice(0, 300000) + '\n… (truncated, use Copy response for all)' : full;
    let html = esc(text);
    if (r.value) {
      const needle = esc(r.rec.json !== undefined && typeof r.value === 'string' ? JSON.stringify(r.value).slice(1, -1) : r.value);
      const at = html.indexOf(needle);
      if (at >= 0) html = html.slice(0, at) + '<mark>' + needle + '</mark>' + html.slice(at + needle.length);
    }
    return html;
  }

  function copy(text, btn) {
    const label = btn.textContent;
    const done = () => { btn.textContent = 'Copied ✓'; setTimeout(() => (btn.textContent = label), 1400); };
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(done).catch(() => {
      const ta = document.createElement('textarea'); ta.value = text; shadow.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove(); done();
    });
  }

  function onPanelClick(e) {
    const b = e.target.closest('button');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'close') return hidePanel();
    if (act === 'pick') return startMode('pick');
    if (act === 'action') return startMode('action');
    if (act === 'go') return runSearch();
    if (act === 'aisettings') { if (hasChrome) chrome.runtime.sendMessage({ type: 'T2C_OPEN_OPTIONS' }); return; }
    if (act === 'errors' || act === 'all') {
      current = records.filter(act === 'errors' ? isError : () => true).slice().reverse().slice(0, 50).map((rec) => ({ rec }));
      currentTitle = act === 'errors' ? 'Failed requests (4xx, 5xx, network)' : 'All captured requests';
      setStatus(`${currentTitle}: <b>${current.length}</b>${act === 'all' && records.length > 50 ? ' (newest 50 shown)' : ''}.`);
      if (act === 'errors' && !current.length) { $body.innerHTML = '<div class="empty">No failed requests.</div>'; return; }
      return renderList();
    }
    const card = b.closest('.card');
    if (!card) return;
    const r = current[+card.dataset.i];
    if (b.dataset.fmt) {
      settings.format = b.dataset.fmt; saveSettings();
      card.querySelectorAll('.tab').forEach((t) => t.classList.toggle('sel', t === b));
      card.querySelector('.code').textContent = FORMATS[settings.format][1](r.rec);
      card.querySelector('[data-act="copy"]').textContent = 'Copy ' + FORMATS[settings.format][0];
      return;
    }
    if (act === 'copy') return copy(FORMATS[settings.format][1](r.rec), b);
    if (act === 'copyresp') return copy(prettyResponse(r.rec), b);
    if (act === 'copypath') return copy(r.path, b);
    if (act === 'resp') {
      const box = card.querySelector('.resp');
      if (box.style.display === 'none') {
        if (!box.innerHTML) box.innerHTML = renderResponse(r);
        box.style.display = 'block'; b.textContent = 'Hide response';
        const m = box.querySelector('mark'); if (m) box.scrollTop = m.offsetTop - box.clientHeight / 2;
      } else { box.style.display = 'none'; b.textContent = 'Show response'; }
    }
  }

  // ---------- AI search ----------
  const STOP = new Set('the a an and or of in on at to for from with about which what where who is are was were be been api apis response responses request requests that this these those any all does do did talk talks talking mention mentions contain contains show find me my it its they them there here into by as than then'.split(' '));
  function terms(q) {
    return [...new Set(norm(q).split(/[^\p{L}\p{N}_-]+/u).filter((w) => w.length >= 2 && !STOP.has(w)))];
  }
  // Short, relevant excerpt per response: the start, plus windows around words of the question.
  function excerpt(rec, ts) {
    const raw = rec.json !== undefined ? JSON.stringify(rec.json)
      : String(rec.response).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    const low = raw.toLowerCase();
    const hits = [];
    for (const t of ts) {
      let i = low.indexOf(t), n = 0;
      while (i >= 0 && n < 3) { hits.push(i); i = low.indexOf(t, i + t.length); n++; }
    }
    if (!hits.length) return { text: raw.slice(0, 900) + (raw.length > 900 ? ' …' : ''), hits: 0 };
    hits.sort((a, b) => a - b);
    const parts = [raw.slice(0, 400)];
    let last = 400, budget = 2600;
    for (const h of hits) {
      const a = Math.max(last, h - 250), b = Math.min(raw.length, h + 250);
      if (b <= a || budget <= 0) continue;
      parts.push(raw.slice(a, b)); budget -= b - a; last = b;
    }
    return { text: parts.join(' … '), hits: hits.length };
  }
  function findPath(rec, evidence) {
    if (rec.json === undefined || !evidence) return null;
    if (!rec._leaves) rec._leaves = leaves(rec.json, '$', []).map((l) => ({ ...l, n: norm(l.value) }));
    // Evidence may be quoted from raw JSON ("title":"Quarterly report …), so also try the pieces between JSON punctuation.
    const whole = norm(evidence).replace(/^["']|["']$/g, '');
    const pieces = [whole, ...whole.split(/["{}[\],:]+/).map((x) => x.trim()).filter((x) => x.length >= 4)]
      .sort((a, b) => b.length - a.length);
    for (const ev of pieces) {
      let best = null;
      for (const l of rec._leaves) {
        if (!l.n) continue;
        if (l.n === ev || (ev.length >= 3 && l.n.includes(ev)) || (l.n.length >= 4 && ev.includes(l.n))) {
          if (!best || Math.abs(l.n.length - ev.length) < Math.abs(best.n.length - ev.length)) best = l;
        }
      }
      if (best) return best;
    }
    return null;
  }
  // ---------- background calls (AI runs in the service worker; the key never enters the page) ----------
  function bg(type, payload) {
    if (hasChrome) {
      return new Promise((resolve) => chrome.runtime.sendMessage(Object.assign({ type }, payload), (r) =>
        resolve(r || { ok: false, error: (chrome.runtime.lastError && chrome.runtime.lastError.message) || 'No answer' })));
    }
    if (window.T2CAI) { // test harness without the extension runtime
      let s = {};
      try { s = JSON.parse(localStorage.getItem('t2c_ai') || '{}'); } catch (e) {}
      const p = type === 'T2C_AI_REWRITE' ? window.T2CAI.rewriteQuery(s, payload.question) : window.T2CAI.search(s, payload.question, payload.items);
      return p.then((result) => ({ ok: true, result }), (e) => ({ ok: false, error: e.message }));
    }
    return Promise.resolve({ ok: false, error: 'AI is not available here.' });
  }

  // ---------- search modes ----------
  const PLACEHOLDER = {
    exact: 'Exact value, e.g. an ID, a name or a price…',
    bm25: 'Keywords, e.g. refund status (ranked, local, free)',
    ai: 'Ask in plain language, e.g. “which APIs mention refunds?”',
  };
  const MODE_HELP = {
    exact: 'Exact: finds responses that contain the value as typed.',
    bm25: 'BM25: ranked keyword search over all responses, on this computer, no AI and no cost.',
    ai: '✨ AI: rewrites your question into keywords and related terms, retrieves candidates with BM25, then the model decides. Press <b>Enter</b>. <button data-act="aisettings">AI settings</button>',
  };
  function setSearchMode(m, silent) {
    settings.searchMode = PLACEHOLDER[m] ? m : 'bm25';
    const search = shadow.querySelector('.search');
    shadow.querySelector('.smode').value = settings.searchMode;
    shadow.querySelector('.sbox').classList.toggle('ai', settings.searchMode === 'ai');
    search.placeholder = PLACEHOLDER[settings.searchMode];
    if (silent) return;
    saveSettings();
    search.focus();
    setStatus(MODE_HELP[settings.searchMode]);
  }
  function runSearch() {
    const q = shadow.querySelector('.search').value.trim();
    if (!q) { setStatus('Type something to search.'); current = []; renderList(); return; }
    if (settings.searchMode === 'ai') return runSmartSearch(q);
    if (settings.searchMode === 'bm25') return runBm25(q);
    current = searchTexts([norm(q)], []);
    currentTitle = `Exact “${esc(q.slice(0, 80))}”`;
    setStatus(`${currentTitle}: <b>${current.length}</b> matching request(s).`);
    renderList();
  }
  const searchable = () => records.filter((r) => !r.binary && r.response);
  const bmCard = (h) => ({ rec: h.rec, bm25: true, score: h.pct, path: h.path, value: h.value, matched: h.matched });
  function termsRow(rw) {
    if (!rw) return '';
    const chips = rw.keywords.map((k) => `<span>${esc(k)}</span>`).join('') + rw.synonyms.map((k) => `<span class="syn">${esc(k)}</span>`).join('');
    return `<div class="terms" style="padding:6px 0 0">Searched for: ${chips}</div>`;
  }

  function runBm25(q) {
    const hits = T2CSearch.bm25(records, T2CSearch.queryTerms(q), 30);
    current = hits.map(bmCard);
    currentTitle = `BM25 “${esc(q.slice(0, 80))}”`;
    setStatus(`${currentTitle}: <b>${current.length}</b> ranked request(s) · ${searchable().length} responses searched locally`);
    if (!current.length) {
      $body.innerHTML = '<div class="empty"><h4>No response contains these words.</h4>Try other words, or switch to ✨ AI, which also searches related terms and meaning.</div>';
      return;
    }
    renderList();
  }

  // Pipeline: 1) AI rewrites the question  2) BM25 retrieves candidates  3) AI decides which candidates really match.
  async function runSmartSearch(question) {
    if (aiBusy) return;
    const docs = searchable();
    if (!docs.length) { setStatus('No API responses captured yet. Reload the page and try again.'); return; }
    aiBusy = true;
    const t = Date.now();
    let tokens = 0;
    const addUsage = (u) => { if (u) tokens += (u.prompt_tokens || 0) + (u.completion_tokens || 0); };
    currentTitle = `✨ “${esc(question.slice(0, 80))}”`;
    const authError = (e) => /model|key|401|403|settings|not available/i.test(e || '');

    // 1. Query rewrite
    setStatus(`<span class="spin"></span>${currentTitle}: 1/3 understanding the question…`);
    let rw = null;
    const r1 = await bg('T2C_AI_REWRITE', { question });
    if (r1 && r1.ok) { rw = r1.result; addUsage(rw.usage); }
    else if (authError(r1 && r1.error)) {
      aiBusy = false;
      setStatus(`${currentTitle}: <span style="color:#ffa8a8">${esc(r1.error)}</span> <button data-act="aisettings">AI settings</button>`);
      return;
    }

    // 2. BM25 retrieval with the original words (weight 1), AI keywords (1) and related terms (0.6)
    setStatus(`<span class="spin"></span>${currentTitle}: 2/3 ranking ${docs.length} responses with BM25…${termsRow(rw)}`);
    const hits = T2CSearch.bm25(records, T2CSearch.queryTerms(question, rw));
    const cand = hits.slice(0, 40);
    // Safety net for matches by meaning only (no shared word): also offer the newest other responses, briefly.
    const seen = new Set(cand.map((h) => h.rec.id));
    const extra = docs.filter((r) => !seen.has(r.id)).slice(-20).reverse();
    const allTerms = [...new Set([...terms(question), ...(rw ? [...rw.keywords, ...rw.synonyms] : []).map((x) => norm(x))])].filter((x) => x.length >= 2);
    const items = [...cand.map((h) => h.rec), ...extra].map((rec) => ({
      id: rec.id, method: rec.method, url: redactUrl(rec.url), status: rec.status, excerpt: excerpt(rec, allTerms).text,
    }));

    // 3. Decision
    setStatus(`<span class="spin"></span>${currentTitle}: 3/3 the model is checking ${items.length} candidate(s)…${termsRow(rw)}`);
    const q3 = rw ? `${question} (intent: ${rw.intent}; related terms: ${[...rw.keywords, ...rw.synonyms].join(', ')})` : question;
    const r3 = await bg('T2C_AI_SEARCH', { question: q3, items });
    aiBusy = false;
    const bmById = new Map(hits.map((h) => [h.rec.id, h]));
    const secs = ((Date.now() - t) / 1000).toFixed(1);
    if (!r3 || !r3.ok) {
      current = cand.slice(0, 30).map(bmCard);
      setStatus(`${currentTitle}: AI decision failed (<span style="color:#ffa8a8">${esc((r3 && r3.error) || 'no answer')}</span>). Showing <b>${current.length}</b> BM25 result(s)${rw ? ' with the expanded terms' : ''}. <button data-act="aisettings">AI settings</button>${termsRow(rw)}`);
      renderList();
      return;
    }
    addUsage(r3.result.usage);
    const byId = new Map(records.map((x) => [x.id, x]));
    current = r3.result.matches.filter((m) => byId.has(m.id)).map((m) => {
      const rec = byId.get(m.id);
      const leaf = findPath(rec, m.evidence);
      const bm = bmById.get(m.id);
      return { rec, ai: true, score: m.relevance, reason: m.reason, path: leaf ? leaf.path : null, value: leaf ? leaf.value : m.evidence,
        bm: bm ? bm.pct : null, matched: bm ? bm.matched : null };
    });
    setStatus(`${currentTitle}: <b>${current.length}</b> relevant request(s) · ${items.length} candidates from ${docs.length} responses · ${secs} s${tokens ? ' · ' + tokens + ' tokens' : ''}${rw ? '' : ' · (question rewrite skipped)'}${termsRow(rw)}`);
    if (!current.length) {
      $body.innerHTML = '<div class="empty"><h4>The AI found no response about this.</h4>Try other words, or reload the page so more requests are captured.</div>';
      return;
    }
    renderList();
  }

  // ---------- entry points ----------
  function toggle() {
    ensureUI();
    if (mode !== 'idle') { stopMode(); showPanel(); return; }
    startMode('pick');
  }
  if (hasChrome && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg) => { if (msg && msg.type === 'ACI_TOGGLE') toggle(); });
  } else {
    // Fallback when loaded without the extension runtime (test harness).
    document.addEventListener('keydown', (e) => { if (e.altKey && e.shiftKey && e.code === 'KeyC') toggle(); }, true);
  }
  window.__t2cTest = { runSearch, setSearchMode, runSmartSearch, excerpt, terms, toggle, startMode, showForElement, searchTexts, toCurl, toFetch, toPython, records, settings, norm,
    get shadow() { return shadow; } };
})();
