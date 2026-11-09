-- 가져오기 작업 기록. 작업 하나 = 1행. 단계가 바뀔 때마다 갱신한다
-- 이미 초기화된 DB에는 자동 실행되지 않는다. 직접 적용:
--   docker compose exec -T db psql -U postgres -d postgres < db/init/03-ingest-jobs.sql

CREATE TABLE IF NOT EXISTS ingest_jobs (
    id              bigserial PRIMARY KEY,
    path            text        NOT NULL,                   -- 가져올 문서 경로 (경로 검사를 통과한 값)
    params          jsonb       NOT NULL DEFAULT '{}',      -- 요청 메타데이터 (환경·자료 성격·검증 상태 등)
    status          text        NOT NULL DEFAULT 'queued'   -- 대기 / 진행 / 완료 / 실패
                    CHECK (status IN ('queued', 'running', 'done', 'failed')),
    stage           text,                                   -- 현재 단계 이름 (확인 / 중복 확인 / 청킹 / 토큰 검사 / 임베딩 / 저장)
    stage_index     int,                                    -- 현재 단계 번호 (1~6)
    progress_done   int,                                    -- 임베딩처럼 나눠서 하는 단계의 진행 수
    progress_total  int,
    error           text,                                   -- 실패 이유. 실패한 단계는 stage에 남는다
    result          jsonb,                                  -- 완료 결과 (inserted/replaced/skipped, document_id 등)
    created_at      timestamptz NOT NULL DEFAULT now(),
    started_at      timestamptz,
    finished_at     timestamptz
);

-- 같은 경로의 작업이 진행 중인지 빨리 찾기 위한 색인
CREATE INDEX IF NOT EXISTS ingest_jobs_path_status ON ingest_jobs (path, status);
