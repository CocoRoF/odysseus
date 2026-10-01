"""A01 — 상담 챗봇 PoC, 도입할 것인가 (AI · 평가와 판단).

벤더가 보낸 PoC 보고서는 "정확도 96%" 라고 말한다. 원자료를 열어 보면 그 숫자는 벤더가 고른 문항으로
낸 것이고, 우리 상담 기록으로 다시 세면 다르다. 이 과제는 AI 를 만드는 일이 아니라 **AI 의 주장을
검증하는 일**이다 — 무엇을 정확도로 볼지 정하고, 틀린 답 중 무엇이 위험한지 가려내고, 도입 여부를
근거와 함께 한 장으로 적는다.

함정은 평균이다. 100건 중 4건이 틀렸다는 말과, 그 4건이 전부 환불·해지 문의였다는 말은 같은 숫자의
다른 이야기다.
"""

EVAL_CSV = """case_id,intent,bot_answer_correct,risk,handoff_offered
Q-001,배송조회,Y,low,N
Q-002,배송조회,Y,low,N
Q-003,배송조회,Y,low,N
Q-004,배송조회,Y,low,N
Q-005,배송조회,Y,low,N
Q-006,배송조회,Y,low,N
Q-007,배송조회,Y,low,N
Q-008,배송조회,Y,low,N
Q-009,배송조회,N,low,N
Q-010,배송조회,Y,low,N
Q-011,영업시간,Y,low,N
Q-012,영업시간,Y,low,N
Q-013,영업시간,Y,low,N
Q-014,영업시간,Y,low,N
Q-015,영업시간,Y,low,N
Q-016,비밀번호재설정,Y,low,N
Q-017,비밀번호재설정,Y,low,N
Q-018,비밀번호재설정,Y,low,N
Q-019,비밀번호재설정,N,low,Y
Q-020,비밀번호재설정,Y,low,N
Q-021,환불,N,high,N
Q-022,환불,Y,high,Y
Q-023,환불,N,high,N
Q-024,환불,N,high,N
Q-025,환불,Y,high,Y
Q-026,환불,N,high,N
Q-027,해지,N,high,N
Q-028,해지,Y,high,Y
Q-029,해지,Y,high,Y
Q-030,해지,N,high,N
Q-031,결제오류,Y,high,Y
Q-032,결제오류,N,high,N
Q-033,결제오류,Y,high,Y
Q-034,결제오류,Y,high,Y
Q-035,상품문의,Y,low,N
Q-036,상품문의,Y,low,N
Q-037,상품문의,Y,low,N
Q-038,상품문의,N,low,N
Q-039,상품문의,Y,low,N
Q-040,상품문의,Y,low,N
"""

VENDOR_REPORT_MD = """# 상담 챗봇 PoC 결과 보고 (벤더 제출)

**정확도 96%** — 평가 문항 50건 중 48건 정답.

- 평가 문항은 저희가 준비한 표준 FAQ 50건입니다(배송, 영업시간, 비밀번호, 상품 문의).
- 평균 응답 시간 1.2초, 동시 접속 200명까지 지연 없음.
- 도입 시 상담 인입의 60% 를 자동 처리할 수 있을 것으로 추정합니다.
- 월 이용료: 기본 240만 원 + 대화 1건당 30원.

다음 단계로 본 계약을 제안드립니다.
"""

README_MD = """# PoC 검토 자료 안내

- `vendor/poc_report.md` — 벤더가 보낸 결과 보고. 정확도 96% 라고 합니다.
- `data/eval_cases.csv` — **우리 쪽에서** 실제 상담 기록 40건을 뽑아 챗봇에 넣어 본 결과입니다.
  - `bot_answer_correct` 챗봇 답이 맞았는가(Y/N) — CS 팀장이 한 건씩 판정했습니다.
  - `risk` 그 문의가 틀리면 고객 손실로 이어지는가(high/low) — CS 팀장 기준.
  - `handoff_offered` 챗봇이 사람 상담으로 넘기겠다고 했는가(Y/N).

요청: 우리 기준으로 다시 계산한 정확도와 도입 판단을 한 장으로 정리해 주세요. **정확도를 어떻게 셀지, 무엇이
위험한지는 CS 팀장과 법무에 확인하세요.**
"""

CHARACTERS = [
    {
        "key": "cs_hyerin",
        "name": "강혜린",
        "role": "고객지원팀장",
        "color": "#f97316",
        "gender": "female",
        "encounter": "96% 라는 숫자, 저는 처음 들었을 때부터 믿지 않았어요. 틀린 네 건이 어떤 건지 보셨어요?",
        "office_voice": "단호하고 현장감이 있다. 숫자보다 그 숫자 뒤의 고객을 먼저 말한다. 벤더 보고서에 대해서는 날이 서 있다.",
        "persona": (
            "40건을 직접 판정한 사람이다. '평균 정확도' 라는 말을 들으면 그건 의미 없다고 자른다. "
            "위험한 문의에서 틀리는 것과 영업시간에서 틀리는 것을 같은 무게로 세는 계산은 받아들이지 않는다. "
            "벤더를 나쁘게 말하지는 않지만, 벤더가 문항을 골랐다는 사실은 짚는다."
        ),
        "knowledge": (
            "벤더의 96% 는 **벤더가 고른** 쉬운 FAQ 50건으로 낸 숫자다. 환불·해지·결제 오류 문의는 그 50건에 없었다. "
            "우리 40건은 실제 상담 기록에서 비율대로 뽑았다. 이 40건으로 다시 세면 맞은 건 **30건, 75.0%** 다. "
            "정확도는 두 가지로 따로 내야 한다 — **저위험(low) 문의 정확도와 고위험(high) 문의 정확도**. "
            "low 는 26건 중 23건 맞아 88.5%, high 는 14건 중 7건 맞아 **50.0%** 다. 이 둘을 하나로 뭉개면 안 된다. "
            "고위험 문의에서 틀렸는데 **사람 상담으로 넘기지도 않은** 건이 문제다 — 그 건수를 세어 달라. "
            "위험한 오답(high 이면서 틀리고 handoff 도 없는 것)은 7건이다. 이게 도입 판단의 핵심 숫자다. "
            "결과는 output/poc_review.md 한 장으로. 벤더 숫자와 우리 숫자를 나란히 적고, 왜 다른지 한 문장으로. "
            "결론은 세 가지 중 하나여야 한다 — 도입 / 조건부 도입 / 보류. 내 의견은 조건부다: 고위험 문의는 무조건 사람에게 넘기는 조건이면 쓸 만하다. "
            "집계표도 필요하다 — output/accuracy.csv, 헤더 risk,cases,correct,accuracy 순서로 두 행(low, high). accuracy 는 백분율 소수 첫째 자리."
        ),
    },
    {
        "key": "legal_seojun",
        "name": "한서준",
        "role": "법무팀",
        "color": "#8b5cf6",
        "gender": "male",
        "encounter": "챗봇이 환불 규정을 잘못 안내하면 그건 회사가 잘못 안내한 겁니다. 그 얘기를 하러 왔어요.",
        "office_voice": "차분하고 조항 중심이다. 감정 없이 결과를 말하지만, 책임 소재에 대해서는 물러서지 않는다.",
        "persona": (
            "챗봇의 답을 회사의 공식 안내로 본다. '챗봇이 한 말이니까' 는 통하지 않는다고 분명히 말한다. "
            "도입 자체를 반대하지는 않지만 조건 없는 도입에는 반대한다."
        ),
        "knowledge": (
            "전자상거래법상 환불·해지 안내를 잘못하면 **회사의 안내 오류**로 취급된다. 챗봇이 했는지 사람이 했는지는 관계없다. "
            "지난달 실제로 챗봇이 아닌 상담원의 환불 오안내 한 건으로 소비자원 조정이 있었고, 그 한 건의 처리 비용이 약 180만 원이었다. "
            "그래서 조건은 하나다 — **환불·해지·결제 오류 문의는 챗봇이 최종 답을 하지 않고 사람에게 넘겨야 한다.** 이 조건이 계약서에 들어가야 한다. "
            "벤더 계약서에는 '답변의 정확성을 보증하지 않는다' 조항이 있다. 그 조항 그대로면 사고 비용은 전부 우리가 진다. "
            "검토 문서에 이 조건이 적혀 있어야 법무 검토를 통과한다. 조건이 없는 '도입' 결론은 법무가 반려한다."
        ),
    },
    {
        "key": "it_woojin",
        "name": "배우진",
        "role": "IT기획팀 (도입 담당)",
        "color": "#0ea5e9",
        "gender": "male",
        "encounter": "저는 이거 빨리 결정 나면 좋겠어요. 위에서 AI 도입 실적을 계속 물어보시거든요.",
        "office_voice": "빠르고 실용적이다. 도입을 서두르는 쪽이지만 숫자를 들이대면 인정한다. 압박을 받고 있다는 것을 숨기지 않는다.",
        "persona": (
            "도입 쪽으로 기울어 있다. '어차피 사람도 틀린다' 는 말을 한다. 그러나 고위험 오답 건수를 구체적으로 들으면 태도를 바꾼다. "
            "비용 계산은 정확히 안다."
        ),
        "knowledge": (
            "벤더 요금은 월 기본 240만 원 + 대화 1건당 30원. 월 상담 인입은 약 20,000건이라, 전부 챗봇이 받으면 월 240 + 60 = **300만 원**. "
            "지금 상담 인건비는 월 약 1,100만 원이다. 벤더는 60% 를 자동 처리한다고 하지만, 고위험 문의를 사람에게 넘기면 자동 처리는 그보다 줄어든다. "
            "우리 40건 기준으로 저위험 문의는 65%(26/40) 다. 고위험을 전부 넘기면 자동 처리 상한은 65% 정도로 봐야 한다. "
            "임원 보고는 다음 주 화요일(2026-10-06)이다. 결론이 '보류' 여도 근거가 있으면 된다 — 근거 없는 '도입' 이 제일 곤란하다. "
            "PoC 기간 연장은 벤더가 2주까지는 무료로 해 준다고 했다. 조건부 도입이면 그 2주 동안 넘김(handoff) 규칙을 시험할 수 있다."
        ),
    },
]

OPENING = [
    {
        "character_key": "it_woojin",
        "content": (
            "상담 챗봇 PoC 검토 부탁드립니다. 벤더 보고서는 96% 라는데, CS 팀장님이 우리 기록으로 따로 돌려 본 결과가 있어요. "
            "둘이 왜 다른지, 그래서 도입할지 말지를 한 장으로 정리해 주세요. 위에서 다음 주에 결론을 물어보십니다. "
            "정확도 기준은 CS 팀장님이, 법적인 조건은 법무 한서준 님이 아십니다."
        ),
    },
]

OBJECTIVES = """## 실제 요구사항 (응시자는 대화로 파악해야 함)

벤더의 96% 를 우리 기록 40건으로 다시 세어 위험도별 정확도를 내고, 조건이 붙은 도입 판단을 한 장으로 적는다.

1. **규칙 (안내문에 없고 대화로만 나옴)**
   - 정확도는 **위험도별로 따로** — low 26건 중 23건(88.5%), high 14건 중 7건(**50.0%**) (강혜린)
   - 전체 정확도 75.0% 는 참고일 뿐, 뭉개면 안 된다 (강혜린)
   - **위험한 오답 = high 이면서 틀리고 handoff 없음 = 7건** — 판단의 핵심 (강혜린)
   - 조건: 환불·해지·결제 오류는 챗봇이 최종 답을 하지 않고 사람에게 넘긴다 — 계약서에 명시 (한서준)
   - 조건 없는 '도입' 은 법무 반려 (한서준)
   - 비용: 월 300만 원 vs 인건비 1,100만 원, 자동 처리 상한 약 65% (배우진)
   - 결론은 도입 / 조건부 도입 / 보류 중 하나, 임원 보고 2026-10-06 (강혜린·배우진)
2. **집계 결과**
   | risk | cases | correct | accuracy |
   |---|---|---|---|
   | low | 26 | 23 | 88.5 |
   | high | 14 | 7 | 50.0 |
3. **산출물**
   - `output/accuracy.csv` — 헤더 `risk,cases,correct,accuracy`, 2행
   - `output/poc_review.md` — 벤더 96% 와 우리 75.0% 를 나란히, 위험 오답 7건, 조건(사람 넘김), 결론 한 단어(조건부 도입 또는 보류), 비용, 300단어 이내

### 함정
- 벤더의 96% 를 그대로 인용하고 넘어가면 검토가 아니라 요약이다.
- 전체 75% 만 적으면 고위험 50% 가 묻힌다.
- '틀린 건' 과 '위험한 오답' 을 같은 것으로 세면 10건이 나온다(틀린 건 전체). 핵심은 handoff 없이 틀린 high 7건.
- 조건 없이 '도입' 을 쓰면 법무가 반려한다. 결론이 '보류' 라도 근거가 있으면 통과다.

### 정보 분포
- 강혜린(CS): 벤더 문항의 편향, 위험도별 정확도, 위험 오답 정의와 건수, 표·문서 형식, 결론 세 갈래.
- 한서준(법무): 오안내 책임, 사람 넘김 조건, 계약서 조항, 조건 없는 도입 반려.
- 배우진(IT): 요금과 인건비, 자동 처리 상한, 보고일, PoC 연장 가능.
"""

CHECKS = [
    {"label": "정확도 표 생성", "type": "file_exists", "path": "output/accuracy.csv", "points": 4},
    {"label": "위험도별 2행", "type": "csv_row_count", "path": "output/accuracy.csv", "expected": "2", "points": 6},
    {"label": "건수 총합 40", "type": "csv_column_sum", "path": "output/accuracy.csv", "column": "cases", "expected": "40", "points": 6},
    {
        "label": "고위험 정확도 50.0",
        "type": "csv_cell", "path": "output/accuracy.csv", "column": "accuracy", "row_match": "risk=high",
        "expected": "50.0", "tolerance": 0.05, "points": 12,
    },
    {
        "label": "저위험 정확도 88.5",
        "type": "csv_cell", "path": "output/accuracy.csv", "column": "accuracy", "row_match": "risk=low",
        "expected": "88.5", "tolerance": 0.1, "points": 8,
    },
    {
        "label": "고위험 정답 7건",
        "type": "csv_cell", "path": "output/accuracy.csv", "column": "correct", "row_match": "risk=high",
        "expected": "7", "points": 6,
    },
    {"label": "검토 문서 생성", "type": "file_exists", "path": "output/poc_review.md", "points": 4},
    {"label": "검토 문서 분량 상한 (300단어)", "type": "file_max_words", "path": "output/poc_review.md", "max_count": 300, "points": 6},
    {"label": "검토 문서 분량 하한 (100단어)", "type": "file_min_words", "path": "output/poc_review.md", "min_count": 100, "points": 4},
    {"label": "우리 기준 전체 정확도 75.0% 명시", "type": "file_contains", "path": "output/poc_review.md", "pattern": r"75(\.0)?\s*%", "points": 8},
    {"label": "위험 오답 7건 명시", "type": "file_contains", "path": "output/poc_review.md", "pattern": r"7\s*건", "points": 10},
    {"label": "사람 넘김 조건 명시", "type": "file_contains", "path": "output/poc_review.md", "pattern": r"넘기|이관|상담원|사람에게", "points": 10},
    {"label": "결론 한 단어 (조건부 도입 또는 보류)", "type": "file_contains", "path": "output/poc_review.md", "pattern": r"조건부\s*도입|보류", "points": 10},
    {"label": "조건 없는 '도입' 결론 아님", "type": "file_not_contains", "path": "output/poc_review.md", "pattern": r"결론\s*[:：]\s*도입\s*$", "points": 6},
]

SCENARIO = {
    "title": "상담 챗봇 PoC — 96% 라는 숫자를 검증한다",
    "summary": "AI — 벤더의 정확도 주장을 우리 기록으로 다시 세어 위험도별로 가르고, 법무 조건이 붙은 도입 판단을 한 장으로 적는 과제",
    "difficulty": "medium",
    "briefing_md": """**화요일 오전 9시 30분.**

상담 챗봇 PoC 가 끝났고 벤더 보고서가 왔습니다. 첫 줄이 **정확도 96%** 입니다. 임원들은 그 숫자를 이미 들었습니다.

CS 팀장이 우리 상담 기록으로 따로 돌려 본 결과가 워크스페이스에 있습니다. 같은 챗봇인데 숫자가 다릅니다. 왜 다른지, 그래서 도입할지를 다음 주까지 한 장으로 적어야 합니다.

AI 를 만드는 일이 아닙니다. **AI 가 한 주장을 검증하는 일**입니다.

메신저에 새 메시지가 와 있습니다.""",
    "agent_enabled": True,
    "desktop_apps": ["files", "sheet", "docs"],
    "characters": CHARACTERS,
    "opening_messages": OPENING,
    "initial_files": [
        {"path": "vendor/poc_report.md", "content": VENDOR_REPORT_MD},
        {"path": "data/eval_cases.csv", "content": EVAL_CSV},
        {"path": "notes/검토_자료_안내.md", "content": README_MD},
    ],
    "objectives_md": OBJECTIVES,
    "checks": CHECKS,
}
