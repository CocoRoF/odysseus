"""게스트 로그인 실동작 검증 (개발 스택, 호스트에서 엣지를 통해 실행).

  EDGE_URL=http://127.0.0.1:3100/api ADMIN_EMAIL=... ADMIN_PASSWORD=... \
    python3 tests/security/test_guest_login.py

보는 것:
  * 정책이 꺼져 있으면 게스트로 들어올 수 없다 (버튼 유무와 무관하게 서버가 막는다)
  * 게스트는 관리자 API 에 닿지 못한다 — 메뉴를 숨기는 것과 별개로
  * 게스트는 배정 없이 모든 시험을 본다
  * 정지시키면 그 자리에서 세션이 죽는다
  * 주소를 차단하면 새 게스트도, 열려 있던 세션도 막힌다
  * 관리자는 자기 주소가 차단돼 있어도 들어올 수 있다 (자물쇠를 안에서 잠그지 않기)

주의: 마지막 검사가 차단을 남기지 않도록 finally 에서 정리한다.
"""

import json
import os
import sys
import urllib.error
import urllib.request
from http.cookiejar import CookieJar

EDGE = os.environ.get("EDGE_URL", "http://127.0.0.1:3100/api")
ADMIN_EMAIL = os.environ.get("ADMIN_EMAIL", "admin@odysseus.local")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")
ok = fail = 0


def check(name, cond, detail=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"  PASS {name}")
    else:
        fail += 1
        print(f"  FAIL {name} {str(detail)[:240]}")


def session():
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))


def call(op, method, path, body=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    h = {"Content-Type": "application/json", **(headers or {})}
    req = urllib.request.Request(f"{EDGE}{path}", data=data, method=method, headers=h)
    try:
        with op.open(req, timeout=60) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, raw[:200].decode(errors="replace")


def set_policy(admin, **kw):
    body = {
        "enabled": True,
        "max_new_per_hour_per_ip": 50,
        "chat_per_min": 6,
        "chat_total_per_attempt": 60,
        **kw,
    }
    return call(admin, "PUT", "/admin/access/guest", body)


admin = session()
status, _ = call(admin, "POST", "/auth/login", {"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
if status != 200:
    print(f"관리자 로그인 실패({status}) — ADMIN_EMAIL/ADMIN_PASSWORD 를 지정하세요")
    sys.exit(2)

saved = call(admin, "GET", "/admin/access/guest")[1]
created_block = None

try:
    print("정책이 꺼져 있을 때")
    set_policy(admin, enabled=False)
    status, _ = call(session(), "GET", "/auth/guest")
    check("공개 조회는 열려 있다", status == 200)
    check("꺼짐이라고 답한다", call(session(), "GET", "/auth/guest")[1]["enabled"] is False)
    status, _ = call(session(), "POST", "/auth/guest", {"name": ""})
    check("게스트 시작이 막힌다", status == 403, status)

    print("정책이 켜져 있을 때")
    set_policy(admin, enabled=True)
    guest = session()
    status, me = call(guest, "POST", "/auth/guest", {"name": "테스트게스트"})
    check("게스트로 들어온다", status == 200, me)
    check("역할이 guest", (me or {}).get("role") == "guest", me)
    guest_id = (me or {}).get("id")

    check("세션이 유지된다", call(guest, "GET", "/auth/me")[1].get("role") == "guest")

    print("게스트가 닿을 수 없는 곳")
    for path in ("/admin/users", "/admin/access/guest", "/admin/access/ip-blocks", "/admin/settings/ai/providers"):
        status, _ = call(guest, "GET", path)
        check(f"관리자 API 차단: {path}", status == 403, status)
    status, _ = call(guest, "POST", "/admin/users", {"email": "x@y.z", "name": "x", "password": "abcdef"})
    check("관리자 API 쓰기 차단", status == 403, status)

    print("게스트가 닿을 수 있는 곳")
    status, rows = call(guest, "GET", "/my/assignments")
    check("시험 목록을 본다", status == 200, rows)
    admin_rows = call(admin, "GET", "/my/assignments")[1]
    check(
        "배정 없이 모든 시험이 보인다",
        isinstance(rows, list) and len(rows) == len(admin_rows),
        f"guest={len(rows or [])} admin={len(admin_rows or [])}",
    )
    check("전부 미배정으로 표시", all(r["assigned"] is False for r in rows or []), rows)

    startable = [r for r in rows or [] if not r["attempt_status"]]
    if startable:
        target = startable[0]["assessment_id"]
        status, attempt = call(guest, "POST", f"/assessments/{target}/attempts", None)
        check("배정 없이 응시를 시작한다", status == 200, attempt)
        if status == 200:
            status, _ = call(guest, "GET", f"/attempts/{attempt['id']}")
            check("자기 응시를 연다", status == 200, status)
            # 남의 응시는 못 본다 — 스태프가 아니면 소유자만 (deps.is_staff)
            others = [a for a in call(admin, "GET", "/review/attempts")[1] or [] if a["id"] != attempt["id"]]
            if others:
                status, _ = call(guest, "GET", f"/attempts/{others[0]['id']}")
                check("남의 응시는 막힌다", status == 403, status)
            status, _ = call(guest, "POST", f"/attempts/{attempt['id']}/retake")
            check("재응시는 막힌다", status == 403, status)
            status, _ = call(guest, "GET", "/reference/web/search?q=test")
            check("시험 밖 참고자료 미리보기는 막힌다", status in (403, 404, 422), status)

            # 대화 상한이 실제로 발화하는지. LLM 은 없어도 된다 — 게이트가 공급자
            # 호출보다 먼저 걸리므로, 막히지 않은 요청은 503(AI 미설정)으로 떨어진다.
            scenarios = attempt.get("scenarios") or []
            chars = (scenarios[0].get("characters") if scenarios else None) or []
            if chars:
                sid, ckey = scenarios[0]["scenario_id"], chars[0]["key"]
                set_policy(admin, chat_per_min=1)  # burst = max(2, 0) = 2
                path = f"/attempts/{attempt['id']}/scenarios/{sid}/messenger/{ckey}"
                codes = [call(guest, "POST", path, {"content": f"안녕하세요 {i}"})[0] for i in range(4)]
                check("게스트 대화 상한이 429 로 걸린다", 429 in codes, codes)
                check("막히기 전 요청은 상한이 아니었다", codes[0] != 429, codes)
            else:
                print("  SKIP 대화 상한 (등장인물이 있는 시나리오가 없음)")
    else:
        print("  SKIP 응시 시작 (시작 가능한 시험이 없음)")

    print("계정 정지")
    check("관리자 목록에 게스트가 있다",
          any(u["id"] == guest_id for u in call(admin, "GET", "/admin/users")[1]))
    call(admin, "PATCH", f"/admin/users/{guest_id}", {"is_active": False})
    status, _ = call(guest, "GET", "/auth/me")
    check("정지되면 세션이 죽는다", status == 401, status)

    print("주소 차단")
    guest2 = session()
    status, me2 = call(guest2, "POST", "/auth/guest", {"name": ""})
    check("새 게스트는 아직 들어온다", status == 200, me2)
    my_ip = call(admin, "GET", "/admin/users")[1]
    my_ip = next((u["created_ip"] for u in my_ip if u["id"] == me2["id"]), None)
    check("게스트의 접속 주소가 기록된다", bool(my_ip), my_ip)

    status, block = call(admin, "POST", "/admin/access/ip-blocks", {"cidr": my_ip, "reason": "테스트"})
    check("차단 등록", status == 200, block)
    created_block = (block or {}).get("id")

    status, _ = call(guest2, "GET", "/auth/me")
    check("열려 있던 게스트 세션이 끊긴다", status in (401, 403), status)
    status, _ = call(session(), "POST", "/auth/guest", {"name": ""})
    check("새 게스트도 막힌다", status == 403, status)
    status, _ = call(admin, "GET", "/auth/me")
    check("관리자는 영향받지 않는다", status == 200, status)
    fresh_admin = session()
    status, _ = call(fresh_admin, "POST", "/auth/login", {"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
    check("관리자는 차단된 주소에서도 로그인된다", status == 200, status)

    call(admin, "DELETE", f"/admin/access/ip-blocks/{created_block}")
    created_block = None
    status, _ = call(session(), "POST", "/auth/guest", {"name": ""})
    check("차단을 풀면 다시 들어온다", status == 200, status)

    print("생성 총량")
    set_policy(admin, max_new_per_hour_per_ip=0)
    status, _ = call(session(), "POST", "/auth/guest", {"name": ""})
    check("주소당 0 이면 새 게스트를 받지 않는다", status == 403, status)

finally:
    if created_block:
        call(admin, "DELETE", f"/admin/access/ip-blocks/{created_block}")
    if saved:
        call(admin, "PUT", "/admin/access/guest", saved)
    # 검사가 만든 게스트 계정 정리 (응시 기록은 CASCADE 로 함께 지워진다)
    for u in call(admin, "GET", "/admin/users?role=guest")[1] or []:
        call(admin, "DELETE", f"/admin/users/{u['id']}")

print(f"\n통과 {ok} / 실패 {fail}")
sys.exit(1 if fail else 0)
