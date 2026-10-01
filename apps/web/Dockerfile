# 베이스 이미지는 digest 로 고정하고, 의존성은 lockfile 그대로만 설치한다 (ODY-013)
FROM node:26-alpine@sha256:0b36e8c136b94cd4fcf02188228e76c31ad5872eef3fec8cbd2eee500cfd9e80 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund

FROM node:26-alpine@sha256:0b36e8c136b94cd4fcf02188228e76c31ad5872eef3fec8cbd2eee500cfd9e80 AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# 구입 에셋(비공개 서브모듈 public/office/licensed): 서빙하는 건 팩에서 만든 시트뿐이다. 팩 원본(source/)과 서브모듈
# 메타는 이미지에 넣지 않는다 — 넣으면 /office/licensed/source/… 로 원본이 그대로 내려받힌다.
RUN rm -rf public/office/licensed/source public/office/licensed/.git public/office/licensed/README.md \
 && (ls public/office/licensed/atlas-*.png >/dev/null 2>&1 \
     || echo "⚠ 구입 에셋 서브모듈이 없습니다 — 사무실 소품·벽 그림 없이 빌드합니다 (git submodule update --init)")
# Monaco를 셀프호스팅 (외부 CDN 의존 제거 — 폐쇄망 배포 지원)
RUN mkdir -p public/monaco && cp -r node_modules/monaco-editor/min/vs public/monaco/vs
# standalone 빌드는 rewrite 대상(next.config)을 빌드 시점에 고정한다 — compose 내부 주소로 명시
ARG API_URL=http://api:8000
ENV API_URL=${API_URL}
RUN npm run build

FROM node:26-alpine@sha256:0b36e8c136b94cd4fcf02188228e76c31ad5872eef3fec8cbd2eee500cfd9e80 AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
EXPOSE 3000
CMD ["node", "server.js"]
