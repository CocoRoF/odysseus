"""Install per-execution resource guards, then start the reliable worker.

RLIMIT_AS cannot safely represent real memory use for JVM/Go because they reserve large virtual
address spaces. Instead this guard samples the *whole descendant process tree* RSS and kills only the
execution that exceeds its budget, while the outer container remains the final hard memory boundary.
"""

from __future__ import annotations

import os
import threading
import time

import worker as legacy

_REAL_EXECUTE = legacy.execute
CONTAINER_MEM_MB = int(os.environ.get("RUNNER_MEM_MB", "4096"))
DEFAULT_EXEC_MEM_MB = max(512, int(CONTAINER_MEM_MB * 0.8 / max(1, legacy.CONCURRENCY)))
_raw_exec_mem = os.environ.get("RUNNER_EXEC_MEM_MB", "").strip()
try:
    EXEC_MEM_MB = max(256, int(_raw_exec_mem or DEFAULT_EXEC_MEM_MB))
except ValueError:
    print(f"[runner] RUNNER_EXEC_MEM_MB 값이 숫자가 아닙니다 ({_raw_exec_mem!r}) — 자동값 {DEFAULT_EXEC_MEM_MB}MB 사용", flush=True)
    EXEC_MEM_MB = DEFAULT_EXEC_MEM_MB


def guarded_execute(*args, **kwargs):
    original_on_start = kwargs.get("on_start")
    memory_hit = threading.Event()
    watcher_done = threading.Event()

    def on_start(proc):
        if original_on_start:
            original_on_start(proc)

        def watch() -> None:
            limit = EXEC_MEM_MB * 1024 * 1024
            while not watcher_done.is_set() and proc.poll() is None:
                try:
                    usage = legacy.tree_usage({proc.pid}).get(proc.pid, {})
                    if int(usage.get("rss", 0) or 0) > limit:
                        memory_hit.set()
                        legacy.kill_tree(proc)
                        return
                except Exception:
                    pass
                time.sleep(0.1)

        threading.Thread(target=watch, daemon=True).start()

    kwargs["on_start"] = on_start
    try:
        result = _REAL_EXECUTE(*args, **kwargs)
    finally:
        watcher_done.set()
    if memory_hit.is_set():
        result.status = "error"
        result.stderr = (
            (result.stderr or "")
            + f"\n[실행 메모리가 {EXEC_MEM_MB}MB 상한을 넘어 프로세스 트리를 중단했습니다]"
        ).strip()
    return result


legacy.execute = guarded_execute

if __name__ == "__main__":
    print(f"[runner] per-execution memory budget={EXEC_MEM_MB}MB", flush=True)
    from reliable_worker import main

    main()
