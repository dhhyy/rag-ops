"""작업(ingest_jobs 테이블) 기록과 실행. API(작업 만들기·조회)와 Celery worker(실행)가 함께 쓴다.

작업 종류(params.kind):
  ingest  문서 하나를 가져와 기본 색인에 넣는다 (기본값)
  build   저장된 문서 하나를 다른 색인에 넣는다 (색인 만들기·갱신)
  eval    현재 설정으로 평가를 돌린다
상태는 queued(대기) → running(진행) → done(완료) / failed(실패) 순서로만 바뀐다.
"""
from __future__ import annotations

from pathlib import Path

from psycopg.types.json import Jsonb

from ingest import STAGES, IngestError, connect, ingest_file, load_env

JOB_COLUMNS = ("id, path, params, status, stage, stage_index, progress_done, progress_total, "
               "error, result, created_at, started_at, finished_at")

NOW = object()  # update_job에 넘기면 DB 시각 now()로 기록한다


# 작업 1행을 dict로 읽는다. 없으면 None.
def fetch_job(job_id: int) -> dict | None:
    with connect(load_env()) as conn:
        cur = conn.execute(f"SELECT {JOB_COLUMNS} FROM ingest_jobs WHERE id=%s", (job_id,))
        row = cur.fetchone()
        return dict(zip([c.name for c in cur.description], row)) if row else None


# 작업 행의 일부 칸을 바꾼다. 단계가 바뀔 때마다 짧은 트랜잭션으로 바로 커밋해서, 조회·스트리밍 쪽이 곧바로 보게 한다.
def update_job(job_id: int, **fields) -> None:
    sets = ", ".join(f"{k}=now()" if v is NOW else f"{k}=%({k})s" for k, v in fields.items())
    params = {k: v for k, v in fields.items() if v is not NOW}
    with connect(load_env()) as conn:
        conn.execute(f"UPDATE ingest_jobs SET {sets} WHERE id=%(id)s", {**params, "id": job_id})


# 대기 중인 작업을 '진행'으로 바꾸면서 가져간다. 이미 가져갔거나 끝난 작업이면 None.
# 같은 작업 번호가 대기열에 두 번 들어가도(worker 재시작 때 다시 넣는 경우) 한 번만 실행되게 하는 장치다.
def claim_job(job_id: int) -> tuple[str, dict] | None:
    with connect(load_env()) as conn:
        row = conn.execute(
            """UPDATE ingest_jobs SET status='running', started_at=now()
               WHERE id=%s AND status='queued' RETURNING path, params""",
            (job_id,),
        ).fetchone()
    return (row[0], row[1] or {}) if row else None


# worker가 부르는 실제 작업. ingest_file의 단계 알림을 받아 작업 행에 기록하고, 끝나면 완료·실패를 남긴다.
def run_job(job_id: int) -> None:
    claimed = claim_job(job_id)
    if claimed is None:
        return
    path, params = claimed

    # 가져오기·색인 작업은 6단계(STAGES) 번호를 남기고, 평가처럼 단계가 다른 작업은 이름만 남긴다.
    def on_step(name: str, done: int | None, total: int | None) -> None:
        update_job(job_id, stage=name, stage_index=STAGES.index(name) + 1 if name in STAGES else None,
                   progress_done=done, progress_total=total)

    kind = params.get("kind", "ingest")
    try:
        if kind == "build":
            from indexes import build_document
            result = build_document(int(params["index_id"]), int(params["document_id"]), on_step)
        elif kind == "eval":
            from evaluate import run_eval
            result = run_eval(label=params.get("label", ""), on_step=on_step,
                              index_id=int(params["index_id"]) if params.get("index_id") else None,
                              reranker=params.get("reranker"), keyword=params.get("keyword"),
                              answers=bool(params.get("answers")))
        else:
            result = ingest_file(Path(path), env_label=params.get("env"), doc_type=params.get("doc_type"),
                                 verification=params.get("verification") or "미확인",
                                 checked_at=params.get("checked_at"), external_ok=bool(params.get("external_ok")),
                                 on_step=on_step)
        update_job(job_id, status="done", result=Jsonb(result), finished_at=NOW)
        if kind == "build" and params.get("apply"):
            apply_when_built(int(params["index_id"]), params.get("batch", ""))
    except IngestError as e:
        update_job(job_id, status="failed", error=str(e), finished_at=NOW)
    except Exception as e:  # TEI·DB 오류 등 예상 못 한 실패도 어느 단계였는지와 함께 남긴다
        update_job(job_id, status="failed", error=f"{type(e).__name__}: {e}", finished_at=NOW)


# 색인 만들기 요청에서 "만들고 적용"을 골랐으면, 같은 요청(batch)의 작업이 모두 성공으로 끝났을 때 현재 설정을 그 색인으로 바꾼다.
# 하나라도 실패했거나 아직 남아 있으면 바꾸지 않는다 (덜 만든 색인으로 검색하지 않게).
def apply_when_built(index_id: int, batch: str) -> None:
    with connect(load_env()) as conn:
        left = conn.execute(
            """SELECT count(*) FILTER (WHERE status IN ('queued', 'running')), count(*) FILTER (WHERE status = 'failed')
               FROM ingest_jobs WHERE params->>'kind' = 'build' AND params->>'batch' = %s""", (batch,)).fetchone()
        if left[0] == 0 and left[1] == 0:
            conn.execute("UPDATE active_setup SET index_id=%s, updated_at=now() WHERE id=1", (index_id,))
