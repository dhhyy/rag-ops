-- 색인(청킹 방식 × 임베딩 모델 조합)과 현재 설정, 평가 결과
-- 처음 DB를 만들 때는 02 다음에 자동 실행된다. 이미 초기화된 DB에는 직접 적용 (여러 번 실행해도 결과가 같다):
--   docker compose exec -T db psql -U postgres -d postgres < db/init/04-indexes.sql
-- 적용 뒤 기존 문서의 원문(documents.content)은 비어 있다. 채우기:
--   .venv/bin/python engine/app/indexes.py backfill-content

-- 원문을 DB에 둔다. 색인을 새로 만들 때 원본 파일이 바뀌었어도 같은 판으로 다시 자를 수 있게 하려는 것이다.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS content text;

-- 색인 1개 = 청킹 방식 1개 × 임베딩 모델 1개. 같은 조합은 한 번만 만든다 (key가 같으면 같은 색인).
CREATE TABLE IF NOT EXISTS indexes (
    id          bigserial PRIMARY KEY,
    key         text        NOT NULL UNIQUE,   -- 예: heading[prefix=path]|tei-bge-m3[]  (components.index_key와 같은 규칙)
    chunker     jsonb       NOT NULL,          -- {"id": "heading", "params": {...}}
    embedder    jsonb       NOT NULL,          -- {"id": "tei-bge-m3", "params": {...}}
    dims        int         NOT NULL,          -- 벡터 차원. 조각 벡터는 이 값과 같아야 한다
    is_base     boolean     NOT NULL DEFAULT false,  -- 새 문서를 넣을 때 자동으로 갱신하는 기본 색인 (하나만)
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS indexes_one_base ON indexes (is_base) WHERE is_base;

INSERT INTO indexes (key, chunker, embedder, dims, is_base)
VALUES ('heading[prefix=path]|tei-bge-m3[]',
        '{"id": "heading", "params": {"prefix": "path"}}',
        '{"id": "tei-bge-m3", "params": {}}', 1024, true)
ON CONFLICT (key) DO NOTHING;

-- 조각은 색인마다 따로 둔다. 기존 조각은 기본 색인 것으로 옮긴다.
-- 벡터 차원은 모델마다 달라서 칸에 차원을 고정하지 않는다 (차원 검사는 indexes.dims로 한다).
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS index_id bigint REFERENCES indexes(id) ON DELETE CASCADE;
UPDATE chunks SET index_id = (SELECT id FROM indexes WHERE is_base) WHERE index_id IS NULL;
ALTER TABLE chunks ALTER COLUMN index_id SET NOT NULL;
ALTER TABLE chunks ALTER COLUMN embedding TYPE vector;
ALTER TABLE chunks DROP CONSTRAINT IF EXISTS chunks_document_id_chunk_index_key;
CREATE UNIQUE INDEX IF NOT EXISTS chunks_index_document_chunk ON chunks (index_id, document_id, chunk_index);
-- 벡터 색인(HNSW)은 조각이 수천 개를 넘을 때 차원별 식 색인으로 추가한다. 지금은 전체 비교로 충분하다.

-- 색인마다 어떤 판(content_hash)의 문서로 만들었는지. documents와 해시가 다르면 그 색인은 "뒤처짐"이다.
CREATE TABLE IF NOT EXISTS index_documents (
    index_id      bigint      NOT NULL REFERENCES indexes(id) ON DELETE CASCADE,
    document_id   bigint      NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    content_hash  text        NOT NULL,
    built_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (index_id, document_id)
);
INSERT INTO index_documents (index_id, document_id, content_hash)
SELECT DISTINCT c.index_id, d.id, d.content_hash
FROM chunks c JOIN documents d ON d.id = c.document_id
ON CONFLICT DO NOTHING;

-- 현재 설정: 한 행만 둔다. Playground·Evaluations가 이 설정으로 검색한다.
-- query: 질문할 때 쓰는 값 (top_k, 나중에 reranker·generator 등)
CREATE TABLE IF NOT EXISTS active_setup (
    id          int         PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    index_id    bigint      NOT NULL REFERENCES indexes(id),
    query       jsonb       NOT NULL DEFAULT '{}',
    updated_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO active_setup (id, index_id, query)
SELECT 1, id, '{"top_k": 5}' FROM indexes WHERE is_base
ON CONFLICT (id) DO NOTHING;

-- 이름 붙여 저장한 설정. 불러오면 현재 설정에 복사한다.
CREATE TABLE IF NOT EXISTS setups (
    id          bigserial   PRIMARY KEY,
    name        text        NOT NULL UNIQUE,
    index_id    bigint      NOT NULL REFERENCES indexes(id) ON DELETE CASCADE,
    query       jsonb       NOT NULL DEFAULT '{}',
    created_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO setups (name, index_id, query)
SELECT 'Baseline', id, '{"top_k": 5}' FROM indexes WHERE is_base
ON CONFLICT (name) DO NOTHING;

-- 평가 결과. setup에는 실행할 때의 설정 전체(색인 조합 포함)를 그대로 남긴다. 색인이 지워져도 결과는 남는다.
CREATE TABLE IF NOT EXISTS eval_runs (
    id             bigserial   PRIMARY KEY,
    label          text        NOT NULL DEFAULT '',
    setup          jsonb       NOT NULL,
    index_id       bigint      REFERENCES indexes(id) ON DELETE SET NULL,
    questions_sha  text        NOT NULL,
    summary        jsonb       NOT NULL,
    detail         jsonb       NOT NULL,   -- 질문별 결과와 지도 좌표
    created_at     timestamptz NOT NULL DEFAULT now()
);
