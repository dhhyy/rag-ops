-- 사용 기록: 질문 하나마다 한 행. 비용·지연·오류를 서비스 단위로 모아 보려고 남긴다.
-- service: 어느 서비스에서 온 질문인지 (지금은 playground 하나). 엔진과 서비스를 나눌 때 이 칸으로 구분한다.
-- 질문과 답 원문이 들어가므로, 회사 문서를 넣으면 이 표도 회사 자료로 다룬다.
CREATE TABLE IF NOT EXISTS usage_log (
    id             bigserial   PRIMARY KEY,
    service        text        NOT NULL DEFAULT 'playground',
    created_at     timestamptz NOT NULL DEFAULT now(),
    status         text        NOT NULL,              -- ok / error / stopped
    question       text        NOT NULL,
    setup          jsonb       NOT NULL,              -- 그때의 색인·리랭크·답변 설정 (사람이 읽는 이름 포함)
    hits           jsonb       NOT NULL DEFAULT '[]', -- 근거 후보: [{chunk_id, document_id, title, heading}]
    answer         text,
    sources        int[],                             -- LLM에 보낸 근거 번호
    embed_tokens   int         NOT NULL DEFAULT 0,
    input_tokens   int         NOT NULL DEFAULT 0,
    cached_tokens  int         NOT NULL DEFAULT 0,
    output_tokens  int         NOT NULL DEFAULT 0,
    cost_usd       numeric(12, 8),                    -- 임베딩 + 답변. 단가를 모르면 NULL
    latency_ms     jsonb       NOT NULL DEFAULT '{}', -- {embed, db, rerank, answer, total}
    error          text
);
CREATE INDEX IF NOT EXISTS usage_log_service_time ON usage_log (service, created_at DESC);
