# 엔진 API 규약 v1 (서비스용)

- 작성일: 2026-11-13
- 대상: rag-ops 엔진을 부르는 서비스 (quiz-arena, doc-search 등)
- 관리 콘솔(웹)이 쓰는 `/search`, `/projects` 등은 이 규약이 아니다. 화면에 맞춰 바뀔 수 있다.
- `/v1` 아래 응답 모양은 바꾸지 않는다. 필드를 **더하는** 것만 한다. 지우거나 뜻을 바꿀 일이 생기면 `/v2`를 만든다.

## 구조

```
[서비스]  ── X-Service-Key ──▶  [Kong 게이트웨이 :8001]  ──▶  [엔진 /v1 :8000]
                                  키 확인, 서비스 이름 붙이기,      검색, 응답 모양 고정,
                                  호출 횟수 제한, 접근 기록         사용 기록(서비스별)
```

- 서비스는 **게이트웨이 주소**만 쓴다 (로컬: `http://127.0.0.1:8001`). 엔진 포트(8000)는 관리 콘솔용이다.
- 게이트웨이가 키를 확인하고, 엔진에 서비스 이름(`X-Consumer-Username`)을 붙여 넘긴다. 엔진은 이 이름으로 사용 기록을 나눈다.
- 서비스 키는 `gateway/kong.yml`(커밋 안 함, 예시는 `gateway/kong.example.yml`)에 있다. 게이트웨이 이미지는 `kong:3.9.3` (DB 없이 선언형 설정, 관리 API 끔). 키를 받으려면 rag-ops 운영자에게 요청한다.

## 엔진이 하는 일과 안 하는 일

| 엔진 (`/v1`) | 서비스 |
| --- | --- |
| 근거 조각 찾기, 근거 위치·판·검증 상태·환경·외부 전송 가능 여부 붙이기 | 답변을 쓸지 **보류할지 판단** |
| 사용 기록 (서비스별 질문 수·지연·비용) | 답변 생성(LLM), 화면, 사용자 기록 |

- `/v1/search`는 **답변을 만들지 않는다.** 근거만 준다.
- 외부 LLM에 근거를 보낼 때는 `meta.external_ok`가 `true`인 조각만 보낸다 (서비스 책임).

## POST /v1/search

### 요청

```http
POST /v1/search
X-Service-Key: <서비스 키>
Content-Type: application/json

{
  "query": "nginx 운영 서버 worker_connections 값은?",
  "project_id": 12,
  "top_k": 5,
  "rerank": "setting"
}
```

| 필드 | 필수 | 설명 |
| --- | --- | --- |
| `query` | ✓ | 질문. 앞뒤 공백을 뺀 뒤 1~2000자 |
| `project_id` | | 검색 범위 프로젝트. 없으면 전체 문서 |
| `top_k` | | 돌려받을 근거 수, 1~20. 없으면 엔진 현재 설정값 |
| `rerank` | | `"setting"`(엔진 현재 설정대로, 기본) 또는 `"off"`(리랭크 끔, 빠름) |

### 응답 200

```json
{
  "query": "nginx 운영 서버 worker_connections 값은?",
  "project_id": 12,
  "setup": {
    "index_id": 1,
    "chunker": "Heading sections",
    "embedder": "bge-m3",
    "reranker": null,
    "keyword": null,
    "top_k": 5
  },
  "hits": [
    {
      "rank": 1,
      "chunk_id": 345,
      "score": 0.8123,
      "text": "조각 원문 …",
      "location": {
        "document_id": 7,
        "title": "nginx 운영 설정",
        "heading_path": "nginx 운영 설정 > events",
        "page": null
      },
      "source": {
        "repo": "infra-config",
        "path": "nginx/nginx.conf.md",
        "commit": "a1b2c3d",
        "version": 2
      },
      "meta": {
        "env": "운영",
        "doc_type": "설정",
        "verification": "확인",
        "checked_at": "2026-11-02",
        "external_ok": false
      }
    }
  ],
  "latency_ms": { "embed": 35, "search": 4, "rerank": 120, "total": 165 },
  "usage_id": 981
}
```

| 필드 | 설명 |
| --- | --- |
| `hits` | 점수 높은 순. 근거가 없으면 빈 배열 (오류 아님) |
| `rank` | 1부터 |
| `score` | 최종 순위 점수. 리랭크가 켜져 있으면 리랭커 점수, 꺼져 있으면 벡터 유사도(또는 키워드 합산 점수). **설정에 따라 범위가 달라지므로** 보류 기준값은 `setup`이 같을 때만 비교한다 |
| `location.heading_path` | 문서 안 제목 경로 (` > `로 이은 문자열). PDF는 `"제목 > p.3"` |
| `location.page` | PDF면 쪽 번호(정수), 아니면 `null` |
| `source.version` | 직접 관리 프로젝트에서 올린 문서의 판 번호. 판 기록이 없는 문서는 `null` |
| `meta.env` | `운영` / `개발` / `샘플` / `혼합` / `null` |
| `meta.doc_type` | `설정` / `실행 결과` / `해설` / `장애 기록` / `null` |
| `meta.verification` | `확인` / `추정` / `미확인` / `폐기` |
| `meta.checked_at` | 확인일 (YYYY-MM-DD) 또는 `null` |
| `meta.external_ok` | 외부 LLM에 보내도 되는지 |
| `latency_ms` | 엔진 안 구간 시간. 게이트웨이 시간은 빠져 있다 |
| `usage_id` | 엔진 사용 기록 번호. 문제 제보할 때 함께 알려 주면 추적할 수 있다 |

### 오류

엔진 오류는 늘 같은 모양이다.

```json
{ "error": { "code": "invalid_query", "message": "질문은 1~2000자로 적어 주세요" } }
```

| HTTP | code | 언제 |
| --- | --- | --- |
| 400 | `invalid_query` / `invalid_request` | 질문이 비었거나 너무 김, `top_k` 범위 밖, 모르는 필드 값 / 프로젝트 이름이 맞지 않음 |
| 404 | `project_not_found` / `job_not_found` | 없거나 다른 서비스의 것 |
| 409 | `project_exists` / `conflict` | 같은 이름의 프로젝트가 있음 / 넣는 중이라 지울 수 없음 |
| 503 | `engine_unavailable` | 임베딩·리랭커가 응답하지 않음, 설정한 리랭커를 쓸 수 없음 |

게이트웨이(Kong)에서 막힌 요청은 **Kong 모양**으로 온다. 서비스는 HTTP 상태로 먼저 나눈다.

| HTTP | 본문 예 | 언제 |
| --- | --- | --- |
| 401 | `{"message": "No API key found in request", "request_id": "…"}` 또는 `{"message": "Unauthorized", …}` | 키가 없거나 틀림 |
| 429 | `{"message": "API rate limit exceeded", …}` | 호출 횟수 제한 넘음 (서비스마다 분당 60회) |
| 404 | `{"message": "no Route matched with those values", …}` | `/v1` 밖 경로 (게이트웨이는 `/v1`만 연다) |
| 413 | `{"message": "Request size limit exceeded", …}` | 본문이 21MB를 넘음 |

## GET /v1/health

키 필요. 엔진이 살아 있으면 `{"ok": true}`.

## 프로젝트와 소유권

- 서비스가 `/v1/projects`로 만든 프로젝트는 **그 서비스 것**이다. 그 서비스만 올리고, 작업을 보고, 지우고, 검색할 수 있다.
- 관리 콘솔에서 만든 프로젝트는 **모든 서비스가 검색만** 할 수 있다 (예: doc-search 샘플 프로젝트).
- 다른 서비스의 프로젝트·작업은 있어도 `404`로 답한다 (있는지도 알려 주지 않는다).
- 이름은 `<서비스>-<이름>`으로 저장된다 (예: `quiz-arena-room-42`). 관리 콘솔에서 누구 것인지 보인다.

## POST /v1/projects

```json
{ "name": "room-42", "external_ok": false, "description": "" }
```

| 필드 | 필수 | 설명 |
| --- | --- | --- |
| `name` | ✓ | 1~40자. 서비스 안에서 겹치면 409 |
| `external_ok` | | 이 프로젝트에 올리는 문서를 외부 LLM에 보내도 되는지. **사용자 동의를 받았을 때만 true** (기본 false) |
| `description` | | 200자 이하 |

응답 201: `{"project": {"id": 42, "name": "quiz-arena-room-42", "external_ok": false}}`

## POST /v1/projects/{id}/pdf?name=파일이름.pdf

본문은 PDF 원본 바이트 (`Content-Type: application/pdf`). 20MB 이하, 글자가 있는 PDF (스캔본은 글자가 안 나온다). 쪽마다 조각 하나가 된다.

응답 202, `status`로 나눈다.

| status | 뜻 | 다른 필드 |
| --- | --- | --- |
| `queued` | 넣기 작업을 시작함 | `job_id`, `pages`, `empty_pages`, `suspect`(글자가 깨졌을 수 있음), `replaces`(같은 이름의 이전 판 번호, 처음이면 null) |
| `unchanged` | 같은 이름·같은 내용이 이미 있음 | `version` |
| `skipped` | 넣지 않음 | `reason` (PDF 아님, 20MB 초과, 같은 파일 넣는 중 등) |

같은 이름으로 내용이 다른 PDF를 올리면 새 판이 된다 (`source.version`이 1 늘어남).

## GET /v1/jobs/{job_id}

```json
{ "job_id": 138, "project_id": 42, "name": "bio.pdf", "status": "done", "stage": "저장",
  "progress": { "done": null, "total": null }, "error": null,
  "document_id": 35, "version": 1, "chunks": 2 }
```

- `status`: `queued` → `running` → `done` | `failed`. `failed`면 `error`에 이유.
- 1~2초 간격으로 물어보면 된다 (분당 60회 제한 안에서).

## DELETE /v1/projects/{id}

방이 끝났을 때 프로젝트와 그 문서·조각·판을 모두 지운다. 되돌릴 수 없다. 넣는 중인 작업이 있으면 `409 conflict`.

응답 200: `{"deleted": 42, "name": "quiz-arena-room-42", "documents": 1, "chunks": 2}`

## 앞으로 (아직 없음)

- `POST /v1/llm`: 외부 LLM 호출을 엔진이 대신 해 주고 `external_ok`를 검사, 비용을 기록
- 판 바뀜 알림
