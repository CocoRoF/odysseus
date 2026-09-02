"""Odysseus 핵심 흐름 스모크 — 라이브 스택 + 모의 LLM로 풀 E2E.

시나리오 스튜디오 → 응시 시작(물질화) → 메신저(NPC) → 워크스페이스/IDE 실행(러너)
→ AI 에이전트(도구 루프) → 행동 이벤트 → 종료 → 리뷰/자동평가 → 권한.

사용법: python3 mock_llm.py &  →  python3 test_core.py "http://<gateway>:18011/v1"
"""
import sys
import time

import requests

API = "http://localhost:8100"
MOCK_BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:18011/v1"
ok = fail = 0


def check(name, cond, detail=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"  PASS {name}")
    else:
        fail += 1
        print(f"  FAIL {name} {detail}")


ad = requests.Session()
r = ad.post(f"{API}/auth/login", json={"email": "admin@odysseus.dev", "password": "admin1234"})
check("admin login", r.status_code == 200, str(r.status_code))

# 0. LLM 공급자 정리 + 모의 공급자 등록
for p in ad.get(f"{API}/admin/settings/ai/providers").json():
    ad.delete(f"{API}/admin/settings/ai/providers/{p['id']}")
prov = ad.post(f"{API}/admin/settings/ai/providers", json={
    "name": "모의 LLM", "provider": "custom", "base_url": MOCK_BASE, "model": "mock-model"}).json()
check("provider created", prov.get("is_chat_default") and prov.get("is_eval_default"), str(prov)[:200])
t = ad.post(f"{API}/admin/settings/ai/test", json={"provider_id": prov["id"]}).json()
check("provider live test", t.get("ok") and "정상" in t.get("reply", ""), str(t)[:200])

# 1. 시드 시나리오/시험 존재
scenarios = ad.get(f"{API}/scenarios").json()
check("seed scenario exists", any("매출 리포트" in s["title"] for s in scenarios), str(scenarios)[:200])
demo_sc = next(s for s in scenarios if "매출 리포트" in s["title"])
sc_detail = ad.get(f"{API}/scenarios/{demo_sc['id']}").json()
check("scenario has 3 characters", len(sc_detail["characters"]) == 3, str(len(sc_detail["characters"])))
check("scenario hides nothing from staff", "paid" in sc_detail["objectives_md"], "")

# 2. 시나리오 CRUD + 검증
r = ad.post(f"{API}/scenarios", json={"title": "x", "characters": [{"key": "a", "name": "A"}],
                                      "opening_messages": [{"character_key": "ghost", "content": "hi"}]})
check("opening needs valid character (400)", r.status_code == 400, str(r.status_code))
new_sc = ad.post(f"{API}/scenarios", json={
    "title": "스모크 시나리오", "characters": [{"key": "boss", "name": "팀장", "knowledge": "테스트"}],
    "opening_messages": [{"character_key": "boss", "content": "안녕하세요"}],
    "initial_files": [{"path": "hello.txt", "content": "world"}],
    "objectives_md": "hello.txt를 확인한다",
    "checks": [{"label": "파일 존재", "type": "file_exists", "path": "hello.txt", "points": 10}],
}).json()
check("scenario created with default rubric", bool(new_sc.get("rubric", {}).get("process")), str(new_sc)[:150])
ad.delete(f"{API}/scenarios/{new_sc['id']}")

# 3. 데모 시험 응시 시작 (admin 체험) — 물질화 검증
assessments = ad.get(f"{API}/assessments").json()
demo_as = next(a for a in assessments if "데모" in a["title"])
mine = ad.get(f"{API}/my/assignments").json()
row = next(x for x in mine if x["assessment_id"] == demo_as["id"])
if row["attempt_id"]:
    ad.delete(f"{API}/attempts/{row['attempt_id']}")
at = ad.post(f"{API}/assessments/{demo_as['id']}/attempts").json()
check("attempt started", at.get("status") == "in_progress" and len(at["scenarios"]) == 1, str(at)[:200])
sid = at["scenarios"][0]["scenario_id"]
check("characters exposed w/o persona", all("persona" not in c for c in at["scenarios"][0]["characters"]), "")
base = f"{API}/attempts/{at['id']}/scenarios/{sid}"

files = ad.get(f"{base}/files").json()
check("initial files materialized", {f["path"] for f in files} == {"data/orders.csv", "report.py", "README.md"}, str(files)[:200])
msgs = ad.get(f"{base}/messenger").json()
check("opening message arrived", len(msgs) == 1 and msgs[0]["sender"] == "npc" and msgs[0]["character_key"] == "pm_sujin", str(msgs)[:200])

# 4. 워크스페이스 파일 API
r = ad.put(f"{base}/files/content", json={"path": "../escape.txt", "content": "x"})
check("path traversal rejected (400)", r.status_code == 400, str(r.status_code))
ad.put(f"{base}/files/content", json={"path": "notes/plan.md", "content": "# 계획"})
got = ad.get(f"{base}/files/content", params={"path": "notes/plan.md"}).json()
check("file save+read", got["content"] == "# 계획", str(got)[:100])
ad.post(f"{base}/files/rename", json={"from_path": "notes/plan.md", "to_path": "notes/plan2.md"})
files2 = {f["path"] for f in ad.get(f"{base}/files").json()}
check("file rename", "notes/plan2.md" in files2 and "notes/plan.md" not in files2, str(files2))
ad.delete(f"{base}/files", params={"path": "notes/plan2.md"})

# 5. IDE 실행 (러너 E2E — 산출물 파일 반영)
run = ad.post(f"{base}/run", json={"command": "python3 report.py"}).json()
done = None
for _ in range(60):
    time.sleep(1)
    done = ad.get(f"{API}/executions/{run['id']}").json()
    if done["status"] in ("done", "error"):
        break
check("run finished ok", done and done["status"] == "done" and done["exit_code"] == 0, str(done)[:300])
check("run stdout captured", done and "리포트 생성 완료" in (done.get("stdout") or ""), str(done.get("stdout"))[:100] if done else "")
changed = [c["path"] for c in (done.get("changed_files") or [])] if done else []
check("run writes back files", "output/weekly_report.csv" in changed, str(changed))
report = ad.get(f"{base}/files/content", params={"path": "output/weekly_report.csv"}).json()
check("output file in workspace", report["content"].startswith("date,total_amount,order_count"), report["content"][:60])

# 6. 메신저 NPC 응답 (모의 LLM)
pair = ad.post(f"{base}/messenger/pm_sujin", json={"content": "무슨 문제인가요?"}).json()
check("messenger send returns pair", len(pair) == 2 and pair[0]["sender"] == "candidate" and pair[1]["sender"] == "npc", str(pair)[:200])
check("npc reply from llm", "정상" in pair[1]["content"], pair[1]["content"][:80])

# 7. AI 에이전트 (도구 루프 → 파일 생성)
usage0 = ad.get(f"{API}/attempts/{at['id']}/agent/usage").json()
check("agent usage baseline", usage0["enabled"] and usage0["used"] == 0, str(usage0))
r = ad.post(f"{base}/agent/messages", json={"content": "파일만들어줘"})
check("agent sse 200 + tool + done", r.status_code == 200 and '"tool"' in r.text and '"done"' in r.text, f"{r.status_code} {r.text[:200]}")
note = ad.get(f"{base}/files/content", params={"path": "agent_note.txt"})
check("agent wrote file", note.status_code == 200 and "에이전트" in note.json()["content"], str(note.status_code))
amsgs = ad.get(f"{base}/agent/messages").json()
check("agent transcript recorded", len(amsgs) == 2 and amsgs[1]["role"] == "assistant" and amsgs[1]["meta"].get("steps"), str(amsgs)[-200:])
usage1 = ad.get(f"{API}/attempts/{at['id']}/agent/usage").json()
check("agent turn consumed", usage1["used"] == 1, str(usage1))

# 7b. 에이전트 → 러너 실행 (도구 run_command E2E)
r = ad.post(f"{base}/agent/messages", json={"content": "실행해줘"})
check("agent run tool streamed", r.status_code == 200 and "run_command" in r.text and '"done"' in r.text, r.text[:200])
amsgs2 = ad.get(f"{base}/agent/messages").json()
last_meta = amsgs2[-1]["meta"]
check("agent run step recorded", any(st.get("tool") == "run_command" for st in last_meta.get("steps", [])), str(last_meta)[:200])
check("agent saw run result", "도구 결과 확인" in amsgs2[-1]["content"] or "exit" in amsgs2[-1]["content"], amsgs2[-1]["content"][:120])

# 8. 행동 이벤트 (화이트리스트)
r = ad.post(f"{API}/attempts/{at['id']}/events", json={"events": [
    {"type": "tab_hidden", "scenario_id": sid, "payload": {}},
    {"type": "hack_event", "scenario_id": sid, "payload": {}},
]}).json()
check("events whitelist", r["recorded"] == 1, str(r))

# 9. 종료 → 리뷰 → 자동평가
fin = ad.post(f"{API}/attempts/{at['id']}/finish").json()
check("finish", fin["status"] == "submitted", str(fin)[:100])
r = ad.put(f"{base}/files/content", json={"path": "late.txt", "content": "x"})
check("no edits after finish (400)", r.status_code == 400, str(r.status_code))

detail = ad.get(f"{API}/review/attempts/{at['id']}").json()
check("review detail has objectives", "paid" in detail["scenarios"][0]["objectives_md"], "")
events = ad.get(f"{API}/review/attempts/{at['id']}/events").json()
types = {e["type"] for e in events}
check("event log covers lifecycle", {"attempt_started", "msg_sent", "msg_received", "run_request", "run_done", "agent_turn", "attempt_submitted"} <= types, str(types))

ev = ad.post(f"{API}/review/attempts/{at['id']}/autoeval", json={})
check("autoeval 200", ev.status_code == 200, ev.text[:200])
scores = ev.json()["scores"]
sres = scores["scenarios"][0]
check("autoeval ran checks", sres["checks_total"] == 60 and any(c["label"] == "리포트 파일 생성" and c["passed"] for c in sres["checks"]), str(sres["checks"])[:300])
check("autoeval check regex works", any(c["label"].startswith("8/26") for c in sres["checks"]), "")
he = ad.post(f"{API}/review/attempts/{at['id']}/evaluate", json={"scores": {"overall_score": 88}, "summary": "좋음"})
check("human eval saved", he.status_code == 200, str(he.status_code))

# 10. 권한
cd = requests.Session()
cd.post(f"{API}/auth/login", json={"email": "candidate@odysseus.dev", "password": "cand1234"})
r = cd.get(f"{API}/scenarios")
check("candidate blocked from scenarios", r.status_code == 403, str(r.status_code))
r = cd.get(f"{base}/messenger")
check("candidate blocked from others' attempt", r.status_code == 403, str(r.status_code))
r = cd.get(f"{API}/review/attempts")
check("candidate blocked from review", r.status_code == 403, str(r.status_code))

# 정리
ad.delete(f"{API}/attempts/{at['id']}")
for p in ad.get(f"{API}/admin/settings/ai/providers").json():
    ad.delete(f"{API}/admin/settings/ai/providers/{p['id']}")
print(f"\n=== {ok} passed, {fail} failed ===")
sys.exit(1 if fail else 0)
