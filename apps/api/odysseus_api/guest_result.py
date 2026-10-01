"""게스트가 시험을 마치고 받아 가는 것.

게스트는 나가면 그 계정으로 다시 못 들어온다. 그래서 **제출 직후 그 화면이 마지막 화면**이고,
거기서 아무것도 주지 않으면 180분을 쓴 사람이 빈손으로 나간다. 지금까지가 그랬다 — 자동 채점은
평가자가 리뷰 화면에서 눌러야만 돌았고, 게스트에게는 점수도 총평도 닿지 않았다.

여기서 두 가지를 한다.

- 채점 자체는 여기 없다. 시험이 끝나면 grading.schedule 이 건다 — 게스트든 응시자든 같다.
- **채점 결과를 응시자가 볼 수 있는 모양으로 깎는다** (:func:`view`).

여기서 무엇을 빼는지가 이 모듈의 핵심이다. 기준은 하나다 — **응시자가 한 일에 대한 평가는 주고,
하지 않은 일(= 했어야 하는 일)은 주지 않는다.** 후자는 정답지이고, 같은 시나리오가 실제 채용 시험으로
쓰인다. 게스트로 한 번 들어와 아무것도 하지 않고 제출하면 "무엇을 만들었어야 했는지" 목록을 통째로
받아 갈 수 있어서는 안 된다.

그 기준으로 실제 채점 결과를 보면(2026-09-19 운영 확인):

- ``checks`` 는 정답지 그 자체다 — 통과 **개수**만 남기고 항목 이름은 뺀다.
- ``summary`` · ``concerns`` · ``requirement_discovery`` · 항목별 ``comment`` 는 정답을 옆에 놓고 쓴
  글이라 그대로 새어 나갔다. 실제로 "output/analysis.json, config/routing.yaml 수정, output/report.md
  등 필수 산출물이 생성되지 않았다" 가 게스트 응답에 그대로 실렸다. 전부 뺀다.
- ``strengths`` 는 응시자가 **실제로 한 일**의 목록이라 남긴다. 점수와 항목별 배점도 남긴다.

빠진 자리는 화면이 한 줄로 말한다 — 무엇을 더 했어야 했는지는 알려 주지 않는다고.
"""

from __future__ import annotations

import logging
import re

from sqlalchemy.ext.asyncio import AsyncSession

from .models import Attempt

log = logging.getLogger("odysseus.guest-result")

from .grading import is_running, latest_auto


def _num(value) -> float | None:
    try:
        return round(float(value), 1)
    except (TypeError, ValueError):
        return None


def _check_counts(checks) -> dict:
    """자동 확인 통과 **개수**. 항목 이름은 쓰지 않고 세기만 한다."""
    rows = [c for c in (checks or []) if isinstance(c, dict) and not c.get("unverified")]
    return {
        "checks_passed": sum(1 for c in rows if c.get("passed")),
        "checks_total": len(rows),
    }


_STRIP = re.compile(r"[^0-9A-Za-z가-힣]+")
#: 이 길이의 글자 덩어리가 정답지에 그대로 있으면 그 문장은 정답지를 옮겨 적은 것으로 본다.
#: 다섯 글자면 "응답시간대"·"20261102"·"이서진문가영" 은 잡고, "질문하여"·"파악함" 같은 흔한 말은 지나간다.
_WINDOW = 5


def _answer_corpus(scenario) -> str:
    """정답지에 해당하는 글 전부 — 숨은 목표, 체크 이름·경로·기대 출력."""
    parts = [str(getattr(scenario, "objectives_md", "") or "")]
    for c in getattr(scenario, "checks", None) or []:
        if isinstance(c, dict):
            parts.extend(str(c.get(k) or "") for k in ("label", "path", "pattern", "expected_stdout", "command"))
    return _STRIP.sub("", " ".join(parts))


def _shares_answer(text: str, corpus: str) -> bool:
    """이 문장에 정답지 글자 덩어리가 들어 있는가.

    '잘한 점' 은 응시자가 **한 일**만 적는 자리지만, 모델은 정답지를 옆에 놓고 쓴다. 그래서 "진짜
    목적(화·목 회의, 응답시간대)을 일부 파악함" 처럼 한 일을 칭찬하는 문장 안에 정답이 그대로 실린다
    (2026-09-20 운영 확인). 프롬프트로 부탁하는 것만으로는 부족하다 — 서버가 다시 본다.
    """
    flat = _STRIP.sub("", text or "")
    if not corpus or len(flat) < _WINDOW:
        return False
    return any(flat[i : i + _WINDOW] in corpus for i in range(len(flat) - _WINDOW + 1))


def _scenario_view(row: dict, corpus: str = "") -> dict:
    """한 시나리오 결과에서 **게스트에게 보여도 되는 것만** 골라 낸다 (모듈 설명의 기준).

    항목별 ``comment`` 까지 빼는 이유: 낮은 점수의 근거는 곧 "무엇이 없었는가" 이고, 그것을 적으면
    정답을 적는 것과 같아진다. 점수만으로도 어디가 약했는지는 보인다.
    """

    def _items(key: str) -> list[dict]:
        out = []
        for item in row.get(key) or []:
            if not isinstance(item, dict):
                continue
            out.append(
                {
                    "name": str(item.get("name", ""))[:120],
                    # 루브릭은 만점을 max 로, 받은 점수를 score 로 적는다 (ai/autoeval 출력 형식).
                    "points": _num(item.get("max", item.get("points"))),
                    "earned": _num(item.get("score", item.get("earned"))),
                }
            )
        return out

    return {
        "title": row.get("title", ""),
        "points": row.get("points", 0),
        "score_pct": row.get("score_pct", 0),
        "earned_points": row.get("earned_points", 0),
        # 정답지는 주지 않는다 — 몇 개를 통과했는지 수만. ``checks_earned`` 는 개수가 아니라 배점
        # 합계라서 "N개 통과" 로 쓸 수 없다(0/100 처럼 보인다). 여기서 실제 개수를 센다.
        **_check_counts(row.get("checks")),
        "process": _items("process"),
        "result": _items("result"),
        # 응시자가 실제로 한 일만 남긴다. 총평·아쉬운 점·요구사항 파악 평가는 정답을 옆에 놓고 쓴 글이다.
        "strengths": [
            str(x)[:300] for x in (row.get("strengths") or []) if not _shares_answer(str(x), corpus)
        ][:6],
    }


async def view(db: AsyncSession, attempt: Attempt) -> dict:
    """게스트가 보는 결과. 아직 채점 전이면 그 사실을 말한다."""
    evaluation = await latest_auto(db, attempt.id)
    if evaluation is None:
        return {"state": "grading" if is_running(attempt.id) else "pending", "scenarios": []}
    scores = evaluation.scores if isinstance(evaluation.scores, dict) else {}
    rows = [s for s in (scores.get("scenarios") or []) if isinstance(s, dict)]
    # 정답지는 응시 시작 때 동결한 정의에서 읽는다 — 채점이 본 것과 같은 것이어야 걸러진다.
    from .definitions import definition_for_attempt, scenario_from_definition

    definition = await definition_for_attempt(db, attempt)
    corpus_by_id = {
        str(r.get("scenario_id")): _answer_corpus(sc)
        for r in rows
        if (sc := scenario_from_definition(definition, r.get("scenario_id")))
    }
    return {
        "state": "ready",
        "overall_score": scores.get("overall_score"),
        "graded_at": evaluation.created_at,
        "scenarios": [_scenario_view(r, corpus_by_id.get(str(r.get("scenario_id")), "")) for r in rows],
    }
