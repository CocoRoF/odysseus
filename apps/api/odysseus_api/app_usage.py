"""어떤 앱을 **실제로 썼는가** — 기록에서 스스로 알아낸다.

시나리오가 제공한 앱은 "쓸 수 있었던 것"이고, 채점이 봐야 하는 것은 "쓴 것"이다. 둘을 같은 것으로
다루면 두 방향으로 어긋난다. 표를 준 시나리오에서 표를 한 번도 열지 않았는데 [OdyCell] 자리가
비어 있는 채로 놓여 있으면 채점자는 매번 그 빈자리를 확인해야 하고, 반대로 쓴 흔적이 있는데 그 앱이
목록에 없다는 이유로 감춰지면 증거가 사라진다.

그래서 **활동이 있으면 본다**를 하나의 규칙으로 둔다. 사람이 목록을 고르지 않는다 — 제공 앱과 남은
기록을 맞춰 서버가 정한다. 화면(채점 탭)과 자동 평가가 같은 함수를 부르므로 둘의 판단이 갈라지지
않는다.

활동의 근거는 **서버가 남긴 기록**이다. 파일이 바뀌었다는 사실, 명령이 돌았다는 사실, 메일을
보냈다는 사실, 자료를 열었다는 사실. 어느 창이 했는지(actor)는 브라우저가 붙인 이름표라 사실
판정에는 쓰지 않고 분류에만 쓴다.
"""

from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .desktop import allowed_desktop_apps
from .models import AgentMessage, Event, Execution, MessengerMessage

#: 그 앱이 일했다고 볼 이벤트 — 전부 서버가 직접 남긴 것들
FILE_WRITE_EVENTS = ("file_create", "file_save", "file_delete", "file_copy", "file_rename")

#: actor 이름표가 붙는 앱 → (그 앱의 활동으로 셀 이벤트, 한 마디 설명)
_BY_ACTOR: dict[str, tuple[tuple[str, ...], str]] = {
    "docs": (FILE_WRITE_EVENTS + ("file_open",), "문서 작업"),
    "sheet": (FILE_WRITE_EVENTS + ("file_open",), "표 작업"),
    "files": (FILE_WRITE_EVENTS + ("file_open",), "파일 정리"),
    "ide": (FILE_WRITE_EVENTS + ("file_open",), "코드 작업"),
    # 뷰어는 읽기만 한다 — "작업" 이라고 적으면 채점자가 고친 줄 안다
    "viewer": (("file_open",), "열람"),
}


def _count_actor(events: list[Event], actor: str, types: tuple[str, ...]) -> int:
    # 서버가 본 것만 센다. 브라우저가 보고한 행(client_untrusted)은 종류가 같아도 활동의 근거가 아니다.
    return sum(
        1
        for e in events
        if e.type in types
        and (e.source or "server") == "server"
        and ((e.payload or {}).get("actor") or "ide") == actor
    )


async def app_activity(
    db: AsyncSession, attempt_id: uuid.UUID, scenario
) -> dict[str, dict]:
    """이 시나리오에서 앱별로 무슨 일이 있었는가 — DB 에서 읽어 :func:`activity_from` 에 넘긴다.

    반환: ``{app_id: {"provided": bool, "used": bool, "count": int, "what": str}}``
    제공되지 않았어도 기록이 있으면 ``used`` 는 참이다 — 탭을 감추는 일이 증거를 감추는 일이 되면
    안 된다. (제공하지 않은 앱의 API 는 서버가 막지만, 막기 전에 쌓인 옛 기록은 남아 있다.)
    """
    events = list(
        (
            await db.execute(
                select(Event).where(Event.attempt_id == attempt_id, Event.scenario_id == scenario.id)
            )
        ).scalars().all()
    )
    runs = list(
        (
            await db.execute(
                select(Execution).where(
                    Execution.attempt_id == attempt_id, Execution.scenario_id == scenario.id
                )
            )
        ).scalars().all()
    )
    said = (
        await db.execute(
            select(MessengerMessage).where(
                MessengerMessage.attempt_id == attempt_id,
                MessengerMessage.scenario_id == scenario.id,
                MessengerMessage.sender == "candidate",
            )
        )
    ).scalars().all()
    asked = (
        await db.execute(
            select(AgentMessage).where(
                AgentMessage.attempt_id == attempt_id,
                AgentMessage.scenario_id == scenario.id,
                AgentMessage.role == "user",
            )
        )
    ).scalars().all()
    return activity_from(scenario, events, runs, said_count=len(said), asked_count=len(asked))


def activity_from(
    scenario, events: list[Event], runs: list[Execution], *, said_count: int, asked_count: int
) -> dict[str, dict]:
    """기록에서 앱별 활동을 계산한다 — 순수 함수. 평가는 이미 읽어 둔 기록을 그대로 넘긴다."""
    # 활동은 서버가 본 사실로만 판정한다 (ODY-017)
    events = [e for e in events if (getattr(e, "source", None) or "server") == "server"]
    said = [None] * said_count
    asked = [None] * asked_count
    provided = set(allowed_desktop_apps(scenario.desktop_apps or []))
    out: dict[str, dict] = {}

    def put(app: str, count: int, what: str, *, offered: bool | None = None) -> None:
        out[app] = {
            "provided": provided.__contains__(app) if offered is None else offered,
            "used": count > 0,
            "count": count,
            "what": what,
        }

    for app, (types, what) in _BY_ACTOR.items():
        put(app, _count_actor(events, app, types), what)

    # 메일 — 보낸 사실이 먼저다. 보내지 않고 초안만 쓴 것도 메일 앱을 쓴 것이다.
    # 보내기 한 번은 file_create 와 mail_sent 두 줄을 남기므로, 보낸 파일의 쓰기는 다시 세지 않는다.
    sent_paths = {(e.payload or {}).get("path") for e in events if e.type == "mail_sent"}
    drafts = sum(
        1
        for e in events
        if e.type in FILE_WRITE_EVENTS
        and (e.payload or {}).get("actor") == "mail"
        and (e.payload or {}).get("path") not in sent_paths
    )
    put("mail", len(sent_paths) + drafts, "발송·작성")

    # 명령 실행 — 응시자가 직접 돌린 것만. 에이전트가 대신 돌린 것은 에이전트의 활동이고,
    # 자동 채점이 돌린 것(source=check)은 응시자의 활동이 아니다 — 그것을 세면 채점을 한 번
    # 돌린 순간 모든 응시가 "터미널을 썼다" 가 된다.
    user_runs = sum(1 for r in runs if r.source not in ("agent", "check"))
    # 터미널과 IDE 는 같은 셸을 나눠 쓴다(terminalSession) — 어느 창에서 쳤는지는 알 수 없다.
    # 시나리오가 준 쪽에 붙인다. 둘 다 줬으면 터미널이다.
    runs_home = "terminal" if "terminal" in provided or "ide" not in provided else "ide"
    put("terminal", user_runs if runs_home == "terminal" else 0, "명령 실행")
    if runs_home == "ide":
        out["ide"]["count"] += user_runs
        out["ide"]["used"] = out["ide"]["count"] > 0
    # 탭·평가가 "실행이 있었는가" 를 한 번에 볼 수 있게 따로도 적는다
    out["terminal"]["runs"] = user_runs

    # 저장소·참고자료 — 서버가 직접 남긴 조회 기록
    put(
        "github",
        sum(1 for e in events if e.type.startswith("reference_") or e.type == "github_clone"),
        "자료 조회",
    )

    # 메신저와 에이전트는 desktop_apps 가 관장하지 않는다 (messenger 는 문제 제시 수단,
    # agent 는 agent_enabled). 그래서 제공 여부를 따로 적는다.
    out["messenger"] = {"provided": True, "used": len(said) > 0, "count": len(said), "what": "대화"}
    agent_runs = sum(1 for r in runs if r.source == "agent")
    agent_files = _count_actor(events, "agent", FILE_WRITE_EVENTS)
    out["agent"] = {
        "provided": bool(getattr(scenario, "agent_enabled", True)),
        "used": bool(asked),
        "count": len(asked),
        "what": "질문",
        # 실제로 무언가를 고치거나 돌렸는가 — 물어보기만 한 것과 구분한다
        "acted": agent_runs + agent_files,
    }
    return out


def used_apps(activity: dict[str, dict]) -> list[str]:
    """활동이 있었던 앱만 — 화면과 평가가 같이 쓰는 목록."""
    return [app for app, row in activity.items() if row.get("used")]
