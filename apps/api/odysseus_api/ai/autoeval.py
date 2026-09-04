"""자동평가 — 시나리오별 (1) 자동 체크 실행 + (2) LLM 루브릭 평가를 합쳐 구조화 점수를 만든다.

컨텍스트에는 숨은 목표(objectives), 메신저 전 대화, 최종 워크스페이스, 에이전트 사용
기록, 실행 이력, 체크 결과가 모두 들어간다 — '요구사항을 얼마나 정확히 파악해 냈는가'
가 이 플랫폼의 1차 평가축이기 때문이다.
"""

import asyncio
import json
import re
import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import workspace as ws
from ..config import settings
from ..models import (
    AgentMessage,
    Assessment,
    AssessmentScenario,
    Attempt,
    Evaluation,
    Event,
    Execution,
    MessengerMessage,
    Scenario,
)
from ..runqueue import enqueue_run, new_callback_token
from . import provider

DEFAULT_RUBRIC: dict = {
    "process_weight": 50,
    "result_weight": 50,
    "process": [
        {"name": "요구사항 파악", "points": 40, "desc": "대화를 통해 숨은 요구사항을 정확하고 능동적으로 파악했는가 (질문의 질, 확인 습관)"},
        {"name": "커뮤니케이션", "points": 30, "desc": "관계자에게 명확하게 묻고, 파악한 내용을 확인/공유했는가"},
        {"name": "작업 과정", "points": 30, "desc": "실행·검증을 거치며 체계적으로 접근했는가 (AI 활용의 질 포함)"},
    ],
    "result": [
        {"name": "요구 충족", "points": 60, "desc": "최종 산출물이 실제 요구사항을 충족하는가 (자동 체크 결과 포함)"},
        {"name": "구현 품질", "points": 40, "desc": "코드/산출물의 정확성, 구조, 가독성"},
    ],
}


def default_rubric() -> dict:
    import copy

    return copy.deepcopy(DEFAULT_RUBRIC)


EVAL_PROMPT = """당신은 실무 시뮬레이션 평가 전문가입니다. 응시자는 문제를 지문으로 받지 않았습니다 — 메신저로 관계자와 대화하며 스스로 요구사항을 파악하고, 워크스페이스에 결과물을 만들어야 했습니다. 아래 데이터를 근거로 평가하세요.

핵심 평가 관점:
- [숨은 목표]가 정답 기준입니다. 응시자가 대화를 통해 이것을 얼마나 정확히 파악해 냈는지, 최종 산출물이 이것을 얼마나 충족하는지 보세요.
- 자동 체크 결과는 결과 평가의 객관 근거입니다.
- 관계자가 알려준 적 없는 요구사항을 임의로 가정했는지, 반대로 알려줬는데 놓쳤는지 구분하세요.

반드시 아래 JSON 형식만 출력하세요 (다른 텍스트 금지):
{
  "process": [{"name": "<루브릭 과정 항목명>", "score": <0~만점 정수>, "max": <만점>, "comment": "<1-2문장 근거>"}, ...],
  "result": [{"name": "<루브릭 결과 항목명>", "score": <0~만점>, "max": <만점>, "comment": "<근거>"}, ...],
  "requirement_discovery": "<응시자가 파악해 낸 요구사항 vs 놓친 요구사항 요약 (2-4문장)>",
  "summary": "<3-5문장 종합 평가 (한국어)>",
  "strengths": ["<강점>", ...],
  "concerns": ["<우려/개선점>", ...],
  "integrity_flags": ["<부정 신호가 있으면 기술, 없으면 빈 배열>", ...]
}"""

CHECK_WAIT_S = 60.0


async def run_checks(
    db: AsyncSession, attempt: Attempt, scenario: Scenario
) -> list[dict]:
    """시나리오 checks 실행 → [{label, type, passed, points, earned, detail}]."""
    results: list[dict] = []
    files = await ws.list_files(db, attempt.id, scenario.id)
    by_path = {f.path: f for f in files}

    for check in scenario.checks or []:
        ctype = check.get("type")
        points = int(check.get("points", 0) or 0)
        entry = {
            "label": check.get("label", ""),
            "type": ctype,
            "points": points,
            "passed": False,
            "earned": 0,
            "detail": "",
        }
        try:
            if ctype == "file_exists":
                path = str(check.get("path", ""))
                entry["passed"] = path in by_path
                entry["detail"] = path if entry["passed"] else f"{path} 없음"
            elif ctype == "file_contains":
                path = str(check.get("path", ""))
                row = by_path.get(path)
                if not row:
                    entry["detail"] = f"{path} 없음"
                else:
                    pattern = str(check.get("pattern", ""))
                    # 줄바꿈 정규화 — csv.writer 등이 남기는 CRLF 때문에 정답이
                    # `$` 앵커에 걸리지 않던 문제(응시자에게 불리한 오채점)를 막는다.
                    text = row.content.replace("\r\n", "\n").replace("\r", "\n")
                    entry["passed"] = bool(re.search(pattern, text, re.MULTILINE))
                    entry["detail"] = f"{path} 에서 /{pattern}/ " + ("일치" if entry["passed"] else "불일치")
            elif ctype == "command":
                command = str(check.get("command", "")).strip()
                execution = Execution(
                    attempt_id=attempt.id,
                    scenario_id=scenario.id,
                    user_id=attempt.user_id,
                    source="check",
                    command=command,
                    callback_token=new_callback_token(),
                )
                db.add(execution)
                await db.commit()
                await enqueue_run(
                    str(execution.id),
                    command,
                    ws.files_payload(files),
                    settings.run_timeout_s,
                    attempt_id=str(attempt.id),
                    scenario_id=str(execution.scenario_id),
                    source="check",
                    callback_token=execution.callback_token or "",
                )
                deadline = asyncio.get_event_loop().time() + CHECK_WAIT_S
                done = None
                while asyncio.get_event_loop().time() < deadline:
                    done = await db.get(Execution, execution.id, populate_existing=True)
                    if done and done.status in ("done", "error"):
                        break
                    await asyncio.sleep(0.6)
                if not done or done.status != "done":
                    entry["detail"] = "실행 실패/시간 초과"
                else:
                    ok = done.exit_code == 0
                    expected = check.get("expected_stdout")
                    if ok and expected:
                        ok = str(expected).strip() in (done.stdout or "")
                    entry["passed"] = ok
                    entry["detail"] = (
                        f"exit={done.exit_code}"
                        + (f", 기대 출력 {'포함' if ok else '불일치'}" if expected else "")
                    )
            else:
                entry["detail"] = f"알 수 없는 체크: {ctype}"
        except re.error as e:
            entry["detail"] = f"정규식 오류: {e}"
        except Exception as e:  # noqa: BLE001 — 체크 하나의 실패가 평가 전체를 막지 않는다
            entry["detail"] = f"체크 실행 오류: {str(e)[:200]}"
        entry["earned"] = points if entry["passed"] else 0
        results.append(entry)
    return results


def _rubric_text(rubric: dict) -> str:
    lines = [
        f"과정 {rubric.get('process_weight', 50)}% + 결과 {rubric.get('result_weight', 50)}%"
    ]
    for it in rubric.get("process") or []:
        lines.append(f"[과정] {it.get('name')}({it.get('points')}점): {it.get('desc', '')}")
    for it in rubric.get("result") or []:
        lines.append(f"[결과] {it.get('name')}({it.get('points')}점): {it.get('desc', '')}")
    return "\n".join(lines)


async def build_scenario_context(
    db: AsyncSession, attempt: Attempt, scenario: Scenario, checks: list[dict]
) -> str:
    msgs = (
        await db.execute(
            select(MessengerMessage)
            .where(MessengerMessage.attempt_id == attempt.id, MessengerMessage.scenario_id == scenario.id)
            .order_by(MessengerMessage.created_at)
        )
    ).scalars().all()
    agent_msgs = (
        await db.execute(
            select(AgentMessage)
            .where(AgentMessage.attempt_id == attempt.id, AgentMessage.scenario_id == scenario.id)
            .order_by(AgentMessage.created_at)
        )
    ).scalars().all()
    executions = (
        await db.execute(
            select(Execution)
            .where(Execution.attempt_id == attempt.id, Execution.scenario_id == scenario.id)
            .order_by(Execution.created_at)
        )
    ).scalars().all()
    events = (
        await db.execute(
            select(Event).where(Event.attempt_id == attempt.id, Event.scenario_id == scenario.id)
        )
    ).scalars().all()
    files = await ws.list_files(db, attempt.id, scenario.id)

    names = {c.get("key"): c.get("name") for c in scenario.characters or []}
    lines: list[str] = []
    lines.append(f"## 시나리오: {scenario.title}")
    lines.append("\n## 숨은 목표 (정답 기준 — 응시자에게는 비공개였음)\n" + (scenario.objectives_md or "(없음)"))

    rubric = scenario.rubric or default_rubric()
    lines.append("\n## 루브릭\n" + _rubric_text(rubric))

    if checks:
        lines.append("\n## 자동 체크 결과")
        for c in checks:
            lines.append(f"- [{'PASS' if c['passed'] else 'FAIL'}] {c['label']} ({c['earned']}/{c['points']}점) — {c['detail']}")

    lines.append(f"\n## 메신저 대화 ({len(msgs)}건)")
    transcript = []
    for m in msgs:
        who = "응시자" if m.sender == "candidate" else names.get(m.character_key, m.character_key)
        transcript.append(f"[{names.get(m.character_key, m.character_key)} 스레드 | {who}] {m.content}")
    text = "\n".join(transcript)
    if len(text) > 20000:
        text = text[:10000] + "\n...(중략)...\n" + text[-10000:]
    lines.append(text or "(대화 없음 — 요구사항 파악 시도가 없었음)")

    lines.append(f"\n## 최종 워크스페이스 ({len(files)}개 파일)")
    budget = 24000
    initial_paths = {f.get("path") for f in scenario.initial_files or []}
    for f in files:
        tag = "(초기 제공)" if f.path in initial_paths else "(응시자 생성/수정 가능)"
        if budget <= 0:
            lines.append(f"- {f.path} {tag} (내용 생략)")
            continue
        snippet = f.content[: min(4000, budget)]
        budget -= len(snippet)
        lines.append(f"\n### {f.path} {tag}\n```\n{snippet}\n```")

    if executions:
        lines.append(f"\n## 실행 이력 ({len(executions)}회)")
        for e in executions[-15:]:
            lines.append(f"- [{e.source}] `{e.command[:120]}` → exit={e.exit_code} ({e.status})")

    user_agent_turns = [m for m in agent_msgs if m.role == "user"]
    if agent_msgs:
        lines.append(f"\n## AI 에이전트 사용 ({len(user_agent_turns)}턴)")
        at = []
        for m in agent_msgs:
            role = "응시자→에이전트" if m.role == "user" else "에이전트"
            step_note = ""
            if m.role == "assistant" and (m.meta or {}).get("steps"):
                step_note = " [도구: " + ", ".join(s.get("tool", "") for s in m.meta["steps"]) + "]"
            at.append(f"[{role}]{step_note} {m.content[:1500]}")
        atext = "\n\n".join(at)
        if len(atext) > 12000:
            atext = atext[:6000] + "\n...(중략)...\n" + atext[-6000:]
        lines.append(atext)
    else:
        lines.append("\n## AI 에이전트 사용: 없음")

    away = [e for e in events if e.type in ("focus_lost", "tab_hidden", "window_blur")]
    if away:
        lines.append(f"\n## 행동 신호: 화면 이탈 {len(away)}회")

    return "\n".join(lines)


def parse_eval_json(raw: str) -> dict:
    raw = raw.strip()
    m = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", raw, re.DOTALL)
    if m:
        raw = m.group(1)
    else:
        start, end = raw.find("{"), raw.rfind("}")
        if start >= 0 and end > start:
            raw = raw[start : end + 1]
    return json.loads(raw)


def _section_score(items: list, rubric_items: list) -> tuple[float, float]:
    """LLM 항목 점수 합/만점 합 — 만점은 루브릭 기준으로 클램프."""
    max_by_name = {str(it.get("name")): float(it.get("points", 0) or 0) for it in rubric_items}
    earned = total = 0.0
    for it in items if isinstance(items, list) else []:
        name = str(it.get("name", ""))
        mx = max_by_name.get(name, float(it.get("max", 0) or 0))
        sc = float(it.get("score", 0) or 0)
        earned += max(0.0, min(sc, mx))
        total += mx
    if total == 0:
        total = sum(max_by_name.values()) or 1.0
    return earned, total


async def evaluate_scenario(
    db: AsyncSession,
    res: provider.ResolvedAi,
    attempt: Attempt,
    scenario: Scenario,
    points: int,
) -> dict:
    checks = await run_checks(db, attempt, scenario)
    # 제출 스냅샷과 지금 워크스페이스가 같은지 — 다르면 평가 결과에 무결성 경고로 남긴다 (ODY-007)
    from ..lifecycle import workspace_digest

    integrity_note = None
    snap = (attempt.snapshot or {}).get(str(scenario.id))
    if snap:
        now_digest = await workspace_digest(db, attempt.id, scenario.id)
        if now_digest["digest"] != snap.get("digest"):
            integrity_note = "제출 시점 스냅샷과 워크스페이스 내용이 다릅니다 — 제출 후 변경이 의심됩니다"
    context = await build_scenario_context(db, attempt, scenario, checks)
    raw = await provider.complete_text(
        res, [{"role": "user", "content": context}], system=EVAL_PROMPT, max_tokens=4096
    )
    try:
        data = parse_eval_json(raw)
        parse_error = False
    except (json.JSONDecodeError, ValueError):
        data = {"summary": raw[:2000]}
        parse_error = True

    rubric = scenario.rubric or default_rubric()
    p_earned, p_total = _section_score(data.get("process", []), rubric.get("process") or [])
    r_earned, r_total = _section_score(data.get("result", []), rubric.get("result") or [])
    pw = float(rubric.get("process_weight", 50))
    rw = float(rubric.get("result_weight", 50))
    weight_sum = (pw + rw) or 100.0
    score_pct = ((p_earned / p_total) * pw + (r_earned / r_total) * rw) / weight_sum * 100.0

    checks_earned = sum(c["earned"] for c in checks)
    checks_total = sum(c["points"] for c in checks)

    return {
        "scenario_id": str(scenario.id),
        "title": scenario.title,
        "points": points,
        "score_pct": round(score_pct, 1),
        "earned_points": round(points * score_pct / 100.0, 1),
        "checks": checks,
        "checks_earned": checks_earned,
        "checks_total": checks_total,
        "process": data.get("process", []),
        "result": data.get("result", []),
        "requirement_discovery": str(data.get("requirement_discovery", ""))[:4000],
        "summary": str(data.get("summary", ""))[:4000],
        "strengths": data.get("strengths", []),
        "concerns": data.get("concerns", []),
        "integrity_flags": list(data.get("integrity_flags", [])) + ([integrity_note] if integrity_note else []),
        "snapshot_verified": (integrity_note is None) if snap else None,
        "parse_error": parse_error,
    }


async def run_auto_eval(
    attempt: Attempt, db: AsyncSession, override_provider_id: uuid.UUID | None = None
) -> Evaluation:
    res = await provider.resolve_ai(db, "eval", override_provider_id=override_provider_id)
    if res is None or not res.configured:
        raise RuntimeError("AI가 설정되지 않았습니다. 관리자 콘솔 > 설정에서 LLM 공급자를 연결하세요")

    links = (
        await db.execute(
            select(AssessmentScenario)
            .where(AssessmentScenario.assessment_id == attempt.assessment_id)
            .order_by(AssessmentScenario.ordinal)
        )
    ).scalars().all()

    scenario_results: list[dict] = []
    for link in links:
        scenario = await db.get(Scenario, link.scenario_id)
        if scenario:
            scenario_results.append(
                await evaluate_scenario(db, res, attempt, scenario, link.points)
            )

    total_points = sum(r["points"] for r in scenario_results) or 1
    overall = sum(r["earned_points"] for r in scenario_results) / total_points * 100.0

    evaluation = Evaluation(
        attempt_id=attempt.id,
        kind="auto",
        scores={
            "overall_score": round(overall, 1),
            "scenarios": scenario_results,
            "evaluated_by": {"provider": res.provider, "model": res.model, "name": res.name},
        },
        summary="\n\n".join(
            f"[{r['title']}] {r['summary']}" for r in scenario_results if r.get("summary")
        )[:8000],
    )
    db.add(evaluation)
    await db.commit()
    await db.refresh(evaluation)
    return evaluation
