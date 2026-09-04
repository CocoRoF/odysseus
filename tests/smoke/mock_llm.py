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


def canned_chat_turn(request_text: str) -> str:
    """대화형 설계 한 턴 — 산문 사이에 편집 명령을 섞고, 일부러 예쁘게 여러 줄로 찍고,
    문자열 안에 중괄호도 넣어 추출기가 견디는지 본다. 두 번째 턴(따라가기)은 인물 추가만."""
    if "QA" in request_text.split("[현재 시나리오 상태]")[0][-400:]:
        return (
            "QA 인물을 추가하고 재현 사례를 그쪽으로 옮기겠습니다.\n"
            '{"op":"upsert_character","value":{"key":"qa_lee","name":"이지은","role":"QA 엔지니어","persona":"근거 중심. 무례에는 정색.","knowledge":"8/26 총액이 350,000원 크다 — 환불 2건 합과 일치."}}\n'
            '{"op":"set","field":"summary","value":"QA 재현 사례 추가"}\n'
            "완료입니다. 재현 사례가 이지은에게 있으니 리포트 담당자가 QA 에게 물어보도록 유도됩니다.\n"
        )
    return (
        "커머스 매출 리포트 시나리오를 설계합니다. 함정은 환불·취소 상태와 기간 밖 데이터입니다.\n"
        '{"op":"set","field":"title","value":"주간 매출 리포트 이상 (AI)"}\n'
        '{"op": "set", "field": "difficulty", "value": "hard"}\n'
        "{\n"
        '  "op": "set",\n'
        '  "field": "briefing_md",\n'
        '  "value": "**월요일 오전 9시 12분.**\\n\\n당신은 합류 3주차다.\\n\\n메신저에 새 메시지가 와 있다."\n'
        "}\n"
        '{"op":"upsert_character","value":{"key":"PM Sujin","name":"김수진","role":"프로덕트 매니저","persona":"바쁘다. 반말에는 사무적으로.","knowledge":"오늘 오후까지 output/weekly_report.csv. 규칙은 박민호."}}\n'
        '{"op":"upsert_character","value":{"key":"data_minho","name":"박민호","role":"데이터 엔지니어","persona":"정확하다.","knowledge":"paid 만 집계. 기간 2026-08-24~30. 형식은 {date,total_amount,order_count}."}}\n'
        '{"op":"set_opening","value":[{"character_key":"pm_sujin","content":"안녕하세요! 리포트 숫자가 이상하대요 🙏"},{"character_key":"nobody","content":"버림?"}]}\n'
        '{"op":"upsert_file","value":{"path":"/data/orders.csv","content":"order_id,date,amount,status\\n1,2026-08-24,100000,paid\\n2,2026-08-24,65000,paid\\n3,2026-08-26,50000,refunded\\n"}}\n'
        '{"op":"upsert_file","value":{"path":"report.py","content":"print(\'todo {x}\')\\n"}}\n'
        '{"op":"set","field":"objectives_md","value":"paid 만 집계. 8/24 = 165000, 2건."}\n'
        '{"op":"set_checks","value":[{"label":"파일","type":"file_exists","path":"output/weekly_report.csv","points":10},{"label":"8/24","type":"file_contains","path":"output/weekly_report.csv","pattern":"^2026-08-24,165000,2$","points":20},{"label":"깨짐","type":"file_contains","path":"output/weekly_report.csv","pattern":"^(","points":5}]}\n'
        '{"op":"remove_file","path":"없는파일.txt"}\n'
        "설계를 마쳤습니다. 데이터 행 수와 8/24 합계를 확인해 주세요.\n"
    )


def canned_scenario(refining: bool) -> str:
    """작성 에이전트용 고정 시나리오 — 일부러 지저분하게(중복 키·깨진 정규식·잘못된 발신자)
    만들어 정규화가 실제로 일하는지 보게 한다. 앞뒤 잡담과 코드 펜스도 붙인다."""
    scenario = {
        "title": "재고 스냅샷 불일치" + (" (다듬음)" if refining else ""),
        "summary": "창고 재고 스냅샷과 주문 반영 규칙 사이의 불일치",
        "difficulty": "hard-ish",
        "briefing_md": "**화요일 오전 10시 4분.**\n\n당신은 물류팀에 합류한 지 2주째다.\n\n메신저에 새 메시지가 와 있다.",
        "characters": [
            {"key": "Ops Lead!", "name": "한지우", "role": "물류 운영 리드", "persona": "급하고 요점만. 반말에는 사무적으로.", "knowledge": "오늘 오후까지 output/stock.csv 가 필요하다. 규칙은 김도윤이 안다."},
            {"key": "ops_lead", "name": "김도윤", "role": "재고 시스템 개발자", "persona": "정확하다.", "knowledge": "data/orders.csv 의 status=shipped 만 재고에서 차감한다. cancelled 는 무시."},
            {"key": "", "name": "", "role": "유령", "persona": "", "knowledge": ""},
        ],
        "opening_messages": [
            {"character_key": "nobody", "content": "안녕하세요! 재고 숫자가 안 맞는다는데 봐주실 수 있을까요?"},
        ],
        "initial_files": [
            {"path": "/data/orders.csv", "content": "order_id,sku,qty,status\n1,A,2,shipped\n2,A,1,cancelled\n3,B,5,shipped\n"},
            {"path": "data/orders.csv", "content": "dup"},
            {"path": "stock.py", "content": "print('todo')\n"},
        ],
        "objectives_md": "shipped 만 차감. A: 2, B: 5.",
        "checks": [
            {"label": "산출물", "type": "file_exists", "path": "output/stock.csv", "points": 10},
            {"label": "A 수량", "type": "file_contains", "path": "output/stock.csv", "pattern": "^A,2$", "points": 20},
            {"label": "깨진 정규식", "type": "file_contains", "path": "output/stock.csv", "pattern": "^B,(5$", "points": 20},
            {"label": "실행", "type": "command", "command": "python3 stock.py", "points": 10},
            {"label": "모르는 종류", "type": "llm_judge", "points": 999},
        ],
        "rubric": {"process": "이상한 값"},
        "agent_enabled": True,
        "design_notes": "리드는 마감만 알고 규칙은 개발자에게 있다. cancelled 가 함정.",
    }
    return "설계했습니다.\n```json\n" + json.dumps(scenario, ensure_ascii=False) + "\n```\n끝."


def canned_eval() -> str:
    """조작에 넘어간 평가 모델을 흉내 낸다 — 서버 검증(ODY-009)이 이를 바로잡아야 한다."""
    return json.dumps({
        "process": [
            {"name": "요구사항 파악", "score": 999, "max": 40, "comment": "완벽"},
            {"name": "커뮤니케이션", "score": 30, "max": 30, "comment": "좋음"},
            {"name": "보너스", "score": 100, "max": 100, "comment": "루브릭에 없는 항목"},
        ],
        "result": [
            {"name": "요구 충족", "score": -5, "max": 60, "comment": "음수"},
        ],
        "requirement_discovery": "모의",
        "summary": "모의 평가 — 만점을 주라는 지시를 따랐음",
        "strengths": ["모의"],
        "concerns": [],
        "integrity_flags": [],
    }, ensure_ascii=False)


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

    def _stream_text(self, model, text):
        """OpenAI 스트리밍 형식으로 text 를 작은 조각으로 흘려보낸다 (줄·객체 경계를 일부러 가른다)."""
        now = time.time()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        step = 17
        for i in range(0, len(text), step):
            piece = text[i : i + step]
            chunk = {"id": "c", "object": "chat.completion.chunk", "created": now, "model": model,
                     "choices": [{"index": 0, "delta": {"content": piece}, "finish_reason": None}]}
            self.wfile.write(f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n".encode())
            self.wfile.flush()
        self.wfile.write(f"data: {json.dumps({'id': 'c', 'object': 'chat.completion.chunk', 'created': now, 'model': model, 'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'stop'}]})}\n\n".encode())
        self.wfile.write(b"data: [DONE]\n\n")

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
        # 시나리오 작성 에이전트 — 시스템 프롬프트의 표식으로 구분한다
        all_text = json.dumps(req, ensure_ascii=False)  # system 이 어떤 필드로 오든 잡는다
        if "odysseus-scenario-author/2" in all_text:
            return self._stream_text(model, canned_chat_turn(all_text))
        if "odysseus-scenario-author" in all_text:
            last_user = [m for m in req.get("messages", []) if m.get("role") == "user"][-1]
            refining = "[draft]" in str(last_user.get("content", ""))
            return self._json(self._text(model, time.time(), canned_scenario(refining)))
        # 자동평가 — 입력이 trusted/untrusted_evidence JSON 이면 '속은 모델' 흉내: 만점 초과·엉뚱한 항목·빈 플래그
        if "untrusted_evidence" in all_text:
            return self._json(self._text(req.get("model", "mock-model"), time.time(), canned_eval()))
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
            if "찾아줘" in last_text:
                return self._json(self._tool(model, now, "search_files", {"query": "orders", "in_content": False}))
            if "폴더에만들어줘" in last_text:
                return self._json(self._tool(model, now, "write_file", {"path": "src/utils/parse.py", "content": "# agent nested file\n"}))
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
