"""최초 기동 데이터 — 관리자 부트스트랩과 (개발 전용) 데모 시드.

두 경로가 있고 서로 섞이지 않는다.

* **bootstrap** (기본, 운영): DB 가 비어 있으면 관리자 계정 하나와 기본 제공
  시나리오·시험을 만든다. 비밀번호는 `BOOTSTRAP_ADMIN_PASSWORD` 로 받거나, 없으면
  무작위로 만들어 **로그에 한 번만** 찍는다. 알려진 고정 비밀번호는 어디에도 없다.
* **demo** (`SEED_DEMO_DATA=true`, `ODYSSEUS_ENV=development` 에서만): 위에 더해
  평가자·응시자 데모 계정을 고정 비밀번호로 만든다. 로컬 개발과 스모크 테스트용이며
  운영 모드에서는 애플리케이션이 기동을 거부한다 (main.py 참조).

시나리오 본문은 `odysseus_api/scenarios/` 패키지가 단일 소스다.
"""

import secrets
import sys

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .ai.autoeval import default_rubric
from .config import settings
from .models import Assessment, AssessmentScenario, Assignment, Scenario, User
from .scenarios import DEFAULT_ASSESSMENTS, DEFAULT_SCENARIOS
from .security import hash_password

DEFAULT_BOOTSTRAP_EMAIL = "admin@odysseus.app"  # .local·.example 같은 특수 도메인은 이메일 검증에 걸린다

# 개발 전용 데모 계정 — 운영 모드에서는 절대 만들어지지 않는다 (check_startup_security 가 막는다).
DEMO_ACCOUNTS: list[dict] = [
    {"email": "admin@odysseus.dev", "name": "관리자", "role": "admin", "password": "admin1234"},
    {"email": "evaluator@odysseus.dev", "name": "평가자", "role": "evaluator", "password": "eval1234"},
    {"email": "candidate@odysseus.dev", "name": "응시자", "role": "candidate", "password": "cand1234"},
]


#: 프리셋 지문에 들어가는 필드 — 코드가 정하는 내용의 전부. 관리자만 만지는 것(보관·장면·기본 프롬프트)은 뺀다.
PRESET_FIELDS = (
    "title", "summary", "difficulty", "briefing_md", "characters", "opening_messages", "initial_files",
    "objectives_md", "checks", "rubric", "agent_enabled", "desktop_apps",
)


def spec_hash(values: dict) -> str:
    """내용의 지문 — 같은 내용이면 같은 값. 저장된 행과 코드 사양을 같은 방식으로 잰다."""
    import hashlib
    import json

    canon = {k: values.get(k) for k in PRESET_FIELDS}
    if canon.get("rubric") in (None, {}):
        canon["rubric"] = default_rubric()
    canon["desktop_apps"] = list(canon.get("desktop_apps") or [])
    return hashlib.sha256(json.dumps(canon, ensure_ascii=False, sort_keys=True, default=str).encode()).hexdigest()


def row_values(row: Scenario) -> dict:
    return {k: getattr(row, k) for k in PRESET_FIELDS}


def apply_spec(row: Scenario, spec: dict) -> None:
    """코드 사양을 행에 옮겨 적는다 — scenario_row 와 같은 필드, 같은 기본값."""
    row.title = spec["title"]
    row.summary = spec.get("summary", "")
    row.difficulty = spec.get("difficulty", "medium")
    row.briefing_md = spec.get("briefing_md", "")
    row.characters = spec.get("characters", [])
    row.opening_messages = spec.get("opening_messages", [])
    row.initial_files = spec.get("initial_files", [])
    row.objectives_md = spec.get("objectives_md", "")
    row.checks = spec.get("checks", [])
    row.rubric = spec.get("rubric") or default_rubric()
    row.agent_enabled = spec.get("agent_enabled", True)
    row.desktop_apps = list(spec.get("desktop_apps") or [])
    row.preset_hash = spec_hash(spec)


def scenario_row(spec: dict, created_by) -> Scenario:
    return Scenario(
        preset_hash=spec_hash(spec),
        title=spec["title"],
        summary=spec.get("summary", ""),
        difficulty=spec.get("difficulty", "medium"),
        briefing_md=spec.get("briefing_md", ""),
        characters=spec.get("characters", []),
        opening_messages=spec.get("opening_messages", []),
        initial_files=spec.get("initial_files", []),
        objectives_md=spec.get("objectives_md", ""),
        checks=spec.get("checks", []),
        rubric=spec.get("rubric") or default_rubric(),
        agent_enabled=spec.get("agent_enabled", True),
        desktop_apps=list(spec.get("desktop_apps") or []),
        created_by=created_by,
    )


async def _has_users(db: AsyncSession) -> bool:
    return (await db.execute(select(User).limit(1))).scalar_one_or_none() is not None


async def seed_content(db: AsyncSession, admin: User, *, demo_candidate: User | None = None) -> None:
    """기본 제공 시나리오·시험. 응시자 데모 계정이 있으면 데모 시험을 배정한다."""
    by_title: dict[str, Scenario] = {}
    for spec in DEFAULT_SCENARIOS:
        row = scenario_row(spec, admin.id)
        db.add(row)
        by_title[spec["title"]] = row
    await db.flush()

    for spec in DEFAULT_ASSESSMENTS:
        assessment = Assessment(
            title=spec["title"],
            description=spec["description"],
            category=spec.get("category", ""),
            label=spec.get("label", ""),
            duration_min=spec["duration_min"],
            agent_max_turns=spec["agent_max_turns"],
            created_by=admin.id,
            scenarios=[],
            assignments=[],
        )
        db.add(assessment)
        await db.flush()
        for i, title in enumerate(spec["scenarios"]):
            db.add(
                AssessmentScenario(
                    assessment_id=assessment.id, scenario_id=by_title[title].id, ordinal=i, points=100
                )
            )
        if spec.get("assign_demo_candidate") and demo_candidate is not None:
            db.add(Assignment(assessment_id=assessment.id, user_id=demo_candidate.id))


async def sync_presets(db: AsyncSession) -> int:
    """코드에 새로 들어온 프리셋 시나리오를 **이미 깔린 설치본**에 더한다. 있는 것은 건드리지 않는다.

    bootstrap 은 빈 DB 에만 심는다. 그러면 운영에는 첫 배포 때의 시나리오만 있고, 그 뒤 코드에 추가된
    프리셋은 영영 도착하지 않는다 — 2026-09-20 에 AI 분야 시험이 0개인 채로 배포돼 있던 이유다.
    제목으로 알아보고 없는 것만 만든다(시나리오 + 그것을 담는 시험). 관리자가 고친 기존 시나리오는
    덮어쓰지 않는다 — 코드는 첫 판을 주는 것이지 정본이 아니다.
    """
    rows = {row.title: row for row in (await db.execute(select(Scenario))).scalars().all()}
    admin = (
        await db.execute(select(User).where(User.role == "admin").order_by(User.created_at).limit(1))
    ).scalar_one_or_none()
    if admin is None:
        return 0
    added = refreshed = 0
    for spec in DEFAULT_SCENARIOS:
        row = rows.get(spec["title"])
        if row is not None:
            # 있는 프리셋 — 관리자가 손대지 않았으면(지금 내용 = 마지막으로 받아 적은 코드) 코드를 따른다.
            # 인물의 말투를 코드에서 고쳤는데 운영 NPC 는 옛 말투로 답하던 일(2026-09-21)을 막는다.
            untouched = row.preset_hash == "legacy-untouched" or (
                row.preset_hash is not None and row.preset_hash == spec_hash(row_values(row))
            )
            if untouched and row.preset_hash != spec_hash(spec):
                apply_spec(row, spec)
                refreshed += 1
            continue
        row = scenario_row(spec, admin.id)
        db.add(row)
        await db.flush()
        plan = next((a for a in DEFAULT_ASSESSMENTS if a["scenarios"] == [spec["title"]]), None)
        if plan is not None:
            assessment = Assessment(
                title=plan["title"],
                description=plan["description"],
                category=plan.get("category", ""),
                label=plan.get("label", ""),
                duration_min=plan["duration_min"],
                agent_max_turns=plan["agent_max_turns"],
                created_by=admin.id,
                scenarios=[],
                assignments=[],
            )
            db.add(assessment)
            await db.flush()
            db.add(AssessmentScenario(assessment_id=assessment.id, scenario_id=row.id, ordinal=0, points=100))
        added += 1
    if added or refreshed:
        await db.commit()
        print(f"[presets] 프리셋 시나리오 {added}개 추가, {refreshed}개 갱신", flush=True)
    return added + refreshed


async def bootstrap_if_empty(db: AsyncSession) -> None:
    """운영 기본 경로 — 빈 DB 에 관리자 1명과 기본 콘텐츠를 만든다. 데모 계정은 없다."""
    if await _has_users(db):
        return
    email = (settings.bootstrap_admin_email or DEFAULT_BOOTSTRAP_EMAIL).strip().lower()
    password = settings.bootstrap_admin_password
    generated = False
    if not password:
        password = secrets.token_urlsafe(18)
        generated = True
    admin = User(email=email, name="관리자", password_hash=hash_password(password), role="admin")
    db.add(admin)
    await db.flush()
    await seed_content(db, admin)
    await db.commit()

    # 비밀번호는 여기서 한 번만 보인다. 저장하지 않으며, 다시 조회할 방법도 없다.
    if generated:
        banner = (
            "\n" + "=" * 72 + "\n"
            "[bootstrap] 최초 관리자 계정을 만들었습니다.\n"
            f"[bootstrap]   이메일:   {email}\n"
            f"[bootstrap]   비밀번호: {password}\n"
            "[bootstrap] 이 비밀번호는 이 로그에만 한 번 출력됩니다. 로그인 후 바로 바꾸세요.\n"
            "[bootstrap] (미리 정하려면 BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD 를 설정하세요)\n"
            + "=" * 72 + "\n"
        )
        print(banner, file=sys.stderr, flush=True)
    else:
        print(f"[bootstrap] 최초 관리자 계정 {email} 을 환경변수의 비밀번호로 만들었습니다", flush=True)
    print(
        f"[bootstrap] {len(DEFAULT_SCENARIOS)} scenarios + {len(DEFAULT_ASSESSMENTS)} assessments created",
        flush=True,
    )


async def seed_demo_if_empty(db: AsyncSession) -> None:
    """개발 전용 — 데모 계정 3개(고정 비밀번호) + 기본 콘텐츠 + 응시자 배정."""
    if await _has_users(db):
        return
    users = {
        spec["role"]: User(
            email=spec["email"], name=spec["name"], password_hash=hash_password(spec["password"]), role=spec["role"]
        )
        for spec in DEMO_ACCOUNTS
    }
    db.add_all(users.values())
    await db.flush()
    await seed_content(db, users["admin"], demo_candidate=users["candidate"])
    await db.commit()
    print(
        f"[seed] DEV ONLY: demo users + {len(DEFAULT_SCENARIOS)} scenarios + {len(DEFAULT_ASSESSMENTS)} assessments created",
        flush=True,
    )


# 이전 이름 — 외부에서 참조하던 곳을 위해 남긴다 (데모 시드).
seed_if_empty = seed_demo_if_empty
