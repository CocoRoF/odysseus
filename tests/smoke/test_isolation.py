"""러너 격리 계약 — 응시자 코드가 실제로 무엇에 닿는지 실행해서 확인한다.

러너 컨테이너는 모든 응시자가 공유한다. 그래서 "누가 무엇을 못 보는가"는
설정 파일을 읽어서가 아니라 **셸을 돌려서** 증명해야 한다. 이 스위트는 한 번
뚫렸던 세 구멍(응시자 교차 열람 · 외부망 · 데이터베이스 도달)을 고정한다.

호스트에서 실행:  python3 tests/smoke/test_isolation.py
"""

import sys
import threading
import time

import requests

API = "http://localhost:8100"
ok = fail = 0


def check(name, cond, detail=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"  PASS {name}")
    else:
        fail += 1
        print(f"  FAIL {name} {detail}")


ad = requests.Session()
ad.post(f"{API}/auth/login", json={"email": "admin@odysseus.dev", "password": "admin1234"})
for a in ad.get(f"{API}/review/attempts").json():
    ad.delete(f"{API}/attempts/{a['id']}")
assessments = ad.get(f"{API}/assessments").json()


def new_attempt(title_part):
    spec = next(a for a in assessments if title_part in a["title"])
    at = ad.post(f"{API}/assessments/{spec['id']}/attempts").json()
    at = ad.get(f"{API}/attempts/{at['id']}").json()
    return at["id"], at["scenarios"][0]["scenario_id"]


def run(aid, sid, command, timeout_s=30):
    ex = ad.post(f"{API}/attempts/{aid}/scenarios/{sid}/run",
                 json={"command": command, "timeout_s": timeout_s}).json()
    for _ in range(90):
        time.sleep(0.5)
        d = ad.get(f"{API}/executions/{ex['id']}").json()
        if d["status"] in ("done", "error"):
            return (d.get("stdout", "") + d.get("stderr", "")).strip()
    return "<timeout>"


a1, s1 = new_attempt("매출")
a2, s2 = new_attempt("인프라")

print("\n── 권한 강등 ──")
out = run(a1, s1, "id")
check("비특권 UID 로 실행", "uid=0(" not in out, out[:80])
check("실행 전용 UID 대역", "uid=61" in out, out[:80])
uid_a = run(a1, s1, "id -u")
uid_b = run(a2, s2, "id -u")
check("실행마다 다른 UID", uid_a != uid_b, f"{uid_a} vs {uid_b}")

print("\n── 루트 승격 ──")
out = run(a1, s1, "sudo -n true 2>&1|head -1; su -c id 2>&1|head -1; unshare -r id 2>&1|head -1")
check("sudo 없음", "command not found" in out, out[:80])
check("su 실패", "Authentication failure" in out or "su:" in out, out[:80])
check("사용자 네임스페이스 거부", "not permitted" in out, out[:80])
out = run(a1, s1, "touch /etc/pwned 2>&1|head -1; cat /proc/1/environ 2>&1|head -1")
check("컨테이너 시스템 경로 쓰기 불가", "Permission denied" in out, out[:80])
check("워커 환경변수(내부 토큰) 읽기 불가", out.count("Permission denied") >= 2, out[:120])

print("\n── 네트워크 경계 ──")
out = run(a1, s1, "timeout 8 python3 -c \"import urllib.request;print(urllib.request.urlopen('https://api.github.com',timeout=6).status)\" 2>&1|tail -1")
check("외부 인터넷 차단", "200" not in out, out[:100])
out = run(a1, s1, "timeout 6 python3 -c \"import socket;socket.create_connection(('postgres',5432),3);print('reachable')\" 2>&1|tail -1")
check("데이터베이스 도달 불가", "reachable" not in out, out[:100])
out = run(a1, s1, "timeout 6 python3 -c \"import socket;socket.create_connection(('api',8000),3);print('reachable')\" 2>&1|tail -1")
check("api 는 도달 가능해야 한다 (결과 콜백)", "reachable" in out, out[:100])

print("\n── 응시자 교차 열람 ──")
ad.put(f"{API}/attempts/{a1}/scenarios/{s1}/files/content",
       json={"path": "secret_answer.txt", "content": "MY-PRIVATE-SOLUTION-42"})
holder = {}


def victim():
    holder["out"] = run(a1, s1, "echo secret > /tmp/leak-from-A; sleep 12; echo done")


t = threading.Thread(target=victim)
t.start()
time.sleep(3)
out = run(a2, s2,
          "ls /work 2>&1|head -2; grep -rl 'PRIVATE-SOLUTION' /work /tmp 2>/dev/null|head -2; "
          "cat /tmp/leak-from-A 2>&1|head -1")
t.join()
check("/work 목록 열람 불가", "Permission denied" in out and "cannot open" in out, out[:120])
check("동시 실행 중인 남의 워크스페이스 못 읽음", "PRIVATE-SOLUTION" not in out, out[:160])
check("공유 /tmp 에 남긴 파일도 못 읽음", "secret" not in out, out[:160])

print("\n── 기능 회귀 (격리가 실행을 망가뜨리지 않았는가) ──")
out = run(a1, s1, "python3 report.py")
check("워크스페이스 실행 정상", "리포트 생성 완료" in out, out[:120])
out = run(a1, s1, "echo hello > made.txt && cat made.txt")
check("파일 생성·회수 정상", "hello" in out, out[:80])
files = ad.get(f"{API}/attempts/{a1}/scenarios/{s1}/files").json()
paths = [f["path"] for f in (files["files"] if isinstance(files, dict) else files)]
check("산출물이 워크스페이스에 반영", "made.txt" in paths, str(paths[:8]))
check("내부 TMPDIR 은 산출물로 새지 않음", not any(p.startswith(".tmp") for p in paths), str(paths[:8]))
out = run(a1, s1, "python3 -c \"import tempfile,os;f=tempfile.NamedTemporaryFile(delete=False);print(os.path.dirname(f.name))\"")
check("임시 파일은 실행 전용 폴더로", "/work/" in out, out[:100])

print(f"\n{ok} passed, {fail} failed")
sys.exit(1 if fail else 0)
