-- 평가 질문 초안: LLM이 문서 조각을 보고 만든 질문. 사람이 고른 것만 eval/questions.jsonl에 들어간다.
-- 처음 DB를 만들 때는 자동 실행된다. 이미 초기화된 DB에는 직접 적용 (여러 번 실행해도 결과가 같다):
--   docker compose exec -T db psql -U postgres -d postgres < db/init/06-eval-drafts.sql
-- 문서 원문 일부(질문·답·근거 문장)가 들어가므로, 회사 문서를 넣으면 이 표도 회사 자료로 다룬다.
CREATE TABLE IF NOT EXISTS eval_drafts (
    id            bigserial   PRIMARY KEY,
    batch         text        NOT NULL,                 -- 한 번의 [초안 만들기] 요청
    created_at    timestamptz NOT NULL DEFAULT now(),
    status        text        NOT NULL DEFAULT 'pending',  -- pending(고르기 전) / accepted(넣음) / discarded(버림)
    kind          text        NOT NULL,                 -- 직접 / 표현 바꿈 ("답 없음"은 사람이 쓴다)
    question      text        NOT NULL,
    answer        text,
    path          text        NOT NULL,                 -- 근거 문서 (documents.source_path)
    heading       text,
    quote         text        NOT NULL,                 -- 근거 문장. 조각 원문과 글자 그대로 맞는 것만 남긴다
    chunk_id      bigint,                               -- 초안을 만든 조각 (만들 때의 색인)
    pair_id       bigint,                               -- 표현 바꿈 초안이면 같은 조각에서 나온 직접 초안 id
    model         text,
    input_tokens  int         NOT NULL DEFAULT 0,       -- 조각 하나에 한 번 부르므로, 직접 초안 쪽에만 기록한다
    output_tokens int         NOT NULL DEFAULT 0,
    cost_usd      numeric(12, 8),
    question_id   text,                                 -- 넣었으면 시험지의 질문 id
    decided_at    timestamptz
);
CREATE INDEX IF NOT EXISTS eval_drafts_status ON eval_drafts (status, id);
