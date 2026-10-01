"""Transparent encryption-at-rest for database secrets.

The application continues to work with plaintext Python values, while SQLAlchemy bind/result
processors store AES-256-GCM envelopes in PostgreSQL. Legacy plaintext rows remain readable and are
rewritten through the encrypted types once at startup.

DATA_ENCRYPTION_KEY is intentionally separate from JWT_SECRET/INTERNAL_TOKEN. Backups require the
same key; losing it makes encrypted provider credentials unrecoverable.
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
from typing import Any

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import attributes
from sqlalchemy.types import Text, TypeDecorator

PREFIX = "enc:v1:"
JSON_ENVELOPE = "__odysseus_encrypted_v1__"
AAD = b"odysseus-db-secret-v1"
_installed = False

log = logging.getLogger("odysseus.secrets")
#: 키가 맞지 않아 읽지 못한 값을 봤다고 한 번만 크게 알린다 (행마다 로그를 도배하지 않는다).
_warned_unreadable = False


def _master_key() -> bytes | None:
    from .config import settings

    raw = (settings.data_encryption_key or "").encode("utf-8")
    return hashlib.sha256(raw).digest() if raw else None


def is_encrypted(value: str | None) -> bool:
    return bool(value and value.startswith(PREFIX))


def encrypt_secret(value: str | None) -> str:
    text = value or ""
    if not text or is_encrypted(text):
        return text
    key = _master_key()
    if key is None:
        # Development can intentionally run without a persistence key; production startup forbids it.
        return text
    nonce = os.urandom(12)
    ciphertext = AESGCM(key).encrypt(nonce, text.encode("utf-8"), AAD)
    payload = base64.urlsafe_b64encode(nonce + ciphertext).decode("ascii")
    return PREFIX + payload


def decrypt_secret(value: str | None, *, soft: bool = False) -> str:
    """봉투를 연다. soft 면 열지 못한 값을 예외 대신 빈 값으로 돌려준다.

    비밀값을 '읽지 못하는 것'과 '틀린 값을 쓰는 것'은 다르다. 후자는 절대 하지 않는다(빈 값이므로
    미설정과 같이 취급되어 '설정되지 않았습니다' 로 이어진다). 다만 전자 때문에 관리 화면 전체가
    500 이 되면 키를 다시 넣어 되살릴 통로까지 막힌다 — 조회 경로는 soft 로 읽는다.
    """
    global _warned_unreadable
    text = value or ""
    if not is_encrypted(text):
        return text  # legacy plaintext / development compatibility
    key = _master_key()
    if key is None:
        if soft:
            if not _warned_unreadable:
                _warned_unreadable = True
                log.error(
                    "DATA_ENCRYPTION_KEY 가 없어 저장된 비밀값(AI 공급자 키·관리자 설정)을 읽지 못합니다. "
                    "미설정으로 취급합니다 — 키를 복구하거나 관리 콘솔에서 다시 입력하세요."
                )
            return ""
        raise RuntimeError("DATA_ENCRYPTION_KEY가 없어 저장된 비밀값을 복호화할 수 없습니다")
    try:
        raw = base64.urlsafe_b64decode(text[len(PREFIX) :].encode("ascii"))
        nonce, ciphertext = raw[:12], raw[12:]
        return AESGCM(key).decrypt(nonce, ciphertext, AAD).decode("utf-8")
    except Exception as exc:  # noqa: BLE001 — key mismatch/corruption must fail closed
        if soft:
            if not _warned_unreadable:
                _warned_unreadable = True
                log.error(
                    "저장된 비밀값을 현재 DATA_ENCRYPTION_KEY 로 열 수 없습니다(키가 다르거나 손상). "
                    "미설정으로 취급합니다 — 올바른 키를 복원하거나 관리 콘솔에서 값을 다시 입력하세요."
                )
            return ""
        raise RuntimeError("저장된 비밀값을 복호화할 수 없습니다. DATA_ENCRYPTION_KEY를 확인하세요") from exc


class EncryptedText(TypeDecorator):
    impl = Text
    cache_ok = True

    def process_bind_param(self, value: Any, dialect) -> str:
        return encrypt_secret(str(value or ""))

    def process_result_value(self, value: Any, dialect) -> str:
        # 조회는 soft — 열지 못한 키는 '미설정'이 되고, 관리 화면은 살아 있어 다시 넣을 수 있다.
        return decrypt_secret(str(value or ""), soft=True)


class EncryptedJSON(TypeDecorator):
    """Store a JSON value as a single encrypted envelope inside the existing JSONB column."""

    impl = JSONB
    cache_ok = True

    def process_bind_param(self, value: Any, dialect) -> Any:
        if value is None:
            return None
        # Already-enveloped values can appear in low-level migrations; do not double encrypt.
        if isinstance(value, dict) and set(value) == {JSON_ENVELOPE}:
            return value
        encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=str)
        encrypted = encrypt_secret(encoded)
        if is_encrypted(encrypted):
            return {JSON_ENVELOPE: encrypted}
        return value

    def process_result_value(self, value: Any, dialect) -> Any:
        if isinstance(value, dict) and set(value) == {JSON_ENVELOPE}:
            decoded = decrypt_secret(str(value[JSON_ENVELOPE]), soft=True)
            if not decoded:
                # 소비처는 모두 기본값과 병합한다 — 설정 한 줄 때문에 화면이 죽지 않는다.
                return {}
            return json.loads(decoded)
        return value  # legacy plaintext JSON / development compatibility


def install_encrypted_types() -> None:
    """Install transparent types before application queries begin."""
    global _installed
    if _installed:
        return
    from .models import AiProvider, AppSetting

    AiProvider.__table__.c.api_key.type = EncryptedText()
    AiProvider.__table__.c.default_headers.type = EncryptedJSON()
    # App settings can contain GitHub/search credentials and legacy AI keys. Encrypt the whole JSON.
    AppSetting.__table__.c.value.type = EncryptedJSON()
    _installed = True


def _is_json_envelope(value: Any) -> bool:
    return isinstance(value, dict) and set(value) == {JSON_ENVELOPE}


async def migrate_encrypted_storage(db: AsyncSession) -> int:
    """Rewrite rows that are still plaintext through the encrypted types. Idempotent.

    ORM 으로 읽으면 이미 복호화된 값만 보여 '아직 평문인가' 를 알 수 없다. 원문 컬럼을 text 로 직접 읽어
    봉투가 아닌 행만 골라 재저장한다 — 매 기동마다 전 행을 새 nonce 로 다시 쓰거나 updated_at 을 건드리지 않는다.
    """
    if _master_key() is None:
        return 0
    from sqlalchemy import text as sql_text
    from .models import AiProvider, AppSetting

    providers: dict[Any, list[str]] = {}
    rows = (await db.execute(sql_text("SELECT id, api_key, default_headers::text FROM ai_providers"))).all()
    for pid, api_key, headers in rows:
        fields: list[str] = []
        if api_key and not is_encrypted(api_key):
            fields.append("api_key")
        if headers:
            try:
                parsed = json.loads(headers)
            except ValueError:
                parsed = None
            if parsed and not _is_json_envelope(parsed):
                fields.append("default_headers")
        if fields:
            providers[pid] = fields
    settings_keys: list[str] = []
    rows = (await db.execute(sql_text("SELECT key, value::text FROM app_settings"))).all()
    for key, raw in rows:
        if raw is None:
            continue
        try:
            parsed = json.loads(raw)
        except ValueError:
            parsed = None
        if parsed is None or _is_json_envelope(parsed):
            continue
        settings_keys.append(key)

    changed = 0
    for pid, fields in providers.items():
        row = await db.get(AiProvider, pid)
        if row is None:
            continue
        for field in fields:
            attributes.flag_modified(row, field)
            changed += 1
    for key in settings_keys:
        row = await db.get(AppSetting, key)
        if row is None:
            continue
        attributes.flag_modified(row, "value")
        changed += 1
    if changed:
        await db.commit()
        print(f"[secrets] {changed}개 평문 비밀값을 암호화 봉투로 재저장했습니다", flush=True)
    return changed


async def report_unreadable_secrets(db: AsyncSession) -> int:
    """현재 키로 열리지 않는 비밀값 수를 세어 기동 로그에 남긴다 (읽기 전용)."""
    from sqlalchemy import text as sql_text

    if _master_key() is None:
        return 0
    unreadable = 0
    rows = (await db.execute(sql_text("SELECT api_key FROM ai_providers"))).all()
    for (api_key,) in rows:
        if api_key and is_encrypted(api_key):
            try:
                decrypt_secret(api_key)
            except RuntimeError:
                unreadable += 1
    rows = (await db.execute(sql_text("SELECT value::text FROM app_settings"))).all()
    for (raw,) in rows:
        if not raw:
            continue
        try:
            parsed = json.loads(raw)
        except ValueError:
            continue
        if isinstance(parsed, dict) and set(parsed) == {JSON_ENVELOPE}:
            try:
                decrypt_secret(str(parsed[JSON_ENVELOPE]))
            except RuntimeError:
                unreadable += 1
    if unreadable:
        log.error(
            "저장된 비밀값 %d건을 현재 DATA_ENCRYPTION_KEY 로 열지 못했습니다. 응시 기록·시나리오 등 시험 데이터는 "
            "암호화 대상이 아니라 그대로입니다. 올바른 키를 복원하거나 관리 콘솔에서 해당 값을 다시 입력하세요.",
            unreadable,
        )
    return unreadable
