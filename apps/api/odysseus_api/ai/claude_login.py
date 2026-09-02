"""Claude 계정 로그인 중계 — `claude setup-token`을 PTY로 구동해 브라우저 OAuth를 관리자에게 넘긴다.

흐름 (실측: claude CLI 2.1.x):
  1. PTY에서 `claude setup-token` 실행 → OSC-8 하이퍼링크로 로그인 URL이 출력된다
     (평문 출력은 80컬럼 랩으로 조각나므로 OSC-8에서 무손상 추출; 윈도우 크기도
     넓게 잡아 토큰 랩핑을 방지한다).
  2. 관리자가 URL에서 로그인 → 승인 코드를 받아 붙여넣는다 → PTY stdin으로 전달.
  3. 성공 시 "authentication token created successfully" + `sk-ant-oat01-…`
     장수 토큰(1년)이 출력된다 → 추출해 반환. 서버에 이미 인증된 계정이 있으면
     코드 없이 즉시 성공하기도 한다(auto-success 경로).

세션은 스레드 리더 + 상태기계로 관리하고, TTL이 지나면 프로세스를 정리한다.
관리자 전용 표면이며, 토큰은 수동 붙여넣기와 동일한 신뢰 경계(HTTPS 응답 1회)로
전달되어 공급자 api_key로 저장된다.
"""

from __future__ import annotations

import fcntl
import os
import pty
import re
import select
import signal
import struct
import termios
import threading
import time
import uuid

__all__ = ["manager", "ClaudeLoginError"]

_URL_OSC8 = re.compile(rb"\x1b\]8;[^;]*;(https://[^\x1b\x07]+)")
_URL_PLAIN = re.compile(r"https://[a-zA-Z0-9./?=&_%\-:+]+")
_TOKEN = re.compile(r"sk-ant-oat[0-9]{2}-[A-Za-z0-9_\-]{40,}")
_SUCCESS = "token created successfully"

_ANSI = re.compile(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?<>=]*[a-zA-Z]|\x1b[=>()][0-9A-B]?")

SESSION_TTL_S = 600.0
MAX_SESSIONS = 3


def _clean(raw: bytes) -> str:
    text = raw.decode("utf-8", errors="replace")
    text = _ANSI.sub("", text)
    return text.replace("\r", "")


class ClaudeLoginError(Exception):
    def __init__(self, code: int, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


class _Session:
    def __init__(self, binary: str):
        self.id = uuid.uuid4().hex
        self.state = "starting"  # starting | awaiting_code | success | error
        self.url: str | None = None
        self.token: str | None = None
        self.error: str | None = None
        self.created_at = time.time()
        self._buf = b""
        self._lock = threading.Lock()
        self._code_sent = False

        pid, fd = pty.fork()
        if pid == 0:  # 자식 — PTY 위에서 CLI 실행
            os.environ["TERM"] = "xterm-256color"
            os.environ["DISABLE_AUTOUPDATER"] = "1"
            try:
                os.execvp(binary, [binary, "setup-token"])
            except OSError:
                os._exit(127)
        self.pid = pid
        self.fd = fd
        # 넓은 창 크기 — 토큰/URL이 80컬럼에서 줄바꿈으로 조각나지 않게
        try:
            fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 400, 0, 0))
        except OSError:
            pass
        self._thread = threading.Thread(target=self._read_loop, daemon=True)
        self._thread.start()

    # ── 리더 스레드 ──
    def _finalize(self) -> None:
        """프로세스 종료/EOF 공통 마무리 — 남은 출력 스캔 후 미완이면 error 확정."""
        with self._lock:
            self._scan_locked()
            if self.state not in ("success", "error"):
                self.state = "error"
                tail = _clean(self._buf)[-400:].strip()
                self.error = f"로그인 프로세스가 종료되었습니다: {tail or '출력 없음'}"

    def _read_loop(self) -> None:
        try:
            while True:
                r, _, _ = select.select([self.fd], [], [], 0.5)
                if self.fd in r:
                    try:
                        chunk = os.read(self.fd, 4096)
                    except OSError:
                        # PTY EOF(EIO) — 자식이 종료됨
                        self._finalize()
                        break
                    if not chunk:
                        self._finalize()
                        break
                    with self._lock:
                        self._buf += chunk
                        self._scan_locked()
                with self._lock:
                    if self.state in ("success", "error"):
                        break
                # 자식 종료 감지 (출력 드레인 후 처리)
                try:
                    done, _status = os.waitpid(self.pid, os.WNOHANG)
                except ChildProcessError:
                    done = self.pid
                if done:
                    self._drain()
                    self._finalize()
                    break
        finally:
            try:
                os.waitpid(self.pid, os.WNOHANG)
            except (ChildProcessError, OSError):
                pass
            try:
                os.close(self.fd)
            except OSError:
                pass

    def _drain(self) -> None:
        while True:
            r, _, _ = select.select([self.fd], [], [], 0.3)
            if self.fd not in r:
                return
            try:
                chunk = os.read(self.fd, 4096)
            except OSError:
                return
            if not chunk:
                return
            with self._lock:
                self._buf += chunk

    def _scan_locked(self) -> None:
        """버퍼에서 URL/코드 프롬프트/토큰을 찾는다 (락 보유 상태에서 호출)."""
        clean = _clean(self._buf)
        joined = clean.replace("\n", "")  # 랩핑 방어 (토큰이 줄바꿈으로 갈라진 경우)

        if self.token is None:
            m = _TOKEN.search(clean) or _TOKEN.search(joined)
            if m and _SUCCESS in joined.lower():
                self.token = m.group(0)
                self.state = "success"
                return

        if self.url is None:
            m8 = _URL_OSC8.search(self._buf)
            if m8:
                self.url = m8.group(1).decode("utf-8", errors="replace").strip()
            else:
                mp = _URL_PLAIN.search(joined)
                if mp and "oauth" in mp.group(0):
                    self.url = mp.group(0)
        # URL이 잡히면 코드 대기 상태로 (코드 프롬프트 문구는 출력이 늦을 수 있어 기다리지 않는다)
        if self.url and self.state == "starting":
            self.state = "awaiting_code"

    # ── 외부 표면 ──
    def submit_code(self, code: str) -> None:
        with self._lock:
            if self.state not in ("awaiting_code", "starting"):
                raise ClaudeLoginError(409, f"코드를 받을 수 있는 상태가 아닙니다 (현재: {self.state})")
            if self._code_sent:
                raise ClaudeLoginError(409, "코드가 이미 제출되었습니다")
            self._code_sent = True
        try:
            os.write(self.fd, (code.strip() + "\r").encode())
        except OSError as e:
            raise ClaudeLoginError(500, f"코드 전달 실패: {e}")

    def snapshot(self) -> dict:
        with self._lock:
            return {
                "session_id": self.id,
                "state": self.state,
                "url": self.url,
                "token": self.token if self.state == "success" else None,
                "error": self.error,
            }

    def kill(self) -> None:
        try:
            os.kill(self.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            os.waitpid(self.pid, os.WNOHANG)
        except ChildProcessError:
            pass


class _Manager:
    def __init__(self) -> None:
        self._sessions: dict[str, _Session] = {}
        self._lock = threading.Lock()

    def _resolve_binary(self, binary_override: str | None = None) -> str:
        import shutil

        if binary_override:
            return binary_override
        env = os.environ.get("CLAUDE_CODE_BINARY", "")
        if env and os.path.isfile(env):
            return env
        found = shutil.which("claude")
        if not found:
            raise ClaudeLoginError(
                503, "서버에 claude CLI가 설치되어 있지 않습니다 (api 이미지의 INSTALL_CLAUDE_CLI 확인)"
            )
        return found

    def _reap(self) -> None:
        now = time.time()
        for sid in list(self._sessions):
            s = self._sessions[sid]
            if now - s.created_at > SESSION_TTL_S or s.state in ("success", "error"):
                if now - s.created_at > SESSION_TTL_S:
                    s.kill()
                    self._sessions.pop(sid, None)

    def start(self, *, binary_override: str | None = None, wait_s: float = 15.0) -> dict:
        binary = self._resolve_binary(binary_override)
        with self._lock:
            self._reap()
            live = [s for s in self._sessions.values() if s.state in ("starting", "awaiting_code")]
            if len(live) >= MAX_SESSIONS:
                raise ClaudeLoginError(429, "진행 중인 로그인 세션이 너무 많습니다. 잠시 후 다시 시도하세요")
            session = _Session(binary)
            self._sessions[session.id] = session
        # URL(또는 즉시 성공)이 잡힐 때까지 잠깐 대기 — UX용, 못 잡아도 세션은 유효
        deadline = time.time() + wait_s
        while time.time() < deadline:
            snap = session.snapshot()
            if snap["state"] != "starting" and (snap["url"] or snap["state"] in ("success", "error")):
                return snap
            time.sleep(0.3)
        return session.snapshot()

    def get(self, session_id: str) -> _Session:
        s = self._sessions.get(session_id)
        if not s:
            raise ClaudeLoginError(404, "로그인 세션을 찾을 수 없습니다 (만료되었을 수 있습니다)")
        return s

    def status(self, session_id: str) -> dict:
        return self.get(session_id).snapshot()

    def submit_code(self, session_id: str, code: str, *, wait_s: float = 30.0) -> dict:
        s = self.get(session_id)
        s.submit_code(code)
        deadline = time.time() + wait_s
        while time.time() < deadline:
            snap = s.snapshot()
            if snap["state"] in ("success", "error"):
                return snap
            time.sleep(0.4)
        return s.snapshot()

    def cancel(self, session_id: str) -> None:
        with self._lock:
            s = self._sessions.pop(session_id, None)
        if s:
            s.kill()


manager = _Manager()
