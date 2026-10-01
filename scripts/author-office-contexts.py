"""Prepare/review missing public office scenes, then apply the exact reviewed artifact.

Run in the API environment: python author-office-contexts.py prepare /path/drafts.json
Then inspect the public artifact and run: python author-office-contexts.py apply /path/drafts.json
Uses the registered default chat model. Does not read exam knowledge, files or objectives.
"""
import argparse
import asyncio
import json
import os
from pathlib import Path

from sqlalchemy import select

from odysseus_api.ai import provider
from odysseus_api.db import SessionLocal, engine
from odysseus_api.models import Scenario
from odysseus_api.npc.authoring import OfficeAuthorIn, OfficeAuthorResult, author_public
from odysseus_api.secrets import install_encrypted_types


def source(title, characters):
    return OfficeAuthorIn(scenario_title=title, characters=[{
        "key": c["key"], "name": c["name"], "role": c.get("role", ""),
        "encounter": c.get("encounter", ""),
        "office_voice": c.get("office_voice", ""),
    } for c in characters])


def save(path, data):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2))
    os.replace(temporary, path)


async def prepare(path, resume=False):
    if path.exists() and not resume:
        raise ValueError("Use a new artifact path; existing reviewed drafts are never overwritten")
    async with SessionLocal() as db:
        res = await provider.resolve_ai(db, "chat")
        # Select only the fields required for public authoring. Characters are
        # immediately projected to the public allowlist before any provider call.
        rows = (await db.execute(select(Scenario.id, Scenario.title, Scenario.characters,
            Scenario.updated_at).where(Scenario.office_public == {}, Scenario.is_archived.is_(False)))).all()
    if not res or not res.configured:
        raise ValueError("No configured default chat model")
    artifact = json.loads(path.read_text()) if resume else {"provider": res.provider, "model": res.model, "drafts": [], "errors": []}
    if (artifact["provider"], artifact["model"]) != (res.provider, res.model):
        raise ValueError("Default model changed during preparation")
    artifact["errors"] = []
    completed = {d["id"] for d in artifact["drafts"]}
    rows = [r for r in rows if str(r.id) not in completed]
    save(path, artifact)
    slots = asyncio.Semaphore(2)

    async def write(row):
        async with slots:
            try:
                body = source(row.title, row.characters)
                result = await author_public(res, body)
                artifact["drafts"].append({"id": str(row.id), "updated_at": row.updated_at.isoformat(),
                    "source": body.model_dump(), "result": result.model_dump()})
                print(json.dumps({"prepared": str(row.id), "title": row.title}, ensure_ascii=False), flush=True)
            except Exception as exc:
                artifact["errors"].append({"id": str(row.id), "error_class": type(exc).__name__})
                print(json.dumps({"failed": str(row.id), "error_class": type(exc).__name__}), flush=True)
            save(path, artifact)

    await asyncio.gather(*(write(row) for row in rows))
    print(json.dumps({"prepared": len(artifact["drafts"]), "failed": len(artifact["errors"])}), flush=True)


async def apply(path):
    import uuid
    artifact = json.loads(path.read_text())
    if artifact["errors"]:
        raise ValueError("Resolve authoring failures before publishing this artifact")
    backup = []
    async with SessionLocal() as db:
        for item in sorted(artifact["drafts"], key=lambda d: d["id"]):
            row = await db.scalar(select(Scenario).where(Scenario.id == uuid.UUID(item["id"])).with_for_update())
            if not row or row.updated_at.isoformat() != item["updated_at"] or row.office_public:
                raise ValueError(f"Scenario changed after preparation: {item['id']}")
            if source(row.title, row.characters).model_dump() != item["source"]:
                raise ValueError("Public source changed")
            result = OfficeAuthorResult.model_validate(item["result"])
            if sorted(v.key for v in result.voices) != sorted(c["key"] for c in row.characters):
                raise ValueError("Voice identities changed")
            backup.append({"id": item["id"], "office_public": row.office_public,
                "voices": {c["key"]: c.get("office_voice", "") for c in row.characters},
                "encounters": {c["key"]: c.get("encounter", "") for c in row.characters}})
            result.office_public.published = True
            row.office_public = result.office_public.model_dump()
            voices = {v.key: v for v in result.voices}
            row.characters = [{**c, "office_voice": voices[c["key"]].voice,
                "encounter": voices[c["key"]].encounter or c.get("encounter", "")} for c in row.characters]
        backup_path = path.with_suffix(".before.json")
        if backup_path.exists():
            raise ValueError("A backup already exists; refusing to apply twice")
        save(backup_path, backup)
        await db.commit()
    print(json.dumps({"published": len(backup)}), flush=True)


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("prepare", "resume", "apply"))
    parser.add_argument("artifact", type=Path)
    args = parser.parse_args()
    install_encrypted_types()
    try:
        await (apply(args.artifact) if args.action == "apply" else prepare(args.artifact, resume=args.action == "resume"))
    finally:
        await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
