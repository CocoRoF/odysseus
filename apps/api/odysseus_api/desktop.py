"""시험 데스크톱에서 제공되는 앱 목록 — 시나리오별로 켜고 끌 수 있다.

엔지니어 시나리오는 터미널·IDE 가 필요하지만, 사무·커뮤니케이션 시나리오에서는
그 두 앱이 오히려 "이 문제는 코딩 문제구나" 라는 잘못된 신호를 준다. 반대로 문서
작성 과제에는 문서 편집기와 표 편집기가 있어야 실제 업무와 같은 환경이 된다.

`Scenario.desktop_apps` 가 비어 있으면 **전부 제공**한다 — 기존 시나리오의 동작을
그대로 유지하기 위한 기본값이다. 목록이 있으면 그 목록만 제공한다. 목록에 없는 이름은
버린다(normalize_desktop_apps) — [인터넷] 을 걷어낸 뒤 옛 시나리오에 남은 "browser" 가
그렇게 조용히 사라진다.

메신저·뷰어는 여기서 다루지 않는다: 메신저는 이 플랫폼의 문제 제시 수단 자체이고,
뷰어는 탐색기에서 파일을 여는 순간 필요한 부속 창이라 끌 대상이 아니다.
AI 에이전트는 예전부터 `agent_enabled` 가 따로 관리한다.

메일도 같은 이유로 앱이다. 사무 과제의 절반은 "받은 메일에 어떻게 답하는가" 이고,
받은 편지함은 `mail/`·`inbox/` 의 파일이라 여기서 한 일은 폴더·에이전트·자동 채점이
그대로 본다.

한때 달력도 앱이었다. 그런데 그것은 일정 CSV 를 **읽기만** 하는 화면이었다 — 고치려면
결국 OdyCell 로 가야 했고, 그러면 달력은 한 번 보고 마는 창이 된다. 반쯤 되는 도구는
없느니만 못해 2026-09-20 에 걷어냈다.
"""

from __future__ import annotations

#: 시나리오가 켜고 끌 수 있는 앱 (표시 순서 = 바탕화면 아이콘 순서)
OPTIONAL_APPS: tuple[str, ...] = (
    "terminal",
    "files",
    "mail",
    "docs",
    "sheet",
    "ide",
    "github",
)

#: 업무 성격별 프리셋 — 시나리오 작성자가 참고하는 조합 (스튜디오 UI 와 프리셋이 쓴다)
APP_PRESETS: dict[str, tuple[str, ...]] = {
    #: 엔지니어링 — 지금까지의 기본값과 같다
    "engineering": ("terminal", "files", "ide", "docs", "sheet", "github"),
    #: 사무·문서 — 터미널과 IDE 없이 메일/문서/표/폴더로 일한다
    "office": ("files", "mail", "docs", "sheet"),
    #: 커뮤니케이션 — 받은 메일에 답하고 문서 하나를 쓰는 과제 (표도 필요 없다)
    "communication": ("files", "mail", "docs"),
    #: 분석 — 표 계산이 중심, 필요하면 문서로 정리
    "analysis": ("files", "sheet", "docs"),
    #: 조율·일정 — 표로 제약을 확인하고 배정한 뒤 안내 메일을 쓴다
    "coordination": ("files", "sheet", "docs", "mail"),
}


def normalize_desktop_apps(values: list[str] | tuple[str, ...] | None) -> list[str]:
    """알 수 없는 값은 버리고, 중복을 없애고, 표시 순서로 정렬한다."""
    if not values:
        return []
    wanted = {str(v).strip().lower() for v in values}
    return [app for app in OPTIONAL_APPS if app in wanted]


def allowed_desktop_apps(values: list[str] | tuple[str, ...] | None) -> list[str]:
    """실제로 제공할 앱 목록 — 비어 있으면 전부."""
    normalized = normalize_desktop_apps(values)
    return normalized or list(OPTIONAL_APPS)


#: 파일을 건드릴 수 있는 창들. 앱 목록(OPTIONAL_APPS)과 같지 않다 — 뷰어는 읽기만 하고,
#: 에이전트는 desktop_apps 가 아니라 agent_enabled 가 관장한다.
FILE_ACTORS: tuple[str, ...] = (
    "ide",
    "docs",
    "sheet",
    "files",
    "mail",
    "viewer",
    "terminal",
    "agent",
    "github",
    #: 저장소를 내려받아 서버가 직접 푼 파일 (reference.py)
    "git",
)


def normalize_actor(value: str | None) -> str:
    """어느 창이 한 일인지 — 모르는 이름은 버리고 "ide" 로 둔다.

    이 값은 **사실이 아니라 이름표**다. 파일이 바뀌었다는 사실은 서버가 보지만, 어느 창이 눌렀는지는
    브라우저만 안다. 그래서 무결성 판단에는 쓰지 않고, "이 사람이 어떤 앱으로 일했는가" 를 되짚는
    데에만 쓴다. 이름표가 없으면 옛 기록과 같은 자리에 둔다.
    """
    v = (value or "").strip().lower()
    return v if v in FILE_ACTORS else "ide"
