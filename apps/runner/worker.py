"""Odysseus 실행 러너.

Redis 큐(odysseus:run:queue)에서 워크스페이스 실행 잡을 꺼내:
  1) 파일을 임시 디렉터리에 물질화하고
  2) 비특권 사용자 + rlimit 아래에서 셸 명령을 실행한 뒤
  3) stdout/stderr/exit code 와 함께 **파일 변경분(diff)** 을 API로 콜백한다.

파일 변경분이 워크스페이스(DB)에 다시 반영되므로, 응시자는 IDE·에이전트에서
`python3 report.py` 같은 명령으로 실제 산출물 파일을 만들 수 있다.
"""

import hashlib
import hmac
import json
import os
import stat
import errno
import sys
import resource as _resource
import shutil
import signal
import threading
import time
import traceback
import uuid

import redis
import requests

from resources import (
    CpuMeter,
    container_cpu_usec,
    container_memory,
    ticks_to_seconds,
    tree_usage,
)
from sandbox import execute, isolation_available, kill_tree, next_exec_uid, wrap_isolated

REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379/0")
API_BASE_URL = os.environ.get("API_BASE_URL", "http://localhost:8000")
INTERNAL_TOKEN = os.environ.get("INTERNAL_TOKEN", "")  # 기본값 없음 — main() 이 없으면 멈춘다
CONCURRENCY = int(os.environ.get("RUNNER_CONCURRENCY", "2"))

QUEUE_KEY = "odysseus:run:queue"
WORK_ROOT = "/work"

MAX_CHANGED_FILES = 60
MAX_CHANGED_FILE_BYTES = 400 * 1024
DEFAULT_TIMEOUT_S = 30
MAX_TIMEOUT_S = 60
# 메모리는 컨테이너 단위(compose mem_limit)로 묶는다 — 아래 limits 표시에 쓴다
CONTAINER_MEM_MB = int(os.environ.get("RUNNER_MEM_MB", "4096"))


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


COLLECT_DEADLINE_S = 10.0


def _read_regular(dfd: int, name: str, uid: int | None, limit: int) -> tuple[bytes | None, str | None]:
    """디렉터리 fd 기준으로 열어 fstat 으로 확인한 **일반 파일**만 읽는다 (ODY-004).

    · O_NOFOLLOW — 심볼릭 링크는 열지 않는다 (ELOOP)
    · O_NONBLOCK — FIFO 에 writer 가 없어도 멈추지 않는다
    · fstat 후 S_ISREG — 열린 fd 를 검사하므로 검사와 읽기 사이에 바꿔치기할 수 없다
    · 소유자 검사 — 이번 실행의 UID 가 만든 파일만 (남의 파일에 건 하드링크 배제)
    · limit+1 바이트까지만 읽는다 — 장치 파일처럼 EOF 가 없는 것도 메모리를 못 먹는다
    반환: (내용 또는 None, 건너뛴 이유 또는 None)
    """
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_NOCTTY | getattr(os, "O_CLOEXEC", 0)
    try:
        fd = os.open(name, flags, dir_fd=dfd)
    except OSError as e:
        if e.errno == errno.ELOOP:
            return None, "symlink"
        return None, f"open:{e.errno}"
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            kind = "fifo" if stat.S_ISFIFO(st.st_mode) else "socket" if stat.S_ISSOCK(st.st_mode) else "device" if stat.S_ISCHR(st.st_mode) or stat.S_ISBLK(st.st_mode) else "special"
            return None, kind
        if uid is not None and st.st_uid != uid:
            return None, "foreign-owner"
        if st.st_size > limit:
            return None, "too-large"
        chunks: list[bytes] = []
        remaining = limit + 1
        while remaining > 0:
            try:
                chunk = os.read(fd, min(65536, remaining))
            except BlockingIOError:
                return None, "would-block"
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        data = b"".join(chunks)
        if len(data) > limit:
            return None, "too-large"
        return data, None
    finally:
        os.close(fd)


def collect_changes(workdir: str, before: dict[str, str], uid: int | None = None) -> tuple[list[dict], list[str]]:
    """실행 후 파일 트리를 훑어 생성/수정/삭제분을 수집 (텍스트 일반 파일만).

    디렉터리 fd 를 들고 내려가며 경로 문자열을 다시 열지 않는다 — 순회 중 링크로 바꿔치기해도
    작업 폴더 밖을 읽을 수 없다. 심볼릭 링크·FIFO·장치·남의 파일은 건너뛰고 사유를 남긴다.
    반환: (변경 목록, 응시자에게 보여줄 안내 줄들)
    """
    changes: list[dict] = []
    notes: list[str] = []
    skipped: dict[str, list[str]] = {}
    seen: set[str] = set()
    deadline = time.monotonic() + COLLECT_DEADLINE_S
    dir_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)

    def walk(dfd: int, rel_dir: str) -> bool:
        """False 를 돌려주면 상한(파일 수/시간)에 걸려 중단한 것."""
        try:
            entries = list(os.scandir(dfd))
        except OSError:
            return True
        entries.sort(key=lambda e: e.name)
        for entry in entries:
            if time.monotonic() > deadline:
                notes.append("[산출물 수집] 시간 상한에 걸려 나머지 파일은 반영하지 않았습니다")
                return False
            rel = f"{rel_dir}/{entry.name}" if rel_dir else entry.name
            if rel == ".tmp":
                continue  # 실행용 TMPDIR 은 산출물이 아니다
            try:
                is_dir = entry.is_dir(follow_symlinks=False)
                is_link = entry.is_symlink()
            except OSError:
                continue
            if is_link:
                skipped.setdefault("symlink", []).append(rel)
                continue
            if is_dir:
                try:
                    sub = os.open(entry.name, dir_flags, dir_fd=dfd)
                except OSError:
                    continue
                try:
                    if not walk(sub, rel):
                        return False
                finally:
                    os.close(sub)
                continue
            seen.add(rel)
            data, why = _read_regular(dfd, entry.name, uid, MAX_CHANGED_FILE_BYTES)
            if data is None:
                if why and why not in ("too-large",) and not why.startswith("open:"):
                    skipped.setdefault(why, []).append(rel)
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
                return False
        return True

    try:
        root_fd = os.open(workdir, dir_flags)
    except OSError:
        return changes, notes
    try:
        complete = walk(root_fd, "")
    finally:
        os.close(root_fd)

    if complete:
        for rel in before:
            if rel not in seen:
                changes.append({"path": rel, "deleted": True})
                if len(changes) >= MAX_CHANGED_FILES:
                    break
    labels = {
        "symlink": "심볼릭 링크",
        "fifo": "FIFO",
        "socket": "소켓",
        "device": "장치 파일",
        "special": "특수 파일",
        "foreign-owner": "다른 소유자의 파일",
        "would-block": "읽을 수 없는 파일",
    }
    for kind, paths in skipped.items():
        shown = ", ".join(paths[:5]) + (f" 외 {len(paths) - 5}개" if len(paths) > 5 else "")
        notes.append(f"[산출물 수집] {labels.get(kind, kind)}은 워크스페이스에 반영하지 않습니다: {shown}")
        print(f"[runner] SECURITY skipped {kind} x{len(paths)}: {shown[:200]}", flush=True)
    return changes, notes


def run_job(job: dict, execution_id: str = "") -> dict:
    command = str(job.get("command", "")).strip()
    if not command:
        return {"status": "error", "exit_code": None, "stdout": "", "stderr": "empty command", "changed_files": []}
    timeout_s = min(int(job.get("timeout_s", DEFAULT_TIMEOUT_S) or DEFAULT_TIMEOUT_S), MAX_TIMEOUT_S)

    uid, gid = next_exec_uid()
    ru0 = None
    r = None
    workdir = os.path.join(WORK_ROOT, uuid.uuid4().hex)
    os.makedirs(workdir, mode=0o700)
    try:
        before = materialize(workdir, job.get("files", []), uid, gid)
        # 네임스페이스가 되면 /tmp 는 이 실행 전용 tmpfs 다. 안 되면(개발 환경 등)
        # 공유 /tmp 를 피해 작업 폴더 안 임시 폴더로 떨어뜨린다.
        isolated = isolation_available()
        if isolated:
            argv = wrap_isolated(command, uid, gid)
            exec_uid = exec_gid = None  # 강등은 네임스페이스 안에서 setpriv 가 한다
            tmp_env = {}
        else:
            argv = ["/bin/bash", "-c", command]
            exec_uid, exec_gid = uid, gid
            tmpdir = os.path.join(workdir, ".tmp")
            os.makedirs(tmpdir, exist_ok=True)
            _own(tmpdir, uid, gid, 0o700)
            tmp_env = {"TMPDIR": tmpdir}
        ru0 = _resource.getrusage(_resource.RUSAGE_CHILDREN)
        r = execute(
            argv,
            cwd=workdir,
            wall_s=float(timeout_s),
            cpu_s=timeout_s,
            nproc=128,
            env={
                "HOME": workdir,
                "PYTHONDONTWRITEBYTECODE": "1",
                "GIT_CONFIG_NOSYSTEM": "0",
                **tmp_env,
            },
            uid=exec_uid,
            gid=exec_gid,
            on_start=(lambda p: register_active(execution_id, job, p)) if execution_id else None,
        )
        changed, collect_notes = collect_changes(workdir, before, uid if isolated else None)
        status = "done" if r.status in ("ok", "timeout") else "error"
        stderr = r.stderr
        if r.status == "timeout":
            stderr = (stderr + f"\n[제한 시간 {timeout_s}초 초과로 중단됨]").strip()
        if collect_notes:
            stderr = (stderr + "\n" + "\n".join(collect_notes)).strip()
        return {
            "status": status,
            "exit_code": r.returncode if r.status == "ok" else (r.returncode or 124),
            "stdout": r.stdout,
            "stderr": stderr,
            "time_ms": r.time_ms,
            "changed_files": changed,
        }
    finally:
        if execution_id:
            rusage_delta = 0.0
            if ru0 is not None:
                ru1 = _resource.getrusage(_resource.RUSAGE_CHILDREN)
                rusage_delta = max(0.0, (ru1.ru_utime + ru1.ru_stime) - (ru0.ru_utime + ru0.ru_stime))
            unregister_active(execution_id, rusage_delta=rusage_delta, time_ms=int(r.time_ms) if r else 0)
        shutil.rmtree(workdir, ignore_errors=True)


def _headers(callback_token: str) -> dict:
    # 서비스 토큰 + 실행별 일회용 토큰. 둘 다 맞아야 API 가 결과를 받는다.
    return {"X-Internal-Token": INTERNAL_TOKEN, "X-Execution-Token": callback_token}


def report(execution_id: str, payload: dict, callback_token: str = "") -> None:
    url = f"{API_BASE_URL}/internal/executions/{execution_id}/result"
    headers = _headers(callback_token)
    for attempt in range(5):
        try:
            resp = requests.post(url, json=payload, headers=headers, timeout=15)
            if resp.status_code < 500:
                return
        except requests.RequestException:
            pass
        time.sleep(2**attempt)
    print(f"[runner] FAILED to report result for {execution_id}", flush=True)


def mark_running(execution_id: str, callback_token: str = "") -> None:
    try:
        requests.post(
            f"{API_BASE_URL}/internal/executions/{execution_id}/running",
            headers=_headers(callback_token),
            timeout=5,
        )
    except requests.RequestException:
        pass


def canonical_job(job: dict) -> bytes:
    # api/runqueue.py 와 같은 규칙
    return json.dumps({k: v for k, v in job.items() if k != "sig"}, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def job_is_signed(job: dict) -> bool:
    """API 가 INTERNAL_TOKEN 으로 서명한 작업만 실행한다 — 큐에 직접 끼워 넣은 작업은 버린다."""
    sig = str(job.get("sig", ""))
    expected = hmac.new(INTERNAL_TOKEN.encode("utf-8"), canonical_job(job), hashlib.sha256).hexdigest()
    return bool(sig) and hmac.compare_digest(sig, expected)


def handle(raw: str) -> None:
    execution_id = "?"
    callback_token = ""
    try:
        job = json.loads(raw)
        execution_id = job["execution_id"]
        if not job_is_signed(job):
            print(f"[runner] DROPPED unsigned/forged job execution={str(execution_id)[:40]}", flush=True)
            return
        callback_token = str(job.get("callback_token", ""))
        mark_running(execution_id, callback_token)
        started = time.monotonic()
        result = run_job(job, execution_id)
        print(
            f"[runner] {execution_id} `{str(job.get('command'))[:60]}` -> "
            f"exit={result.get('exit_code')} changed={len(result.get('changed_files', []))} "
            f"({time.monotonic() - started:.1f}s)",
            flush=True,
        )
        report(execution_id, result, callback_token)
    except Exception:
        traceback.print_exc()
        report(
            execution_id,
            {"status": "error", "exit_code": None, "stdout": "", "stderr": "internal runner error", "changed_files": []},
            callback_token,
        )


ENV_KEY = "odysseus:runner:env"
STATS_KEY = "odysseus:runner:stats"
CANCEL_KEY = "odysseus:runner:cancel"
SAMPLE_INTERVAL_S = 1.0

# 지금 돌고 있는 실행들 — 샘플러가 자원을 재고, 관리자의 종료 요청이 여기에 닿는다
_active: dict[str, dict] = {}
_active_lock = threading.Lock()


def register_active(execution_id: str, job: dict, proc) -> None:
    with _active_lock:
        _active[execution_id] = {
            "execution_id": execution_id,
            "attempt_id": job.get("attempt_id"),
            "scenario_id": job.get("scenario_id"),
            "source": job.get("source"),
            "command": str(job.get("command", ""))[:200],
            "started_at": time.time(),
            "proc": proc,
            "cpu_percent": 0.0,
            "memory_bytes": 0,
            "processes": 0,
            "peak_cpu": 0.0,
            "peak_mem": 0,
            "cpu_seconds_sampled": 0.0,
            "overlapped": len(_active) > 0,  # 시작 시점에 다른 실행이 돌고 있었는가
        }
        # 이미 돌고 있던 쪽도 이제 겹친 것이다
        for other in _active.values():
            if other["execution_id"] != execution_id:
                other["overlapped"] = True


LASTRUN_TTL_S = 6 * 3600
_conn_ref: dict = {}


def unregister_active(execution_id: str, *, rusage_delta: float = 0.0, time_ms: int = 0) -> None:
    """실행 종료 — 응시자 화면이 '방금 무엇이 얼마나 돌았는지' 보여 줄 수 있게 요약을 남긴다.

    CPU 시간의 출처는 둘이다. 샘플러가 잰 프로세스 트리 누적치는 그 실행만의 값이지만
    1초 간격이라 짧은 실행을 놓치고, getrusage(RUSAGE_CHILDREN) 증분은 정확하지만
    워커 전체 자식의 합이라 **다른 실행과 겹치면 남의 몫이 섞인다**. 그래서 겹친
    실행이 없었을 때만 getrusage 를 믿고, 겹쳤으면 샘플 누적치를 쓴다.
    """
    with _active_lock:
        entry = _active.pop(execution_id, None)
        overlapped = bool(entry and entry.get("overlapped"))
    cpu_seconds = (entry or {}).get("cpu_seconds_sampled", 0.0) if overlapped else max(rusage_delta, (entry or {}).get("cpu_seconds_sampled", 0.0))
    conn = _conn_ref.get("conn")
    if not entry or not conn or not entry.get("attempt_id"):
        return
    try:
        aid = entry["attempt_id"]
        last = {
            "command": entry["command"],
            "duration_s": round(time_ms / 1000, 2),
            "cpu_seconds": round(cpu_seconds, 3),
            "peak_cpu": entry.get("peak_cpu", 0.0),
            "peak_mem": entry.get("peak_mem", 0),
            "source": entry.get("source"),
            "ended_at": time.time(),
        }
        pipe = conn.pipeline()
        pipe.set(f"odysseus:attempt:{aid}:lastrun", json.dumps(last), ex=LASTRUN_TTL_S)
        pipe.hincrby(f"odysseus:attempt:{aid}:stats", "runs", 1)
        pipe.hincrbyfloat(f"odysseus:attempt:{aid}:stats", "cpu_seconds", round(cpu_seconds, 3))
        pipe.expire(f"odysseus:attempt:{aid}:stats", LASTRUN_TTL_S)
        pipe.execute()
    except Exception:
        traceback.print_exc()


def _kill_execution(execution_id: str) -> bool:
    """관리자 종료 — 프로세스 그룹째 죽인다 (PID 네임스페이스 init 이 죽으면 전부 정리된다)."""
    with _active_lock:
        entry = _active.get(execution_id)
        proc = entry.get("proc") if entry else None
    if not proc:
        return False
    kill_tree(proc)
    return True


def sampler_loop(conn) -> None:
    """1초마다 자원을 재서 Redis 에 게시하고, 종료 요청을 집행한다."""
    meter = CpuMeter()
    while True:
        try:
            with _active_lock:
                snapshot = [dict(e) for e in _active.values()]
            pid_map = {e["execution_id"]: e["proc"].pid for e in snapshot if e.get("proc")}
            usage = tree_usage(set(pid_map.values())) if pid_map else {}

            rows = []
            for entry in snapshot:
                eid = entry["execution_id"]
                pid = pid_map.get(eid)
                u = usage.get(pid, {}) if pid else {}
                cpu_s = ticks_to_seconds(u.get("cpu_ticks", 0))
                elapsed = max(0.05, time.time() - entry["started_at"])
                # 첫 샘플은 증분이 없어 0 이 된다 — 시작부터의 누적으로 대신 잰다
                cpu = meter.percent(eid, cpu_s) if eid in meter._last else round(min(cpu_s / elapsed * 100, 100 * (os.cpu_count() or 1)), 1)
                if eid not in meter._last:
                    meter._last[eid] = (time.monotonic(), cpu_s)
                row = {
                    "execution_id": eid,
                    "attempt_id": entry["attempt_id"],
                    "scenario_id": entry["scenario_id"],
                    "source": entry["source"],
                    "command": entry["command"],
                    "elapsed_s": round(time.time() - entry["started_at"], 1),
                    "cpu_percent": cpu,
                    "memory_bytes": u.get("rss", 0),
                    "processes": u.get("procs", 0),
                }
                rows.append(row)
                with _active_lock:
                    if eid in _active:
                        _active[eid].update(
                            cpu_percent=cpu,
                            memory_bytes=row["memory_bytes"],
                            processes=row["processes"],
                            peak_cpu=max(_active[eid].get("peak_cpu", 0.0), cpu),
                            peak_mem=max(_active[eid].get("peak_mem", 0), row["memory_bytes"]),
                            cpu_seconds_sampled=max(_active[eid].get("cpu_seconds_sampled", 0.0), cpu_s),
                        )

            live = {r["execution_id"] for r in rows}
            for stale in [k for k in list(meter._last) if k not in live and isinstance(k, str)]:
                meter.forget(stale)

            mem_used, mem_limit = container_memory()
            cpu_usec = container_cpu_usec()
            payload = {
                "updated_at": time.time(),
                "concurrency": CONCURRENCY,
                "active": rows,
                "queue_depth": _queue_depth(conn),
                "container": {
                    "cpu_percent": meter.percent("__container__", (cpu_usec or 0) / 1_000_000),
                    "memory_bytes": mem_used,
                    "memory_limit_bytes": mem_limit,
                    "cpu_count": os.cpu_count(),
                },
            }
            conn.set(STATS_KEY, json.dumps(payload), ex=30)

            for eid in conn.smembers(CANCEL_KEY) or []:
                if _kill_execution(eid):
                    print(f"[runner] killed {eid} by request", flush=True)
                conn.srem(CANCEL_KEY, eid)
        except Exception:
            traceback.print_exc()
        time.sleep(SAMPLE_INTERVAL_S)


def _queue_depth(conn) -> int:
    try:
        return int(conn.llen(QUEUE_KEY) or 0)
    except Exception:
        return 0


def publish_environment(conn) -> None:
    """실행 환경 스펙을 조사해 Redis 에 게시.

    응시자에게 보여줄 정보이므로 러너 자신이 조사해야 정확하다. 이미지가 바뀌면
    러너가 다시 뜨면서 갱신된다.
    """
    try:
        from probe import probe_environment

        spec = probe_environment()
        spec["isolated"] = isolation_available()
        spec["limits"] = {
            "timeout_s": DEFAULT_TIMEOUT_S,
            "max_timeout_s": MAX_TIMEOUT_S,
            "memory_mb": CONTAINER_MEM_MB,
            "max_file_bytes": MAX_CHANGED_FILE_BYTES,
            "max_changed_files": MAX_CHANGED_FILES,
            "network": False,
        }
        conn.set(ENV_KEY, json.dumps(spec, ensure_ascii=False))
        langs = len(spec.get("languages", []))
        print(f"[runner] environment published ({langs} runtimes, isolated={spec['isolated']})", flush=True)
    except Exception:
        traceback.print_exc()


def main() -> None:
    if len(INTERNAL_TOKEN) < 32:
        print("[runner] INTERNAL_TOKEN 이 없거나 너무 짧습니다 (최소 32자) — 기동하지 않습니다", flush=True)
        sys.exit(2)
    print(f"[runner] starting, concurrency={CONCURRENCY}", flush=True)
    conn = redis.from_url(REDIS_URL, decode_responses=True)
    _conn_ref["conn"] = conn
    publish_environment(conn)
    threading.Thread(target=sampler_loop, args=(conn,), daemon=True).start()
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
