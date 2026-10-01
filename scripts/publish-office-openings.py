"""Apply reviewed office openings/voices atomically, without changing exam content.

Run in the API environment: python publish-office-openings.py reviewed.json before.json
The artifact must include each scenario's id, title, updated_at and complete character
key list with encounter/office_voice. A concurrent author edit aborts the entire update.
"""
import asyncio
import json
import os
import sys
import uuid
from datetime import datetime
from pathlib import Path

from sqlalchemy import select

from odysseus_api.db import SessionLocal, engine
from odysseus_api.models import Scenario
from odysseus_api.schemas import CharacterIn


async def publish(artifact_path, backup_path):
    artifact = json.loads(Path(artifact_path).read_text())
    if artifact.get("version") != 1 or not artifact.get("scenarios"):
        raise ValueError("Missing reviewed scenario edits")
    ids = [item["id"] for item in artifact["scenarios"]]
    if len(ids) != len(set(ids)):
        raise ValueError("Duplicate scenario IDs")
    before, count = [], 0
    async with SessionLocal() as db:
        for item in sorted(artifact["scenarios"], key=lambda v: v["id"]):
            row = await db.scalar(select(Scenario).where(Scenario.id == uuid.UUID(item["id"])).with_for_update())
            if not row or row.title != item["title"] or row.updated_at != datetime.fromisoformat(item["updated_at"]):
                raise ValueError(f"Scenario changed after review: {item['id']}")
            edits = {c["key"]: c for c in item["characters"]}
            if len(edits) != len(item["characters"]) or set(edits) != {c["key"] for c in row.characters}:
                raise ValueError("Character identities changed")
            before.append({"id": item["id"], "title": row.title, "updated_at": row.updated_at.isoformat(),
                "characters": [{k: c.get(k, "") for k in ("key", "encounter", "office_voice")} for c in row.characters]})
            characters = []
            for character in row.characters:
                edit = edits[character["key"]]
                if set(edit) != {"key", "encounter", "office_voice"}:
                    raise ValueError("Only office presentation fields may be edited")
                if not edit["encounter"].strip() or not edit["office_voice"].strip():
                    raise ValueError("Opening and public voice must both be authored")
                updated = {**character, **edit}
                CharacterIn.model_validate(updated)
                characters.append(updated)
            row.characters = characters
            count += len(characters)
        # Exclusive, private backup exists before the transaction commits.
        with os.fdopen(os.open(backup_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as output:
            json.dump({"version": 1, "scenarios": before}, output, ensure_ascii=False, indent=2)
            output.flush()
            os.fsync(output.fileno())
        await db.commit()
    print(json.dumps({"scenarios": len(before), "characters": count}))


async def main():
    try:
        await publish(*sys.argv[1:])
    finally:
        await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
