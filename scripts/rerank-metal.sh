#!/usr/bin/env bash
# Mac(Apple Silicon)에서 리랭커를 Docker 밖에서 GPU(Metal)로 띄운다. Docker 안 TEI는 CPU만 써서 4배쯤 느리다.
# 설치: brew install text-embeddings-inference (1.9.4, Docker 이미지와 같은 판)
# 모델 캐시: RERANK_CACHE (기본 ~/.cache/rag-ops/tei). 처음이면 Docker 캐시를 복사해 쓴다:
#   docker cp rag-ops-rerank-1:/data/. ~/.cache/rag-ops/tei/
# 엔진이 쓰게 하려면 .env에 RERANK_URL_IN_DOCKER=http://host.docker.internal:8082 를 넣고 engine·worker를 다시 띄운다.
# 끄기: pkill -f "text-embeddings-router --model-id BAAI/bge-reranker-v2-m3"
set -euo pipefail
cd "$(dirname "$0")/.."
# compose.yaml의 rerank와 같은 판 (.env에 없으면 compose 기본값)
REV=$(grep '^RERANK_MODEL_REVISION=' .env | cut -d= -f2- || true)
REV="${REV:-953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e}"
mkdir -p "$(dirname "${RERANK_LOG:-$HOME/.cache/rag-ops/x}")"
CACHE="${RERANK_CACHE:-$HOME/.cache/rag-ops/tei}"
PORT="${RERANK_METAL_PORT:-8082}"
LOG="${RERANK_LOG:-$HOME/.cache/rag-ops/rerank-metal.log}"
HF_HUB_OFFLINE=1 HUGGINGFACE_HUB_CACHE="$CACHE" nohup text-embeddings-router \
  --model-id BAAI/bge-reranker-v2-m3 --revision "$REV" \
  --max-batch-tokens 4096 --auto-truncate --hostname 127.0.0.1 --port "$PORT" > "$LOG" 2>&1 &
echo "리랭커(Metal) 시작: 포트 $PORT, 기록 $LOG"
