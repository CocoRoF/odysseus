"""배포 전후로 '무엇이 남아 있어야 하는가'를 세어 비교한다.

세는 대상은 배포로 절대 사라지면 안 되는 것들이다 — 계정, 시나리오·시험,
응시 기록, 워크스페이스 파일, 그리고 **AI 공급자 키와 관리자 설정**.

  python3 scripts/snapshot.py            # 현재 상태 출력(JSON)
  python3 scripts/snapshot.py before.json  # 저장된 스냅샷과 비교
"""

import json
import sys
import urllib.error
import urllib.request
from http.cookiejar import CookieJar

API = "http://localhost:8100"
ADMIN = {"email": "admin@odysseus.dev", "password": "admin1234"}


def call(op, method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        f"{API}{path}", data=data, method=method, headers={"Content-Type": "application/json"}
    )
    try:
        with op.open(req, timeout=30) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        return e.code, None
    except OSError:
        return 0, None


def snapshot() -> dict:
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))
    st, _ = call(op, "POST", "/auth/login", ADMIN)
    if st != 200:
        raise SystemExit(f"관리자 로그인 실패 (status={st}) — 서비스가 준비되지 않았습니다")

    _, providers = call(op, "GET", "/admin/settings/ai/providers")
    _, reference = call(op, "GET", "/admin/settings/reference")
    _, ui = call(op, "GET", "/admin/settings/ui")
    _, assessments = call(op, "GET", "/assessments")
    _, scenarios = call(op, "GET", "/scenarios")
    _, users = call(op, "GET", "/admin/users")
    _, attempts = call(op, "GET", "/review/attempts")

    return {
        # 공급자는 개수뿐 아니라 **키가 살아 있는지**가 핵심이다
        "ai_providers": sorted(
            (p.get("name", ""), p.get("provider", ""), bool(p.get("has_key")))
            for p in (providers or [])
        ),
        "reference_settings": reference,
        "ui_settings": ui,
        "counts": {
            "users": len(users or []),
            "scenarios": len(scenarios or []),
            "assessments": len(assessments or []),
            "attempts": len(attempts or []),
        },
    }


def _normalized(value):
    """JSON 을 거치면 튜플이 배열이 된다 — 비교 전에 같은 모양으로 맞춘다.
    (이걸 빼면 아무것도 안 바뀌었는데도 배포가 실패로 끝난다.)"""
    return json.loads(json.dumps(value, ensure_ascii=False, sort_keys=True))


def diff(before: dict, after: dict) -> list[str]:
    before, after = _normalized(before), _normalized(after)
    problems = []
    if before.get("ai_providers") != after.get("ai_providers"):
        problems.append(f"AI 공급자가 달라졌습니다: {before.get('ai_providers')} → {after.get('ai_providers')}")
    for key in ("reference_settings", "ui_settings"):
        if before.get(key) != after.get(key):
            problems.append(f"{key} 이 달라졌습니다: {before.get(key)} → {after.get(key)}")
    for name, was in (before.get("counts") or {}).items():
        now = (after.get("counts") or {}).get(name)
        if now is None or now < was:
            problems.append(f"{name} 이(가) 줄었습니다: {was} → {now}")
    return problems


if __name__ == "__main__":
    current = snapshot()
    if len(sys.argv) > 1:
        with open(sys.argv[1]) as fh:
            before = json.load(fh)
        problems = diff(before, current)
        if problems:
            print("배포 전후 데이터가 달라졌습니다:")
            for p in problems:
                print(f"  · {p}")
            sys.exit(1)
        print("데이터 보존 확인 — 공급자·설정·기록이 그대로입니다.")
        sys.exit(0)
    print(json.dumps(current, ensure_ascii=False, indent=2))
