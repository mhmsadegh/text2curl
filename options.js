/* global T2CAI */
(() => {
  const $ = (id) => document.getElementById(id);
  const hasChrome = typeof chrome !== 'undefined' && chrome.storage;
  let models = [];
  let structuredOf = {};

  // The API key is kept only inside the extension:
  //  - default: chrome.storage.session (memory only, erased when the browser closes, not readable by web pages)
  //  - "Remember" on: chrome.storage.local (this browser profile only, never synced)
  // Base URL and model are not secret and stay in chrome.storage.local.
  const store = {
    get: () => new Promise((r) => {
      if (!hasChrome) return r(JSON.parse(localStorage.getItem('t2c_ai') || '{}'));
      chrome.storage.local.get(['ai', 'aiKey'], (l) => {
        const ai = l.ai || {};
        const done = (key) => r(Object.assign({}, ai, { apiKey: key || '' }));
        if (l.aiKey) return done(l.aiKey);
        if (chrome.storage.session) chrome.storage.session.get('aiKey', (s) => done(s.aiKey)); else done('');
      });
    }),
    set: (ai) => new Promise((r) => {
      if (!hasChrome) { localStorage.setItem('t2c_ai', JSON.stringify(ai)); return r(); }
      const { apiKey, ...rest } = ai;
      const remember = $('remember').checked;
      chrome.storage.local.set({ ai: Object.assign(rest, { remember }) }, () => {
        if (remember) chrome.storage.session.remove('aiKey', () => chrome.storage.local.set({ aiKey: apiKey }, r));
        else chrome.storage.local.remove('aiKey', () => chrome.storage.session.set({ aiKey: apiKey }, r));
      });
    }),
  };
  $('forget').onclick = () => {
    $('key').value = '';
    if (hasChrome) { chrome.storage.local.remove('aiKey'); chrome.storage.session.remove('aiKey'); } else localStorage.removeItem('t2c_ai');
    msg('savemsg', 'API key deleted ✓', 'ok');
  };
  const current = () => ({ baseUrl: $('base').value.trim() || T2CAI.DEFAULTS.baseUrl, apiKey: $('key').value.trim(), model: $('model').value.trim() });
  const msg = (el, text, cls) => { $(el).textContent = text; $(el).className = 'msg ' + (cls || ''); };

  // The extension needs permission to call the provider's host. Must be asked inside the click.
  function askPermission(baseUrl) {
    if (!hasChrome || !chrome.permissions) return Promise.resolve(true);
    let origin;
    try { origin = new URL(baseUrl).origin + '/*'; } catch (e) { return Promise.resolve(false); }
    return chrome.permissions.request({ origins: [origin] }).catch(() => false);
  }

  T2CAI.PRESETS.forEach((p) => {
    const b = document.createElement('button');
    b.className = 'chip'; b.textContent = p.name; b.title = p.baseUrl;
    b.onclick = () => { $('base').value = p.baseUrl; models = []; render(); };
    $('presets').appendChild(b);
  });

  $('showkey').onclick = () => { const k = $('key'); k.type = k.type === 'password' ? 'text' : 'password'; $('showkey').textContent = k.type === 'password' ? 'Show' : 'Hide'; };

  const fmtPrice = (p) => (p == null ? '' : p === 0 ? 'free' : '$' + (p < 0.1 ? p.toFixed(3) : p.toFixed(2)) + ' / 1M in');
  const fmtCtx = (c) => (c ? (c >= 1000 ? Math.round(c / 1000) + 'k' : c) + ' ctx' : '');

  function render() {
    const box = $('models');
    if (!models.length) { box.innerHTML = '<div class="m"><span class="meta">Press “Load models”.</span></div>'; return; }
    const q = $('fText').value.trim().toLowerCase();
    const list = models.filter((m) => (!$('fSchema').checked || m.structured === 'schema') && (!$('fFree').checked || m.free) &&
      (!q || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)));
    box.innerHTML = list.slice(0, 400).map((m) => `<div class="m ${m.id === $('model').value ? 'sel' : ''}" data-id="${m.id.replace(/"/g, '&quot;')}">
        <span class="id">${m.id}</span>
        <span>${m.recommended ? '<span class="tag rec">recommended</span>' : ''}${m.structured === 'schema' ? '<span class="tag schema">JSON schema</span>' : m.structured === 'json' ? '<span class="tag">JSON mode</span>' : ''}${m.free ? '<span class="tag">free</span>' : ''}</span>
        <span class="meta">${[m.name !== m.id ? m.name : '', fmtCtx(m.ctx), fmtPrice(m.price)].filter(Boolean).join(' · ')}</span>
      </div>`).join('') || '<div class="m"><span class="meta">No model matches the filter.</span></div>';
  }
  ['fSchema', 'fFree'].forEach((id) => ($(id).onchange = render));
  $('fText').oninput = render;
  $('models').onclick = (e) => {
    const row = e.target.closest('.m[data-id]');
    if (!row) return;
    $('model').value = row.dataset.id;
    render();
  };

  $('load').onclick = async () => {
    const s = current();
    const perm = askPermission(s.baseUrl);
    msg('loadmsg', 'Loading…');
    if (!(await perm)) return msg('loadmsg', 'Permission to contact ' + s.baseUrl + ' was not granted.', 'bad');
    try {
      const r = await T2CAI.listModels(s);
      models = r.models;
      structuredOf = Object.fromEntries(models.map((m) => [m.id, m.structured]));
      const rec = models.find((m) => m.recommended);
      if (!$('model').value && rec) $('model').value = rec.id;
      msg('loadmsg', `${models.length} chat models · ${r.hidden} hidden (embedding, image, audio, moderation…)`, 'ok');
      render();
    } catch (e) { msg('loadmsg', e.message, 'bad'); }
  };

  async function save() {
    const s = current();
    if (!s.model) { msg('savemsg', 'Choose a model first.', 'bad'); return null; }
    s.structured = structuredOf[s.model] || (await store.get()).structured || 'unknown';
    await store.set(s);
    return s;
  }
  $('save').onclick = async () => {
    const perm = askPermission(current().baseUrl);
    if (!(await perm)) return msg('savemsg', 'Permission to contact the provider was not granted.', 'bad');
    if (await save()) msg('savemsg', 'Saved ✓', 'ok');
  };
  $('test').onclick = async () => {
    const perm = askPermission(current().baseUrl);
    if (!(await perm)) return msg('savemsg', 'Permission to contact the provider was not granted.', 'bad');
    const s = await save();
    if (!s) return;
    msg('savemsg', 'Testing…');
    const t = Date.now();
    try {
      const r = await T2CAI.search(s, 'Which response mentions a cat?', [
        { id: 1, method: 'GET', url: 'https://example.test/api/pets', status: 200, excerpt: '{"pets":[{"name":"Tom","species":"cat"}]}' },
        { id: 2, method: 'GET', url: 'https://example.test/api/cars', status: 200, excerpt: '{"cars":[{"name":"Model 3"}]}' },
      ]);
      const okMatch = r.matches.length && r.matches[0].id === 1;
      msg('savemsg', okMatch ? `Works ✓ (${Date.now() - t} ms, ${r.mode === 'schema' ? 'JSON schema' : r.mode === 'json' ? 'JSON mode' : 'plain text'} answers)`
        : 'Connected, but the model answered wrongly. Try a stronger model.', okMatch ? 'ok' : 'bad');
    } catch (e) { msg('savemsg', e.message, 'bad'); }
  };

  store.get().then((ai) => {
    $('base').value = ai.baseUrl || T2CAI.DEFAULTS.baseUrl;
    $('key').value = ai.apiKey || '';
    $('model').value = ai.model || '';
    $('remember').checked = !!ai.remember;
    if (ai.model && ai.structured) structuredOf[ai.model] = ai.structured;
  });
})();
