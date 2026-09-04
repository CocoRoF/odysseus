FROM nginx:1.27-alpine@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10
# 공식 이미지의 entrypoint 가 /etc/nginx/templates/*.template 을 envsubst 로 채워 conf.d 에 놓는다.
# 치환되는 변수는 EDGE_HTTPS_ONLY 뿐이다 (NGINX_ENVSUBST_FILTER) — nginx 의 $host 같은 변수는 건드리지 않는다.
ENV NGINX_ENVSUBST_FILTER="^EDGE_" EDGE_HTTPS_ONLY=off
COPY templates/default.conf.template /etc/nginx/templates/default.conf.template
