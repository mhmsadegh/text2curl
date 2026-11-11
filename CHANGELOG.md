# Changelog

## 1.4.0
- **Three search modes** in one box: **Exact**, **BM25** (ranked keyword search, local and free; matches values and JSON
  field names), **✨ AI**. A **Search** button; BM25 and Exact also search as you type.
- **Smarter AI search, retrieve then decide**: 1) the model rewrites the question into keywords and related terms,
  2) local BM25 ranks all responses with them, 3) the model checks the top candidates and returns relevance, reason and evidence.
  Falls back to BM25 results if the AI step fails.
- Results show the matched terms and, for AI results, the BM25 rank too.
- New `ARCHITECTURE.md` with the full design.

## 1.3.0
- **AI search (optional)**: ask in plain language which API responses talk about something. Works with any OpenAI-compatible
  provider (OpenRouter, OpenAI, Groq, DeepSeek, Mistral, Together, Ollama, LM Studio) with your own Base URL and key.
- **Smart model list**: embedding, image, audio, speech, moderation and rerank models are hidden; models with structured
  output (JSON schema) are ranked first and one is recommended.
- **Type-safe answers**: JSON schema output with automatic fallback to JSON mode and plain text.
- AI results show relevance, a one-line reason and the JSON path of the quoted evidence.
- **API key safety**: kept only inside the extension, in memory by default (erased when the browser closes), optional
  "Remember", "Delete key"; AI calls run in the background worker; the key never reaches the page.
- Settings page (Options).

## 1.2.0
- **Watch action**: click a button, link or filter and see every request it sends (2.5 s window).
- **Hide secrets** switch (on by default): masks `Authorization`, cookies, tokens, API keys and passwords in headers, URL query and JSON/form body.
- **Search box**: type a value and find which response contains it.
- **Code formats**: cURL, JavaScript (`fetch`) and Python (`requests`), with one-click copy.
- **Timing and errors**: response time and status on every request; an **Errors** view lists 4xx/5xx and network failures. **All** lists every captured request.
- **Images**: click an image to find the response that contains its URL or file name.
- **Copy JSON path** button.
- Redesigned panel.
- Fix: text next to the clicked element can no longer create a match on its own.

## 1.1.0
- **Show response / Copy response** with the matched value highlighted.
- New name (Text2Curl) and logo.

## 1.0.0
- Click text → matching fetch/XHR request as `curl`, JSON path, ranked results.
