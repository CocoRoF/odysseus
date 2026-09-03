"""제한된 서브프로세스 실행.

러너 컨테이너 하나를 모든 응시자가 공유하므로, 실행 한 건을 세 겹으로 가둔다:

  1. **네임스페이스** — PID/mount/IPC/UTS 를 분리한다. 새 PID 네임스페이스 안에
     `/proc` 을 다시 마운트하므로 `ps` 에 자기 프로세스만 보이고, `/tmp` 는
     실행 전용 tmpfs 라 다른 실행과 공유되지 않는다.
  2. **UID** — 실행마다 다른 UID 로 강등한다. 작업 폴더가 0700 이므로 UID 가
     다르면 커널이 그 경로를 막아 준다.
  3. **rlimit** — CPU/프로세스 수/파일 크기/가상 메모리 상한.
"""

import itertools
import os
import resource
import shutil
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


# 새 네임스페이스 안에서 할 일: 개인 /tmp 를 깔고, 비특권 UID 로 내려가 명령을 실행.
# 사용자 명령은 인자($3)로 넘어오므로 셸 이스케이프가 끼어들 여지가 없다.
_BOOTSTRAP = (
    'mount -t tmpfs -o size=256m,mode=1777,nosuid,nodev tmpfs /tmp 2>/dev/null; '
    'exec setpriv --reuid="$1" --regid="$2" --clear-groups --no-new-privs '
    '/bin/bash -c "$3"'
)


def isolation_available() -> bool:
    """네임스페이스 분리를 쓸 수 있는가 (root + unshare/setpriv 존재)."""
    if os.getuid() != 0:
        return False
    return all(shutil.which(b) for b in ("unshare", "setpriv"))


def wrap_isolated(command: str, uid: int, gid: int) -> list[str]:
    return [
        "unshare",
        "--pid", "--mount", "--ipc", "--uts",
        "--fork", "--mount-proc", "--kill-child",
        "/bin/bash", "-c", _BOOTSTRAP, "odysseus-sandbox", str(uid), str(gid), command,
    ]


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


def _make_preexec(cpu_s: int, nproc: int, uid: int | None, gid: int | None):
    def preexec():
        os.setsid()
        # 만드는 파일은 소유자 전용. /tmp 처럼 컨테이너가 공유하는 경로에 무언가를
        # 남기더라도 UID 가 다른 다른 응시자가 읽지 못한다.
        os.umask(0o077)
        resource.setrlimit(resource.RLIMIT_CPU, (cpu_s, cpu_s + 2))
        resource.setrlimit(resource.RLIMIT_FSIZE, (64 * 1024 * 1024, 64 * 1024 * 1024))
        resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))
        resource.setrlimit(resource.RLIMIT_NPROC, (nproc, nproc))
        # RLIMIT_AS(가상 메모리)는 쓰지 않는다 — Go 런타임과 JVM 은 시작할 때
        # 거대한 주소 공간을 **예약**만 하므로, 실제 사용량과 무관하게 죽는다.
        # 메모리 폭주는 컨테이너 단위 상한(compose mem_limit)과 실행 시간으로 막는다.
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
    nproc: int = 256,
    env: dict | None = None,
    uid: int | None = None,
    gid: int | None = None,
    on_start=None,
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
            preexec_fn=_make_preexec(cpu_s, nproc, uid, gid),
        )
    except OSError as e:
        return ExecResult("error", -1, "", f"spawn failed: {e}", 0)

    if on_start:
        on_start(proc)  # 샘플러가 이 트리의 자원을 재고, 종료 요청을 집행한다

    try:
        out, err = proc.communicate(stdin_data.encode(), timeout=wall_s)
        elapsed = int((time.monotonic() - start) * 1000)
    except subprocess.TimeoutExpired:
        kill_tree(proc)
        # 파이프를 물고 있는 자손이 남으면 communicate 가 영영 돌아오지 않는다 —
        # 슬롯을 잃지 않도록 회수 자체에도 상한을 둔다.
        out = err = b""
        for _ in range(2):
            try:
                out, err = proc.communicate(timeout=5)
                break
            except subprocess.TimeoutExpired:
                proc.kill()
        return ExecResult("timeout", -1, _decode(out), _decode(err, STDERR_LIMIT), int(wall_s * 1000))

    stdout = _decode(out)
    stderr = _decode(err, STDERR_LIMIT)

    # SIGXCPU/SIGKILL로 죽었으면 CPU 시간 초과로 간주
    if proc.returncode in (-signal.SIGXCPU, -signal.SIGKILL):
        return ExecResult("timeout", proc.returncode, stdout, stderr, elapsed)
    return ExecResult("ok", proc.returncode, stdout, stderr, elapsed)


def kill_tree(proc: subprocess.Popen) -> None:
    """실행을 확실히 끝낸다 — 프로세스 그룹과 자손 트리를 모두 친다.

    그룹만으로는 부족하다: `unshare --fork` 가 만든 자식은 새 PID 네임스페이스의
    init 이고, 부모가 SIGKILL 로 즉사하면 --kill-child 를 돌릴 틈이 없다.
    """
    from resources import descendants

    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError, OSError):
        pass
    for pid in descendants(proc.pid):
        try:
            os.kill(pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError, OSError):
            pass
    try:
        proc.kill()
    except (ProcessLookupError, OSError):
        pass


def _decode(data: bytes, limit: int = OUTPUT_LIMIT) -> str:
    if data is None:
        return ""
    if len(data) > limit:
        data = data[:limit]
    # NUL 은 걸러야 한다 — Postgres 의 text 는 저장하지 못해서, 바이너리를 출력한
    # 명령(`cat /bin/ls`, `cat /proc/*/environ`)의 결과 보고가 통째로 실패한다.
    return data.decode(errors="replace").replace("\x00", "")
