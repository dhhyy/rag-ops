# 엔진 이미지. 엔진 API(uvicorn)와 Celery worker가 같은 이미지를 쓰고 실행 명령만 다르다 (compose.yaml).
FROM python:3.12.15-slim-trixie

# git: 문서의 출처(저장소·커밋)를 기록하는 데 쓴다
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
# 문서 폴더는 Mac 사용자 소유로 연결되므로, 소유자가 달라도 git이 읽도록 허용한다
RUN git config --system --add safe.directory '*'
# 문서 폴더는 읽기 전용으로 연결한다. git status가 잠금 파일을 쓰려 하지 않게 한다
ENV GIT_OPTIONAL_LOCKS=0 PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1

COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt
# OpenAI 임베딩의 토큰 수를 세는 tiktoken은 첫 사용 때 인코딩 파일을 내려받는다. 이미지에 미리 받아 둔다
ENV TIKTOKEN_CACHE_DIR=/srv/tiktoken
RUN python -c "import tiktoken; tiktoken.get_encoding('cl100k_base')" && chmod -R a+rX /srv/tiktoken

# ingest.py는 자기 위치에서 두 단계 위를 저장소 루트로 본다. 같은 구조(engine/app)로 둔다
COPY app/ /srv/engine/app/
WORKDIR /srv/engine/app
# celery는 앱을 불러올 때만 현재 폴더를 import 경로에 넣었다가 뺀다. 작업 도중 늦게 불러오는 모듈(indexes 등)도 찾도록 고정한다
ENV PYTHONPATH=/srv/engine/app

RUN useradd --create-home worker
USER worker
CMD ["celery", "-A", "tasks", "worker", "--concurrency=1", "--loglevel=INFO"]
