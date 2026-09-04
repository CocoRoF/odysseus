from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str = "postgresql+asyncpg://odysseus:odysseus@localhost:5432/odysseus"
    redis_url: str = "redis://localhost:6379/0"

    # 시크릿에는 기본값이 없다 — 운영 모드에서는 충분히 긴 무작위 값이 없으면 기동을 거부한다
    jwt_secret: str = ""
    jwt_expire_hours: int = 12  # 절대 만료
    session_idle_hours: int = 4  # 이 시간 동안 요청이 없으면 세션 만료 (ODY-023)
    internal_token: str = ""
    # MCP 브리지가 되돌아 호출하는 주소 (api 컨테이너 내부)
    internal_api_base: str = "http://127.0.0.1:8000"

    # 운영 모드가 기본. development 에서만 데모 시드(고정 비밀번호)가 허용된다.
    odysseus_env: str = "production"  # production | development
    seed_demo_data: bool = False
    # 빈 DB 최초 기동 시 만들 관리자 — 비밀번호를 비우면 무작위로 만들어 로그에 한 번 출력한다
    bootstrap_admin_email: str = ""
    bootstrap_admin_password: str = ""
    # 세션 쿠키 Secure 와 "프록시를 거친 변경 요청은 HTTPS 여야 한다" 규칙 (ODY-014).
    # None 이면 운영 모드에서 켜지고 개발 모드에서 꺼진다.
    cookie_secure: bool | None = None
    https_only: bool | None = None

    # DB에 공급자가 없을 때의 env 폴백 (OpenAI 호환)
    ai_base_url: str = "https://api.openai.com/v1"
    ai_api_key: str = ""
    ai_chat_model: str = "gpt-4o-mini"
    ai_eval_model: str = "gpt-4o-mini"

    # 워크스페이스 제한
    max_file_bytes: int = 400 * 1024  # 파일 1개 상한
    max_files_per_scenario: int = 600  # clone 으로 참고 저장소를 통째로 들여올 수 있게 여유를 둔다
    max_event_batch: int = 50

    # 대화/에이전트 제한
    messenger_max_per_attempt: int = 300  # 응시 1건이 보낼 수 있는 메신저 메시지 총량 (LLM 비용 예산)
    run_max_concurrent_per_attempt: int = 2  # 응시 1건의 동시 queued/running 실행 수
    messenger_history_limit: int = 60  # NPC 호출에 싣는 스레드 이력 상한
    agent_history_limit: int = 30  # 에이전트 호출에 싣는 이력 상한
    agent_max_tool_iterations: int = 10  # 에이전트 1턴의 도구 루프 한도

    # 실행(러너) 제한
    run_timeout_s: int = 30
    run_command_max_len: int = 500

    class Config:
        env_file = ".env"
        extra = "ignore"


settings = Settings()


def cookie_secure_enabled() -> bool:
    return settings.cookie_secure if settings.cookie_secure is not None else settings.odysseus_env != "development"


def https_only_enabled() -> bool:
    return settings.https_only if settings.https_only is not None else settings.odysseus_env != "development"


# 코드·예시 파일에 한 번이라도 적혔던 값 — 어디에서든 시크릿으로 받지 않는다
KNOWN_PLACEHOLDER_SECRETS = frozenset(
    {
        "",
        "odysseus-dev-secret-change-me",
        "odysseus-internal-change-me",
        "change-me-openssl-rand-hex-32",
    }
)
MIN_SECRET_LEN = 32


def _secret_problem(name: str, value: str) -> str | None:
    if value in KNOWN_PLACEHOLDER_SECRETS:
        return f"{name} 이 비어 있거나 알려진 자리표시자 값입니다"
    if len(value) < MIN_SECRET_LEN:
        return f"{name} 이 너무 짧습니다 ({len(value)}자, 최소 {MIN_SECRET_LEN}자)"
    return None


def check_startup_security() -> None:
    """기동 전에 '알려진 자격증명이 생길 수 있는 구성' 을 거부한다.

    운영 모드에서는 JWT 시크릿과 내부 토큰이 자리표시자이거나 짧으면 멈춘다. 개발 모드는
    경고만 한다 — 로컬에서는 시크릿이 약해도 되지만 그 사실을 로그에서 보이게 한다.

    데모 시드는 코드에 적힌 고정 비밀번호로 관리자 계정을 만든다. 개발 환경에서만
    의미가 있고, 운영에서 켜져 있으면 인터넷에 노출된 즉시 관리자 계정이 알려진다.
    실수로 켠 배포가 조용히 뜨는 대신 여기서 멈춘다.
    """
    problems = [
        p
        for p in (
            _secret_problem("JWT_SECRET", settings.jwt_secret),
            _secret_problem("INTERNAL_TOKEN", settings.internal_token),
        )
        if p
    ]
    if problems:
        hint = "각각 `openssl rand -hex 32` 로 만들어 .env 에 넣으세요."
        if settings.odysseus_env == "development":
            import sys

            print(f"[security] WARNING (development): {'; '.join(problems)}. {hint}", file=sys.stderr, flush=True)
        else:
            raise RuntimeError(f"{'; '.join(problems)}. {hint}")
    if settings.seed_demo_data and settings.odysseus_env != "development":
        raise RuntimeError(
            "SEED_DEMO_DATA=true 는 ODYSSEUS_ENV=development 에서만 허용됩니다. "
            "운영 환경에서는 SEED_DEMO_DATA 를 끄고 BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD "
            "로 최초 관리자를 만드세요 (비워 두면 무작위 비밀번호가 로그에 한 번 출력됩니다)."
        )
