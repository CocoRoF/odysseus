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


def scenario_row(spec: dict, created_by) -> Scenario:
    return Scenario(
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
