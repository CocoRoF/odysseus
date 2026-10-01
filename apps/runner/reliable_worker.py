"""Reliable queue entrypoint for Odysseus runner.

`BRPOP` removes work before it is processed, so a runner crash loses that execution forever. This
entrypoint atomically moves pending jobs to a runner-owned processing list, ACKs only after the API
accepts a result, and requeues work after transient callback failure. On restart it recovers the
previous instance's unacked processing list.

RUNNER_ID must be unique for concurrently running runner replicas and stable across restarts of that
replica (compose defaults to `runner-main`).
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
import traceback

import redis
import requests

import worker as legacy

QUEUE_KEY = legacy.QUEUE_KEY
CANCEL_KEY = legacy.CANCEL_KEY
RUNNER_ID = os.environ.get("RUNNER_ID", "runner-main").strip() or "runner-main"
PROCESSING_KEY = f"odysseus:run:processing:{RUNNER_ID}"
# 같은 실행을 이만큼 넘게 받으면 더 돌리지 않는다 — 결과 콜백이 결정적으로 5xx 를 내는 payload 가
# 응시자 CPU 를 무한히 태우며 재전송되는 것을 막는다.
MAX_DELIVERIES = 5
DELIVERY_KEY_TTL_S = 24 * 3600


def _delivery_count(conn, raw: str) -> tuple[str, int]:
    try:
        execution_id = str(json.loads(raw)["execution_id"])
    except Exception:  # noqa: BLE001 — 깨진 payload 는 handle_reliable 이 error 로 보고하고 ACK 한다
        return "?", 1
    try:
        key = f"odysseus:run:deliveries:{execution_id}"
        n = int(conn.incr(key))
        conn.expire(key, DELIVERY_KEY_TTL_S)
        return execution_id, n
    except redis.RedisError:
        return execution_id, 1


def probe_isolation() -> bool:
    """실제로 네임스페이스를 만들어 본다 — 바이너리 존재 여부만으로는 SYS_ADMIN/AppArmor 거부를 못 본다."""
    import subprocess

    uid, gid = legacy.next_exec_uid()
    try:
        proc = subprocess.run(
            legacy.wrap_isolated("true", uid, gid), capture_output=True, timeout=30, cwd="/work"
        )
    except (OSError, subprocess.SubprocessError) as exc:
        print(f"[runner] isolation probe failed to run: {type(exc).__name__}", flush=True)
        return False
    if proc.returncode != 0:
        print(f"[runner] isolation probe exit={proc.returncode}: {legacy._log_safe(proc.stderr.decode(errors='replace'), 300)}", flush=True)
    return proc.returncode == 0


def _report_ok(execution_id: str, payload: dict, callback_token: str) -> bool:
    """True once API gave a terminal (<500) answer; False only for retryable transport/server failure."""
    url = f"{legacy.API_BASE_URL}/internal/executions/{execution_id}/result"
    headers = legacy._headers(callback_token)
    for attempt in range(5):
        try:
            resp = requests.post(url, json=payload, headers=headers, timeout=15)
            if resp.status_code < 500:
                return True
        except requests.RequestException:
            pass
        time.sleep(2**attempt)
    print(f"[runner] result callback unavailable execution={execution_id}; requeueing", flush=True)
    return False


def handle_reliable(raw: str, conn) -> bool:
    """Process one claimed job. Return True to ACK, False to requeue."""
    execution_id = "?"
    callback_token = ""
    try:
        job = json.loads(raw)
        execution_id = str(job["execution_id"])
        if not legacy.job_is_signed(job):
            print(f"[runner] DROPPED unsigned/forged job execution={legacy._log_safe(execution_id, 40)}", flush=True)
            return True

        # finalize_attempt leaves a tombstone for queued work. Do not spend CPU on a job that was
        # already cancelled before this runner claimed it.
        if conn.sismember(CANCEL_KEY, execution_id):
            conn.srem(CANCEL_KEY, execution_id)
            print(f"[runner] skipped cancelled queued execution={legacy._log_safe(execution_id, 40)}", flush=True)
            return True

        callback_token = str(job.get("callback_token", ""))
        legacy.mark_running(execution_id, callback_token)
        started = time.monotonic()
        result = legacy.run_job(job, execution_id)
        print(
            f"[runner] {legacy._log_safe(execution_id, 40)} `{legacy._log_safe(str(job.get('command')))}` -> "
            f"exit={result.get('exit_code')} changed={len(result.get('changed_files', []))} "
            f"({time.monotonic() - started:.1f}s)",
            flush=True,
        )
        return _report_ok(execution_id, result, callback_token)
    except Exception:
        traceback.print_exc()
        return _report_ok(
            execution_id,
            {"status": "error", "exit_code": None, "stdout": "", "stderr": "internal runner error", "changed_files": []},
            callback_token,
        )


def sampler_loop(conn) -> None:
    """Resource sampler + cancellation executor.

    A cancellation tombstone is removed only after an active process was actually killed. Tombstones
    for queued jobs remain until `handle_reliable` claims and skips that job.
    """
    meter = legacy.CpuMeter()
    while True:
        try:
            with legacy._active_lock:
                snapshot = [dict(e) for e in legacy._active.values()]
            pid_map = {e["execution_id"]: e["proc"].pid for e in snapshot if e.get("proc")}
            usage = legacy.tree_usage(set(pid_map.values())) if pid_map else {}

            rows = []
            for entry in snapshot:
                eid = entry["execution_id"]
                pid = pid_map.get(eid)
                u = usage.get(pid, {}) if pid else {}
                cpu_s = legacy.ticks_to_seconds(u.get("cpu_ticks", 0))
                elapsed = max(0.05, time.time() - entry["started_at"])
                cpu = meter.percent(eid, cpu_s) if eid in meter._last else round(
                    min(cpu_s / elapsed * 100, 100 * (os.cpu_count() or 1)), 1
                )
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
                with legacy._active_lock:
                    if eid in legacy._active:
                        legacy._active[eid].update(
                            cpu_percent=cpu,
                            memory_bytes=row["memory_bytes"],
                            processes=row["processes"],
                            peak_cpu=max(legacy._active[eid].get("peak_cpu", 0.0), cpu),
                            peak_mem=max(legacy._active[eid].get("peak_mem", 0), row["memory_bytes"]),
                            cpu_seconds_sampled=max(legacy._active[eid].get("cpu_seconds_sampled", 0.0), cpu_s),
                        )

            live = {r["execution_id"] for r in rows}
            for stale in [k for k in list(meter._last) if k not in live and isinstance(k, str)]:
                meter.forget(stale)

            mem_used, mem_limit = legacy.container_memory()
            cpu_usec = legacy.container_cpu_usec()
            payload = {
                "updated_at": time.time(),
                "concurrency": legacy.CONCURRENCY,
                "active": rows,
                "queue_depth": legacy._queue_depth(conn),
                "processing_depth": int(conn.llen(PROCESSING_KEY) or 0),
                "runner_id": RUNNER_ID,
                "container": {
                    "cpu_percent": meter.percent("__container__", (cpu_usec or 0) / 1_000_000),
                    "memory_bytes": mem_used,
                    "memory_limit_bytes": mem_limit,
                    "cpu_count": os.cpu_count(),
                },
            }
            conn.set(legacy.STATS_KEY, json.dumps(payload), ex=30)

            for eid in conn.smembers(CANCEL_KEY) or []:
                if legacy._kill_execution(eid):
                    print(f"[runner] killed {eid} by request", flush=True)
                    conn.srem(CANCEL_KEY, eid)
        except Exception:
            traceback.print_exc()
        time.sleep(legacy.SAMPLE_INTERVAL_S)


def recover_processing(conn) -> int:
    """Return this runner identity's unacked jobs to the pending queue after a restart."""
    recovered = 0
    while True:
        raw = conn.rpoplpush(PROCESSING_KEY, QUEUE_KEY)
        if raw is None:
            break
        recovered += 1
    if recovered:
        print(f"[runner] recovered {recovered} unacked jobs from {PROCESSING_KEY}", flush=True)
    return recovered


def main() -> None:
    if len(legacy.INTERNAL_TOKEN) < 32:
        print("[runner] INTERNAL_TOKEN 이 없거나 너무 짧습니다 (최소 32자) — 기동하지 않습니다", flush=True)
        sys.exit(2)
    require_isolation = os.environ.get("RUNNER_REQUIRE_ISOLATION", "true").lower() not in ("0", "false", "no")
    if require_isolation and (legacy.isolation_available() is False or not probe_isolation()):
        print("[runner] required namespace isolation is unavailable — refusing to execute candidate code", flush=True)
        sys.exit(3)

    print(
        f"[runner] starting id={RUNNER_ID}, concurrency={legacy.CONCURRENCY}, processing={PROCESSING_KEY}",
        flush=True,
    )
    conn = redis.from_url(legacy.REDIS_URL, decode_responses=True)
    legacy._conn_ref["conn"] = conn
    recover_processing(conn)
    legacy.publish_environment(conn)
    threading.Thread(target=sampler_loop, args=(conn,), daemon=True).start()
    slots = threading.Semaphore(legacy.CONCURRENCY)

    while True:
        try:
            # Atomic pending -> processing claim. A crash leaves the raw job recoverable.
            raw = conn.brpoplpush(QUEUE_KEY, PROCESSING_KEY, timeout=5)
        except redis.RedisError:
            time.sleep(2)
            continue
        if not raw:
            continue
        slots.acquire()

        def run(claimed=raw):
            try:
                execution_id, deliveries = _delivery_count(conn, claimed)
                if deliveries > MAX_DELIVERIES:
                    print(f"[runner] execution={legacy._log_safe(execution_id, 40)} delivered {deliveries} times — giving up", flush=True)
                    try:
                        job = json.loads(claimed)
                        token = str(job.get("callback_token", ""))
                    except Exception:  # noqa: BLE001
                        token = ""
                    _report_ok(
                        execution_id,
                        {"status": "error", "exit_code": None, "stdout": "", "stderr": "runner gave up after repeated delivery failures", "changed_files": []},
                        token,
                    )
                    ack = True
                else:
                    ack = handle_reliable(claimed, conn)
                conn.lrem(PROCESSING_KEY, 1, claimed)
                if not ack:
                    conn.lpush(QUEUE_KEY, claimed)
                    time.sleep(1)
            except Exception:
                traceback.print_exc()
                # If Redis itself is down, leave processing untouched for restart recovery.
            finally:
                slots.release()

        threading.Thread(target=run, daemon=True).start()


if __name__ == "__main__":
    main()
