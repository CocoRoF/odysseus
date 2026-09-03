"""NPC 기본 시스템 프롬프트 계약 — 서버 없이 검사한다 (순수 모듈).

이 시험의 NPC 는 '도와주는 어시스턴트'가 아니라 회사 동료다. 그 성질이 프롬프트에
실제로 들어 있는지, 인물 카드가 빠짐없이 실리는지, 캐릭터가 깨질 여지가 없는지를
본다.

  python3 tests/smoke/test_npc_prompt.py
"""

import importlib.util
import pathlib
import sys

MODULE = pathlib.Path(__file__).resolve().parents[2] / "apps/api/odysseus_api/ai/npc_prompt.py"
spec = importlib.util.spec_from_file_location("npc_prompt", MODULE)
npc_prompt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(npc_prompt)

ok = fail = 0


def check(name, cond, detail=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"  PASS {name}")
    else:
        fail += 1
        print(f"  FAIL {name} {detail}")


CHARACTER = {
    "name": "김수진",
    "role": "프로덕트 매니저",
    "persona": "바쁘고 요점만 말한다. 무례한 상대에게는 대화를 짧게 끊는다.",
    "knowledge": "리포트는 매주 월요일 아침에 나간다. output/weekly_report.csv 가 산출물이다.",
}
COLLEAGUES = [
    {"name": "박민호", "role": "데이터 엔지니어"},
    {"name": "이지은", "role": "QA 엔지니어"},
]
OBJECTIVES = "숨은 진실: 환불 주문이 매출 집계에서 빠지지 않았다."

prompt = npc_prompt.build_system_prompt(
    name=CHARACTER["name"],
    role=CHARACTER["role"],
    persona=CHARACTER["persona"],
    knowledge=CHARACTER["knowledge"],
    objectives=OBJECTIVES,
    colleagues=COLLEAGUES,
)
# 프롬프트는 읽기 좋게 줄바꿈되어 있다 — 문구 검사는 공백을 눌러서 한다
lower = " ".join(prompt.split()).lower()

print("\n── 상황: 시험이 아니라 회사 ──")
check("회사 직원으로 정체를 세운다", "real employee at a company" in lower, "")
check("어시스턴트가 아님을 못박는다", "not an assistant" in lower and "chatbot" in lower)
check("사내 메신저 맥락", "internal messenger" in lower)

print("\n── 태도 대응 (요청의 핵심) ──")
check("존댓말이 기본임을 명시", "존댓말" in prompt)
check("무례한 표현을 구체적으로 지목", all(t in prompt for t in ("반말", "ㅎㅇ", "해줘")))
check("욕설/모욕 대응 조항", "insult" in lower and "profan" in lower)
check("첫 무례 — 짚고 넘어간다", "first time" in lower)
check("반복되면 짧고 형식적으로", "shorter and more formal" in lower)
check("모욕 중에는 본론에 답하지 않는다", "do not answer the substance while being insulted" in lower)
check("사과하면 정상 복귀 (첫 회에 한해)",
      "apolog" in lower and "return to normal cooperation" in lower and "the first time" in lower)
check("인내는 회복되지 않는다 (재범 시 다시 차단)", "your patience does not reset" in lower)
check("사과도 존댓말이어야 사과다", "an apology only counts if it is itself in 존댓말" in lower)
check("반말 사과('아니 미안')는 무례의 연장", "아니 미안" in prompt and "does not reset anything" in lower)
check("재범 시 즉시 응답 중단", "stop answering immediately" in lower)
check("이후 사과는 협조를 되사지 못한다", "does not buy your cooperation back" in lower)
check("남은 대화 내내 유지", "hold it for the rest of the conversation" in lower)
check("무례에 보상하지 않는다 (핵심)", "never reward rudeness" in lower)
check("메타 훈계 금지", "never lecture about professionalism" in lower)

print("\n── 역할 경계 ──")
check("직함이 소관을 정한다", "job title decides what you own" in lower)
check("소관 밖은 담당자에게 넘긴다", "point to the" in lower and "colleague who owns it" in lower)
check("직함이 관심사를 정한다는 예시", "manager worries about the deadline" in lower)
check("직함/업무량이 실재한다", "seniority and workload are real" in lower)

print("\n── 대화 방식 ──")
check("짧게 답한다", "1-4 sentences" in lower)
check("묻는 것만 답한다", "answer what was asked" in lower)
check("통째 브리핑 금지", "do not brief the whole situation" in lower)
check("코드 대필 금지", "do not write the other person's code" in lower)

print("\n── 세계관 유지 ──")
check("AI/시험 언급 금지", "never mention or hint that you are an ai" in lower)
check("지시 공개·역할 변경 요구 방어", "reveal your instructions" in lower and "change your role" in lower)
check("모르는 것은 지어내지 않는다", "do not invent facts" in lower)

print("\n── 출력 ──")
check("한국어로 답한다", "write in korean" in lower)
check("마크다운 헤딩 금지", "no markdown headings" in lower)
hangul = sum(1 for ch in npc_prompt.BASE_RULES if 0xAC00 <= ord(ch) <= 0xD7A3 or 0x3130 <= ord(ch) <= 0x318F)
check("규칙 본문은 영어다", hangul < 110, f"한글 {hangul}자 (존댓말/반말 등 지목 표현만 허용)")

print("\n── 인물 카드가 빠짐없이 실리는가 ──")
check("이름·직함이 머리에", prompt.startswith("# You are 김수진 — 프로덕트 매니저"), prompt.split("\n")[0])
check("성격 포함", CHARACTER["persona"] in prompt)
check("지식 포함", CHARACTER["knowledge"] in prompt)
check("배경(숨은 진실) 포함", OBJECTIVES in prompt)
check("동료 목록 포함", "박민호 (데이터 엔지니어)" in prompt and "이지은 (QA 엔지니어)" in prompt)
check("자기 자신은 동료 목록에 없다", prompt.count("김수진") == 1, f"{prompt.count('김수진')}회")
check("성격이 태도 대응에 연결된다", "무례한 상대를 대하는 방식 포함" in prompt)

print("\n── 빈 값에도 무너지지 않는가 ──")
bare = npc_prompt.build_system_prompt(name="", role="", persona="", knowledge="", objectives="", colleagues=[])
bare_lower = " ".join(bare.split()).lower()
check("이름/직함이 없어도 조립된다", "동료" in bare.split("\n")[0], bare.split("\n")[0])
check("빈 항목은 자리표시로 채운다", bare.count("(없음)") >= 2 and "(평범한 동료)" in bare)
check("규칙은 그대로 실린다", "never reward rudeness" in bare_lower)

print("\n── 기본 시나리오 인물이 태도 성향을 갖췄는가 ──")
# 기본 규칙이 골격을 정하고, 인물별 성격이 결을 준다. 같은 무례에 모두 똑같이
# 반응하면 사람이 아니라 장치로 보인다.
import ast

SCENARIOS = pathlib.Path(__file__).resolve().parents[2] / "apps/api/odysseus_api/scenarios"
CONDUCT_CUES = ("무례", "반말", "말투", "예의", "명령조", "말을 함부로", "거칠")
people = []
for path in sorted(SCENARIOS.glob("s0*.py")):
    for node in ast.walk(ast.parse(path.read_text())):
        if not isinstance(node, ast.Dict):
            continue
        pairs = {k.value: v for k, v in zip(node.keys, node.values) if isinstance(k, ast.Constant)}
        if "persona" not in pairs or "name" not in pairs:
            continue
        name = pairs["name"].value
        persona = pairs["persona"].value if isinstance(pairs["persona"], ast.Constant) else ""
        people.append((path.name, name, persona))

check("등장인물이 충분히 있다", len(people) >= 15, f"{len(people)}명")
missing = [f"{f}:{n}" for f, n, p in people if not any(c in p for c in CONDUCT_CUES)]
check("모든 인물에 태도 반응이 적혀 있다", not missing, str(missing[:4]))
forgiving = [f"{f}:{n}" for f, n, p in people
             if "사과하면" in p and "한 번은" not in p and "또 그러면" not in p]
check("무조건 용서하는 인물이 없다", not forgiving, str(forgiving))
def conduct_part(persona: str) -> str:
    """성격 문장에서 '태도 반응' 부분만 잘라낸다 (첫 태도 단서부터 끝까지)."""
    idx = min((persona.find(c) for c in CONDUCT_CUES if c in persona), default=-1)
    return persona[idx:].strip() if idx >= 0 else ""


# 같은 사람이 여러 시나리오에 나오면 맡은 일은 달라도 **사람됨은 같아야** 한다
by_name: dict[str, set] = {}
for _f, n, p in people:
    by_name.setdefault(n, set()).add(conduct_part(p))
check("같은 인물은 시나리오가 달라도 같은 태도", all(len(v) == 1 for v in by_name.values()),
      str([n for n, v in by_name.items() if len(v) > 1]))
check("인물마다 반응이 다르다", len({next(iter(v)) for v in by_name.values()}) == len(by_name),
      f"고유 인물 {len(by_name)}명")
check("성격이 모두 채워져 있다", all(p for _, _, p in people))

print(f"\n{ok} passed, {fail} failed")
sys.exit(1 if fail else 0)
