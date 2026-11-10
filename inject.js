// Runs in the page's MAIN world at document_start. Wraps fetch and XHR and
// posts each finished request (with response text) to the content script.
(() => {
  if (window.__aciInstalled) return;
  window.__aciInstalled = true;
  const MAX_BODY = 2 * 1024 * 1024;
  const post = (rec) => {
    try { window.postMessage({ __aci: true, rec }, '*'); } catch (e) {}
  };
  const abs = (u) => { try { return new URL(u, location.href).href; } catch (e) { return String(u); } };
  const headersToObj = (h) => {
    const out = {};
    if (!h) return out;
    try {
      if (h instanceof Headers) h.forEach((v, k) => { out[k] = v; });
      else if (Array.isArray(h)) h.forEach(([k, v]) => { out[k] = v; });
      else Object.keys(h).forEach((k) => { out[k] = String(h[k]); });
    } catch (e) {}
    return out;
  };
  const bodyToStr = (b) => {
    if (b == null) return null;
    if (typeof b === 'string') return b;
    if (b instanceof URLSearchParams) return b.toString();
    if (b instanceof FormData) {
      const parts = [];
      b.forEach((v, k) => parts.push(k + '=' + (typeof v === 'string' ? v : '[file]')));
      return { formData: parts };
    }
    return '[binary body]';
  };
  const textType = (ct) => !ct || /json|text|xml|javascript|graphql|x-www-form/i.test(ct);

  // ---- fetch ----
  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (input, init) {
      const p = origFetch.apply(this, arguments);
      try {
        const isReq = typeof Request !== 'undefined' && input instanceof Request;
        const url = abs(isReq ? input.url : input);
        const method = ((init && init.method) || (isReq && input.method) || 'GET').toUpperCase();
        const headers = Object.assign({}, isReq ? headersToObj(input.headers) : {}, headersToObj(init && init.headers));
        const body = bodyToStr(init && init.body);
        const credentials = (init && init.credentials) || (isReq && input.credentials) || 'same-origin';
        const t = Date.now();
        p.then((res) => {
          const ct = res.headers.get('content-type') || '';
          const base = { kind: 'fetch', method, url, headers, body, credentials, status: res.status, contentType: ct, time: t };
          if (!textType(ct)) { post(Object.assign(base, { response: '', binary: true, duration: Date.now() - t })); return; }
          res.clone().text().then((text) => {
            post(Object.assign(base, { response: text.slice(0, MAX_BODY), duration: Date.now() - t }));
          }).catch(() => {});
        }).catch((err) => {
          post({ kind: 'fetch', method, url, headers, body, credentials, status: 0, contentType: '',
            response: '', error: String(err && err.message || err), time: t, duration: Date.now() - t });
        });
      } catch (e) {}
      return p;
    };
  }

  // ---- XMLHttpRequest ----
  const XHR = window.XMLHttpRequest;
  if (XHR) {
    const open = XHR.prototype.open, send = XHR.prototype.send, setH = XHR.prototype.setRequestHeader;
    XHR.prototype.open = function (method, url) {
      this.__aci = { method: String(method || 'GET').toUpperCase(), url: abs(url), headers: {} };
      return open.apply(this, arguments);
    };
    XHR.prototype.setRequestHeader = function (k, v) {
      if (this.__aci) this.__aci.headers[k] = v;
      return setH.apply(this, arguments);
    };
    XHR.prototype.send = function (body) {
      const info = this.__aci;
      if (info) {
        info.body = bodyToStr(body);
        info.time = Date.now();
        this.addEventListener('loadend', () => {
          try {
            const ct = this.getResponseHeader('content-type') || '';
            let text = null;
            if (this.responseType === '' || this.responseType === 'text') text = this.responseText;
            else if (this.responseType === 'json') text = JSON.stringify(this.response);
            const binary = text == null || !textType(ct);
            post({ binary, error: this.status === 0 ? 'Network error' : undefined, duration: Date.now() - info.time, kind: 'xhr', method: info.method, url: info.url, headers: info.headers, body: info.body,
              credentials: this.withCredentials ? 'include' : 'same-origin', status: this.status,
              contentType: ct, response: binary ? '' : text.slice(0, MAX_BODY), time: info.time });
          } catch (e) {}
        });
      }
      return send.apply(this, arguments);
    };
  }
})();
