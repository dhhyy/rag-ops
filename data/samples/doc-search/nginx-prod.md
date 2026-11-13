# 웹 서버 nginx 운영 설정

운영 웹 서버(web-prod)의 nginx 설정을 정리한 문서다.

## 연결 수

- `worker_processes auto;`
- `worker_connections 4096;` — 워커 하나가 동시에 받을 수 있는 연결 수

## 요청 크기

- `client_max_body_size 20m;` — 올릴 수 있는 파일 최대 크기
