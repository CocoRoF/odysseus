"""기본 시나리오/시험을 기존 배포에 주입 (멱등).

이미 있는 제목은 건너뛰고, 없는 것만 만든다. api 컨테이너 안에서 실행한다:

  docker cp tests/smoke/seed_scenarios.py odysseus-api-1:/tmp/
  docker exec -e PYTHONPATH=/app odysseus-api-1 python3 /tmp/seed_scenarios.py

`--refresh-briefings` 를 주면 이미 있는 시나리오의 시작 화면(브리핑)도 패키지
내용으로 덮어쓴다 (문구를 다듬었을 때 배포 반영용).

`--refresh-characters` 는 등장인물(성격·지식·직함)을 패키지 내용으로 덮어쓴다.
NPC 프롬프트 규약이 바뀌었을 때(예: 태도 대응 성향 추가) 이미 배포된 시나리오에
반영하는 경로다. 진행 중인 응시의 이미 오간 대화는 그대로 남는다.
"""

import asyncio
import sys

from sqlalchemy import select

from odysseus_api.db import SessionLocal
from odysseus_api.models import Assessment, AssessmentScenario, Assignment, Scenario, User
from odysseus_api.scenarios import DEFAULT_ASSESSMENTS, DEFAULT_SCENARIOS
from odysseus_api.seed import scenario_row


async def main() -> None:
    async with SessionLocal() as db:
        admin = (
            await db.execute(select(User).where(User.role == "admin").order_by(User.created_at))
        ).scalars().first()
        candidate = (
            await db.execute(select(User).where(User.email == "candidate@odysseus.dev"))
        ).scalar_one_or_none()

        existing = {
            s.title: s for s in (await db.execute(select(Scenario))).scalars().all()
        }
        refresh = "--refresh-briefings" in sys.argv
        refresh_chars = "--refresh-characters" in sys.argv
        created = refreshed = recast = 0
        for spec in DEFAULT_SCENARIOS:
            if spec["title"] in existing:
                row = existing[spec["title"]]
                if refresh and row.briefing_md != spec.get("briefing_md", ""):
                    row.briefing_md = spec.get("briefing_md", "")
                    refreshed += 1
                if refresh_chars and row.characters != spec.get("characters", []):
                    row.characters = spec.get("characters", [])
                    recast += 1
                continue
            row = scenario_row(spec, admin.id if admin else None)
            db.add(row)
            existing[spec["title"]] = row
            created += 1
        await db.flush()

        have = {a.title for a in (await db.execute(select(Assessment))).scalars().all()}
        made_assessments = 0
        for spec in DEFAULT_ASSESSMENTS:
            if spec["title"] in have:
                continue
            missing = [t for t in spec["scenarios"] if t not in existing]
            if missing:
                print(f"  skip '{spec['title']}' — 시나리오 없음: {missing}")
                continue
            assessment = Assessment(
                title=spec["title"],
                description=spec["description"],
                duration_min=spec["duration_min"],
                agent_max_turns=spec["agent_max_turns"],
                created_by=admin.id if admin else None,
                scenarios=[],
                assignments=[],
            )
            db.add(assessment)
            await db.flush()
            for i, title in enumerate(spec["scenarios"]):
                db.add(
                    AssessmentScenario(
                        assessment_id=assessment.id, scenario_id=existing[title].id, ordinal=i, points=100
                    )
                )
            if spec.get("assign_demo_candidate") and candidate:
                db.add(Assignment(assessment_id=assessment.id, user_id=candidate.id))
            made_assessments += 1

        await db.commit()
        print(
            f"시나리오 {created}개, 시험 {made_assessments}개 추가"
            + (f", 브리핑 {refreshed}개 갱신" if refresh else "")
            + (f", 등장인물 {recast}개 갱신" if refresh_chars else "")
            + f" (전체 시나리오 {len(existing)}개)"
        )


asyncio.run(main())
sys.exit(0)
