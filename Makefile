.PHONY: up down build logs ps rebuild reset

up:
	docker compose up -d

build:
	docker compose build

down:
	docker compose down

logs:
	docker compose logs -f --tail=200

ps:
	docker compose ps

rebuild:
	docker compose build --no-cache && docker compose up -d

# 데이터까지 전부 초기화
reset:
	docker compose down -v && docker compose up -d --build
