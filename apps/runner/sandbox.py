"""제한된 서브프로세스 실행.

컨테이너 안에서 root로 돌면 자식 프로세스를 **실행마다 다른 UID**로 강등하고,
setrlimit으로 CPU/프로세스 수/파일 크기/(선택) 가상 메모리를 제한한다.

UID를 실행마다 나누는 이유: 러너 컨테이너 하나를 모든 응시자가 공유하므로,
같은 UID로 돌리면 동시에 시험 보는 다른 응시자의 작업 폴더를 읽을 수 있다.
UID가 다르고 작업 폴더가 0700이면 커널이 그 경로를 막아 준다.
"""

import itertools
import os
import resource
import signal
import subprocess
import threading

OUTPUT_LIMIT = 4 * 1024 * 1024  # stdout 보존 상한 (대형 출력 정답 보호)
STDERR_LIMIT = 8 * 1024

# 실행마다 배정하는 익명 UID 대역 (/etc/passwd 에 없어도 setuid 는 된다).
# 동시 실행끼리 겹치지 않기만 하면 되므로 순환 카운터로 충분하다.
UID_BASE = 61000
UID_SPAN = 2000
_uid_counter = itertools.count()
_uid_lock = threading.Lock()


def next_exec_uid() -> tuple[int, int]:
    """이번 실행에 쓸 (uid, gid). root 가 아니면 강등할 수 없으므로 현재 값을 그대로 쓴다."""
    if os.getuid() != 0:
        return os.getuid(), os.getgid()
    with _uid_lock:
        n = next(_uid_counter) % UID_SPAN
    uid = UID_BASE + n
    return uid, uid


class ExecResult:
    def __init__(self, status: str, returncode: int, stdout: str, stderr: str, time_ms: int):
        self.status = status  # ok | timeout | error
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr
        self.time_ms = time_ms


def _make_preexec(cpu_s: int, mem_mb: int | None, nproc: int, uid: int | None, gid: int | None):
    def preexec():
        os.setsid()
        # 만드는 파일은 소유자 전용. /tmp 처럼 컨테이너가 공유하는 경로에 무언가를
        # 남기더라도 UID 가 다른 다른 응시자가 읽지 못한다.
        os.umask(0o077)
        resource.setrlimit(resource.RLIMIT_CPU, (cpu_s, cpu_s + 2))
        resource.setrlimit(resource.RLIMIT_FSIZE, (64 * 1024 * 1024, 64 * 1024 * 1024))
        resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))
        resource.setrlimit(resource.RLIMIT_NPROC, (nproc, nproc))
        if mem_mb:
            limit = mem_mb * 1024 * 1024
            resource.setrlimit(resource.RLIMIT_AS, (limit, limit))
        if uid is not None and os.getuid() == 0:
            os.setgroups([])
            os.setgid(gid)
            os.setuid(uid)

    return preexec


def execute(
    cmd: list[str],
    cwd: str,
    stdin_data: str = "",
    wall_s: float = 10.0,
    cpu_s: int = 10,
    mem_mb: int | None = None,
    nproc: int = 256,
    env: dict | None = None,
    uid: int | None = None,
    gid: int | None = None,
) -> ExecResult:
    import time

    full_env = {
        "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
    }
    if env:
        full_env.update(env)

    start = time.monotonic()
    try:
        proc = subprocess.Popen(
            cmd,
            cwd=cwd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=full_env,
            preexec_fn=_make_preexec(cpu_s, mem_mb, nproc, uid, gid),
        )
    except OSError as e:
        return ExecResult("error", -1, "", f"spawn failed: {e}", 0)

    try:
        out, err = proc.communicate(stdin_data.encode(), timeout=wall_s)
        elapsed = int((time.monotonic() - start) * 1000)
    except subprocess.TimeoutExpired:
        _kill_group(proc)
        out, err = proc.communicate()
        return ExecResult("timeout", -1, _decode(out), _decode(err, STDERR_LIMIT), int(wall_s * 1000))

    stdout = _decode(out)
    stderr = _decode(err, STDERR_LIMIT)

    # SIGXCPU/SIGKILL로 죽었으면 CPU 시간 초과로 간주
    if proc.returncode in (-signal.SIGXCPU, -signal.SIGKILL):
        return ExecResult("timeout", proc.returncode, stdout, stderr, elapsed)
    return ExecResult("ok", proc.returncode, stdout, stderr, elapsed)


def _kill_group(proc: subprocess.Popen) -> None:
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        try:
            proc.kill()
        except ProcessLookupError:
            pass


def _decode(data: bytes, limit: int = OUTPUT_LIMIT) -> str:
    if data is None:
        return ""
    if len(data) > limit:
        data = data[:limit]
    return data.decode(errors="replace")
