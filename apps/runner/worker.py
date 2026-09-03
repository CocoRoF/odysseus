"""Odysseus 실행 러너.

Redis 큐(odysseus:run:queue)에서 워크스페이스 실행 잡을 꺼내:
  1) 파일을 임시 디렉터리에 물질화하고
  2) 비특권 사용자 + rlimit 아래에서 셸 명령을 실행한 뒤
  3) stdout/stderr/exit code 와 함께 **파일 변경분(diff)** 을 API로 콜백한다.

파일 변경분이 워크스페이스(DB)에 다시 반영되므로, 응시자는 IDE·에이전트에서
`python3 report.py` 같은 명령으로 실제 산출물 파일을 만들 수 있다.
"""

import hashlib
import json
import os
import shutil
import threading
import time
import traceback
import uuid

import redis
import requests

from sandbox import execute, next_exec_uid

REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379/0")
API_BASE_URL = os.environ.get("API_BASE_URL", "http://localhost:8000")
INTERNAL_TOKEN = os.environ.get("INTERNAL_TOKEN", "odysseus-internal-change-me")
CONCURRENCY = int(os.environ.get("RUNNER_CONCURRENCY", "2"))

QUEUE_KEY = "odysseus:run:queue"
WORK_ROOT = "/work"

MAX_CHANGED_FILES = 60
MAX_CHANGED_FILE_BYTES = 400 * 1024
DEFAULT_TIMEOUT_S = 30
MAX_TIMEOUT_S = 60
MEM_LIMIT_MB = 512


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def materialize(workdir: str, files: list[dict], uid: int, gid: int) -> dict[str, str]:
    """파일 트리 생성. path→해시 스냅샷 반환.

    소유자는 이번 실행의 UID, 권한은 0700/0600 — 같은 컨테이너에서 동시에 도는
    다른 응시자의 실행이 이 트리를 열어볼 수 없어야 한다.
    """
    snapshot: dict[str, str] = {}
    for f in files:
        rel = str(f.get("path", "")).strip().lstrip("/")
        if not rel or ".." in rel.split("/"):
            continue
        abspath = os.path.join(workdir, rel)
        os.makedirs(os.path.dirname(abspath), exist_ok=True)
        data = str(f.get("content", "")).encode("utf-8", errors="ignore")
        with open(abspath, "wb") as fh:
            fh.write(data)
        snapshot[rel] = _sha(data)
    # 이번 실행의 UID 만 접근할 수 있게 소유권과 권한을 좁힌다
    _own(workdir, uid, gid, 0o700)
    for root, dirs, filenames in os.walk(workdir):
        for d in dirs:
            _own(os.path.join(root, d), uid, gid, 0o700)
        for name in filenames:
            _own(os.path.join(root, name), uid, gid, 0o600)
    return snapshot


def _own(path: str, uid: int, gid: int, mode: int) -> None:
    """권한을 먼저 좁히고 소유권을 넘긴다 (순서가 바뀌면 CAP_FOWNER 가 필요해진다)."""
    try:
        os.chmod(path, mode)
        if os.getuid() == 0:
            os.chown(path, uid, gid)
    except OSError:
        pass


def collect_changes(workdir: str, before: dict[str, str]) -> list[dict]:
    """실행 후 파일 트리를 훑어 생성/수정/삭제분을 수집 (텍스트 파일만)."""
    changes: list[dict] = []
    seen: set[str] = set()
    for root, dirs, filenames in os.walk(workdir):
        dirs[:] = [d for d in dirs if d != ".tmp"]  # 실행용 TMPDIR 은 산출물이 아니다
        for name in filenames:
            abspath = os.path.join(root, name)
            rel = os.path.relpath(abspath, workdir).replace(os.sep, "/")
            seen.add(rel)
            try:
                size = os.path.getsize(abspath)
                if size > MAX_CHANGED_FILE_BYTES:
                    continue
                with open(abspath, "rb") as fh:
                    data = fh.read()
            except OSError:
                continue
            digest = _sha(data)
            if before.get(rel) == digest:
                continue
            try:
                text = data.decode("utf-8")
            except UnicodeDecodeError:
                continue  # 바이너리 산출물은 워크스페이스에 반영하지 않는다
            if "\x00" in text:
                continue
            changes.append({"path": rel, "content": text})
            if len(changes) >= MAX_CHANGED_FILES:
                return changes
    for rel in before:
        if rel not in seen:
            changes.append({"path": rel, "deleted": True})
            if len(changes) >= MAX_CHANGED_FILES:
                break
    return changes


def run_job(job: dict) -> dict:
    command = str(job.get("command", "")).strip()
    if not command:
        return {"status": "error", "exit_code": None, "stdout": "", "stderr": "empty command", "changed_files": []}
    timeout_s = min(int(job.get("timeout_s", DEFAULT_TIMEOUT_S) or DEFAULT_TIMEOUT_S), MAX_TIMEOUT_S)

    uid, gid = next_exec_uid()
    workdir = os.path.join(WORK_ROOT, uuid.uuid4().hex)
    os.makedirs(workdir, mode=0o700)
    try:
        before = materialize(workdir, job.get("files", []), uid, gid)
        # TMPDIR 도 작업 폴더 안으로 — /tmp 는 컨테이너가 공유하므로 실행 사이에
        # 남은 파일이 다음 응시자에게 보인다.
        tmpdir = os.path.join(workdir, ".tmp")
        os.makedirs(tmpdir, exist_ok=True)
        _own(tmpdir, uid, gid, 0o700)
        r = execute(
            ["/bin/bash", "-c", command],
            cwd=workdir,
            wall_s=float(timeout_s),
            cpu_s=timeout_s,
            mem_mb=MEM_LIMIT_MB,
            nproc=128,
            env={
                "HOME": workdir,
                "TMPDIR": tmpdir,
                "PYTHONDONTWRITEBYTECODE": "1",
            },
            uid=uid,
            gid=gid,
        )
        changed = collect_changes(workdir, before)
        status = "done" if r.status in ("ok", "timeout") else "error"
        stderr = r.stderr
        if r.status == "timeout":
            stderr = (stderr + f"\n[제한 시간 {timeout_s}초 초과로 중단됨]").strip()
        return {
            "status": status,
            "exit_code": r.returncode if r.status == "ok" else (r.returncode or 124),
            "stdout": r.stdout,
            "stderr": stderr,
            "time_ms": r.time_ms,
            "changed_files": changed,
        }
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def report(execution_id: str, payload: dict) -> None:
    url = f"{API_BASE_URL}/internal/executions/{execution_id}/result"
    headers = {"X-Internal-Token": INTERNAL_TOKEN}
    for attempt in range(5):
        try:
            resp = requests.post(url, json=payload, headers=headers, timeout=15)
            if resp.status_code < 500:
                return
        except requests.RequestException:
            pass
        time.sleep(2**attempt)
    print(f"[runner] FAILED to report result for {execution_id}", flush=True)


def mark_running(execution_id: str) -> None:
    try:
        requests.post(
            f"{API_BASE_URL}/internal/executions/{execution_id}/running",
            headers={"X-Internal-Token": INTERNAL_TOKEN},
            timeout=5,
        )
    except requests.RequestException:
        pass


def handle(raw: str) -> None:
    execution_id = "?"
    try:
        job = json.loads(raw)
        execution_id = job["execution_id"]
        mark_running(execution_id)
        started = time.monotonic()
        result = run_job(job)
        print(
            f"[runner] {execution_id} `{str(job.get('command'))[:60]}` -> "
            f"exit={result.get('exit_code')} changed={len(result.get('changed_files', []))} "
            f"({time.monotonic() - started:.1f}s)",
            flush=True,
        )
        report(execution_id, result)
    except Exception:
        traceback.print_exc()
        report(
            execution_id,
            {"status": "error", "exit_code": None, "stdout": "", "stderr": "internal runner error", "changed_files": []},
        )


def main() -> None:
    print(f"[runner] starting, concurrency={CONCURRENCY}", flush=True)
    conn = redis.from_url(REDIS_URL, decode_responses=True)
    slots = threading.Semaphore(CONCURRENCY)

    while True:
        try:
            item = conn.brpop(QUEUE_KEY, timeout=5)
        except redis.RedisError:
            time.sleep(2)
            continue
        if not item:
            continue
        _, raw = item
        slots.acquire()

        def run(raw=raw):
            try:
                handle(raw)
            finally:
                slots.release()

        threading.Thread(target=run, daemon=True).start()


if __name__ == "__main__":
    main()
