"""시나리오 작성 에이전트 — 관리자의 한 줄 요청으로 시나리오 전체를 설계한다.

이 플랫폼의 시나리오는 '문제 지문'이 아니라 '상황'이다. 좋은 시나리오는
  · 요구사항이 어디에도 통째로 적혀 있지 않고, 인물별로 조각나 있으며
  · 초기 파일이 진짜 데이터처럼 생겼고, 그 데이터에서 정답이 **결정론적으로** 나오고
  · 자동 체크가 그 정답을 정확히 잡아내며
  · 순진하게 접근하면 걸리는 함정이 하나쯤 있다.
이걸 사람이 손으로 짜려면 오래 걸린다. LLM 에게 설계 규약을 주고 JSON 으로 받되,
받은 것을 그대로 믿지 않고 여기서 검증·정규화한다 — 참조가 깨진 인물 키, 컴파일되지
않는 정규식, 범위를 벗어난 배점은 조용히 시험을 망가뜨리기 때문이다.
"""

from __future__ import annotations

import json
import re
import unicodedata

from ..schemas import ScenarioIn
from . import provider
from .autoeval import default_rubric

AUTHOR_MARKER = "odysseus-scenario-author/1"
COLORS = ["#8b5cf6", "#0ea5e9", "#f59e0b", "#10b981", "#ef4444", "#ec4899", "#6366f1", "#14b8a6"]
CHECK_TYPES = {"file_exists", "file_contains", "command"}
DIFFICULTIES = {"easy", "medium", "hard"}

SYSTEM = f"""You are the scenario designer for Odysseus, a work-simulation assessment
platform. ({AUTHOR_MARKER})

## What a scenario is here
A candidate sits at a virtual desktop — messenger, IDE, terminal, AI agent,
file explorer, GitHub, a restricted browser. **The task is never stated.** The
candidate discovers what is actually needed by talking to coworkers (NPCs) on
the messenger, then produces artifacts in the workspace. Everything they do is
recorded; artifacts are auto-checked and then graded against a rubric.

So a scenario is not a problem statement. It is a *situation* with information
deliberately scattered across people and files.

## Design rules (each one matters)
1. **No one hands over the whole task.** The opening message is a vague,
   human request from someone who does not know the technical details. Every
   requirement lives in a specific character's `knowledge` or in a file.
2. **Spread the knowledge.** 2–4 characters. Each holds something the others do
   not: the manager knows the deadline and the shape of the deliverable; the
   engineer knows the schema, rules, and edge cases; QA holds a concrete
   reproducible case with numbers. At least one character must redirect to
   another by name ("그건 박민호가 잘 알아요"). No character's knowledge should be
   a copy of another's.
3. **Plant a trap.** Include at least one thing a naive candidate gets wrong:
   an out-of-range row, a status that must be excluded, a unit mismatch, an
   inclusive/exclusive boundary, a stale comment in the code. Put the truth in
   one character's knowledge, not in the opening message.
4. **Files are real.** Provide realistic initial files: data (CSV/JSON/JSONL/
   YAML/logs) with **20–60 rows** that a person would plausibly have, plus, when
   appropriate, an existing script that is subtly wrong. Data must be
   internally consistent and deterministic — you will derive expected answers
   from it by hand, so keep the arithmetic simple enough to be exact.
5. **Checks are derived, not invented.** Compute expected outputs from the
   files you wrote and encode them as checks. Use `file_exists` for each
   deliverable, `file_contains` with **anchored regex on a whole line**
   (e.g. `^2026-08-26,240000,2$`) for exact values, `command` for scripts
   that must run. 4–8 checks, points summing to 60–100. Never assert a value
   you did not compute from the data. Write the computed values into
   `objectives_md` too, so graders can see them.
6. **`objectives_md` is the hidden truth.** State the real requirements, the
   trap, and the exact expected results. It is shown only to NPCs and graders,
   never to the candidate.
7. **Briefing is narrative, not instructions.** 4–7 short paragraphs in
   Korean, like the opening of a novel: time of day, who the candidate is (new
   to the team, N weeks in), what just happened, and that a message is waiting
   on the messenger. Bold the first line (e.g. `**월요일 오전 9시 12분.**`).
   No bullet lists of tasks, no hints about the trap.
8. **Personas are people.** Each `persona` has a tone, what they care about,
   how they redirect, and one sentence on how they react to a rude or 반말
   candidate (they are coworkers, not assistants — some cool off, some cut the
   conversation). `knowledge` is written as facts the person would actually
   know, in first-person-neutral Korean, specific enough to answer questions.
9. **Environment limits.** The workspace has python3 (numpy, pandas), node,
   go, java, gcc, git, sqlite3, jq — **no network**. Do not require pip
   installs or external services. Paths are relative (`data/orders.csv`,
   `output/report.csv`). Scripts are run with commands like `python3 report.py`.
10. **Korean everywhere** for names, messages, files' human text, briefing,
    objectives. Character keys are ASCII slugs like `pm_sujin`.

## Output
Return **only** a JSON object, no prose, no code fences:
{{
  "title": "…",
  "summary": "관리자용 한 줄 (응시자 비노출)",
  "difficulty": "easy|medium|hard",
  "briefing_md": "…",
  "characters": [{{"key":"pm_sujin","name":"김수진","role":"프로덕트 매니저","persona":"…","knowledge":"…"}}],
  "opening_messages": [{{"character_key":"pm_sujin","content":"…"}}],
  "initial_files": [{{"path":"data/orders.csv","content":"…"}}],
  "objectives_md": "…",
  "checks": [{{"label":"…","type":"file_exists","path":"output/x.csv","points":10}},
             {{"label":"…","type":"file_contains","path":"output/x.csv","pattern":"^…$","points":15}},
             {{"label":"…","type":"command","command":"python3 x.py","expected_stdout":"…","points":10}}],
  "rubric": null,
  "agent_enabled": true,
  "design_notes": "관리자에게: 정보를 어떻게 나눴고 함정이 무엇이며 체크 값을 어떻게 계산했는지 (한국어, 5–10문장)"
}}
`rubric` may be null to use the platform default. Keep the whole response
under ~12,000 tokens; prefer fewer, richer files over many thin ones."""

EXAMPLE_BRIEF = (
    "예: '중견 커머스 데이터플랫폼팀. 주간 매출 리포트 숫자가 이상하다는 CS 제보 — "
    "환불·취소 주문과 기간 밖 데이터가 섞여 들어가는 집계 버그. 난이도 medium.'"
)


def _user_prompt(brief: str, draft: dict | None, instruction: str | None) -> str:
    if draft:
        return (
            "Below is the current scenario draft as JSON. Apply the instruction and return the "
            "**complete** updated scenario in the same output format (all fields, not a diff). "
            "Keep everything the instruction does not touch. Recompute checks if data changed.\n\n"
            f"[instruction]\n{(instruction or '').strip() or '전체를 더 완성도 있게 다듬어라.'}\n\n"
            f"[draft]\n{json.dumps(draft, ensure_ascii=False)}"
        )
    return (
        "Design a complete scenario from this brief. Fill every field.\n\n"
        f"[brief]\n{brief.strip()}"
    )


# ── 응답 파싱 ────────────────────────────────────────────────────

_FENCE = re.compile(r"```(?:json)?\s*(.*?)```", re.S)


def extract_json(text: str) -> dict:
    """모델 출력에서 JSON 객체를 꺼낸다 — 코드 펜스·앞뒤 잡담을 견딘다."""
    candidates = [m.group(1) for m in _FENCE.finditer(text)] + [text]
    for cand in candidates:
        start = cand.find("{")
        end = cand.rfind("}")
        if start < 0 or end <= start:
            continue
        try:
            data = json.loads(cand[start : end + 1])
        except json.JSONDecodeError:
            continue
        if isinstance(data, dict):
            return data
    raise ValueError("응답에서 JSON 객체를 찾지 못했습니다")


# ── 정규화 ───────────────────────────────────────────────────────

def _slug(text: str, fallback: str) -> str:
    base = unicodedata.normalize("NFKD", str(text or "")).encode("ascii", "ignore").decode()
    base = re.sub(r"[^a-z0-9]+", "_", base.lower()).strip("_")
    return base[:40] or fallback


def _path(raw: str) -> str | None:
    p = str(raw or "").strip().replace("\\", "/").lstrip("/")
    if not p or any(seg in ("", ".", "..") for seg in p.split("/")):
        return None
    return p[:300]


def _int(value, lo: int, hi: int, default: int) -> int:
    try:
        return max(lo, min(hi, int(value)))
    except (TypeError, ValueError):
        return default


def normalize_scenario(raw: dict) -> tuple[dict, list[str]]:
    """모델이 준 것을 ScenarioIn 이 받을 수 있는 형태로. 고친 것은 warnings 로 남긴다."""
    warnings: list[str] = []

    title = str(raw.get("title") or "").strip()[:200] or "제목 없는 시나리오"
    summary = str(raw.get("summary") or "").strip()[:2000]
    difficulty = str(raw.get("difficulty") or "medium").strip().lower()
    if difficulty not in DIFFICULTIES:
        warnings.append(f"난이도 '{difficulty}' 를 medium 으로")
        difficulty = "medium"
    briefing = str(raw.get("briefing_md") or "").strip()[:40000]
    objectives = str(raw.get("objectives_md") or "").strip()[:32000]

    # 인물 — 키는 ASCII 슬러그, 유일해야 한다
    characters: list[dict] = []
    seen: set[str] = set()
    for i, c in enumerate(raw.get("characters") or []):
        if not isinstance(c, dict):
            continue
        name = str(c.get("name") or "").strip()[:60]
        if not name:
            warnings.append(f"이름 없는 인물 #{i + 1} 제외")
            continue
        key = _slug(c.get("key") or "", f"person_{i + 1}")
        base_key, n = key, 2
        while key in seen:
            key = f"{base_key}_{n}"
            n += 1
        seen.add(key)
        characters.append(
            {
                "key": key,
                "name": name,
                "role": str(c.get("role") or "").strip()[:80],
                "color": str(c.get("color") or COLORS[i % len(COLORS)]),
                "persona": str(c.get("persona") or "").strip()[:4000],
                "knowledge": str(c.get("knowledge") or "").strip()[:8000],
            }
        )
        if len(characters) >= 8:
            break

    # 오프닝 — 존재하는 인물이 보내야 한다
    opening: list[dict] = []
    for m in raw.get("opening_messages") or []:
        if not isinstance(m, dict):
            continue
        content = str(m.get("content") or "").strip()[:4000]
        if not content:
            continue
        ck = _slug(m.get("character_key") or "", "")
        if ck not in seen:
            if not characters:
                continue
            warnings.append(f"오프닝 발신자 '{ck}' 를 {characters[0]['name']} 으로")
            ck = characters[0]["key"]
        opening.append({"character_key": ck, "content": content})
        if len(opening) >= 10:
            break

    # 초기 파일 — 경로 정규화, 중복 제거
    files: list[dict] = []
    paths: set[str] = set()
    for f in raw.get("initial_files") or []:
        if not isinstance(f, dict):
            continue
        p = _path(f.get("path"))
        if not p or p in paths:
            if p:
                warnings.append(f"중복 파일 {p} 제외")
            continue
        paths.add(p)
        files.append({"path": p, "content": str(f.get("content") or "")[:400_000]})
        if len(files) >= 60:
            break

    # 체크 — 종류·필수 필드·정규식 컴파일·배점 범위
    checks: list[dict] = []
    for c in raw.get("checks") or []:
        if not isinstance(c, dict):
            continue
        ctype = str(c.get("type") or "").strip()
        label = str(c.get("label") or "").strip()[:120] or "체크"
        points = _int(c.get("points"), 1, 100, 10)
        if ctype not in CHECK_TYPES:
            warnings.append(f"체크 '{label}': 알 수 없는 종류 '{ctype}' 제외")
            continue
        entry: dict = {"label": label, "type": ctype, "points": points}
        if ctype in ("file_exists", "file_contains"):
            p = _path(c.get("path"))
            if not p:
                warnings.append(f"체크 '{label}': 경로 없음 — 제외")
                continue
            entry["path"] = p
        if ctype == "file_contains":
            pattern = str(c.get("pattern") or "")
            try:
                re.compile(pattern)
            except re.error as e:
                warnings.append(f"체크 '{label}': 정규식 오류({e}) — 제외")
                continue
            if not pattern:
                warnings.append(f"체크 '{label}': 패턴 없음 — 제외")
                continue
            entry["pattern"] = pattern[:1000]
        if ctype == "command":
            cmd = str(c.get("command") or "").strip()
            if not cmd:
                warnings.append(f"체크 '{label}': 명령 없음 — 제외")
                continue
            entry["command"] = cmd[:500]
            if c.get("expected_stdout"):
                entry["expected_stdout"] = str(c["expected_stdout"])[:2000]
        checks.append(entry)
        if len(checks) >= 30:
            break

    rubric = raw.get("rubric")
    if not (
        isinstance(rubric, dict)
        and isinstance(rubric.get("process"), list)
        and isinstance(rubric.get("result"), list)
        and all(isinstance(x, dict) and x.get("name") for x in rubric["process"] + rubric["result"])
    ):
        rubric = default_rubric()

    scenario = {
        "title": title,
        "summary": summary,
        "difficulty": difficulty,
        "briefing_md": briefing,
        "characters": characters,
        "opening_messages": opening,
        "initial_files": files,
        "objectives_md": objectives,
        "checks": checks,
        "rubric": rubric,
        "agent_enabled": bool(raw.get("agent_enabled", True)),
    }
    # 최종 관문 — 저장 스키마가 거부할 것이면 여기서 알아야 한다
    ScenarioIn.model_validate(scenario)

    if not characters:
        warnings.append("인물이 하나도 없습니다 — 직접 추가해야 합니다")
    if not opening:
        warnings.append("오프닝 메시지가 없습니다 — 응시자의 유일한 출발점입니다")
    if not objectives:
        warnings.append("숨은 요구사항(objectives)이 비어 있습니다")
    if not checks:
        warnings.append("자동 체크가 없습니다 — 결과 평가가 전부 사람 몫이 됩니다")
    return scenario, warnings


# ── 실행 ─────────────────────────────────────────────────────────

async def author_scenario(
    res: provider.ResolvedAi,
    *,
    brief: str,
    draft: dict | None = None,
    instruction: str | None = None,
) -> tuple[dict, str, list[str]]:
    """(정규화된 시나리오, 설계 노트, 경고). JSON 이 깨지면 한 번 고쳐 달라고 한다."""
    messages = [{"role": "user", "content": _user_prompt(brief, draft, instruction)}]
    text = await provider.complete_text(res, messages, system=SYSTEM, max_tokens=16000)
    try:
        raw = extract_json(text)
    except ValueError:
        repair = messages + [
            {"role": "assistant", "content": text[-6000:]},
            {"role": "user", "content": "That was not valid JSON. Return the complete scenario again as a single valid JSON object and nothing else."},
        ]
        text = await provider.complete_text(res, repair, system=SYSTEM, max_tokens=16000)
        raw = extract_json(text)  # 두 번째도 실패하면 그대로 올린다
    scenario, warnings = normalize_scenario(raw)
    notes = str(raw.get("design_notes") or "").strip()[:6000]
    return scenario, notes, warnings
