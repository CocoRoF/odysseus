"""ODY-023 검증 — 로그아웃·비밀번호 변경·비활성화·만료가 토큰을 실제로 죽이는지 (api 컨테이너 안에서).

  docker cp tests/security/test_session_revocation.py <api>:/tmp/
  docker exec -e PYTHONPATH=/app <api> python3 /tmp/test_session_revocation.py
DB 는 DATABASE_URL 로 직접 만진다 (만료·유휴 시각 조작).
"""

import asyncio
import json
import os
import sys
import urllib.error
import urllib.request

import asyncpg

API = "http://127.0.0.1:8000"
DSN = os.environ["DATABASE_URL"].replace("postgresql+asyncpg://", "postgresql://")
ok = fail = 0


def check(name, cond, detail=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"  PASS {name}")
    else:
        fail += 1
        print(f"  FAIL {name} {str(detail)[:240]}")


def sql(q, *args):
    async def go():
        c = await asyncpg.connect(DSN)
        try:
            return await c.fetch(q, *args)
        finally:
            await c.close()

    return asyncio.run(go())


def req(method, path, body=None, token=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    h = {"Content-Type": "application/json", **(headers or {})}
    if token:
        h["Cookie"] = f"odysseus_token={token}"
    r = urllib.request.Request(f"{API}{path}", data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(r, timeout=30) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else None), {k.lower(): v for k, v in resp.headers.items()}
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            b = json.loads(raw)
        except Exception:
            b = raw.decode(errors="replace")
        return e.code, b, {k.lower(): v for k, v in e.headers.items()}


def login(email, pw):
    st, body, h = req("POST", "/auth/login", {"email": email, "password": pw})
    assert st == 200, (st, body)
    cookie = h.get("set-cookie", "")
    return cookie.split("odysseus_token=", 1)[1].split(";", 1)[0]


admin = login("admin@odysseus.dev", "admin1234")
_, users, _ = req("GET", "/admin/users", token=admin)
cand = next(u for u in users if u["email"] == "candidate@odysseus.dev")

print("\n── 로그아웃은 서버에서도 세션을 죽인다 ──")
tok = login("candidate@odysseus.dev", "cand1234")
st, me, _ = req("GET", "/auth/me", token=tok)
check("로그인 직후 /auth/me 200", st == 200, st)
st, _, h = req("POST", "/auth/logout", token=tok)
check("로그아웃 200 + Clear-Site-Data", st == 200 and "clear-site-data" in h and "storage" in h["clear-site-data"], h.get("clear-site-data"))
st, _, _ = req("GET", "/auth/me", token=tok)
check("복사해 둔 토큰으로 재사용 → 401", st == 401, st)
st, _, _ = req("GET", "/auth/me", headers={"Authorization": f"Bearer {tok}"})
check("Bearer 헤더로도 401", st == 401, st)
rows = sql("select revoked_reason from sessions where revoked_at is not null order by revoked_at desc limit 1")
check("세션 행에 revoked(logout)", rows and rows[0]["revoked_reason"] == "logout", rows)

print("\n── 비밀번호 변경·비활성화는 다른 기기의 세션도 죽인다 ──")
t1 = login("candidate@odysseus.dev", "cand1234")
t2 = login("candidate@odysseus.dev", "cand1234")
st, _, _ = req("PATCH", f"/admin/users/{cand["id"]}", {"password": "newpass-1234"}, token=admin)
check("관리자가 비밀번호 변경", st == 200, st)
check("기존 세션 둘 다 401", req("GET", "/auth/me", token=t1)[0] == 401 and req("GET", "/auth/me", token=t2)[0] == 401)
t3 = login("candidate@odysseus.dev", "newpass-1234")
check("새 비밀번호로는 로그인", req("GET", "/auth/me", token=t3)[0] == 200)
st, _, _ = req("PATCH", f"/admin/users/{cand["id"]}", {"is_active": False}, token=admin)
check("비활성화 → 세션 401", st == 200 and req("GET", "/auth/me", token=t3)[0] == 401)
req("PATCH", f"/admin/users/{cand["id"]}", {"is_active": True, "password": "cand1234"}, token=admin)

print("\n── 절대 만료·유휴 만료 ──")
t4 = login("candidate@odysseus.dev", "cand1234")
sid = sql("select id from sessions where user_id = $1 and revoked_at is null order by created_at desc limit 1", __import__("uuid").UUID(cand["id"]))[0]["id"]
sql("update sessions set last_seen_at = now() - interval '5 hours' where id = $1", sid)
check("4시간 넘게 요청이 없던 세션 → 401", req("GET", "/auth/me", token=t4)[0] == 401)
t5 = login("candidate@odysseus.dev", "cand1234")
sid = sql("select id from sessions where user_id = $1 and revoked_at is null order by created_at desc limit 1", __import__("uuid").UUID(cand["id"]))[0]["id"]
sql("update sessions set expires_at = now() - interval '1 minute' where id = $1", sid)
check("절대 만료 지난 세션 → 401", req("GET", "/auth/me", token=t5)[0] == 401)

print("\n── 캐시 금지 헤더 ──")
t6 = login("candidate@odysseus.dev", "cand1234")
st, _, h = req("GET", "/auth/me", token=t6)
check("API 응답 Cache-Control: no-store", "no-store" in h.get("cache-control", ""), h.get("cache-control"))
st, _, h = req("GET", "/my/assignments", token=t6)
check("데이터 API 도 no-store", "no-store" in h.get("cache-control", ""), h.get("cache-control"))

print("\n── jti 없는 옛 토큰은 거부 ──")
import jwt as _jwt  # PyJWT (api 이미지에 있음)

from odysseus_api.config import settings as _s

old = _jwt.encode({"sub": cand["id"], "role": "candidate", "exp": 9999999999}, _s.jwt_secret, algorithm="HS256")
check("세션 없는 토큰 → 401", req("GET", "/auth/me", token=old)[0] == 401)

print(f"\n{ok} passed, {fail} failed")
sys.exit(1 if fail else 0)
