// Text2Curl AI module. Works with any OpenAI-compatible API (OpenRouter, OpenAI, Groq,
// Together, DeepSeek, Mistral, local Ollama / LM Studio, ...).
// Loaded by background.js (importScripts) and by test/harness.html.
/* global self */
(function (root) {
  const DEFAULTS = { baseUrl: 'https://openrouter.ai/api/v1', apiKey: '', model: '' };

  const PRESETS = [
    { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
    { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
    { name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1' },
    { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1' },
    { name: 'Mistral', baseUrl: 'https://api.mistral.ai/v1' },
    { name: 'Together', baseUrl: 'https://api.together.xyz/v1' },
    { name: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1' },
    { name: 'LM Studio (local)', baseUrl: 'http://localhost:1234/v1' },
  ];

  const trimBase = (u) => String(u || '').trim().replace(/\/+$/, '');
  const headers = (s) => {
    const h = { 'Content-Type': 'application/json' };
    if (s.apiKey) h.Authorization = 'Bearer ' + s.apiKey;
    if (/openrouter\.ai/.test(s.baseUrl)) { h['HTTP-Referer'] = 'https://github.com/mhmsadegh/text2curl'; h['X-Title'] = 'Text2Curl'; }
    return h;
  };

  // ---------- model list with smart filtering ----------
  // Models that cannot read text and answer in text are useless here.
  const NOT_CHAT = /(embed|embedding|bge-|e5-|gte-|nomic-embed|rerank|whisper|tts|transcri|speech|audio|realtime|dall-e|gpt-image|image-gen|imagen|stable-diffusion|sdxl|flux|midjourney|moderation|guard|safety|omni-moderation|davinci-00|babbage|ada-00|text-similarity|search-(doc|query)|code-search|clip|vision-embed|veo|sora|lyria)/i;

  function classify(m) {
    const id = m.id || '';
    const arch = m.architecture || {};
    const inMods = arch.input_modalities || (arch.modality ? arch.modality.split('->')[0].split('+') : null);
    const outMods = arch.output_modalities || (arch.modality ? arch.modality.split('->')[1].split('+') : null);
    if (NOT_CHAT.test(id) || NOT_CHAT.test(m.name || '')) return null;
    if (outMods && !outMods.includes('text')) return null;
    if (inMods && !inMods.includes('text')) return null;
    if (m.type && !/chat|llm|language/i.test(m.type)) return null;             // Together, LM Studio
    if (m.capabilities && m.capabilities.completion_chat === false) return null; // Mistral
    const params = m.supported_parameters || [];
    const structured = params.includes('structured_outputs') ? 'schema'
      : params.includes('response_format') ? 'json' : (params.length ? 'none' : 'unknown');
    const price = m.pricing && m.pricing.prompt != null ? Number(m.pricing.prompt) * 1e6 : null; // $ per 1M input tokens
    const ctx = m.context_length || m.max_context_length || (m.top_provider && m.top_provider.context_length) || null;
    return { id, name: m.name || id, structured, price, ctx, free: /:free$/.test(id) || price === 0 };
  }

  // Ranking: structured output first (typesafe answers), then enough context, then cheaper.
  function rankModels(list) {
    const sRank = { schema: 0, json: 1, unknown: 2, none: 3 };
    const ok = list.map(classify).filter(Boolean);
    ok.sort((a, b) =>
      sRank[a.structured] - sRank[b.structured] ||
      ((b.ctx || 0) >= 32000) - ((a.ctx || 0) >= 32000) ||
      (a.price == null) - (b.price == null) || (a.price || 0) - (b.price || 0) ||
      a.id.localeCompare(b.id));
    // Recommend: structured output, >= 64k context, cheapest paid model (free models are often rate-limited).
    const rec = ok.find((m) => m.structured === 'schema' && (m.ctx || 0) >= 64000 && !m.free && m.price != null)
      || ok.find((m) => m.structured !== 'none') || ok[0];
    if (rec) rec.recommended = true;
    return { models: ok, hidden: list.length - ok.length };
  }

  async function listModels(settings) {
    const s = Object.assign({}, DEFAULTS, settings);
    const res = await fetch(trimBase(s.baseUrl) + '/models', { headers: headers(s) });
    if (!res.ok) throw new Error(`Model list failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const j = await res.json();
    const list = Array.isArray(j) ? j : (j.data || j.models || []);
    return rankModels(list);
  }

  // ---------- AI search ----------
  const SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['matches'],
    properties: {
      matches: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'relevance', 'reason', 'evidence'],
          properties: {
            id: { type: 'integer', description: 'The request id from the input' },
            relevance: { type: 'integer', minimum: 0, maximum: 100 },
            reason: { type: 'string', description: 'One short sentence: why this response matches' },
            evidence: { type: 'string', description: 'An exact short quote (max 120 chars) copied from the response that proves the match' },
          },
        },
      },
    },
  };

  const SYSTEM = `You search captured HTTP API responses for the user.
You get a question and a list of requests (id, method, url, status, response excerpt).
Return every request whose RESPONSE is relevant to the question, ordered by relevance (0-100).
Rules:
- Judge by the response content; use the URL only as a hint.
- "evidence" must be copied exactly from the response excerpt, short (max 120 characters).
- Do not invent ids. If nothing is relevant, return {"matches": []}.
- Answer only with JSON matching: {"matches":[{"id":int,"relevance":int,"reason":string,"evidence":string}]}.`;

  async function chat(s, messages, mode, schema, schemaName) {
    const body = { model: s.model, messages, temperature: 0 };
    if (mode === 'schema') body.response_format = { type: 'json_schema', json_schema: { name: schemaName || 'api_matches', strict: true, schema: schema || SCHEMA } };
    else if (mode === 'json') body.response_format = { type: 'json_object' };
    const res = await fetch(trimBase(s.baseUrl) + '/chat/completions', { method: 'POST', headers: headers(s), body: JSON.stringify(body) });
    const text = await res.text();
    if (!res.ok) { const e = new Error(`AI request failed: HTTP ${res.status} ${text.slice(0, 300)}`); e.status = res.status; throw e; }
    const j = JSON.parse(text);
    const content = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    if (!content) throw new Error('AI returned an empty answer');
    return { content, usage: j.usage || null };
  }

  function parseMatches(content) {
    let t = String(content).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a >= 0 && b > a) t = t.slice(a, b + 1);
    const j = JSON.parse(t);
    const arr = Array.isArray(j) ? j : (j.matches || []);
    return arr.filter((m) => m && Number.isFinite(Number(m.id))).map((m) => ({
      id: Number(m.id), relevance: Math.max(0, Math.min(100, Number(m.relevance) || 0)),
      reason: String(m.reason || ''), evidence: String(m.evidence || ''),
    }));
  }

  function parseJson(content) {
    let t = String(content).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a >= 0 && b > a) t = t.slice(a, b + 1);
    return JSON.parse(t);
  }

  // ---------- step 1: query rewrite ----------
  const REWRITE_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['intent', 'keywords', 'synonyms'],
    properties: {
      intent: { type: 'string', description: 'One sentence: what the user is looking for' },
      keywords: { type: 'array', items: { type: 'string' }, description: 'Core search terms, max 12' },
      synonyms: { type: 'array', items: { type: 'string' }, description: 'Related terms, variants, translations, likely JSON field names, max 16' },
    },
  };
  const REWRITE_SYSTEM = `You turn a user's question into search terms for finding HTTP API responses (mostly JSON).
Return:
- intent: one short sentence describing what to find.
- keywords: the core terms exactly as they would appear in data (names, codes, abbreviations kept as written).
- synonyms: related words, spelling variants, singular/plural, abbreviation <-> full form, English/Persian translations
  when useful, and likely JSON field names (e.g. "price" -> "amount", "cost", "unit_price").
Keep each term short (1-3 words). Do not add unrelated terms. Answer only with JSON: {"intent":string,"keywords":[string],"synonyms":[string]}.`;

  async function rewriteQuery(settings, question) {
    const s = Object.assign({}, DEFAULTS, settings);
    if (!s.model) throw new Error('Choose a model in the Text2Curl AI settings first.');
    const r = await askStructured(s, [
      { role: 'system', content: REWRITE_SYSTEM },
      { role: 'user', content: question },
    ], REWRITE_SCHEMA, 'query_rewrite', (c) => {
      const j = parseJson(c);
      const list = (x) => (Array.isArray(x) ? x : []).map(String).map((v) => v.trim()).filter(Boolean).slice(0, 16);
      return { intent: String(j.intent || ''), keywords: list(j.keywords), synonyms: list(j.synonyms) };
    });
    return Object.assign(r.value, { usage: r.usage, mode: r.mode });
  }

  // Structured output first (typesafe); if the provider/model rejects it, fall back step by step.
  async function askStructured(s, messages, schema, name, parse) {
    const modes = s.structured === 'json' ? ['json', 'plain'] : s.structured === 'none' ? ['plain'] : ['schema', 'json', 'plain'];
    let last;
    for (const mode of modes) {
      try {
        const r = await chat(s, messages, mode, schema, name);
        return { value: parse(r.content), usage: r.usage, mode };
      } catch (e) {
        last = e;
        if (e.status && e.status !== 400 && e.status !== 422) throw e;   // auth, quota, network: stop
      }
    }
    throw last;
  }

  async function askOnce(s, messages) {
    const modes = s.structured === 'json' ? ['json', 'plain'] : s.structured === 'none' ? ['plain'] : ['schema', 'json', 'plain'];
    let last;
    for (const mode of modes) {
      try {
        const r = await chat(s, messages, mode);
        return { matches: parseMatches(r.content), usage: r.usage, mode };
      } catch (e) {
        last = e;
        if (e.status && e.status !== 400 && e.status !== 422) throw e;   // auth, quota, network: stop
      }
    }
    throw last;
  }

  // items: [{id, method, url, status, excerpt}] already trimmed by the content script.
  async function search(settings, question, items) {
    const s = Object.assign({}, DEFAULTS, settings);
    if (!s.model) throw new Error('Choose a model in the Text2Curl AI settings first.');
    const MAX_CHARS = s.maxChars || 60000;
    const batches = [];
    let cur = [], size = 0;
    for (const it of items) {
      const block = `### id=${it.id} ${it.method} ${it.url} (status ${it.status})\n${it.excerpt}\n`;
      if (size + block.length > MAX_CHARS && cur.length) { batches.push(cur); cur = []; size = 0; }
      cur.push(block); size += block.length;
    }
    if (cur.length) batches.push(cur);
    const all = [];
    const usage = { prompt_tokens: 0, completion_tokens: 0 };
    let mode = null;
    for (const b of batches.slice(0, s.maxBatches || 4)) {
      const r = await askOnce(s, [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `Question: ${question}\n\nRequests:\n${b.join('\n')}` },
      ]);
      mode = r.mode;
      all.push(...r.matches);
      if (r.usage) { usage.prompt_tokens += r.usage.prompt_tokens || 0; usage.completion_tokens += r.usage.completion_tokens || 0; }
    }
    const valid = new Set(items.map((i) => i.id));
    const best = new Map();
    all.filter((m) => valid.has(m.id)).forEach((m) => { if (!best.has(m.id) || best.get(m.id).relevance < m.relevance) best.set(m.id, m); });
    return {
      matches: [...best.values()].sort((a, b) => b.relevance - a.relevance),
      batches: Math.min(batches.length, s.maxBatches || 4), skippedBatches: Math.max(0, batches.length - (s.maxBatches || 4)),
      usage, mode,
    };
  }

  root.T2CAI = { DEFAULTS, PRESETS, listModels, rankModels, classify, search, rewriteQuery, parseMatches, SCHEMA, REWRITE_SCHEMA };
})(typeof self !== 'undefined' ? self : window);
