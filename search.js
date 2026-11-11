// Text2Curl local search engine: BM25 over captured API responses.
// Runs in the content-script world (loaded before content.js). No network, no AI.
//
// Each response is one document. For JSON, every leaf is indexed as "<key> <value>",
// so a query can match field names (e.g. "price") as well as values. Each leaf also
// keeps its own token set, so the best-matching JSON path can be reported.
(function (root) {
  const K1 = 1.2;
  const B = 0.75;
  const MAX_LEAVES = 20000;
  const STOP = new Set(('the a an and or of in on at to for from with about which what where who whom is are was were be been ' +
    'api apis response responses request requests that this these those any all does do did talk talks talking mention mentions ' +
    'mentioned contain contains containing show find me my it its they them there here into by as than then please give list ' +
    'related regarding something anything').split(' '));

  const norm = (s) => String(s).normalize('NFKC')
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06F0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[ي]/g, 'ی').replace(/[ك]/g, 'ک')   // Arabic ya/kaf -> Persian
    .replace(/‌/g, ' ');                                         // zero-width non-joiner

  // Light English stemmer: enough to join plural / -ing / -ed forms.
  function stem(t) {
    if (t.length <= 4 || /\d/.test(t) || !/^[a-z]+$/.test(t)) return t;
    if (t.endsWith('ies') && t.length > 5) return t.slice(0, -3) + 'y';
    if (t.endsWith('sses')) return t.slice(0, -2);
    if (t.endsWith('ing') && t.length > 6) return t.slice(0, -3);
    if (t.endsWith('ed') && t.length > 5) return t.slice(0, -2);
    if (t.endsWith('es') && /(ch|sh|x|z)es$/.test(t)) return t.slice(0, -2);
    if (t.endsWith('s') && !t.endsWith('ss') && !t.endsWith('us')) return t.slice(0, -1);
    return t;
  }

  // "orderTotal", "order_total", "Order-Total" -> ["order", "total"]
  function tokenize(text, keepStop) {
    const s = norm(text).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
    const out = [];
    for (const raw of s.split(/[^\p{L}\p{N}]+/u)) {
      if (!raw) continue;
      if (raw.length < 2 && !/\d/.test(raw)) continue;
      if (!keepStop && STOP.has(raw)) continue;
      out.push(stem(raw));
    }
    return out;
  }

  function leaves(v, path, out) {
    if (out.length > MAX_LEAVES) return out;
    if (v === null || typeof v !== 'object') {
      if (v !== null && v !== undefined && v !== '') out.push({ path, value: String(v) });
      return out;
    }
    if (Array.isArray(v)) v.forEach((x, i) => leaves(x, path + '[' + i + ']', out));
    else Object.keys(v).forEach((k) => leaves(v[k], path + (/^[A-Za-z_$][\w$]*$/.test(k) ? '.' + k : '[' + JSON.stringify(k) + ']'), out));
    return out;
  }
  const lastKey = (path) => { const m = path.match(/(?:\.([\w$]+)|\["(.+?)"\])$/); return m ? (m[1] || m[2]) : ''; };

  // Build (once per response) the term frequencies and per-field token sets.
  function docOf(rec) {
    if (rec._bm) return rec._bm;
    const tf = new Map();
    const fields = [];
    const add = (toks) => toks.forEach((t) => tf.set(t, (tf.get(t) || 0) + 1));
    if (rec.json !== undefined) {
      for (const l of leaves(rec.json, '$', [])) {
        const toks = tokenize(lastKey(l.path) + ' ' + l.value);
        add(toks);
        fields.push({ path: l.path, value: l.value, toks: new Set(toks) });
      }
    } else {
      const text = String(rec.response || '').replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
      add(tokenize(text));
      fields.push({ path: '(raw text)', value: text.replace(/\s+/g, ' ').slice(0, 300), toks: new Set(tokenize(text)) });
    }
    let len = 0;
    tf.forEach((n) => { len += n; });
    rec._bm = { tf, len: len || 1, fields };
    return rec._bm;
  }

  // terms: [{t: "refund", w: 1}] (already tokenized). Returns ranked hits.
  function bm25(records, terms, limit) {
    const docs = records.filter((r) => !r.binary && r.response).map((r) => ({ rec: r, d: docOf(r) }));
    const N = docs.length;
    if (!N || !terms.length) return [];
    const avg = docs.reduce((a, x) => a + x.d.len, 0) / N;
    // merge duplicate terms, keep the highest weight
    const q = new Map();
    terms.forEach(({ t, w }) => { if (t && (!q.has(t) || q.get(t) < w)) q.set(t, w); });
    const idf = new Map();
    q.forEach((w, t) => {
      let df = 0;
      docs.forEach((x) => { if (x.d.tf.has(t)) df++; });
      idf.set(t, Math.log(1 + (N - df + 0.5) / (df + 0.5)));
    });
    const hits = [];
    for (const { rec, d } of docs) {
      let score = 0;
      const matched = [];
      q.forEach((w, t) => {
        const f = d.tf.get(t);
        if (!f) return;
        matched.push(t);
        score += w * idf.get(t) * (f * (K1 + 1)) / (f + K1 * (1 - B + B * d.len / avg));
      });
      if (!score) continue;
      // Best field: the leaf that covers the most (weighted) query terms; shorter wins ties.
      let best = null, bestW = 0;
      for (const f of d.fields) {
        let fw = 0;
        q.forEach((w, t) => { if (f.toks.has(t)) fw += w * idf.get(t); });
        if (fw > bestW || (fw === bestW && fw > 0 && best && f.value.length < best.value.length)) { best = f; bestW = fw; }
      }
      hits.push({ rec, score, matched, path: best ? best.path : null, value: best ? best.value : null });
    }
    hits.sort((a, b) => b.score - a.score || b.rec.id - a.rec.id);
    const top = hits.length ? hits[0].score : 1;
    hits.forEach((h) => { h.pct = Math.max(1, Math.round(100 * h.score / top)); });
    return limit ? hits.slice(0, limit) : hits;
  }

  // Query text -> weighted terms.  extra: { keywords: [], synonyms: [] } from the AI rewrite.
  function queryTerms(question, extra) {
    const out = [];
    tokenize(question).forEach((t) => out.push({ t, w: 1 }));
    if (extra) {
      (extra.keywords || []).forEach((k) => tokenize(k).forEach((t) => out.push({ t, w: 1 })));
      (extra.synonyms || []).forEach((k) => tokenize(k).forEach((t) => out.push({ t, w: 0.6 })));
    }
    return out;
  }

  root.T2CSearch = { tokenize, stem, bm25, queryTerms, docOf, STOP };
})(typeof window !== 'undefined' ? window : self);
