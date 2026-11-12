-- 직접 관리 문서: 파일을 올리면 원문을 DB에 두고, 올릴 때마다 판(version)을 하나씩 쌓는다.
-- 처음 DB를 만들 때는 자동 실행된다. 이미 초기화된 DB에는 직접 적용 (여러 번 실행해도 결과가 같다):
--   docker compose exec -T db psql -U postgres -d postgres < db/init/08-managed-documents.sql

-- 문서가 어디서 왔는지: git(저장소·경로·커밋) / managed(직접 관리 프로젝트에 올린 파일)
--   managed 문서는 source_repo = 프로젝트 이름, source_path = 파일 이름, source_commit = 판 이름(v1, v2…)
-- git 저장소 이름과 직접 관리 프로젝트 이름이 같아도 부딪히지 않게 유일 키에 종류를 넣는다.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS source_kind text NOT NULL DEFAULT 'git';
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_source_kind_check;
ALTER TABLE documents ADD CONSTRAINT documents_source_kind_check CHECK (source_kind IN ('git', 'managed'));
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_source_repo_source_path_key;
CREATE UNIQUE INDEX IF NOT EXISTS documents_source ON documents (source_kind, source_repo, source_path);

-- 직접 관리 문서의 판. 내용(해시)이 바뀐 파일을 올렸을 때만 하나 늘어난다. 문서를 지우면 판도 같이 지워진다.
-- 원문을 판마다 남겨서 예전 판과 비교하거나 되돌릴 수 있게 한다. git 문서는 커밋이 판이라 여기에 쌓지 않는다.
CREATE TABLE IF NOT EXISTS document_versions (
    id            bigserial   PRIMARY KEY,
    document_id   bigint      NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    version       int         NOT NULL,
    content_hash  text        NOT NULL,
    content       text        NOT NULL,
    title         text,
    filename      text        NOT NULL,
    size_bytes    int         NOT NULL,
    uploaded_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (document_id, version)
);
