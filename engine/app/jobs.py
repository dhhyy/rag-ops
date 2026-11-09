"""가져오기 작업(ingest_jobs 테이블) 기록과 실행. API(작업 만들기·조회)와 Celery worker(실행)가 함께 쓴다.

작업 하나 = 문서 하나. 상태는 queued(대기) → running(진행) → done(완료) / failed(실패) 순서로만 바뀐다.
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

    def on_step(name: str, done: int | None, total: int | None) -> None:
        update_job(job_id, stage=name, stage_index=STAGES.index(name) + 1,
                   progress_done=done, progress_total=total)

    try:
        result = ingest_file(Path(path), env_label=params.get("env"), doc_type=params.get("doc_type"),
                             verification=params.get("verification") or "미확인",
                             checked_at=params.get("checked_at"), external_ok=bool(params.get("external_ok")),
                             on_step=on_step)
        update_job(job_id, status="done", result=Jsonb(result), finished_at=NOW)
    except IngestError as e:
        update_job(job_id, status="failed", error=str(e), finished_at=NOW)
    except Exception as e:  # TEI·DB 오류 등 예상 못 한 실패도 어느 단계였는지와 함께 남긴다
        update_job(job_id, status="failed", error=f"{type(e).__name__}: {e}", finished_at=NOW)
