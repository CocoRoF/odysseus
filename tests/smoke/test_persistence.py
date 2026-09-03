"""배포로 데이터가 날아가지 않는가 — 백업·복원·보존 도구의 계약.

한 번 잃으면 되돌릴 수 없는 것들이 있다: AI 공급자 키(브라우저 로그인으로만
받을 수 있다), 관리자 설정, 응시 기록, 워크스페이스 파일. 배포 스크립트가
이것들을 실제로 지키는지 본다 — 문서가 아니라 실행으로.

  sudo python3 tests/smoke/test_persistence.py
"""

import gzip
import json
import pathlib
import re
import subprocess
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parents[2]
ok = fail = 0


def check(name, cond, detail=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"  PASS {name}")
    else:
        fail += 1
        print(f"  FAIL {name} {detail}")


def run(cmd, **kw):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True, cwd=ROOT, **kw)


print("\n── 배포 도구가 갖춰져 있는가 ──")
for rel in ("scripts/deploy.sh", "scripts/backup.sh", "scripts/restore.sh", "scripts/snapshot.py"):
    p = ROOT / rel
    check(f"{rel} 존재", p.exists())
    if p.exists() and rel.endswith(".sh"):
        check(f"{rel} 실행 가능", p.stat().st_mode & 0o111)
        check(f"{rel} 문법 정상", run(f"bash -n {rel}").returncode == 0)

deploy = (ROOT / "scripts/deploy.sh").read_text()
check("배포가 볼륨을 지우지 않는다", "down -v" not in re.sub(r"^\s*#.*$", "", deploy, flags=re.M),
      "deploy.sh 안에서 down -v 를 실행하면 안 된다")
check("배포 전에 백업한다", "backup.sh" in deploy)
check("배포 후 보존을 검증한다", "snapshot.py" in deploy)
check("실패 시 복원 방법을 알려 준다", "restore.sh" in deploy)

compose = (ROOT / "docker-compose.yml").read_text()
check("compose 에 볼륨 경고가 있다", "down -v" in compose and "pgdata" in compose)
env = (ROOT / ".env").read_text() if (ROOT / ".env").exists() else ""
check("DB 비밀번호가 .env 에 고정되어 있다", "POSTGRES_PASSWORD=" in env,
      "고정하지 않으면 나중에 값이 바뀌어 기존 볼륨에 접속하지 못한다")

print("\n── 스냅샷이 '잃으면 안 되는 것'을 센다 ──")
snap = run("python3 scripts/snapshot.py")
check("스냅샷 실행", snap.returncode == 0, snap.stderr[:120])
if snap.returncode == 0:
    data = json.loads(snap.stdout)
    check("AI 공급자를 키 보유 여부까지 기록", "ai_providers" in data)
    check("관리자 설정을 기록", "reference_settings" in data and "ui_settings" in data)
    for key in ("users", "scenarios", "assessments", "attempts"):
        check(f"{key} 개수를 기록", key in (data.get("counts") or {}))

    # 스냅샷 비교가 '줄어든 것'을 실제로 잡아내는가
    tmp = pathlib.Path("/tmp/odysseus-snap-test.json")
    shrunk = json.loads(snap.stdout)
    shrunk["counts"]["users"] += 5          # 배포 후 5명이 사라진 상황을 흉내
    tmp.write_text(json.dumps(shrunk))
    cmp = run(f"python3 scripts/snapshot.py {tmp}")
    check("데이터가 줄면 배포가 실패로 끝난다", cmp.returncode != 0, cmp.stdout[:120])
    check("무엇이 줄었는지 말해 준다", "users" in cmp.stdout, cmp.stdout[:120])

    lost_key = json.loads(snap.stdout)
    if lost_key["ai_providers"]:
        name, prov, _ = lost_key["ai_providers"][0]
        lost_key["ai_providers"] = [[name, prov, False]]  # 키만 사라진 상황
        tmp.write_text(json.dumps(lost_key))
        cmp = run(f"python3 scripts/snapshot.py {tmp}")
        check("공급자 키가 사라지면 잡아낸다", cmp.returncode != 0, cmp.stdout[:120])

    settings_changed = json.loads(snap.stdout)
    settings_changed["ui_settings"] = {"gamified_intro": "다른값"}
    tmp.write_text(json.dumps(settings_changed))
    cmp = run(f"python3 scripts/snapshot.py {tmp}")
    check("관리자 설정이 바뀌면 잡아낸다", cmp.returncode != 0, cmp.stdout[:120])
    tmp.unlink(missing_ok=True)

    same = pathlib.Path("/tmp/odysseus-snap-same.json")
    same.write_text(snap.stdout)
    cmp = run(f"python3 scripts/snapshot.py {same}")
    check("그대로면 통과한다", cmp.returncode == 0, cmp.stdout[:120])
    same.unlink(missing_ok=True)

print("\n── 백업이 실제로 복원 가능한가 ──")
made = run("./scripts/backup.sh selftest")
check("백업 생성", made.returncode == 0, made.stderr[:160])
path = made.stdout.strip().splitlines()[-1] if made.returncode == 0 else ""
check("백업 파일이 남는다", bool(path) and (ROOT / path).exists(), path)

if path and (ROOT / path).exists():
    raw = gzip.decompress((ROOT / path).read_bytes()).decode(errors="replace")
    for table in ("users", "scenarios", "attempts", "workspace_files", "ai_providers", "app_settings"):
        check(f"{table} 이(가) 백업에 들어 있다", f"COPY public.{table} " in raw)

    # 격리된 임시 DB 에 실제로 복원해 본다 — 프로드는 건드리지 않는다
    name = f"odysseus-restore-check-{int(time.time())}"
    run(f"docker rm -f {name}")
    up = run(
        f"docker run -d --name {name} -e POSTGRES_USER=odysseus "
        f"-e POSTGRES_PASSWORD=odysseus -e POSTGRES_DB=odysseus postgres:16-alpine"
    )
    check("임시 DB 기동", up.returncode == 0, up.stderr[:120])
    if up.returncode == 0:
        for _ in range(40):
            if run(f"docker exec {name} pg_isready -U odysseus -d odysseus").returncode == 0:
                break
            time.sleep(1)
        run(f"gunzip -c {path} | docker exec -i {name} psql -U odysseus -d odysseus -q")
        counts = run(
            f"""docker exec {name} psql -U odysseus -d odysseus -tAc "select (select count(*) from users)"""
            f"""||','||(select count(*) from ai_providers)||','||(select count(*) from workspace_files)" """
        )
        parts = (counts.stdout or "").strip().split(",")
        check("복원 후 데이터가 살아 있다", len(parts) == 3 and int(parts[0]) > 0, counts.stdout.strip())
        keyq = run(
            f"""docker exec {name} psql -U odysseus -d odysseus -tAc """
            f""""select count(*) from ai_providers where api_key is not null and api_key <> ''" """
        )
        check("복원 후 AI 공급자 키까지 살아 있다", (keyq.stdout or "0").strip().isdigit(), keyq.stdout.strip())
        run(f"docker rm -f {name}")
    (ROOT / path).unlink(missing_ok=True)

print(f"\n{ok} passed, {fail} failed")
sys.exit(1 if fail else 0)
