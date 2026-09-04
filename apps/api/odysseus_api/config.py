from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str = "postgresql+asyncpg://odysseus:odysseus@localhost:5432/odysseus"
    redis_url: str = "redis://localhost:6379/0"

    jwt_secret: str = "odysseus-dev-secret-change-me"
    jwt_expire_hours: int = 12
    internal_token: str = "odysseus-internal-change-me"
    # MCP 브리지가 되돌아 호출하는 주소 (api 컨테이너 내부)
    internal_api_base: str = "http://127.0.0.1:8000"

    # 운영 모드가 기본. development 에서만 데모 시드(고정 비밀번호)가 허용된다.
    odysseus_env: str = "production"  # production | development
    seed_demo_data: bool = False
    # 빈 DB 최초 기동 시 만들 관리자 — 비밀번호를 비우면 무작위로 만들어 로그에 한 번 출력한다
    bootstrap_admin_email: str = ""
    bootstrap_admin_password: str = ""

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


def check_startup_security() -> None:
    """기동 전에 '알려진 자격증명이 생길 수 있는 구성' 을 거부한다.

    데모 시드는 코드에 적힌 고정 비밀번호로 관리자 계정을 만든다. 개발 환경에서만
    의미가 있고, 운영에서 켜져 있으면 인터넷에 노출된 즉시 관리자 계정이 알려진다.
    실수로 켠 배포가 조용히 뜨는 대신 여기서 멈춘다.
    """
    if settings.seed_demo_data and settings.odysseus_env != "development":
        raise RuntimeError(
            "SEED_DEMO_DATA=true 는 ODYSSEUS_ENV=development 에서만 허용됩니다. "
            "운영 환경에서는 SEED_DEMO_DATA 를 끄고 BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD "
            "로 최초 관리자를 만드세요 (비워 두면 무작위 비밀번호가 로그에 한 번 출력됩니다)."
        )
