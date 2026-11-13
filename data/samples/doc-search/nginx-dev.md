# 웹 서버 nginx 개발 설정

개발 웹 서버(web-dev)의 nginx 설정을 정리한 문서다.

## 연결 수

- `worker_processes 2;`
- `worker_connections 1024;` — 개발 서버는 접속이 적어 운영보다 낮게 둔다

## 요청 크기

- `client_max_body_size 100m;` — 시험용 큰 파일을 올리려고 운영보다 크게 둔다
