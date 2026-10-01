"""대화형 시나리오 설계 SSE — 명령이 순서대로, 검증되어, 실시간으로 흘러오는가.

mock 은 산문 사이에 편집 명령을 섞고, 일부러 여러 줄로 찍고, 문자열 안에 중괄호를
넣고, 17자씩 잘라 흘린다. 추출기가 그걸 전부 견디고 검증이 실제로 일하는지 본다.

  python3 mock_llm.py &  →  python3 tests/smoke/test_scenario_author_stream.py "http://<gw>:18011/v1"
"""
import json
import sys

import requests

API = "http://localhost:8100"
MOCK = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:18011/v1"
ok = fail = 0


def check(name, cond, detail=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"  PASS {name}")
    else:
        fail += 1
        print(f"  FAIL {name} {detail}")


def stream(sess, body):
    events = []
    with sess.post(f"{API}/scenarios/author/stream", json=body, stream=True, timeout=120) as r:
        if r.status_code != 200:
            return r.status_code, [{"error": r.text[:200]}]
        for line in r.iter_lines(decode_unicode=True):
            if line and line.startswith("data:"):
                events.append(json.loads(line[5:].strip()))
    return 200, events


ad = requests.Session()
ad.post(f"{API}/auth/login", json={"email": "admin@odysseus.dev", "password": "admin1234"})
pid = ad.post(f"{API}/admin/settings/ai/providers", json={
    "name": "author-stream-mock", "provider": "custom", "base_url": MOCK, "api_key": "x",
    "model": "mock-model", "temperature": 0.2, "max_tokens": 4096, "enabled": True,
}).json()["id"]
try:
    print("\n── 권한·입력 ──")
    cand = requests.Session()
    cand.post(f"{API}/auth/login", json={"email": "candidate@odysseus.dev", "password": "cand1234"})
    check("응시자 차단", cand.post(f"{API}/scenarios/author/stream", json={"messages": [{"role": "user", "content": "x"}]}).status_code == 403)
    st, ev = stream(ad, {"messages": [{"role": "assistant", "content": "x"}], "provider_id": pid})
    check("마지막이 사용자 메시지가 아니면 오류", any("error" in e for e in ev), str(ev)[:120])

    print("\n── 첫 턴: 처음부터 설계 ──")
    st, ev = stream(ad, {"messages": [{"role": "user", "content": "커머스 매출 리포트 버그, medium"}], "provider_id": pid})
    check("SSE 200", st == 200)
    deltas = "".join(e["delta"] for e in ev if "delta" in e)
    edits = [e["edit"] for e in ev if "edit" in e]
    labels = [e["label"] for e in ev if "edit" in e]
    warns = [e["warning"] for e in ev if "warning" in e]
    done = next((e for e in ev if e.get("done")), None)
    check("대화 텍스트가 산문으로 온다", "설계합니다" in deltas and "마쳤습니다" in deltas, deltas[:80])
    check("명령은 대화에 섞이지 않는다", '"op"' not in deltas, deltas[:120])
    kinds = [e["op"] for e in edits]
    check("명령이 순서대로 온다", kinds[:3] == ["set", "set", "set"] and "upsert_character" in kinds and "set_checks" in kinds, str(kinds))
    check("여러 줄로 찍힌 JSON 도 잡는다", any(e["op"] == "set" and e["field"] == "briefing_md" and "9시 12분" in e["value"] for e in edits))
    check("문자열 안 중괄호를 견딘다", any(e["op"] == "upsert_file" and "{x}" in e["value"]["content"] for e in edits) and any(e["op"]=="upsert_character" and "{date" in e["value"]["knowledge"] for e in edits))
    check("인물 키를 슬러그로", any(e["op"] == "upsert_character" and e["value"]["key"] == "pm_sujin" for e in edits), str([e["value"]["key"] for e in edits if e["op"]=="upsert_character"]))
    opening = next(e for e in edits if e["op"] == "set_opening")["value"]
    check("없는 발신자는 첫 인물로 + 경고", all(m["character_key"] in ("pm_sujin", "data_minho") for m in opening) and any("nobody" in w for w in warns), str(opening)[:120])
    check("경로 정규화(앞 / 제거)", any(e["op"] == "upsert_file" and e["value"]["path"] == "data/orders.csv" for e in edits))
    checks = next(e for e in edits if e["op"] == "set_checks")["value"]
    check("깨진 정규식 체크는 빠지고 경고", len(checks) == 2 and any("정규식" in w for w in warns), str([c["label"] for c in checks]))
    check("없는 파일 삭제는 무시 + 경고", not any(e["op"] == "remove_file" for e in edits) and any("없는 파일" in w for w in warns))
    check("라벨이 사람 말로", "제목" in labels and any(l.startswith("인물 · 김수진") for l in labels) and any("파일 · data/orders.csv" == l for l in labels), str(labels))
    check("done 에 정규화된 최종 초안", done and done["scenario"]["title"].endswith("(AI)") and len(done["scenario"]["characters"]) == 2, str(done)[:100] if done else "no done")
    check("done 에 모델 원문(raw)", done and '"op"' in done["raw"])
    final = done["scenario"]

    print("\n── 둘째 턴: 이어서 다듬기 (현재 초안 + 이력) ──")
    history = [
        {"role": "user", "content": "커머스 매출 리포트 버그, medium"},
        {"role": "assistant", "content": done["raw"]},
        {"role": "user", "content": "QA 인물을 하나 더"},
    ]
    st, ev = stream(ad, {"messages": history, "draft": final, "provider_id": pid})
    edits2 = [e["edit"] for e in ev if "edit" in e]
    done2 = next((e for e in ev if e.get("done")), None)
    check("둘째 턴 200", st == 200)
    check("추가 명령만 온다", [e["op"] for e in edits2] == ["upsert_character", "set"], str([e["op"] for e in edits2]))
    check("기존 초안 위에 누적된다", done2 and len(done2["scenario"]["characters"]) == 3 and done2["scenario"]["title"].endswith("(AI)"), str(done2["scenario"]["characters"])[:80] if done2 else "")
    check("요약이 바뀌었다", done2 and done2["scenario"]["summary"] == "QA 재현 사례 추가")

    print("\n── 최종본이 실제로 저장된다 ──")
    r = ad.post(f"{API}/scenarios", json=done2["scenario"])
    check("ScenarioIn 저장", r.status_code == 200, r.text[:120])
    if r.status_code == 200:
        ad.delete(f"{API}/scenarios/{r.json()['id']}")
finally:
    ad.delete(f"{API}/admin/settings/ai/providers/{pid}")

print(f"\n{ok} passed, {fail} failed")
sys.exit(1 if fail else 0)
