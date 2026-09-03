"""실행 자원 계측 — cgroup v2 와 /proc 만 사용 (외부 의존 없음).

두 층위를 잰다:
  · 컨테이너 전체 — cgroup v2 의 memory.current / cpu.stat
  · 실행 한 건    — 그 프로세스 트리의 RSS 합과 CPU 시간 합

CPU 사용률은 시점 값이 아니라 두 샘플 사이의 증분이므로, 호출자가 직전 값을
들고 있어야 한다 (CpuMeter 참조).
"""

import os
import time

CGROUP = "/sys/fs/cgroup"
CLOCK_TICKS = os.sysconf("SC_CLK_TCK")
PAGE_SIZE = os.sysconf("SC_PAGE_SIZE")


def _read_int(path: str) -> int | None:
    try:
        with open(path) as fh:
            raw = fh.read().strip()
    except OSError:
        return None
    if raw == "max":
        return None
    try:
        return int(raw)
    except ValueError:
        return None


def container_memory() -> tuple[int | None, int | None]:
    """(사용 바이트, 상한 바이트). 상한이 없으면 호스트 메모리로 대체한다."""
    used = _read_int(f"{CGROUP}/memory.current")
    limit = _read_int(f"{CGROUP}/memory.max")
    if limit is None:
        try:
            with open("/proc/meminfo") as fh:
                for line in fh:
                    if line.startswith("MemTotal:"):
                        limit = int(line.split()[1]) * 1024
                        break
        except (OSError, ValueError):
            limit = None
    return used, limit


def container_cpu_usec() -> int | None:
    try:
        with open(f"{CGROUP}/cpu.stat") as fh:
            for line in fh:
                if line.startswith("usage_usec"):
                    return int(line.split()[1])
    except (OSError, ValueError):
        pass
    return None


def _proc_stat(pid: str) -> tuple[int, int] | None:
    """(ppid, utime+stime 틱). 실행 파일명에 괄호가 있어도 안전하게 자른다."""
    try:
        with open(f"/proc/{pid}/stat") as fh:
            raw = fh.read()
    except OSError:
        return None
    rparen = raw.rfind(")")
    if rparen < 0:
        return None
    fields = raw[rparen + 2 :].split()
    try:
        # stat 필드 4=ppid, 14=utime, 15=stime → 이름 다음이 index 0(state)
        return int(fields[1]), int(fields[11]) + int(fields[12])
    except (IndexError, ValueError):
        return None


def _proc_rss(pid: str) -> int:
    try:
        with open(f"/proc/{pid}/statm") as fh:
            return int(fh.read().split()[1]) * PAGE_SIZE
    except (OSError, ValueError, IndexError):
        return 0


def tree_usage(root_pids: set[int]) -> dict[int, dict]:
    """여러 프로세스 트리의 자원을 한 번의 /proc 스캔으로 집계.

    반환: {root_pid: {"rss": bytes, "cpu_ticks": int, "procs": int}}
    """
    children: dict[int, list[int]] = {}
    stats: dict[int, tuple[int, int]] = {}
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        parsed = _proc_stat(entry)
        if not parsed:
            continue
        ppid, ticks = parsed
        pid = int(entry)
        stats[pid] = (ppid, ticks)
        children.setdefault(ppid, []).append(pid)

    out: dict[int, dict] = {}
    for root in root_pids:
        rss = ticks_total = count = 0
        stack = [root]
        seen: set[int] = set()
        while stack:
            pid = stack.pop()
            if pid in seen or pid not in stats:
                continue
            seen.add(pid)
            count += 1
            ticks_total += stats[pid][1]
            rss += _proc_rss(str(pid))
            stack.extend(children.get(pid, []))
        out[root] = {"rss": rss, "cpu_ticks": ticks_total, "procs": count}
    return out


def descendants(root_pid: int) -> list[int]:
    """root_pid 와 그 모든 자손 (깊은 것부터).

    프로세스 그룹으로 죽이는 것만으로는 부족하다 — `unshare` 가 만든 자식은
    별도 PID 네임스페이스의 init 이라 그룹 시그널이 닿지 않는 경우가 있다.
    """
    children: dict[int, list[int]] = {}
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        parsed = _proc_stat(entry)
        if parsed:
            children.setdefault(parsed[0], []).append(int(entry))

    ordered: list[int] = []
    stack = [root_pid]
    seen: set[int] = set()
    while stack:
        pid = stack.pop()
        if pid in seen:
            continue
        seen.add(pid)
        ordered.append(pid)
        stack.extend(children.get(pid, []))
    return list(reversed(ordered))  # 자손부터, 뿌리는 마지막


class CpuMeter:
    """CPU 시간 증분을 사용률(%)로 바꾼다. 100% = 코어 하나를 가득 쓴 상태."""

    def __init__(self) -> None:
        self._last: dict[object, tuple[float, float]] = {}

    def percent(self, key: object, cpu_seconds: float) -> float:
        now = time.monotonic()
        prev = self._last.get(key)
        self._last[key] = (now, cpu_seconds)
        if not prev:
            return 0.0
        elapsed = now - prev[0]
        if elapsed <= 0:
            return 0.0
        return max(0.0, round((cpu_seconds - prev[1]) / elapsed * 100, 1))

    def forget(self, key: object) -> None:
        self._last.pop(key, None)


def ticks_to_seconds(ticks: int) -> float:
    return ticks / CLOCK_TICKS
