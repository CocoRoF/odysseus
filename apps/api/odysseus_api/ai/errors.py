"""AI 호출 오류의 공개 표현 (ODY-022).

SDK 예외 문자열에는 base URL·호스트·경로·헤더·응답 조각이 섞인다. 응시자에게는 안정된 오류 코드와
일반 설명, 상관 ID 만 돌려주고, 상세는 서버 로그에 (민감값을 가린 채) 남긴다.

**공급자 탓으로 볼 수 있는 코드는 공급자 호출에서 난 예외에만 붙는다.** 코드가 곧 질문 환불
여부(ai_incidents)이기 때문이다. 에이전트 도구가 Redis 에 못 붙어 난 ``ConnectionError`` 를
"AI 공급자에 연결할 수 없습니다" 로 부르면, 안내가 거짓이 되고 횟수까지 돌려준다. 그래서 응시자의
턴을 처리하는 곳은 공급자 호출을 :class:`ProviderCallError` 로 감싸고, 분류는 그 껍질만 본다.
"""

from __future__ import annotations

import asyncio
import logging
import re
import secrets

log = logging.getLogger("odysseus.ai")

_REDACT = [
    (re.compile(r"(sk-[A-Za-z0-9_\-]{6})[A-Za-z0-9_\-]+"), r"\1…"),  # OpenAI 류 키
    (re.compile(r"(Bearer\s+)[^\s\"']+", re.I), r"\1…"),
    (re.compile(r"((?:api[_-]?key|token|secret|password|authorization)\s*[=:]\s*)[^\s,;&\"']+", re.I), r"\1…"),
    (re.compile(r"://[^/\s:@]+:[^/\s@]+@"), "://…:…@"),  # URL userinfo
    (re.compile(r"\?[^\s\"']*"), "?…"),  # 쿼리스트링
]

PUBLIC_MESSAGES = {
    #: 응시자가 [중단] 을 눌렀고 아무것도 나오기 전이었다. 오류가 아니라 의사 표시이므로 사과하지 않는다.
    "AI_CANCELLED": "요청을 중단했습니다",
    #: 새로고침·창 닫기·네트워크 끊김으로 응시자 쪽 연결이 사라졌다. AI 는 멀쩡했으므로 오류라고 하지 않는다.
    "AI_DISCONNECTED": "연결이 끊겨 답변을 받지 못했습니다",
    #: 응시자 쪽에서 끝났지만 답이 일부 왔거나 도구가 이미 돌기 시작했다. 받은 만큼은 남아 있다.
    "AI_INTERRUPTED": "답변이 끝나기 전에 멈췄습니다",
    "AI_TIMEOUT": "AI 응답이 제한 시간 안에 오지 않았습니다",
    "AI_RATE_LIMIT": "AI 공급자의 호출 한도에 걸렸습니다. 잠시 후 다시 시도하세요",
    #: 크레딧·구독 사용량이 바닥났다. 기다려도 풀리지 않을 수 있어 "잠시 후" 라고 하지 않는다.
    "AI_QUOTA": "AI 공급자의 사용 한도가 소진되었습니다. 관리자에게 문의하세요",
    "AI_AUTH": "AI 공급자 인증에 실패했습니다. 관리자에게 문의하세요",
    "AI_UNAVAILABLE": "AI 공급자에 연결할 수 없습니다. 관리자에게 문의하세요",
    "AI_BAD_RESPONSE": "AI 응답을 해석하지 못했습니다",
    "AI_BACKEND_ERROR": "AI 처리 중 오류가 났습니다",
}


class ProviderCallError(Exception):
    """공급자 호출에서 난 예외를 감싼다 — 원래 예외는 ``cause`` 에 있다.

    감싸는 곳은 모델에 요청을 보내고 답을 받는 자리뿐이다. 도구 실행·DB·큐에서 난 예외는 감싸지
    않으므로, :func:`classify` 가 ``provider_only`` 로 불리면 그것들은 공급자 코드를 받지 못한다.
    """

    def __init__(self, cause: BaseException):
        super().__init__(str(cause))
        self.cause = cause


#: 크레딧·구독 한도 소진을 알리는 문구 — 공급자마다 상태 코드가 달라(400·429·CLI 종료 코드) 문구로 본다.
#: npc/provider.complete_with_usage 가 사무실 호출에서 쓰는 목록과 같은 뜻이다.
_QUOTA_MARKERS = (
    "insufficient_quota",
    "credit balance",
    "quota exceeded",
    "usage limit",
    "weekly limit",
    "-hour limit",
    "hit your limit",
)

#: geny-executor 의 APIError.category → 공개 코드. 공급자 SDK 예외를 이미 한 번 분류한 결과라
#: 문자열 추측보다 먼저 믿는다. 여기 없는 분류(bad_request·token_limit·cli_protocol_error 등)는
#: 요청 자체나 실행기 쪽 문제일 수 있어 공급자 탓으로 보지 않는다.
_CATEGORY_CODES = {
    "timeout": "AI_TIMEOUT",
    "cli_timeout": "AI_TIMEOUT",
    "rate_limited": "AI_RATE_LIMIT",
    "auth": "AI_AUTH",
    "cli_auth_failed": "AI_AUTH",
    "network": "AI_UNAVAILABLE",
    "server_error": "AI_UNAVAILABLE",
    "cli_not_found": "AI_UNAVAILABLE",
}


def redact(text: str) -> str:
    for pat, rep in _REDACT:
        text = pat.sub(rep, text)
    return text


def _chain(e: BaseException) -> list[BaseException]:
    """예외와 그 원인들 — SDK 예외는 실행기의 APIError 안에 ``cause`` 로 들어 있다."""
    out: list[BaseException] = []
    cur: BaseException | None = e
    while cur is not None and cur not in out and len(out) < 5:
        out.append(cur)
        cur = getattr(cur, "cause", None) or cur.__cause__
    return out


def _classify_provider(e: BaseException) -> str:
    chain = _chain(e)
    text = " ".join(str(x) for x in chain).lower()
    if any(marker in text for marker in _QUOTA_MARKERS):
        return "AI_QUOTA"
    for x in chain:
        category = getattr(x, "category", None)
        value = str(getattr(category, "value", category) or "").lower()
        if value in _CATEGORY_CODES:
            return _CATEGORY_CODES[value]
        if value and value != "unknown":
            return "AI_BACKEND_ERROR"
    # 분류되지 않은 예외 — SDK 를 직접 부른 경로나 실행기가 UNKNOWN 으로 넘긴 경우의 마지막 추측
    for x in chain:
        name = type(x).__name__.lower()
        xtext = str(x).lower()
        status = getattr(x, "status_code", None) or getattr(getattr(x, "response", None), "status_code", None)
        if isinstance(x, (TimeoutError, asyncio.TimeoutError)) or "timeout" in name or "timed out" in xtext:
            return "AI_TIMEOUT"
        if status == 429 or "rate limit" in xtext or "ratelimit" in name:
            return "AI_RATE_LIMIT"
        if status in (401, 403) or "authentication" in name or "unauthorized" in xtext or "invalid api key" in xtext:
            return "AI_AUTH"
        if isinstance(x, ConnectionError) or "connect" in name or status in (502, 503, 504):
            return "AI_UNAVAILABLE"
    if any(isinstance(x, (ValueError, KeyError)) or "json" in type(x).__name__.lower() for x in chain):
        return "AI_BAD_RESPONSE"
    return "AI_BACKEND_ERROR"


def classify(e: BaseException, *, provider_only: bool = False) -> str:
    """오류 코드. ``provider_only`` 면 :class:`ProviderCallError` 가 아닌 예외는 전부 AI_BACKEND_ERROR.

    응시자의 턴(메신저·에이전트)은 ``provider_only`` 로 부른다 — 코드가 환불과 안내를 정한다.
    관리자 도구(시나리오 작성 등)는 호출 전체가 공급자 호출이라 감싸지 않은 예외도 그대로 분류한다.
    """
    if isinstance(e, ProviderCallError):
        return _classify_provider(e.cause)
    if provider_only:
        return "AI_BACKEND_ERROR"
    return _classify_provider(e)


def describe_error(e: BaseException, *, where: str = "ai", provider_only: bool = False) -> dict:
    """응시자에게 보여도 되는 {code, message, correlation_id} — 상세는 로그로."""
    code = classify(e, provider_only=provider_only)
    cid = secrets.token_hex(6)
    inner = e.cause if isinstance(e, ProviderCallError) else e
    log.error("%s error cid=%s code=%s type=%s detail=%s", where, cid, code, type(inner).__name__, redact(str(inner))[:1500])
    return {"code": code, "message": PUBLIC_MESSAGES[code], "correlation_id": cid}


def public_meta(meta: dict | None) -> dict:
    """저장된 메시지 meta 중 응시자에게 내보내도 되는 것만 — 도구 이름·정제된 오류 코드·환불 여부."""
    meta = meta or {}
    out: dict = {}
    steps = meta.get("steps")
    if isinstance(steps, list):
        out["steps"] = [
            {"tool": str(s.get("tool", ""))[:60], "detail": str(s.get("detail", ""))[:200]}
            for s in steps
            if isinstance(s, dict)
        ]
    if meta.get("error"):
        err = str(meta["error"])
        out["error"] = err if err in PUBLIC_MESSAGES else "AI_BACKEND_ERROR"
        out["error_message"] = PUBLIC_MESSAGES.get(out["error"], PUBLIC_MESSAGES["AI_BACKEND_ERROR"])
        # 환불은 기록할 때 한 번 정해진다 (ai_incidents.refund_decision) — 화면은 그 결정만 옮긴다.
        if meta.get("refunded") is True:
            out["refunded"] = True
    if meta.get("correlation_id"):
        out["correlation_id"] = str(meta["correlation_id"])[:32]
    return out
