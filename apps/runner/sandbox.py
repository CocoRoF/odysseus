"""제한된 서브프로세스 실행.

러너 컨테이너 하나를 모든 응시자가 공유하므로, 실행 한 건을 세 겹으로 가둔다:

  1. **네임스페이스** — PID/mount/IPC/UTS/**net** 을 분리한다. 새 PID 네임스페이스 안에
     `/proc` 을 다시 마운트하므로 `ps` 에 자기 프로세스만 보이고, `/tmp` 는
     실행 전용 tmpfs 라 다른 실행과 공유되지 않는다. 네트워크 네임스페이스에는
     루프백만 있다 — 러너가 붙어 있는 redis/api 에 응시자 코드는 닿을 수 없다 (ODY-003).
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
    'ip link set lo up 2>/dev/null; '
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
        "--pid", "--mount", "--ipc", "--uts", "--net",
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


class _PipeReader(threading.Thread):
    """파이프를 스트리밍으로 비우되 상한까지만 보존한다 (ODY-005).

    communicate() 는 프로세스가 끝날 때까지 모든 바이트를 메모리에 쌓는다. 여기서는
    `keep` 바이트까지만 남기고 나머지는 세기만 하고 버린다. 총량이 `hard_cap` 을 넘으면
    출력 폭주로 보고 `on_flood` 를 불러 프로세스를 끝낸다. select 로 0.5초씩 깨어나므로
    자손이 파이프를 물고 있어도 stop 신호로 빠져나온다.
    """

    def __init__(self, fd: int, keep: int, hard_cap: int, on_flood, stop: threading.Event):
        super().__init__(daemon=True)
        self.fd = fd
        self.keep = keep
        self.hard_cap = hard_cap
        self.on_flood = on_flood
        self.stop = stop
        self.chunks: list[bytes] = []
        self.kept = 0
        self.total = 0
        self.flooded = False

    def run(self) -> None:
        import select

        try:
            while not self.stop.is_set():
                r, _, _ = select.select([self.fd], [], [], 0.5)
                if not r:
                    continue
                try:
                    chunk = os.read(self.fd, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                self.total += len(chunk)
                if self.kept < self.keep:
                    take = chunk[: self.keep - self.kept]
                    self.chunks.append(take)
                    self.kept += len(take)
                if self.total > self.hard_cap and not self.flooded:
                    self.flooded = True
                    self.on_flood()
        finally:
            pass  # fd 는 Popen 의 파일 객체가 소유한다 — execute() 가 마지막에 닫는다

    def data(self) -> bytes:
        return b"".join(self.chunks)


# 보존 상한을 넘어 이만큼까지 쏟아내면 출력 폭주로 보고 실행을 끝낸다 (파이프 drain 비용 상한)
OUTPUT_HARD_CAP = 64 * 1024 * 1024


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

    # 출력은 스트리밍으로 비운다 — 메모리에는 상한까지만 남고, 폭주하면 즉시 끝낸다
    stop = threading.Event()
    flood = {"hit": False}

    def on_flood():
        flood["hit"] = True
        kill_tree(proc)

    # 파이프는 fd 로 직접 읽는다. 파일 객체는 fd 소유자로 남겨 두었다가 끝에 닫는다 (이중 close 방지)
    out_fd = proc.stdout.fileno()
    err_fd = proc.stderr.fileno()
    rd_out = _PipeReader(out_fd, OUTPUT_LIMIT, OUTPUT_HARD_CAP, on_flood, stop)
    rd_err = _PipeReader(err_fd, STDERR_LIMIT, OUTPUT_HARD_CAP, on_flood, stop)
    rd_out.start()
    rd_err.start()
    try:
        if stdin_data:
            proc.stdin.write(stdin_data.encode())
        proc.stdin.close()
    except (BrokenPipeError, OSError):
        pass

    status = "ok"
    try:
        proc.wait(timeout=wall_s)
        elapsed = int((time.monotonic() - start) * 1000)
    except subprocess.TimeoutExpired:
        kill_tree(proc)
        status = "timeout"
        elapsed = int(wall_s * 1000)
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
    # 파이프를 물고 있는 자손이 남아도 리더는 stop 으로 빠져나온다 — 슬롯을 잃지 않는다
    rd_out.join(timeout=3)
    rd_err.join(timeout=3)
    stop.set()
    rd_out.join(timeout=2)
    rd_err.join(timeout=2)
    for f in (proc.stdout, proc.stderr):
        try:
            f.close()
        except OSError:
            pass

    stdout = _decode(rd_out.data())
    stderr = _decode(rd_err.data(), STDERR_LIMIT)
    truncated = rd_out.total > rd_out.kept or rd_err.total > rd_err.kept
    if flood["hit"]:
        status = "error" if status == "ok" else status
        stderr = (stderr + f"\n[출력이 {OUTPUT_HARD_CAP // (1024 * 1024)}MB 를 넘어 실행을 중단했습니다]").strip()
    elif truncated:
        stderr = (stderr + f"\n[출력이 너무 길어 앞 {OUTPUT_LIMIT // (1024 * 1024)}MB 만 보존했습니다]").strip()

    if status == "timeout":
        return ExecResult("timeout", -1, stdout, stderr, elapsed)
    # SIGXCPU/SIGKILL로 죽었으면 CPU 시간 초과로 간주 (폭주로 우리가 죽인 경우는 error)
    if flood["hit"]:
        return ExecResult("error", proc.returncode, stdout, stderr, elapsed)
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
