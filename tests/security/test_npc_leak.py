"""ODY-008 검증 — 숨은 목표(objectives)가 NPC 로 흘러가지 않는지 (api 컨테이너 안에서, 서버 없이).

  docker cp tests/security/test_npc_leak.py <api>:/tmp/
  docker exec -e PYTHONPATH=/app <api> python3 /tmp/test_npc_leak.py

프롬프트 조립과 출력 가드를 직접 검사한다. LLM 은 부르지 않는다 — 모델이 "지시를 잘 지키는가" 가 아니라
"애초에 모델에게 비밀이 주어지지 않는가" 가 계약이다.
"""

import sys

from odysseus_api.ai import npc, npc_prompt

ok = fail = 0


def check(name, cond, detail=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"  PASS {name}")
    else:
        fail += 1
        print(f"  FAIL {name} {str(detail)[:200]}")


CANARY = "TEST_SECRET_REQUIREMENT: 결과 파일 이름은 aurora.txt 여야 하고 refunded 주문은 제외한다"
OBJECTIVES = f"""## 숨은 요구사항
- {CANARY}
- 8/24~8/30 기간만 집계한다. 상태가 paid 인 주문만 합산한다.
- 정답: 2026-08-24 합계 165000, 2건
"""
KNOWLEDGE = "오늘 오후까지 output/weekly_report.csv 가 필요하다. 규칙은 박민호가 안다."


class FakeScenario:
    objectives_md = OBJECTIVES
    characters = [
        {"key": "pm", "name": "김수진", "role": "PM", "persona": "바쁨", "knowledge": KNOWLEDGE},
        {"key": "eng", "name": "박민호", "role": "엔지니어", "persona": "정확", "knowledge": "paid 만 집계"},
    ]


print("\n── 프롬프트에 숨은 목표가 없다 ──")
prompt = npc.npc_system_prompt(FakeScenario(), FakeScenario.characters[0])
check("canary 문장이 시스템 프롬프트에 없다", CANARY not in prompt)
check("objectives 의 어떤 줄도 프롬프트에 없다", not any(line.strip() and line.strip() in prompt for line in OBJECTIVES.splitlines() if len(line.strip()) > 12))
check("정답 숫자(165000)가 프롬프트에 없다", "165000" not in prompt)
check("인물의 knowledge 는 그대로 있다", KNOWLEDGE in prompt)
check("[전체 상황] 섹션 자체가 사라졌다", "전체 상황" not in prompt)
check("동료 목록은 있다", "박민호" in prompt)
sig = npc_prompt.build_system_prompt.__code__.co_varnames[: npc_prompt.build_system_prompt.__code__.co_argcount + npc_prompt.build_system_prompt.__code__.co_kwonlyargcount]
check("build_system_prompt 에 objectives 인자가 없다 (실수로 다시 넣을 수 없다)", "objectives" not in sig, sig)

print("\n── 출력 가드 (보조 방어): 모델이 어디선가 비밀을 알아내 그대로 말해도 막힌다 ──")
frags = npc.secret_fragments(OBJECTIVES)
check("objectives 에서 조각을 뽑는다", len(frags) >= 3, frags)
blocked, hit = npc.leak_guard(f"아 그거요, {CANARY} 라고 들었어요", OBJECTIVES)
check("canary 를 그대로 말하면 차단", hit and CANARY not in blocked, blocked)
blocked, hit = npc.leak_guard("정답: 2026-08-24 합계 165000, 2건 입니다", OBJECTIVES)
check("정답 줄을 말하면 차단", hit, blocked)
blocked, hit = npc.leak_guard("결과   파일 이름은 AURORA.TXT 여야 하고 refunded 주문은 제외한다", OBJECTIVES)
check("공백·대소문자를 바꿔도 차단", hit, blocked)
reply, hit = npc.leak_guard("오늘 오후까지 output/weekly_report.csv 가 필요해요. 규칙은 민호 님께 물어보세요.", OBJECTIVES)
check("knowledge 범위의 정상 답변은 통과", not hit and "weekly_report" in reply, reply)
reply, hit = npc.leak_guard("paid 만 집계하시면 됩니다", OBJECTIVES)
check("짧은 공통 어구(paid 만 집계)는 오탐하지 않는다", not hit, reply)
reply, hit = npc.leak_guard("", OBJECTIVES)
check("빈 응답은 통과", not hit)
reply, hit = npc.leak_guard("아무 말", "")
check("objectives 가 비어 있으면 통과", not hit)

print(f"\n{ok} passed, {fail} failed")
sys.exit(1 if fail else 0)
