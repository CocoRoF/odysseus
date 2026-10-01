from pydantic_settings import BaseSettings


# 배포판 기본값 — repo 에 들어 있어 `docker compose up` 이 아무 준비 없이 바로 돈다.
# 공개된 값이므로 비밀이 아니다. 실제 응시자를 받기 전에 바꾸도록 기동 때마다 크게 알린다.
DEFAULT_JWT_SECRET = "odysseus-default-jwt-secret-CHANGE-ME-before-production"
DEFAULT_INTERNAL_TOKEN = "odysseus-default-internal-token-CHANGE-ME-before-production"
DEFAULT_DATA_ENCRYPTION_KEY = "odysseus-default-data-encryption-key-CHANGE-ME-before-production"
DEFAULT_REDIS_API_PASSWORD = "odysseus-default-redis-api-password"
DEFAULT_REDIS_RUNNER_PASSWORD = "odysseus-default-redis-runner-password"

#: 시나리오가 정할 수 있는 실행 제한 시간의 범위(초).
#: 상한은 러너가 받아들이는 값(apps/runner/worker.py 의 MAX_TIMEOUT_S)과 **같아야 한다** —
#: 여기서 더 크게 받아 주면 출제 화면의 안내와 실제 동작이 어긋난다.
MIN_RUN_TIMEOUT_S = 5
MAX_RUN_TIMEOUT_S = 60

# 위의 기본값과, 과거 예시 파일에 적혔던 자리표시자들. 비밀로 쳐 주지 않는 값의 목록이다.
KNOWN_PLACEHOLDER_SECRETS = frozenset(
    {
        "",
        "odysseus-dev-secret-change-me",
        "odysseus-internal-change-me",
        "change-me-openssl-rand-hex-32",
        DEFAULT_JWT_SECRET,
        DEFAULT_INTERNAL_TOKEN,
        DEFAULT_DATA_ENCRYPTION_KEY,
        DEFAULT_REDIS_API_PASSWORD,
        DEFAULT_REDIS_RUNNER_PASSWORD,
    }
)
MIN_SECRET_LEN = 32

class Settings(BaseSettings):
    database_url: str = "postgresql+asyncpg://odysseus:odysseus@localhost:5432/odysseus"
    redis_url: str = "redis://localhost:6379/0"

    # 시크릿에는 기본값이 없다 — 운영 모드에서는 충분히 긴 무작위 값이 없으면 기동을 거부한다
    jwt_secret: str = DEFAULT_JWT_SECRET
    jwt_expire_hours: int = 12
    session_idle_hours: int = 4
    internal_token: str = DEFAULT_INTERNAL_TOKEN
    # DB에 보관되는 공급자 API 키/AppSetting JSON을 AES-GCM으로 암호화하는 별도 키.
    # 백업 복원에도 같은 값이 필요하며 JWT_SECRET과 분리해 회전 범위를 제한한다.
    data_encryption_key: str = DEFAULT_DATA_ENCRYPTION_KEY
    internal_api_base: str = "http://127.0.0.1:8000"

    # 운영 모드가 기본. development 에서만 데모 시드(고정 비밀번호)가 허용된다.
    odysseus_env: str = "production"
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
    max_file_bytes: int = 400 * 1024
    max_files_per_scenario: int = 600
    max_event_batch: int = 50

    # 대화/에이전트 제한
    messenger_max_per_attempt: int = 300
    run_max_concurrent_per_attempt: int = 2
    messenger_history_limit: int = 60
    agent_history_limit: int = 30
    agent_max_tool_iterations: int = 10

    # Office AI is isolated from assessment dialogue; all limits are per deployment.
    office_dialogue_enabled: bool = True
    office_ambient_enabled: bool = True
    office_exam_bridge_enabled: bool = True
    office_worker_concurrency: int = 4
    office_provider_concurrency: int = 3
    office_llm_timeout_s: int = 25
    office_job_timeout_s: int = 90
    office_ambient_interval_s: int = 60
    office_max_jobs_per_user_hour: int = 120
    office_max_jobs_global_hour: int = 3000
    office_max_tokens_global_hour: int = 8_000_000
    office_token_reservation: int = 48_000
    office_cli_call_budget_usd: float = 0.25
    office_input_chars: int = 14000
    office_memory_limit: int = 8
    # NPC 잡담 대본 캐시(npc/cache.py): 처음 잡담하는 짝에게만 다른 세계에서 만든 대본을 쓴다. 맞는 대본이 min 보다
    # 적으면 새로 만들고, per_key 만큼 모이기 전에는 번갈아 새로 만들어 종류를 넓힌다. 한 대본은 max_replays 번까지만 튼다
    office_cache_enabled: bool = True
    office_cache_min: int = 3
    office_cache_per_key: int = 8
    office_cache_max_replays: int = 40

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




def _secret_problem(name: str, value: str) -> str | None:
    if value in KNOWN_PLACEHOLDER_SECRETS:
        return f"{name} 이 공개된 기본값/자리표시자입니다"
    if len(value) < MIN_SECRET_LEN:
        return f"{name} 이 너무 짧습니다 ({len(value)}자, 최소 {MIN_SECRET_LEN}자)"
    return None


def insecure_secrets() -> list[str]:
    """공개 기본값이거나 너무 짧아 비밀 구실을 못 하는 시크릿들."""
    return [
        p
        for p in (
            _secret_problem("JWT_SECRET", settings.jwt_secret),
            _secret_problem("INTERNAL_TOKEN", settings.internal_token),
            _secret_problem("DATA_ENCRYPTION_KEY", settings.data_encryption_key),
        )
        if p
    ]


def check_startup_security() -> None:
    """기본 시크릿으로도 기동하되, 그 사실을 숨기지 않는다.

    받자마자 도는 것이 배포판의 기본값이다(기본 시크릿은 repo 에 들어 있다). 다만 그 값들은
    공개되어 있어 비밀이 아니므로, 남아 있는 한 기동할 때마다 무엇을 바꿔야 하는지 크게 알린다.
    실제 응시자 데이터를 받기 전에 바꾸는 것은 운영자의 몫이다.
    """
    import sys

    problems = insecure_secrets()
    if problems:
        lines = [
            "=" * 78,
            "[security] 이 서버는 공개된 기본 시크릿으로 돌고 있습니다 — 비밀이 아닙니다.",
            *(f"  - {p}" for p in problems),
            "",
            "  실제 응시자 데이터를 받기 전에 .env 에서 바꾸세요:",
            "    JWT_SECRET=$(openssl rand -hex 32)            # 바꾸면 기존 로그인 세션이 끊깁니다",
            "    INTERNAL_TOKEN=$(openssl rand -hex 32)",
            "    DATA_ENCRYPTION_KEY=$(openssl rand -hex 32)   # 먼저 바꾼 뒤 AI 공급자 키를 다시 입력하세요",
            "  (DATA_ENCRYPTION_KEY 는 DB 백업과 한 세트입니다 — 정한 뒤에는 함께 보관하세요.)",
            "=" * 78,
        ]
        print("\n".join(lines), file=sys.stderr, flush=True)
    if settings.seed_demo_data and settings.odysseus_env != "development":
        raise RuntimeError(
            "SEED_DEMO_DATA=true 는 ODYSSEUS_ENV=development 에서만 허용됩니다. "
            "운영 환경에서는 SEED_DEMO_DATA 를 끄고 BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD "
            "로 최초 관리자를 만드세요 (비워 두면 무작위 비밀번호가 로그에 한 번 출력됩니다)."
        )
