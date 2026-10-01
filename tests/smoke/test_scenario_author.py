"""시나리오 작성 에이전트 E2E — 지저분한 모델 출력이 저장 가능한 시나리오가 되는가.

mock_llm 은 일부러 깨진 JSON 주변 잡담·중복 키·잘못된 발신자·깨진 정규식·범위 밖
배점·엉뚱한 루브릭을 돌려준다. 정규화가 그걸 전부 받아내고, 결과가 실제로 저장되어
응시까지 되는지 본다. 운영 공급자는 건드리지 않는다 (provider_id 로 mock 지정).

  python3 mock_llm.py &   →   python3 tests/smoke/test_scenario_author.py "http://<gw>:18011/v1"
"""
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


ad = requests.Session()
ad.post(f"{API}/auth/login", json={"email": "admin@odysseus.dev", "password": "admin1234"})
mock = ad.post(f"{API}/admin/settings/ai/providers", json={
    "name": "author-mock", "provider": "custom", "base_url": MOCK, "api_key": "x",
    "model": "mock-model", "temperature": 0.2, "max_tokens": 4096, "enabled": True,
}).json()
pid = mock["id"]
created_id = None
try:
    print("\n── 권한·입력 ──")
    cand = requests.Session()
    cand.post(f"{API}/auth/login", json={"email": "candidate@odysseus.dev", "password": "cand1234"})
    check("응시자는 못 쓴다", cand.post(f"{API}/scenarios/author", json={"brief": "x"}).status_code == 403)
    r = ad.post(f"{API}/scenarios/author", json={"brief": "   ", "provider_id": pid})
    check("빈 요청은 400", r.status_code == 400, r.text[:100])

    print("\n── 새로 설계 ──")
    r = ad.post(f"{API}/scenarios/author", json={"brief": "물류팀 재고 불일치", "provider_id": pid})
    check("응답 200", r.status_code == 200, r.text[:200])
    body = r.json()
    sc = body["scenario"]
    check("설계 노트가 온다", "함정" in body["notes"], body["notes"][:80])
    check("공급자 이름", body["provider"] == "author-mock")
    check("코드 펜스·잡담을 걷어내고 JSON 을 꺼냈다", sc["title"].startswith("재고 스냅샷 불일치"))
    check("난이도 오타는 medium 으로", sc["difficulty"] == "medium")
    keys = [c["key"] for c in sc["characters"]]
    check("이름 없는 인물 제외", len(sc["characters"]) == 2, str(keys))
    check("키는 ASCII 슬러그, 중복은 접미사", keys == ["ops_lead", "ops_lead_2"], str(keys))
    check("색이 채워진다", all(c["color"].startswith("#") for c in sc["characters"]))
    check("없는 발신자는 첫 인물로", sc["opening_messages"][0]["character_key"] == "ops_lead")
    paths = [f["path"] for f in sc["initial_files"]]
    check("경로 정규화(앞 / 제거) + 중복 제거", paths == ["data/orders.csv", "stock.py"], str(paths))
    labels = [c["label"] for c in sc["checks"]]
    check("깨진 정규식·모르는 종류 체크 제외", labels == ["산출물", "A 수량", "실행"], str(labels))
    check("배점 범위", all(1 <= c["points"] <= 100 for c in sc["checks"]))
    check("엉뚱한 루브릭은 기본값으로", isinstance(sc["rubric"].get("process"), list) and len(sc["rubric"]["process"]) == 3)
    w = " | ".join(body["warnings"])
    check("고친 것을 경고로 알린다", "정규식" in w and "llm_judge" in w and "중복" in w and "nobody" in w, w[:200])

    print("\n── 결과가 실제로 저장·응시된다 ──")
    r = ad.post(f"{API}/scenarios", json=sc)
    check("ScenarioIn 으로 그대로 저장된다", r.status_code == 200, r.text[:160])
    created_id = r.json()["id"]
    got = ad.get(f"{API}/scenarios/{created_id}").json()
    check("저장된 시나리오 재조회", got["title"] == sc["title"] and len(got["characters"]) == 2)

    print("\n── 초안 다듬기 ──")
    r = ad.post(f"{API}/scenarios/author", json={"brief": "", "draft": sc, "instruction": "제목을 다듬어", "provider_id": pid})
    check("draft+instruction 경로 200", r.status_code == 200, r.text[:160])
    check("다듬기 응답이 반영된다", r.json()["scenario"]["title"].endswith("(다듬음)"), r.json()["scenario"]["title"])

    print("\n── 공급자 없음 ──")
    r = ad.post(f"{API}/scenarios/author", json={"brief": "x", "provider_id": "00000000-0000-0000-0000-000000000000"})
    check("없는 provider_id 는 기본 공급자로 폴백하거나 503", r.status_code in (200, 502, 503), str(r.status_code))
finally:
    if created_id:
        ad.delete(f"{API}/scenarios/{created_id}")
    ad.delete(f"{API}/admin/settings/ai/providers/{pid}")

print(f"\n{ok} passed, {fail} failed")
sys.exit(1 if fail else 0)
