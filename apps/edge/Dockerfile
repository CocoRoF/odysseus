FROM nginx:1.31-alpine@sha256:72ba65eb42c10344912a84ff42408db7d34f2feb642204570ab8fc5ffd29f1d3
# 공식 이미지의 entrypoint 가 /etc/nginx/templates/*.template 을 envsubst 로 채워 conf.d 에 놓는다.
# 치환되는 변수는 EDGE_HTTPS_ONLY 뿐이다 (NGINX_ENVSUBST_FILTER) — nginx 의 $host 같은 변수는 건드리지 않는다.
ENV NGINX_ENVSUBST_FILTER="^EDGE_" EDGE_HTTPS_ONLY=off
COPY templates/default.conf.template /etc/nginx/templates/default.conf.template
