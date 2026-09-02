from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str = "postgresql+asyncpg://odysseus:odysseus@localhost:5432/odysseus"
    redis_url: str = "redis://localhost:6379/0"

    jwt_secret: str = "odysseus-dev-secret-change-me"
    jwt_expire_hours: int = 12
    internal_token: str = "odysseus-internal-change-me"
    # MCP 브리지가 되돌아 호출하는 주소 (api 컨테이너 내부)
    internal_api_base: str = "http://127.0.0.1:8000"

    seed_demo_data: bool = True

    # DB에 공급자가 없을 때의 env 폴백 (OpenAI 호환)
    ai_base_url: str = "https://api.openai.com/v1"
    ai_api_key: str = ""
    ai_chat_model: str = "gpt-4o-mini"
    ai_eval_model: str = "gpt-4o-mini"

    # 워크스페이스 제한
    max_file_bytes: int = 400 * 1024  # 파일 1개 상한
    max_files_per_scenario: int = 200
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
