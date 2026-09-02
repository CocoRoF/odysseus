"""모의 LLM 서버 — Odysseus E2E 검증용 (OpenAI 호환 /v1/chat/completions).

NPC/자동평가: 도구 없는 비스트리밍 → 고정 응답.
에이전트: 도구 시나리오 —
  "파일만들어줘" → write_file 도구 호출 → 결과 확인 후 종료
  "실행해줘"   → run_command(python3 report.py) → 결과 확인 후 종료
"""

import json
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

REPLY = "정상 — 모의 LLM 응답입니다."


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.rstrip("/").endswith("/models"):
            self._json({"object": "list", "data": [{"id": "mock-model", "object": "model", "created": 0, "owned_by": "mock"}]})
        else:
            self._json({"error": "not found"}, 404)

    def do_POST(self):
        path = self.path.split("?", 1)[0].rstrip("/")
        if not path.endswith("/chat/completions"):
            return self._json({"error": "not found"}, 404)
        length = int(self.headers.get("Content-Length", 0))
        req = json.loads(self.rfile.read(length) or b"{}")
        model = req.get("model", "mock-model")
        now = int(time.time())
        msgs = req.get("messages", [])
        last = msgs[-1] if msgs else {}
        last_user = next((m for m in reversed(msgs) if m.get("role") == "user"), {})
        last_text = str(last_user.get("content", ""))

        if req.get("stream"):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            for i, w in enumerate(REPLY.split(" ")):
                chunk = {"id": "c", "object": "chat.completion.chunk", "created": now, "model": model,
                         "choices": [{"index": 0, "delta": {"content": ("" if i == 0 else " ") + w}, "finish_reason": None}]}
                self.wfile.write(f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n".encode())
            self.wfile.write(f"data: {json.dumps({'id': 'c', 'object': 'chat.completion.chunk', 'created': now, 'model': model, 'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'stop'}]})}\n\n".encode())
            self.wfile.write(b"data: [DONE]\n\n")
            return

        if req.get("tools"):
            # 도구 결과가 마지막이면 종결 (키워드보다 먼저 — 무한루프 방지)
            if last.get("role") == "tool":
                return self._json(self._text(model, now, "도구 결과 확인: " + str(last.get("content", ""))[:120]))
            if "파일만들어줘" in last_text:
                return self._json(self._tool(model, now, "write_file", {"path": "agent_note.txt", "content": "에이전트가 생성한 파일"}))
            if "실행해줘" in last_text:
                return self._json(self._tool(model, now, "run_command", {"command": "python3 report.py"}))
        self._json(self._text(model, now, REPLY))

    def _text(self, model, now, text):
        return {"id": "c", "object": "chat.completion", "created": now, "model": model,
                "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 8, "total_tokens": 18}}

    def _tool(self, model, now, name, args):
        return {"id": "c", "object": "chat.completion", "created": now, "model": model,
                "choices": [{"index": 0, "message": {"role": "assistant", "content": None, "tool_calls": [
                    {"id": "call_1", "type": "function", "function": {"name": name, "arguments": json.dumps(args, ensure_ascii=False)}}
                ]}, "finish_reason": "tool_calls"}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 8, "total_tokens": 18}}


if __name__ == "__main__":
    server = ThreadingHTTPServer(("0.0.0.0", 18011), Handler)
    print("mock LLM on :18011", flush=True)
    server.serve_forever()
