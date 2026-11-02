-- 문서와 조각(청크) 테이블
-- 이미 초기화된 DB에는 자동 실행되지 않는다. 직접 적용:
--   docker compose exec -T db psql -U opsrag -d opsrag < db/init/02-chunks.sql

-- 문서 1개 = 1행. 같은 저장소·경로는 한 번만 들어간다 (다시 넣으면 갱신)
CREATE TABLE IF NOT EXISTS documents (
    id             bigserial PRIMARY KEY,
    source_repo    text        NOT NULL,  -- 문서 저장소 이름
    source_path    text        NOT NULL,  -- 저장소 안의 경로
    source_commit  text        NOT NULL,  -- 읽은 판의 커밋 (어느 판을 넣었는지)
    content_hash   text        NOT NULL,  -- 내용 해시. 같으면 다시 처리하지 않는다
    title          text,
    env            text,                  -- 운영 / 개발 / 샘플 / 혼합
    doc_type       text,                  -- 설정 / 실행 결과 / 해설 / 장애 기록
    verification   text,                  -- 확인 / 추정 / 미확인 / 폐기
    checked_at     date,                  -- 확인일
    external_ok    boolean     NOT NULL DEFAULT false,  -- 외부 LLM 전송 가능
    ingested_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (source_repo, source_path)
);

-- 조각. 문서를 지우면 조각도 같이 지워진다
CREATE TABLE IF NOT EXISTS chunks (
    id           bigserial PRIMARY KEY,
    document_id  bigint      NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    chunk_index  int         NOT NULL,  -- 문서 안 순서
    heading_path text        NOT NULL,  -- 예: 문서 제목 > 큰 제목 > 작은 제목
    content      text        NOT NULL,  -- 원문 조각 (답변 근거로 보여 줄 것)
    embed_text   text        NOT NULL,  -- 실제로 임베딩한 글 (제목 경로 포함)
    token_count  int         NOT NULL,  -- embed_text 토큰 수. 2048을 넘으면 잘린다
    embedding    vector(1024) NOT NULL, -- bge-m3
    UNIQUE (document_id, chunk_index)
);

-- 벡터 색인(HNSW)은 조각이 수천 개를 넘을 때 추가한다. 지금은 전체 비교로 충분하다
