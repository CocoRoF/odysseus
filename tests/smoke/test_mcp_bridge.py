"""MCP 브리지 E2E — api 컨테이너 안에서 실행 (표준 라이브러리만 사용).

stdio MCP 서버를 직접 spawn 해 JSON-RPC 로 initialize / tools/list / tools/call 을
주고받고, 도구 실행이 실제 워크스페이스에 반영되는지 API 로 되확인한다.

  docker cp tests/smoke/test_mcp_bridge.py odysseus-api-1:/tmp/
  docker exec -e PYTHONPATH=/app odysseus-api-1 python3 /tmp/test_mcp_bridge.py
"""

import json
import os
import subprocess
import sys
import urllib.request
from http.cookiejar import CookieJar

API = "http://127.0.0.1:8000"
SCRIPT = "/app/odysseus_api/ai/mcp_workspace.py"

ok = fail = 0


def check(name, cond, detail=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"  PASS {name}")
    else:
        fail += 1
        print(f"  FAIL {name} {detail}")


opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))


def call(method, path, body=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        f"{API}{path}", data=data, method=method,
        headers={"Content-Type": "application/json", **(headers or {})},
    )
    try:
        with opener.open(req, timeout=120) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, raw.decode(errors="replace")


# ── 준비: 관리자 로그인 → 응시 생성 ──────────────────────────────
call("POST", "/auth/login", {"email": "admin@odysseus.dev", "password": "admin1234"})
_, attempts = call("GET", "/review/attempts")
for a in attempts or []:
    call("DELETE", f"/attempts/{a['id']}")
_, assessments = call("GET", "/assessments")
# 시험 목록 순서에 기대지 않는다 — 이 스위트는 매출 리포트 워크스페이스를 전제한다
demo = next((a for a in assessments if "매출 리포트" in a["title"]), assessments[0])
_, attempt = call("POST", f"/assessments/{demo['id']}/attempts")
attempt_id = attempt["id"]
scenario_id = attempt["scenarios"][0]["scenario_id"]
base = f"/attempts/{attempt_id}/scenarios/{scenario_id}"

# ── MCP 서버 spawn ───────────────────────────────────────────────
env = {
    **os.environ,
    "ODYSSEUS_API_BASE": API,
    "ODYSSEUS_INTERNAL_TOKEN": os.environ.get("INTERNAL_TOKEN", "odysseus-internal-change-me"),
    "ODYSSEUS_ATTEMPT_ID": attempt_id,
    "ODYSSEUS_SCENARIO_ID": scenario_id,
}
proc = subprocess.Popen(
    [sys.executable, SCRIPT],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    env=env, text=True, bufsize=1,
)


def rpc(msg_id, method, params=None):
    payload = {"jsonrpc": "2.0", "id": msg_id, "method": method}
    if params is not None:
        payload["params"] = params
    proc.stdin.write(json.dumps(payload) + "\n")
    proc.stdin.flush()
    line = proc.stdout.readline()
    return json.loads(line) if line else None


def notify(method, params=None):
    payload = {"jsonrpc": "2.0", "method": method}
    if params is not None:
        payload["params"] = params
    proc.stdin.write(json.dumps(payload) + "\n")
    proc.stdin.flush()


try:
    # 1. initialize
    r = rpc(1, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test", "version": "1"}})
    res = (r or {}).get("result", {})
    check("initialize", res.get("protocolVersion") == "2025-06-18" and res.get("serverInfo", {}).get("name") == "odysseus", str(r)[:200])
    check("advertises tools capability", "tools" in res.get("capabilities", {}), str(res.get("capabilities")))
    notify("notifications/initialized")

    # 2. tools/list — API tools= 와 동일한 도구 집합
    r = rpc(2, "tools/list")
    tools = (r or {}).get("result", {}).get("tools", [])
    names = {t["name"] for t in tools}
    expected = {"list_files", "read_file", "write_file", "delete_file", "search_files", "copy_file", "move_file", "run_command"}
    check("tools/list matches agent tools", names == expected, str(sorted(names)))
    check("tools carry inputSchema", all(isinstance(t.get("inputSchema"), dict) for t in tools), "")

    # 3. tools/call — list_files
    r = rpc(3, "tools/call", {"name": "list_files", "arguments": {}})
    content = (r or {}).get("result", {}).get("content", [{}])[0].get("text", "")
    check("call list_files", "report.py" in content and "data/orders.csv" in content, content[:150])

    # 4. tools/call — write_file 이 실제 워크스페이스에 반영
    r = rpc(4, "tools/call", {"name": "write_file", "arguments": {"path": "mcp/made.py", "content": "print('via mcp')\n"}})
    check("call write_file", "저장됨" in (r or {}).get("result", {}).get("content", [{}])[0].get("text", ""), str(r)[:200])
    status, fc = call("GET", f"{base}/files/content?path=mcp/made.py")
    check("write reflected in workspace", status == 200 and "via mcp" in fc["content"], str(status))

    # 5. tools/call — search_files
    r = rpc(5, "tools/call", {"name": "search_files", "arguments": {"query": "orders", "in_content": False}})
    text = (r or {}).get("result", {}).get("content", [{}])[0].get("text", "")
    check("call search_files", "data/orders.csv" in text, text[:150])

    # 6. 잘못된 도구 → isError
    r = rpc(6, "tools/call", {"name": "nope", "arguments": {}})
    check("unknown tool -> isError", (r or {}).get("result", {}).get("isError") is True, str(r)[:200])

    # 7. run_command (러너 왕복)
    r = rpc(7, "tools/call", {"name": "run_command", "arguments": {"command": "python3 report.py"}})
    text = (r or {}).get("result", {}).get("content", [{}])[0].get("text", "")
    check("call run_command", "exit code: 0" in text and "리포트 생성 완료" in text, text[:200])
    status, _ = call("GET", f"{base}/files/content?path=output/weekly_report.csv")
    check("run output in workspace", status == 200, str(status))

    # 8. ping
    r = rpc(8, "ping")
    check("ping", (r or {}).get("result") == {}, str(r)[:120])

    # 9. 격리 전파 — Claude Code 는 api 컨테이너에서 돌지만, 코드 실행은 이 브리지를
    #    지나 러너의 격리 sandbox 로 가야 한다. 응시자 터미널과 **같은** 조건인지 본다.
    def run(cmd):
        rr = rpc(90, "tools/call", {"name": "run_command", "arguments": {"command": cmd}})
        return (rr or {}).get("result", {}).get("content", [{}])[0].get("text", "")

    out = run("id; ps aux | wc -l; df -h /tmp | tail -1")
    check("에이전트 실행도 비특권 UID", "uid=61" in out, out[:90])
    check("에이전트 실행도 PID 네임스페이스 격리", "worker.py" not in out, out[:120])
    check("에이전트 실행도 전용 tmpfs", "tmpfs" in out, out[:120])
    out = run("timeout 6 python3 -c \"import urllib.request;urllib.request.urlopen('https://api.github.com',timeout=4)\" 2>&1 | tail -1")
    check("에이전트 실행도 네트워크 차단", "200" not in out, out[:90])
    out = run("ls /work 2>&1 | head -1")
    check("에이전트도 다른 실행 폴더를 못 본다", "Permission denied" in out, out[:90])
    out = run("python3 -V; node -v; go version; git --version")
    check("에이전트도 같은 툴체인", all(t in out for t in ("Python 3", "go1.", "git version")), out[:120])
finally:
    proc.stdin.close()
    proc.terminate()
    err = proc.stderr.read()[:400]
    if err.strip():
        print("  [stderr]", err.strip()[:300])
    call("DELETE", f"/attempts/{attempt_id}")

print(f"\n=== {ok} passed, {fail} failed ===")
sys.exit(1 if fail else 0)
