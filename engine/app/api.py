"""엔진 HTTP API: 문서 가져오기와 가져온 문서·조각 조회.

실행 (저장소 루트에서):
  docker compose up -d engine worker                                        # 보통은 컨테이너로
  .venv/bin/uvicorn api:app --app-dir engine/app --host 127.0.0.1 --port 8000  # Mac에서 직접 (compose의 engine은 꺼 둔다)

- 가져오기는 ingest.py의 ingest_file을 그대로 부른다 (CLI와 같은 동작).
- 웹(Rust)이 /api/rag/* 요청을 이 서버로 넘겨준다. 브라우저가 직접 부르지 않는다.
- 읽을 수 있는 파일은 .env의 INGEST_ROOTS(콜론으로 구분한 폴더 목록) 안으로 제한한다.
- 가져오기 작업(/jobs): 파일이나 폴더 경로를 받아 문서마다 작업을 만들고 작업 번호를 바로 돌려준다.
  실제 일은 Celery worker(tasks.py)가 Redis 대기열에서 하나씩 꺼내서 한다.
  진행 상황은 ingest_jobs 테이블에 남기고, /jobs/{id}로 조회하거나 /jobs/{id}/events로 스트리밍(SSE)으로 본다.
"""
from __future__ import annotations

import asyncio
import json
from datetime import date
from pathlib import Path
from typing import Literal

import redis
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from psycopg.types.json import Jsonb

from ingest import STAGES, IngestError, connect, ingest_file, load_env
from jobs import JOB_COLUMNS, fetch_job
from tasks import celery, ingest_task

# 작업은 worker가 실행하므로 엔진을 다시 켜도 진행 중인 작업은 영향을 받지 않는다. (끊긴 작업 정리는 worker가 켜질 때 한다)
app = FastAPI(title="rag-ops engine")


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


# 폴더 안의 .md 파일을 모두 찾는다. 숨김 폴더(.git, .obsidian 등)는 건너뛴다.
# 파일마다 resolve_allowed를 다시 거쳐서, 폴더 안에 있지만 밖을 가리키는 링크는 이유와 함께 빼 둔다.
def expand_folder(folder: Path, roots: list[Path]) -> tuple[list[Path], list[dict]]:
    files, skipped = [], []
    for p in sorted(folder.rglob("*.md")):
        if any(part.startswith(".") for part in p.relative_to(folder).parts):
            continue
        try:
            files.append(resolve_allowed(str(p), roots))
        except ValueError as e:
            skipped.append({"path": str(p), "reason": str(e)})
    return files, skipped


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


# ---------- 가져오기 작업 (Celery 대기열 + 상태 기록 + 스트리밍) ----------

# 가져오기 작업을 만든다. 파일이면 1개, 폴더면 안의 .md마다 1개씩. 경로 검사는 바로 하고, 통과한 문서만 대기열에 넣는다.
@app.post("/jobs", status_code=202)
def create_jobs(req: IngestRequest) -> dict:
    roots = allowed_roots()
    target = Path(req.path).expanduser().resolve()
    try:
        if target.is_dir():
            if not any(target.is_relative_to(root.resolve()) for root in roots):
                raise ValueError("허용된 폴더(INGEST_ROOTS) 밖의 경로입니다")
            files, skipped = expand_folder(target, roots)
            if not files and not skipped:
                raise ValueError("폴더 안에 Markdown(.md) 파일이 없습니다")
        else:
            files, skipped = [resolve_allowed(req.path, roots)], []
    except ValueError as e:
        raise HTTPException(400, str(e))

    params = Jsonb(req.model_dump(mode="json", exclude={"path"}))
    created = []
    with connect(load_env()) as conn:
        for path in files:
            # 같은 파일을 가져오는 작업이 이미 대기·진행 중이면 빼 둔다 (저장 단계에서 서로 부딪히지 않게).
            busy = conn.execute("SELECT id FROM ingest_jobs WHERE path=%s AND status IN ('queued', 'running')",
                                (str(path),)).fetchone()
            if busy:
                skipped.append({"path": str(path), "reason": f"같은 문서를 가져오는 작업이 진행 중입니다 (job {busy[0]})"})
                continue
            job_id = conn.execute("INSERT INTO ingest_jobs (path, params) VALUES (%s, %s) RETURNING id",
                                  (str(path), params)).fetchone()[0]
            created.append({"job_id": job_id, "path": str(path)})

    # 작업 행을 커밋한 뒤에 대기열에 넣는다. 그래야 worker가 꺼냈을 때 행이 반드시 있다.
    try:
        for job in created:
            ingest_task.delay(job["job_id"])
    except Exception as e:
        ids = [j["job_id"] for j in created]
        with connect(load_env()) as conn:
            conn.execute("""UPDATE ingest_jobs SET status='failed', error='대기열(Redis)에 넣지 못함', finished_at=now()
                            WHERE id = ANY(%s) AND status='queued'""", (ids,))
        raise HTTPException(503, f"대기열(Redis)에 연결할 수 없습니다: {type(e).__name__}")

    if not created and len(files) == 1 and not target.is_dir():
        raise HTTPException(409, skipped[0]["reason"])
    return {"jobs": created, "skipped": skipped, "stages": STAGES}


# 최근 작업 목록 (기본 20개, 최대 200개).
@app.get("/jobs")
def list_jobs(limit: int = Query(20, ge=1, le=200)) -> list[dict]:
    with connect(load_env()) as conn:
        cur = conn.execute(f"SELECT {JOB_COLUMNS} FROM ingest_jobs ORDER BY id DESC LIMIT %s", (limit,))
        return [dict(zip([c.name for c in cur.description], row)) for row in cur.fetchall()]


# 대기열 상태: worker가 살아 있는지, 지금 무엇을 처리하는지, Redis에 몇 개가 쌓여 있는지, 작업 기록의 상태별 개수.
# worker에게 직접 물어보므로(Celery inspect) worker가 꺼져 있으면 1초 기다린 뒤 빈 목록을 돌려준다.
@app.get("/queue")
def queue_status() -> dict:
    workers, redis_waiting, problems = [], None, []
    try:
        active = celery.control.inspect(timeout=1.0).active() or {}
        workers = [{"name": name, "active_job_ids": [t["args"][0] for t in tasks if t.get("args")]}
                   for name, tasks in sorted(active.items())]
    except Exception as e:
        problems.append(f"worker 조회 실패: {type(e).__name__}")
    try:
        # Celery 기본 대기열은 Redis의 'celery' 목록(list)이다. worker가 이미 꺼낸 작업은 여기 없다.
        with redis.Redis.from_url(load_env().get("REDIS_URL", "redis://127.0.0.1:6379/0"), socket_timeout=2) as r:
            redis_waiting = r.llen("celery")
    except Exception as e:
        problems.append(f"Redis 조회 실패: {type(e).__name__}")
    with connect(load_env()) as conn:
        counts = dict(conn.execute("SELECT status, count(*) FROM ingest_jobs GROUP BY status").fetchall())
    return {
        "online": bool(workers), "workers": workers, "redis_waiting": redis_waiting,
        "jobs": {k: counts.get(k, 0) for k in ("queued", "running", "done", "failed")},
        "problems": problems,
    }


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
