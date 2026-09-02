"""제한된 서브프로세스 실행.

컨테이너 안에서 root로 돌면 자식 프로세스를 sandbox 사용자로 강등하고,
setrlimit으로 CPU/프로세스 수/파일 크기/(선택) 가상 메모리를 제한한다.
"""

import os
import pwd
import resource
import signal
import subprocess

OUTPUT_LIMIT = 4 * 1024 * 1024  # stdout 보존 상한 (대형 출력 정답 보호)
STDERR_LIMIT = 8 * 1024

try:
    _sandbox = pwd.getpwnam("sandbox")
    SANDBOX_UID, SANDBOX_GID = _sandbox.pw_uid, _sandbox.pw_gid
except KeyError:
    SANDBOX_UID = SANDBOX_GID = None


class ExecResult:
    def __init__(self, status: str, returncode: int, stdout: str, stderr: str, time_ms: int):
        self.status = status  # ok | timeout | error
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr
        self.time_ms = time_ms


def _make_preexec(cpu_s: int, mem_mb: int | None, nproc: int):
    def preexec():
        os.setsid()
        resource.setrlimit(resource.RLIMIT_CPU, (cpu_s, cpu_s + 2))
        resource.setrlimit(resource.RLIMIT_FSIZE, (64 * 1024 * 1024, 64 * 1024 * 1024))
        resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))
        resource.setrlimit(resource.RLIMIT_NPROC, (nproc, nproc))
        if mem_mb:
            limit = mem_mb * 1024 * 1024
            resource.setrlimit(resource.RLIMIT_AS, (limit, limit))
        if SANDBOX_UID is not None and os.getuid() == 0:
            os.setgroups([])
            os.setgid(SANDBOX_GID)
            os.setuid(SANDBOX_UID)

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
            preexec_fn=_make_preexec(cpu_s, mem_mb, nproc),
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
