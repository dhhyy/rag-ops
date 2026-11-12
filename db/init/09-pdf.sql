-- PDF 문서: 직접 관리 프로젝트에 올린 원본 PDF를 둔다. 글(페이지마다 나눈 글)은 지금처럼 documents.content와 판의 content에 있다.
-- 처음 DB를 만들 때는 자동 실행된다. 이미 초기화된 DB에는 직접 적용 (여러 번 실행해도 결과가 같다):
--   docker compose exec -T db psql -U postgres -d postgres < db/init/09-pdf.sql

-- 원본 파일. 같은 파일(sha256)은 한 번만 둔다. Git 프로젝트의 PDF는 저장소에 있으므로 여기에 두지 않는다.
CREATE TABLE IF NOT EXISTS document_files (
    id          bigserial   PRIMARY KEY,
    sha256      text        NOT NULL UNIQUE,
    mime        text        NOT NULL,
    size_bytes  int         NOT NULL,
    data        bytea       NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- 판이 어떤 원본 파일에서 나왔는지. Markdown 판은 원문이 content 그대로라 비어 있다.
ALTER TABLE document_versions ADD COLUMN IF NOT EXISTS file_id bigint REFERENCES document_files(id);
