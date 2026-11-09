"""엔진 HTTP API: 문서 가져오기와 가져온 문서·조각 조회.

실행 (저장소 루트에서):
  .venv/bin/uvicorn api:app --app-dir engine/app --host 127.0.0.1 --port 8000

- 가져오기는 ingest.py의 ingest_file을 그대로 부른다 (CLI와 같은 동작).
- 웹(Rust)이 /api/rag/* 요청을 이 서버로 넘겨준다. 브라우저가 직접 부르지 않는다.
- 읽을 수 있는 파일은 .env의 INGEST_ROOTS(콜론으로 구분한 폴더 목록) 안으로 제한한다.
- 가져오기 작업(/jobs): 요청하면 작업 번호를 바로 돌려주고, 실제 일은 백그라운드 스레드에서 한다.
  진행 상황은 ingest_jobs 테이블에 남기고, /jobs/{id}로 조회하거나 /jobs/{id}/events로 스트리밍(SSE)으로 본다.
"""
from __future__ import annotations

import asyncio
import json
import threading
from contextlib import asynccontextmanager
from datetime import date
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from psycopg.types.json import Jsonb

from ingest import STAGES, IngestError, connect, ingest_file, load_env


# 서버가 켜질 때, 이전 실행에서 끝나지 못한 작업(대기·진행)을 실패로 정리한다. 백그라운드 스레드는 서버와 함께 사라지기 때문이다.
@asynccontextmanager
async def lifespan(_: FastAPI):
    with connect(load_env()) as conn:
        conn.execute("""UPDATE ingest_jobs SET status='failed', error='서버 재시작으로 중단', finished_at=now()
                        WHERE status IN ('queued', 'running')""")
    yield


app = FastAPI(title="rag-ops engine", lifespan=lifespan)


# 가져오기 요청 본문. 메타데이터 값은 documents 테이블 주석에 적힌 선택지로 제한한다.
class IngestRequest(BaseModel):
    path: str
    env: Literal["운영", "개발", "샘플", "혼합"] | None = None
    doc_type: Literal["설정", "실행 결과", "해설", "장애 기록"] | None = None
    verification: Literal["확인", "추정", "미확인", "폐기"] = "미확인"
    checked_at: date | None = None
    external_ok: bool = False


# .env의 INGEST_ROOTS를 폴더 목록으로 읽는다. 값이 없으면 아무 파일도 읽지 못하게 빈 목록을 돌려준다.
def allowed_roots() -> list[Path]:
    raw = load_env().get("INGEST_ROOTS", "")
    return [Path(p).expanduser() for p in raw.split(":") if p.strip()]


# 웹에서 받은 경로가 허용 폴더 안의 파일인지 검사하고, 안전하게 정리한 경로를 돌려준다.
def resolve_allowed(raw_path: str, roots: list[Path]) -> Path:
    """허용 폴더 안의 실제 파일이면 정리한 Path를 돌려주고, 아니면 ValueError를 던진다.

    고려할 것:
      - "../" 로 허용 폴더 밖으로 나가는 경로
      - 허용 폴더 안에 있지만 밖을 가리키는 심볼릭 링크
      - 폴더나 없는 파일, .md가 아닌 파일
    """
    # resolve()로 심볼릭 링크와 ".."를 먼저 풀어야 "폴더 안처럼 보이지만 밖"인 경로를 잡을 수 있다.
    path = Path(raw_path).expanduser().resolve()
    if not any(path.is_relative_to(root.resolve()) for root in roots):
        raise ValueError("허용된 폴더(INGEST_ROOTS) 밖의 경로입니다")
    if path.suffix.lower() != ".md":
        raise ValueError("Markdown(.md) 파일만 가져올 수 있습니다")
    if not path.is_file():
        raise ValueError("파일이 없습니다")
    return path


# 서버가 떠 있는지 확인용.
@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


# 문서 1개를 가져온다. 경로 검사 → ingest_file 실행 → 결과(inserted/replaced/skipped)를 돌려준다.
@app.post("/documents")
def create_document(req: IngestRequest) -> dict:
    try:
        path = resolve_allowed(req.path, allowed_roots())
    except NotImplementedError as e:
        raise HTTPException(501, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))
    try:
        return ingest_file(path, env_label=req.env, doc_type=req.doc_type, verification=req.verification,
                           checked_at=req.checked_at.isoformat() if req.checked_at else None,
                           external_ok=req.external_ok)
    except IngestError as e:
        raise HTTPException(422, str(e))


# 가져온 문서 목록. 출처·메타데이터와 조각 수를 최근에 가져온 순서로 보여 준다.
@app.get("/documents")
def list_documents() -> list[dict]:
    with connect(load_env()) as conn:
        cur = conn.execute(
            """SELECT d.id, d.source_repo, d.source_path, d.source_commit, d.title, d.env, d.doc_type,
                      d.verification, d.checked_at, d.external_ok, d.ingested_at, count(c.id) AS chunks
               FROM documents d LEFT JOIN chunks c ON c.document_id = d.id
               GROUP BY d.id ORDER BY d.ingested_at DESC"""
        )
        cols = [c.name for c in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]


# ---------- 가져오기 작업 (백그라운드 + 상태 기록 + 스트리밍) ----------

JOB_COLUMNS = ("id, path, params, status, stage, stage_index, progress_done, progress_total, "
               "error, result, created_at, started_at, finished_at")


# 작업 1행을 dict로 읽는다. 없으면 None.
def fetch_job(job_id: int) -> dict | None:
    with connect(load_env()) as conn:
        cur = conn.execute(f"SELECT {JOB_COLUMNS} FROM ingest_jobs WHERE id=%s", (job_id,))
        row = cur.fetchone()
        return dict(zip([c.name for c in cur.description], row)) if row else None


# 작업 행의 일부 칸을 바꾼다. 단계가 바뀔 때마다 짧은 트랜잭션으로 바로 커밋해서, 조회·스트리밍 쪽이 곧바로 보게 한다.
NOW = object()  # update_job에 넘기면 DB 시각 now()로 기록한다


def update_job(job_id: int, **fields) -> None:
    sets = ", ".join(f"{k}=now()" if v is NOW else f"{k}=%({k})s" for k, v in fields.items())
    params = {k: v for k, v in fields.items() if v is not NOW}
    with connect(load_env()) as conn:
        conn.execute(f"UPDATE ingest_jobs SET {sets} WHERE id=%(id)s", {**params, "id": job_id})


# 백그라운드 스레드에서 도는 실제 작업. ingest_file의 단계 알림을 받아 작업 행에 기록하고, 끝나면 완료·실패를 남긴다.
def run_job(job_id: int, path: Path, req: IngestRequest) -> None:
    def on_step(name: str, done: int | None, total: int | None) -> None:
        update_job(job_id, stage=name, stage_index=STAGES.index(name) + 1,
                   progress_done=done, progress_total=total)

    update_job(job_id, status="running", started_at=NOW)
    try:
        result = ingest_file(path, env_label=req.env, doc_type=req.doc_type, verification=req.verification,
                             checked_at=req.checked_at.isoformat() if req.checked_at else None,
                             external_ok=req.external_ok, on_step=on_step)
        update_job(job_id, status="done", result=Jsonb(result), finished_at=NOW)
    except IngestError as e:
        update_job(job_id, status="failed", error=str(e), finished_at=NOW)
    except Exception as e:  # TEI·DB 오류 등 예상 못 한 실패도 어느 단계였는지와 함께 남긴다
        update_job(job_id, status="failed", error=f"{type(e).__name__}: {e}", finished_at=NOW)


# 가져오기 작업을 만든다. 경로 검사는 바로 하고(실패하면 작업을 만들지 않음), 통과하면 작업 번호를 즉시 돌려준다.
@app.post("/jobs", status_code=202)
def create_job(req: IngestRequest) -> dict:
    try:
        path = resolve_allowed(req.path, allowed_roots())
    except ValueError as e:
        raise HTTPException(400, str(e))
    with connect(load_env()) as conn:
        # 같은 파일을 가져오는 작업이 이미 대기·진행 중이면 거절한다 (저장 단계에서 서로 부딪히지 않게).
        busy = conn.execute("SELECT id FROM ingest_jobs WHERE path=%s AND status IN ('queued', 'running')",
                            (str(path),)).fetchone()
        if busy:
            raise HTTPException(409, f"같은 문서를 가져오는 작업이 진행 중입니다 (job {busy[0]})")
        job_id = conn.execute(
            "INSERT INTO ingest_jobs (path, params) VALUES (%s, %s) RETURNING id",
            (str(path), Jsonb(req.model_dump(mode="json", exclude={"path"}))),
        ).fetchone()[0]
    threading.Thread(target=run_job, args=(job_id, path, req), daemon=True).start()
    return {"job_id": job_id, "status": "queued", "stages": STAGES}


# 최근 작업 20개.
@app.get("/jobs")
def list_jobs() -> list[dict]:
    with connect(load_env()) as conn:
        cur = conn.execute(f"SELECT {JOB_COLUMNS} FROM ingest_jobs ORDER BY id DESC LIMIT 20")
        return [dict(zip([c.name for c in cur.description], row)) for row in cur.fetchall()]


# 작업 하나의 지금 상태. 화면을 새로 열었을 때 여기서 현재 상태를 받고, 진행 중이면 스트림을 연다.
@app.get("/jobs/{job_id}")
def get_job(job_id: int) -> dict:
    job = fetch_job(job_id)
    if job is None:
        raise HTTPException(404, f"job {job_id} 없음")
    return job


# 스트리밍(SSE): 작업 행을 0.3초마다 읽어 바뀐 것이 있으면 이벤트로 보낸다. 완료·실패하면 마지막 이벤트를 보내고 닫는다.
# 상태를 DB에서 읽기 때문에, 연결이 끊겼다가 다시 열어도 같은 흐름을 이어서 볼 수 있다.
@app.get("/jobs/{job_id}/events")
async def job_events(job_id: int) -> StreamingResponse:
    if await asyncio.to_thread(fetch_job, job_id) is None:
        raise HTTPException(404, f"job {job_id} 없음")

    async def stream():
        last = None
        while True:
            job = await asyncio.to_thread(fetch_job, job_id)
            snapshot = (job["status"], job["stage"], job["progress_done"])
            if snapshot != last:  # 바뀐 것이 있을 때만 보낸다
                last = snapshot
                event = job["status"] if job["status"] in ("done", "failed") else "progress"
                yield f"event: {event}\ndata: {json.dumps(job, default=str, ensure_ascii=False)}\n\n"
            if job["status"] in ("done", "failed"):
                return
            await asyncio.sleep(0.3)

    # 프록시가 모았다가 보내지 않도록 캐시·버퍼링을 끈다.
    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# 문서 하나의 조각 목록. 벡터(embedding)는 크고 화면에 쓸 일이 없어서 뺀다.
@app.get("/documents/{doc_id}/chunks")
def list_chunks(doc_id: int) -> list[dict]:
    with connect(load_env()) as conn:
        if conn.execute("SELECT 1 FROM documents WHERE id=%s", (doc_id,)).fetchone() is None:
            raise HTTPException(404, f"document {doc_id} 없음")
        cur = conn.execute(
            """SELECT chunk_index, heading_path, token_count, content, embed_text
               FROM chunks WHERE document_id=%s ORDER BY chunk_index""",
            (doc_id,),
        )
        cols = [c.name for c in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]
