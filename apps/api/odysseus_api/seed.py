"""데모 시드 — 계정 3개 + 기본 제공 시나리오/시험.

시나리오 본문은 `odysseus_api/scenarios/` 패키지가 단일 소스다.
"""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .ai.autoeval import default_rubric
from .models import Assessment, AssessmentScenario, Assignment, Scenario, User
from .scenarios import DEFAULT_ASSESSMENTS, DEFAULT_SCENARIOS
from .security import hash_password


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


async def seed_if_empty(db: AsyncSession) -> None:
    existing = (await db.execute(select(User).limit(1))).scalar_one_or_none()
    if existing:
        return

    admin = User(email="admin@odysseus.dev", name="관리자", password_hash=hash_password("admin1234"), role="admin")
    evaluator = User(
        email="evaluator@odysseus.dev", name="평가자", password_hash=hash_password("eval1234"), role="evaluator"
    )
    candidate = User(
        email="candidate@odysseus.dev", name="응시자", password_hash=hash_password("cand1234"), role="candidate"
    )
    db.add_all([admin, evaluator, candidate])
    await db.flush()

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
        if spec.get("assign_demo_candidate"):
            db.add(Assignment(assessment_id=assessment.id, user_id=candidate.id))

    await db.commit()
    print(
        f"[seed] demo users + {len(DEFAULT_SCENARIOS)} scenarios + {len(DEFAULT_ASSESSMENTS)} assessments created"
    )
