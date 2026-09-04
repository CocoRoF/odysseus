"""AI 호출 오류의 공개 표현 (ODY-022).

SDK 예외 문자열에는 base URL·호스트·경로·헤더·응답 조각이 섞인다. 응시자에게는 안정된 오류 코드와
일반 설명, 상관 ID 만 돌려주고, 상세는 서버 로그에 (민감값을 가린 채) 남긴다.
"""

from __future__ import annotations

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
    "AI_TIMEOUT": "AI 응답이 제한 시간 안에 오지 않았습니다",
    "AI_RATE_LIMIT": "AI 공급자의 호출 한도에 걸렸습니다. 잠시 후 다시 시도하세요",
    "AI_AUTH": "AI 공급자 인증에 실패했습니다. 관리자에게 문의하세요",
    "AI_UNAVAILABLE": "AI 공급자에 연결할 수 없습니다. 관리자에게 문의하세요",
    "AI_BAD_RESPONSE": "AI 응답을 해석하지 못했습니다",
    "AI_BACKEND_ERROR": "AI 처리 중 오류가 났습니다",
}


def redact(text: str) -> str:
    for pat, rep in _REDACT:
        text = pat.sub(rep, text)
    return text


def classify(e: BaseException) -> str:
    name = type(e).__name__.lower()
    text = str(e).lower()
    status = getattr(e, "status_code", None) or getattr(getattr(e, "response", None), "status_code", None)
    if "timeout" in name or "timed out" in text:
        return "AI_TIMEOUT"
    if status == 429 or "rate limit" in text or "ratelimit" in name:
        return "AI_RATE_LIMIT"
    if status in (401, 403) or "authentication" in name or "unauthorized" in text or "invalid api key" in text:
        return "AI_AUTH"
    if "connect" in name or "connection" in text or status in (502, 503, 504):
        return "AI_UNAVAILABLE"
    if isinstance(e, (ValueError, KeyError)) or "json" in name or "parse" in text:
        return "AI_BAD_RESPONSE"
    return "AI_BACKEND_ERROR"


def describe_error(e: BaseException, *, where: str = "ai") -> dict:
    """응시자에게 보여도 되는 {code, message, correlation_id} — 상세는 로그로."""
    code = classify(e)
    cid = secrets.token_hex(6)
    log.error("%s error cid=%s code=%s type=%s detail=%s", where, cid, code, type(e).__name__, redact(str(e))[:1500])
    return {"code": code, "message": PUBLIC_MESSAGES[code], "correlation_id": cid}


def public_meta(meta: dict | None) -> dict:
    """저장된 메시지 meta 중 응시자에게 내보내도 되는 것만 — 도구 이름·정제된 오류 코드."""
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
    if meta.get("correlation_id"):
        out["correlation_id"] = str(meta["correlation_id"])[:32]
    return out
