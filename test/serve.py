# Local server for the Text2Curl test page.
#   python test/serve.py 8765
# Serves the repo folder, accepts POST for the sample APIs, and offers a MOCK
# OpenAI-compatible AI endpoint at http://127.0.0.1:8765/mock/v1 for testing the
# AI search without a real API key. The mock is NOT an AI: it just reports the
# requests whose excerpt contains a word of the question.
import http.server
import json
import re
import sys

STOP = set('the a an and or of in on at to for from with about which what where who is are was were be '
           'apis api response responses request requests that this talk talks talking mention mentions'.split())

MODELS = {"data": [
    {"id": "mock/chat-schema", "name": "Mock chat (JSON schema)", "context_length": 128000,
     "architecture": {"input_modalities": ["text"], "output_modalities": ["text"]},
     "pricing": {"prompt": "0.00000015"}, "supported_parameters": ["response_format", "structured_outputs"]},
    {"id": "mock/chat-noschema", "name": "Mock chat (rejects JSON schema)", "context_length": 32000,
     "architecture": {"input_modalities": ["text"], "output_modalities": ["text"]},
     "pricing": {"prompt": "0"}, "supported_parameters": ["temperature"]},
    {"id": "openai/text-embedding-3-small", "name": "Embedding", "architecture": {"input_modalities": ["text"], "output_modalities": ["embeddings"]}},
    {"id": "black-forest-labs/flux-1", "name": "Image model", "architecture": {"input_modalities": ["text"], "output_modalities": ["image"]}},
    {"id": "openai/whisper-1", "name": "Speech to text"},
    {"id": "openai/omni-moderation-latest", "name": "Moderation"},
]}


class H(http.server.SimpleHTTPRequestHandler):
    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self._json(204, {})

    def do_GET(self):
        if self.path.startswith('/mock/v1/models'):
            return self._json(200, MODELS)
        return super().do_GET()

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get('Content-Length') or 0))
        if self.path.startswith('/mock/v1/chat/completions'):
            req = json.loads(raw)
            rf = (req.get('response_format') or {}).get('type')
            if req.get('model') == 'mock/chat-noschema' and rf in ('json_schema', 'json_object'):
                return self._json(400, {"error": {"message": "response_format is not supported by this model"}})
            user = req['messages'][-1]['content']
            system = req['messages'][0]['content']
            if system.startswith("You turn a user's question"):
                # Mock query rewrite: question words + a tiny fixed synonym table.
                words = [w for w in re.findall(r'\w+', user.lower()) if len(w) >= 2 and w not in STOP]
                syn = {'refund': ['reimbursement', 'chargeback', 'money back'], 'refunds': ['reimbursement', 'chargeback'],
                       'price': ['amount', 'cost'], 'weather': ['rain', 'forecast']}
                out = {"intent": "Find responses about " + ' '.join(words), "keywords": words,
                       "synonyms": [s for w in words for s in syn.get(w, [])]}
                content = json.dumps(out)
                if rf is None:
                    content = "```json\n" + content + "\n```"
                return self._json(200, {"choices": [{"message": {"role": "assistant", "content": content}}],
                                        "usage": {"prompt_tokens": len(user) // 4, "completion_tokens": len(content) // 4}})
            question = user.split('\n', 1)[0].replace('Question:', '')
            words = [w for w in re.findall(r'\w+', question.lower()) if len(w) >= 2 and w not in STOP]
            matches = []
            for block in re.split(r'\n(?=### id=)', user.split('Requests:\n', 1)[1]):
                m = re.match(r'### id=(\d+)', block.strip())
                if not m:
                    continue
                body = block.split('\n', 1)[1] if '\n' in block else ''
                for w in words:
                    hit = re.search(r'\b' + re.escape(w) + r'\b', body, re.I)
                    if hit:
                        a = max(0, hit.start() - 10)
                        ev = body[a:hit.end() + 30].strip()
                        matches.append({"id": int(m.group(1)), "relevance": 90,
                                        "reason": f"The response mentions '{hit.group(0)}'.", "evidence": ev})
                        break
            content = json.dumps({"matches": matches})
            if rf is None:
                content = "Here is the result:\n```json\n" + content + "\n```"
            return self._json(200, {"choices": [{"message": {"role": "assistant", "content": content}}],
                                    "usage": {"prompt_tokens": len(user) // 4, "completion_tokens": len(content) // 4}})
        return self.do_GET()


http.server.ThreadingHTTPServer(('127.0.0.1', int(sys.argv[1]) if len(sys.argv) > 1 else 8765), H).serve_forever()
