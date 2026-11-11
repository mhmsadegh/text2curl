# Text2Curl architecture

## 1. Components

```mermaid
flowchart LR
  subgraph Page["Web page (tab)"]
    direction TB
    APP["Site JavaScript<br/>fetch / XMLHttpRequest"]
    INJ["inject.js<br/>(MAIN world)<br/>wraps fetch + XHR"]
    APP --> INJ
  end
  subgraph CS["Content scripts (isolated world)"]
    direction TB
    SRCH["search.js<br/>tokenizer + BM25 index"]
    CONT["content.js<br/>capture store (last 500)<br/>picker · watch action<br/>search modes · panel (Shadow DOM)<br/>code generators · secret masking"]
    SRCH --- CONT
  end
  subgraph EXT["Extension (trusted)"]
    direction TB
    BG["background.js<br/>service worker<br/>toolbar / shortcut<br/>AI calls"]
    AI["ai.js<br/>OpenAI-compatible client<br/>model filter · query rewrite · decision"]
    OPT["options.html / options.js<br/>provider, key, model"]
    ST[("chrome.storage<br/>session: API key (default)<br/>local: base URL, model, prefs")]
    BG --- AI
    OPT --- AI
    OPT --> ST
    BG --> ST
  end
  LLM["AI provider<br/>(OpenRouter, OpenAI, Ollama…)"]

  INJ -- "window.postMessage<br/>{method, url, headers, body, status, timing, response}" --> CONT
  CONT -- "chrome.runtime.sendMessage<br/>question + excerpts (no headers, no cookies)" --> BG
  BG -- "HTTPS, Bearer key" --> LLM
```

| File | World | Job |
|---|---|---|
| `inject.js` | page (MAIN) | Wraps `fetch` and `XMLHttpRequest` at `document_start`; posts one record per finished request (text/JSON up to 2 MB, plus status, timing, errors). |
| `search.js` | content script | Tokenizer (Unicode, camelCase / snake_case split, Persian/Arabic normalisation, light English stemming) and BM25 index per response. |
| `content.js` | content script | Stores the last 500 records, picker, *Watch action*, the three search modes, the AI pipeline orchestration, the panel UI, code generators (cURL / fetch / Python), secret masking. |
| `background.js` | service worker | Toolbar / shortcut toggle. Runs every AI request, so the API key never enters a web page. Accepts messages only from its own extension. |
| `ai.js` | service worker + options page | OpenAI-compatible client: model listing, filtering and ranking; structured-output calls with fallback; query rewrite; decision. |
| `options.*` | extension page | Provider (Base URL), API key, model picker, connection test. |

## 2. Search modes

| Mode | Where it runs | Cost | Finds |
|---|---|---|---|
| **Exact** | local | free | Responses containing the value as typed (normalised: case, spaces, `1,250` = `1250`, Persian digits). |
| **BM25** | local | free | Ranked keyword search. Matches words in values **and** field names (`ticket status` → `$.tickets[0].status`). |
| **✨ AI** | local + your provider | tokens | Meaning: related terms, synonyms, abbreviations, translations, then a model decides. |

## 3. AI pipeline (retrieve, then decide)

```mermaid
sequenceDiagram
  participant U as User
  participant C as content.js
  participant S as search.js (BM25)
  participant B as background.js
  participant M as Model
  U->>C: question + Enter
  C->>B: 1. T2C_AI_REWRITE(question)
  B->>M: chat (JSON schema: intent, keywords[], synonyms[])
  M-->>B: {intent, keywords, synonyms}
  B-->>C: rewrite
  C->>S: 2. bm25(question words ×1, keywords ×1, synonyms ×0.6)
  S-->>C: ranked responses + best JSON field
  Note over C: candidates = top 40 by BM25<br/>+ 20 newest others (meaning-only safety net)<br/>excerpt = start + windows around every term
  C->>B: 3. T2C_AI_SEARCH(question + intent + terms, candidates)
  B->>M: chat (JSON schema: matches[{id, relevance, reason, evidence}])
  M-->>B: matches
  B-->>C: matches
  Note over C: evidence quote → exact JSON path<br/>show relevance, BM25 rank, reason, path
```

### Step 1: query rewrite
The model turns the question into `intent`, `keywords` (exact data terms, codes and abbreviations kept as written)
and `synonyms` (variants, plural/singular, abbreviation ↔ full form, English/Persian translations, likely JSON field names).
If this step fails for a non-auth reason, the pipeline continues with the original words.

### Step 2: BM25 retrieval (local)
- Document = one response. JSON leaves are indexed as `"<last key> <value>"`.
- Score: `Σ w(t) · idf(t) · tf·(k1+1) / (tf + k1·(1 − b + b·len/avglen))`, `k1 = 1.2`, `b = 0.75`,
  `idf = ln(1 + (N − df + 0.5)/(df + 0.5))`.
- Weights: original words 1.0, AI keywords 1.0, AI synonyms 0.6.
- Best field: the JSON leaf covering the most idf-weighted query terms → reported path.

### Step 3: decision
- Candidates: top 40 BM25 hits plus the 20 newest other responses (so a match by meaning only still has a chance).
- Each candidate sent as `id, method, URL (secrets masked), status, excerpt` (≈ 0.9 to 3 KB).
- Batches of ≈ 60k characters, at most 4.
- The model must return `relevance`, a one-line `reason`, and an exact `evidence` quote; Text2Curl maps the quote back to a JSON path so every answer can be checked.
- If the decision fails, the BM25 results (with the expanded terms) are shown instead.

### Structured output ("type-safe" answers)
Every AI call asks for an exact JSON schema (`response_format: json_schema, strict: true`).
If the model or provider rejects it (HTTP 400/422) Text2Curl retries with `json_object`, then plain text,
and parses the first JSON object in the answer. Auth, quota and network errors stop immediately. Temperature is 0.

### Model selection
`GET {baseUrl}/models`, then:
1. **Hide** models that cannot read text and answer in text: by provider metadata (input/output modalities, `type`,
   `capabilities.completion_chat`) and by name (embedding, rerank, whisper / tts / audio / realtime, image and video
   generators, moderation / guard).
2. **Rank:** JSON-schema support → JSON mode → unknown → none; then context ≥ 32k; then price.
3. **Recommend:** cheapest paid model with JSON schema and ≥ 64k context.

## 4. Security and privacy

| Concern | Design |
|---|---|
| API key exposure to pages | Key is read and used only in the service worker; pages and content scripts never receive it. |
| Key at rest | Default `chrome.storage.session` (memory, erased on browser close, `TRUSTED_CONTEXTS` only). Optional "Remember" → `chrome.storage.local`. Never `storage.sync`. "Delete key" button. |
| Message spoofing | Background accepts messages only where `sender.id === chrome.runtime.id`. |
| Data sent to the AI | Only when the user presses Search in AI mode. Question + short excerpts + URLs with secret query params masked. No headers, no cookies. |
| Host access for the AI | `optional_host_permissions`, requested for the chosen provider's origin only, when the user loads models / saves. |
| Secrets in copied code | "Hide secrets" (default on) masks auth headers, cookies, API keys, tokens and passwords in headers, URL and body. |
| Page styles / scripts | Panel lives in a Shadow DOM; the capture store is in the isolated world. |

## 5. Data limits

| Item | Limit |
|---|---|
| Captured requests per tab | 500 (oldest dropped) |
| Response text stored | 2 MB each |
| JSON leaves indexed | 20 000 per response |
| AI candidates | 40 BM25 + 20 recent |
| AI batch | ≈ 60k characters, max 4 batches |
