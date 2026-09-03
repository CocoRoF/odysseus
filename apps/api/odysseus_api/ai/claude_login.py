"""Claude 계정 로그인 중계 — `claude setup-token` 을 PTY 로 구동해 브라우저 OAuth 를 관리자에게 넘긴다.

이 구현은 사내 xgen-workflow 의 검증된 로그인 서비스
(`service/claude_code/claude_code_service.py`)의 규약을 그대로 따른다. 아래는
그쪽이 실측으로 잡아 둔 함정들이며, 하나라도 어기면 조용히 실패한다:

  1. **코드와 Enter 를 한 번에 쓰면 안 된다.** 긴 코드(100자+)를 `코드+\\r` 로
     한 번에 write 하면 ink 입력이 paste 로 처리해 Enter 를 놓치고, setup-token 이
     제출 자체를 못 받는다(짧은 코드는 우연히 된다). 코드를 전량 쓰고 **잠깐 뒤
     Enter 를 별도 write** 해야 확실히 제출된다.
  2. **URL/토큰은 줄 단위로 추출한다.** 누적 버퍼 전체에서 공백을 지우고 스캔하면
     뒤따르는 프롬프트("Pastecodehereifprompted>")가 URL 의 state 에 병합되고,
     토큰도 뒤 텍스트까지 과다 캡처돼 401 이 난다.
  3. **ink 박스/장식 문자를 지운다.** 테두리(│ ─ 등)가 값에 섞인다.
  4. PTY 를 아주 넓게(1000 컬럼) 잡아 URL·토큰이 줄바꿈되지 않게 한다.
  5. 캡처한 토큰은 **실제로 인증되는지 검증**한 뒤 넘긴다(과다/부족 캡처 방어).
  6. 코드가 틀리면 CLI 는 "Press Enter to retry" 로 무한 대기한다 — 오류 문구를
     감지해 끊지 않으면 화면이 영영 '확인 중'에 머문다.
  7. 코드 제출 후 정체되면 egress 를 능동 확인해 원인을 확정한다.

관리자 전용 표면이며, 토큰은 수동 붙여넣기와 동일한 신뢰 경계(HTTPS 응답 1회)로
전달되어 공급자 api_key 로 저장된다.
"""

from __future__ import annotations

import fcntl
import json
import os
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import tempfile
import termios
import threading
import time
import uuid

__all__ = ["manager", "ClaudeLoginError"]

# ── 추출 규약 (xgen-workflow claude_code_service 준용) ──────────────────
_ANSI = re.compile(
    r"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-B0-9]|[\x00-\x08\x0b\x0c\x0e-\x1f]"
)
_TOKEN = re.compile(r"sk-ant-oat[0-9]+-[A-Za-z0-9_\-]{20,}")
# <>` 도 배제 — URL 뒤 프롬프트가 state 파라미터에 병합되지 않게
_URL = re.compile(r"https?://[^\s\"'\)\]<>`]+")
# ink 박스/장식 문자와 공백 — 한 줄 안에서만 지운다
_DECOR = {ord(c): None for c in "│┃|─━┄┅┈┉╌╍┌┐└┘├┤┬┴┼╭╮╯╰▏▕║╔╗╚╝ \t"}

_INVALID_CODE_MARKERS = ("oautherror", "invalidcode", "fullcodewascopied", "authenticationfailed")
_NETWORK_MARKERS = (
    "enotfound", "econnrefused", "etimedout", "econnreset", "timedout",
    "networkerror", "connectionrefused", "connectionreset", "unabletoconnect",
    "couldnotconnect", "couldnotreach", "failedtofetch", "requestfailed",
    "fetchfailed", "getaddrinfo", "socketerror",
)

SESSION_TTL_S = 600.0
MAX_SESSIONS = 3
# 코드 전량 write 후 Enter 까지의 지연 — 함정 1 참조 (xgen 실측 0.4s)
ENTER_DELAY_S = 0.4
# 코드 제출 후 성공/실패까지 허용 시간. 정상 교환은 수 초.
CODE_STALL_TIMEOUT_S = 60.0
EGRESS_PROBE_URL = "https://platform.claude.com/oauth/code/success"


def _clean(raw: bytes) -> str:
    text = raw.decode("utf-8", errors="replace")
    return _ANSI.sub("", text.replace("\r\n", "\n").replace("\r", "\n"))


def _find_url(accum: str) -> str | None:
    """authorize URL 을 줄 단위로 추출 (함정 2·3)."""
    for line in accum.splitlines():
        for url in _URL.findall(line.translate(_DECOR)):
            if "oauth" in url:
                return url
    return None


def _find_token(accum: str) -> str | None:
    """토큰을 줄 단위로 정확히 잘라낸다 (함정 2·3)."""
    for line in accum.splitlines():
        m = _TOKEN.search(line.translate(_DECOR))
        if m:
            return m.group(0)
    return None


def _flat(accum: str) -> str:
    """문구 판정용 — 실제 CLI 는 커서 이동으로 그려 공백이 흩어진다."""
    return accum.replace("\n", "").replace(" ", "").lower()


def _probe_egress(timeout: float = 6.0) -> tuple[bool, str]:
    """인증 서버 아웃바운드 도달성 — HTTP 응답이 오면 도달 가능."""
    import urllib.error
    import urllib.request

    try:
        urllib.request.urlopen(EGRESS_PROBE_URL, timeout=timeout)
        return True, ""
    except urllib.error.HTTPError as e:
        return True, f"HTTP {e.code}"  # 응답이 온 것이므로 도달 가능
    except Exception as e:  # noqa: BLE001
        return False, f"{type(e).__name__}: {str(e)[:120]}"


def _validate_token(token: str, binary: str | None = None) -> bool:
    """캡처한 토큰이 실제로 인증되는지 확인 (함정 5).

    과다/부족 캡처된 토큰은 401 이 나므로 넘기기 전에 걸러낸다. 임시 HOME 을 써
    서버의 다른 자격증명 영향을 배제한다.
    """
    binary = binary or shutil.which("claude")
    if not binary:
        return True  # 검증할 수단이 없으면 통과 (저장 후 [연결 테스트]로 확인)
    home = tempfile.mkdtemp(prefix="cc-validate-")
    env = {k: v for k in ("PATH", "USER", "LANG", "TERM", "TZ") if (v := os.environ.get(k))}
    env.update(HOME=home, CLAUDE_CODE_OAUTH_TOKEN=token, DISABLE_AUTOUPDATER="1")
    try:
        r = subprocess.run(
            [binary, "--print", "--output-format", "json", "ping"],
            env=env, capture_output=True, text=True, timeout=45,
        )
    except (OSError, subprocess.SubprocessError):
        return True  # 검증 자체가 실패하면 막지 않는다
    finally:
        shutil.rmtree(home, ignore_errors=True)
    try:
        envelope = json.loads((r.stdout or "").strip().splitlines()[-1])
    except (ValueError, IndexError):
        envelope = {}
    return r.returncode == 0 and not envelope.get("is_error")


class ClaudeLoginError(Exception):
    def __init__(self, code: int, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


class _Session:
    def __init__(self, binary: str):
        self.id = uuid.uuid4().hex
        self.binary = binary  # 토큰 검증도 같은 바이너리로 한다
        self.state = "starting"  # starting | awaiting_code | verifying | success | error
        self.url: str | None = None
        self.token: str | None = None
        self.error: str | None = None
        self.diagnostic: str | None = None
        self.created_at = time.time()
        self._buf = b""
        self._accum = ""
        self._lock = threading.Lock()
        self._code_sent = False
        self._code_sent_at: float | None = None
        self._settled = False  # 성공/오류를 이미 확정했다

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
        # 아주 넓은 창 — URL/토큰이 줄바꿈으로 갈라지지 않게 (함정 4)
        try:
            fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 100, 1000, 0, 0))
        except OSError:
            pass
        self._thread = threading.Thread(target=self._read_loop, daemon=True)
        self._thread.start()

    # ── 리더 스레드 ──
    def _read_loop(self) -> None:
        try:
            while True:
                r, _, _ = select.select([self.fd], [], [], 0.5)
                if self.fd in r:
                    try:
                        chunk = os.read(self.fd, 4096)
                    except OSError:
                        break
                    if not chunk:
                        break
                    with self._lock:
                        self._buf += chunk
                        self._accum = (self._accum + _clean(chunk))[-32768:]
                        self._scan_locked()
                with self._lock:
                    if self.state in ("success", "error"):
                        break
                    self._check_stall_locked()
                try:
                    done, _status = os.waitpid(self.pid, os.WNOHANG)
                except ChildProcessError:
                    done = self.pid
                if done:
                    self._drain()
                    break
        finally:
            self._finalize()
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
                self._accum = (self._accum + _clean(chunk))[-32768:]
                self._scan_locked()

    def _finalize(self) -> None:
        """프로세스 종료 — 남은 출력을 훑고, 미결이면 실제 출력을 남겨 원인을 알린다."""
        with self._lock:
            self._scan_locked()
            # 이미 결론이 났거나(_settled) 토큰 검증이 도는 중이면 건드리지 않는다 —
            # CLI 는 토큰을 뱉자마자 종료하므로, 여기서 덮으면 검증 결과가 유실된다.
            if self.state in ("success", "error") or self._settled:
                return
            self.state = "error"
            self.diagnostic = self._masked_tail_locked()
            self.error = self.error or (
                "토큰을 발급받지 못한 채 로그인 프로세스가 끝났습니다. "
                "아래 출력을 확인하고 다시 시도해 주세요."
            )

    def _masked_tail_locked(self) -> str:
        tail = _TOKEN.sub(lambda m: m.group(0)[:14] + "•••", self._accum)[-1500:]
        return "\n".join(ln for ln in tail.splitlines() if ln.strip())[-1200:]

    def _scan_locked(self) -> None:
        """누적 출력에서 URL / 토큰 / 오류를 찾는다 (락 보유 상태)."""
        if self.url is None:
            # OSC-8 하이퍼링크가 있으면 무손상이라 우선한다
            m8 = re.search(rb"\x1b\]8;[^;]*;(https://[^\x1b\x07]+)", self._buf)
            if m8:
                self.url = m8.group(1).decode("utf-8", errors="replace").strip()
            else:
                self.url = _find_url(self._accum)
            if self.url and self.state == "starting":
                self.state = "awaiting_code"

        if self._settled:
            return

        token = _find_token(self._accum)
        if token:
            self._settled = True
            self._pending_token = token
            self.state = "verifying"
            threading.Thread(target=self._verify_and_finish, args=(token,), daemon=True).start()
            return

        flat = _flat(self._accum)
        if any(m in flat for m in _INVALID_CODE_MARKERS):
            self._settled = True
            self.state = "error"
            self.error = "인증 코드가 올바르지 않거나 만료되었습니다. 다시 로그인해 주세요."
            self._terminate()
        elif any(m in flat for m in _NETWORK_MARKERS):
            self._settled = True
            self.state = "error"
            self.diagnostic = self._masked_tail_locked()
            self.error = (
                "인증 서버(platform.claude.com)에 연결하지 못했습니다. "
                "서버의 아웃바운드 네트워크를 확인해 주세요."
            )
            self._terminate()

    def _check_stall_locked(self) -> None:
        """코드 제출 후 정체 — egress 를 확인해 원인을 확정한다 (함정 7)."""
        if self._settled or not self._code_sent or self._code_sent_at is None:
            return
        if time.time() - self._code_sent_at < CODE_STALL_TIMEOUT_S:
            return
        self._settled = True
        self.state = "error"
        self.diagnostic = self._masked_tail_locked()
        reachable, detail = _probe_egress()
        if reachable:
            self.error = (
                f"인증 코드 확인이 {int(CODE_STALL_TIMEOUT_S)}초 안에 끝나지 않았습니다. "
                "인증 서버 연결은 정상이니 코드를 전체로 다시 복사해 시도해 주세요."
            )
        else:
            self.error = (
                "인증 서버(platform.claude.com)에 연결할 수 없습니다 — 서버의 아웃바운드 "
                f"네트워크가 막혀 있습니다. ({detail}) API 키 방식으로 대신 등록할 수 있습니다."
            )
        self._terminate()

    def _verify_and_finish(self, token: str) -> None:
        """토큰이 실제로 인증되는지 확인한 뒤 성공을 확정한다 (함정 5)."""
        ok = _validate_token(token, self.binary)
        with self._lock:
            if ok:
                self.token = token
                self.state = "success"
            else:
                self.state = "error"
                self.diagnostic = self._masked_tail_locked()
                self.error = "발급된 토큰이 인증에 실패했습니다(캡처 오류 가능). 다시 시도해 주세요."
        self._terminate()

    def _terminate(self) -> None:
        try:
            os.kill(self.pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError, OSError):
            pass

    # ── 외부 표면 ──
    def submit_code(self, code: str) -> None:
        """인증 코드를 PTY 로 전달한다.

        코드를 **전량 쓰고, 잠깐 뒤 Enter 를 따로** 보낸다 — 한 번에 쓰면 ink 가
        paste 로 처리해 Enter 를 놓치고 제출이 되지 않는다 (함정 1).
        """
        with self._lock:
            if self.state not in ("awaiting_code", "starting"):
                raise ClaudeLoginError(409, f"코드를 받을 수 있는 상태가 아닙니다 (현재: {self.state})")
            if self._code_sent:
                raise ClaudeLoginError(409, "코드가 이미 제출되었습니다")
            self._code_sent = True
            self._code_sent_at = time.time()
            self.error = None

        data = code.strip().encode()
        try:
            written = 0
            while written < len(data):
                written += os.write(self.fd, data[written:])
        except OSError as e:
            raise ClaudeLoginError(500, f"코드 전달 실패: {e}")

        def send_enter() -> None:
            try:
                os.write(self.fd, b"\r")
            except OSError:
                pass

        threading.Timer(ENTER_DELAY_S, send_enter).start()

    def snapshot(self) -> dict:
        with self._lock:
            return {
                "session_id": self.id,
                "state": self.state,
                "url": self.url,
                "token": self.token if self.state == "success" else None,
                "error": self.error,
                "diagnostic": self.diagnostic,
            }

    def kill(self) -> None:
        try:
            os.kill(self.pid, signal.SIGKILL)
        except (ProcessLookupError, OSError):
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

    def submit_code(self, session_id: str, code: str, *, wait_s: float = 90.0) -> dict:
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
