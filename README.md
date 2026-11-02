# ops-rag

> **운영 문서와 설정을 근거로, 확인된 것만 답하는 사내 RAG**
>
> *Self-hosted RAG that answers ops questions only from verified docs and configs, with citations.*

답변마다 근거 위치와 검증 상태를 붙이고, 근거가 부족하면 답하지 않는다.
목표는 이 RAG에 연계된 인프라 전체를 직접 띄우고, 단계마다 측정해 기록하는 것이다.

## 원칙

- **근거와 검증 상태**: "문서에 설정됨"과 "지금 동작함"을 구분한다.
- **모르면 보류**: 보류해야 정답인 질문을 평가셋에 넣는다.
- **데이터는 안에서**: 임베딩·검색은 서버 안에서, 외부 LLM에는 허용된 자료만 보낸다.
- **측정으로 증명**: 기술을 붙일 때마다 같은 평가셋으로 이전 단계와 비교한다.

## 구성

| 역할 | 선택 | 상태 |
| --- | --- | --- |
| 벡터 DB | PostgreSQL 18 + pgvector 0.8.7 | ✅ |
| 임베딩 | TEI 1.9.4 + bge-m3 | ✅ |
| 하이브리드 검색 / 리랭커 | BM25 + kiwipiepy / bge-reranker-v2-m3 | ⏳ |
| API / 비동기 인덱싱 | FastAPI / Celery + Redis | ⏳ |
| 관측 | OpenTelemetry + Tempo + Grafana | ⏳ |

## 측정 기록

- 임베딩 서버 메모리 **11.8GB → 3.9GB** (`--max-batch-tokens` 16384 → 2048). 검색 지연은 그대로, 대량 인덱싱만 15~25% 느려짐.

## 실행

```bash
cp .env.example .env
```

`.env`의 `POSTGRES_PASSWORD`를 바꾼 뒤:

```bash
docker compose up -d
```
