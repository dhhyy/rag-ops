-- 프로젝트: 문서를 묶는 단위. 프로젝트마다 문서를 가져오는 방식(kind)이 하나로 정해진다.
-- 처음 DB를 만들 때는 자동 실행된다. 이미 초기화된 DB에는 직접 적용 (여러 번 실행해도 결과가 같다):
--   docker compose exec -T db psql -U postgres -d postgres < db/init/07-projects.sql
-- 적용 뒤 이미 있는 문서를 프로젝트로 옮기기 (저장소마다 Git 프로젝트 하나):
--   docker compose exec engine python projects.py backfill

-- kind
--   git     : 원본은 git 저장소. 우리는 읽기만 한다. 판 = 커밋.
--   managed : 파일을 올리면 원문을 DB에 저장한다. 판 = DB가 매기는 번호 (다음 단계에서 만든다).
-- source (git): {"from": "local", "path": "<서버에서 읽을 폴더>"}
--   폴더 경로는 .env의 INGEST_ROOTS 안이어야 한다. 경로는 이 파일에 적지 않는다 (사람마다 다르다).
-- defaults: 이 프로젝트로 넣는 문서의 기본 메타데이터 {"env": "운영", "doc_type": "해설"}
CREATE TABLE IF NOT EXISTS projects (
    id           bigserial   PRIMARY KEY,
    name         text        NOT NULL UNIQUE,
    kind         text        NOT NULL CHECK (kind IN ('git', 'managed')),
    source       jsonb       NOT NULL DEFAULT '{}',
    defaults     jsonb       NOT NULL DEFAULT '{}',
    description  text        NOT NULL DEFAULT '',
    created_at   timestamptz NOT NULL DEFAULT now()
);

-- 프로젝트와 문서의 연결. 문서는 한 번만 저장하고, 여러 프로젝트에 연결만 늘린다 (다시 임베딩하지 않는다).
--   is_origin: 문서를 들여온 프로젝트. 문서마다 하나뿐이고 떼어 낼 수 없다.
--   나머지 연결은 사람이 붙이고 뗀다.
CREATE TABLE IF NOT EXISTS project_documents (
    project_id   bigint      NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    document_id  bigint      NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    is_origin    boolean     NOT NULL DEFAULT false,
    linked_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, document_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS project_documents_one_origin ON project_documents (document_id) WHERE is_origin;
-- 검색 범위를 걸 때 문서 id로 찾는다
CREATE INDEX IF NOT EXISTS project_documents_document ON project_documents (document_id);
