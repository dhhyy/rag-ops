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
import time
import uuid
from datetime import date
from pathlib import Path
from typing import Literal

import anyio
import redis
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from psycopg.types.json import Jsonb

import components as comp
import evaluate
import indexes
import questions
from ingest import STAGES, IngestError, connect, ingest_file, load_env
from jobs import JOB_COLUMNS, fetch_job
from search import answer, hit_dict, load_setup, query_defaults, retrieve_steps
from tasks import celery, ingest_task
import telemetry
import usage

# 작업은 worker가 실행하므로 엔진을 다시 켜도 진행 중인 작업은 영향을 받지 않는다. (끊긴 작업 정리는 worker가 켜질 때 한다)
app = FastAPI(title="rag-ops engine")
# 추적: 요청마다 구간을 남긴다. 화면이 자주 부르는 상태 조회(health, queue, 진행 스트림, 사용 기록)는 빼서 잡음을 줄인다
if telemetry.setup("rag-ops-engine"):
    from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
    FastAPIInstrumentor.instrument_app(app, excluded_urls="health,queue,jobs/[0-9]+/events,usage")


# 가져오기 요청 본문. 메타데이터 값은 documents 테이블 주석에 적힌 선택지로 제한한다.
class IngestRequest(BaseModel):
    path: str
    env: Literal["운영", "개발", "샘플", "혼합"] | None = None
    doc_type: Literal["설정", "실행 결과", "해설", "장애 기록"] | None = None
    verification: Literal["확인", "추정", "미확인", "폐기"] = "미확인"
    checked_at: date | None = None
    # 비우면 폴더로 정한다: EXTERNAL_OK_ROOTS 안의 문서만 허용, 나머지(회사 문서 등)는 불가
    external_ok: bool | None = None


# .env의 INGEST_ROOTS를 폴더 목록으로 읽는다. 값이 없으면 아무 파일도 읽지 못하게 빈 목록을 돌려준다.
def allowed_roots() -> list[Path]:
    raw = load_env().get("INGEST_ROOTS", "")
    return [Path(p).expanduser() for p in raw.split(":") if p.strip()]


# 외부 API로 보내도 되는 폴더 목록(.env의 EXTERNAL_OK_ROOTS). 비어 있으면 모든 문서가 기본 "불가"다.
def external_ok_roots() -> list[Path]:
    raw = load_env().get("EXTERNAL_OK_ROOTS", "")
    return [Path(p).expanduser().resolve() for p in raw.split(":") if p.strip()]


# 요청에 값이 없으면 문서 위치로 외부 전송 기본값을 정한다. 목록에 없는 폴더는 안전하게 "불가".
def default_external(path: Path, given: bool | None, roots: list[Path]) -> bool:
    if given is not None:
        return given
    return any(path.is_relative_to(root) for root in roots)


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
                           external_ok=default_external(path, req.external_ok, external_ok_roots()))
    except IngestError as e:
        raise HTTPException(422, str(e))


# 가져온 문서 목록. 출처·메타데이터와 조각 수를 최근에 가져온 순서로 보여 준다.
@app.get("/documents")
def list_documents() -> list[dict]:
    with connect(load_env()) as conn:
        cur = conn.execute(
            """SELECT d.id, d.source_repo, d.source_path, d.source_commit, d.title, d.env, d.doc_type,
                      d.verification, d.checked_at, d.external_ok, d.ingested_at, count(c.id) AS chunks
               FROM documents d
               LEFT JOIN chunks c ON c.document_id = d.id AND c.index_id = (SELECT id FROM indexes WHERE is_base)
               GROUP BY d.id ORDER BY d.ingested_at DESC"""
        )
        cols = [c.name for c in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]


# ---------- 가져오기 작업 (Celery 대기열 + 상태 기록 + 스트리밍) ----------

# 작업 행을 커밋한 뒤에 대기열에 넣는다. 그래야 worker가 꺼냈을 때 행이 반드시 있다.
# Redis에 넣지 못하면 그 작업들을 실패로 표시하고 503을 돌려준다.
def enqueue(job_ids: list[int]) -> None:
    try:
        for job_id in job_ids:
            ingest_task.delay(job_id)
    except Exception as e:
        with connect(load_env()) as conn:
            conn.execute("""UPDATE ingest_jobs SET status='failed', error='대기열(Redis)에 넣지 못함', finished_at=now()
                            WHERE id = ANY(%s) AND status='queued'""", (job_ids,))
        raise HTTPException(503, f"대기열(Redis)에 연결할 수 없습니다: {type(e).__name__}")

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

    base_params = req.model_dump(mode="json", exclude={"path"}) | {"kind": "ingest"}
    ok_roots = external_ok_roots()
    created = []
    with connect(load_env()) as conn:
        for path in files:
            # 같은 파일을 가져오는 작업이 이미 대기·진행 중이면 빼 둔다 (저장 단계에서 서로 부딪히지 않게).
            busy = conn.execute("SELECT id FROM ingest_jobs WHERE path=%s AND status IN ('queued', 'running')",
                                (str(path),)).fetchone()
            if busy:
                skipped.append({"path": str(path), "reason": f"같은 문서를 가져오는 작업이 진행 중입니다 (job {busy[0]})"})
                continue
            params = Jsonb(base_params | {"external_ok": default_external(path, req.external_ok, ok_roots)})
            job_id = conn.execute("INSERT INTO ingest_jobs (path, params) VALUES (%s, %s) RETURNING id",
                                  (str(path), params)).fetchone()[0]
            created.append({"job_id": job_id, "path": str(path)})

    enqueue([j["job_id"] for j in created])
    if not created and len(files) == 1 and not target.is_dir():
        raise HTTPException(409, skipped[0]["reason"])
    return {"jobs": created, "skipped": skipped, "stages": STAGES}


# 최근 작업 목록 (기본 20개, 최대 200개). kind로 종류를 고를 수 있다 (예: kind=ingest,build).
@app.get("/jobs")
def list_jobs(limit: int = Query(20, ge=1, le=200), kind: str | None = None) -> list[dict]:
    kinds = [k for k in (kind or "").split(",") if k]
    with connect(load_env()) as conn:
        cur = conn.execute(f"""SELECT {JOB_COLUMNS} FROM ingest_jobs
                               WHERE %(all)s OR coalesce(params->>'kind', 'ingest') = ANY(%(kinds)s)
                               ORDER BY id DESC LIMIT %(limit)s""",
                           {"all": not kinds, "kinds": kinds, "limit": limit})
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


# ---------- 검색 (Playground) ----------

class SearchRequest(BaseModel):
    question: str
    rerank: Literal["setting", "off"] = "setting"   # off: 이번 질문만 리랭크 없이
    answer: Literal["setting", "off"] = "setting"   # off: 이번 질문만 답변 없이 (검색만)


# 동기 제너레이터를 한 단계씩 스레드에서 돌린다. 화면이 연결을 끊어 응답이 취소되면,
# 돌고 있던 단계가 끝난 뒤 제너레이터를 닫아 finally(사용 기록)가 반드시 실행되게 한다.
_END = object()


async def closing_stream(gen):
    try:
        while True:
            item = await anyio.to_thread.run_sync(next, gen, _END)
            if item is _END:
                break
            yield item
    finally:
        with anyio.CancelScope(shield=True):
            await anyio.to_thread.run_sync(gen.close)


# 현재 설정으로 검색하면서 단계마다 한 줄씩(JSON Lines) 흘려보낸다.
#   {"type":"start"…} → {"type":"embedded"} → {"type":"candidates", hits(벡터 순 상위 k)} → {"type":"rerank", done, total}… → {"type":"done", hits}
# 화면이 연결을 끊으면(멈추기) 다음 리랭크 묶음 전에 멈춘다. 끝나면 사용 기록(usage_log)에 한 행 남긴다.
@app.post("/search")
def search_stream(req: SearchRequest) -> StreamingResponse:
    question = req.question.strip()
    if not question or len(question) > 2000:
        raise HTTPException(400, "질문은 1~2000자로 적어 주세요")
    env = load_env()
    with connect(env) as conn:
        setup = load_setup(conn)
    query = setup["query"] if req.rerank == "setting" else {**setup["query"], "reranker": None}
    index, k = setup["index"], setup["query"]["top_k"]
    if query["reranker"]:
        ok, reason = comp.RERANKERS[query["reranker"]["id"]].availability(env)
        if not ok:
            raise HTTPException(409, reason)

    def line(obj: dict) -> str:
        return json.dumps(obj, ensure_ascii=False, default=str) + "\n"

    # 사용 기록에 남길 설정 요약 (사람이 읽는 이름 포함)
    setup_rec = {"index_id": index["id"], "embedder": comp.describe("embedder", index["embedder"]),
                 "reranker": comp.describe("reranker", query["reranker"]) if query["reranker"] else None,
                 "keyword": comp.describe("keyword", query["keyword"]) if query["keyword"] else None,
                 "generator": comp.describe("generator", query["generator"]) if query["generator"] and req.answer == "setting" else None,
                 "top_k": k}

    def stream():
        t_start = time.perf_counter()
        rec: dict = {"status": "stopped", "question": question, "setup": setup_rec, "latency_ms": {},
                     "trace_id": telemetry.current_trace_id()}
        cost = 0.0
        priced = False
        try:
            yield line({"type": "start", "price_checked": comp.PRICE_CHECKED, "top_k": k, "index_id": index["id"],
                        "embedder": setup_rec["embedder"], "external": comp.is_external("embedder", index["embedder"]),
                        "reranker": setup_rec["reranker"], "keyword": setup_rec["keyword"],
                        "candidates": int(query["reranker"]["params"]["candidates"]) if query["reranker"] else None})
            final: list[dict] = []
            try:
                for kind, value in retrieve_steps(env, index, query, question, k):
                    if kind == "embedded":
                        rec["embed_tokens"] = value[1]
                        if value[2] is not None:
                            cost, priced = cost + value[2], True
                        yield line({"type": "embedded", "ms": round(value[0] * 1000), "tokens": value[1], "cost_usd": value[2]})
                    elif kind == "candidates":
                        hits, t_db = value
                        yield line({"type": "candidates", "ms": round(t_db * 1000), "count": len(hits),
                                    "hits": [hit_dict(h) for h in hits[:k]]})
                    elif kind == "reranked":
                        yield line({"type": "rerank", "done": value[0], "total": value[1]})
                    else:
                        lat = {key: round(v * 1000) for key, v in value["latency"].items()}
                        rec["latency_ms"] = dict(lat)
                        final = value["hits"][:k]
                        shown = [hit_dict(h) for h in final]
                        rec["hits"] = [{"chunk_id": h["chunk_id"], "document_id": h["document_id"], "title": h["title"],
                                        "heading": h["heading_path"]} for h in shown]
                        yield line({"type": "done", "latency_ms": lat, "hits": shown})
            except IngestError as e:
                rec.update(status="error", error=str(e))
                yield line({"type": "error", "message": str(e)})
                return
            gen = query["generator"] if req.answer == "setting" else None
            if gen and final:
                yield line({"type": "answering", "generator": comp.describe("generator", gen)})
                try:
                    out = answer(env, gen, question, final)
                except comp.ComponentError as e:
                    rec.update(status="error", error=f"답변: {e}")
                    yield line({"type": "answer_error", "message": str(e)})
                    return
                rec.update(answer=out.get("text"), sources=out.get("sources"), input_tokens=out.get("input_tokens", 0),
                           cached_tokens=out.get("cached_tokens", 0), output_tokens=out.get("output_tokens", 0))
                rec["latency_ms"]["answer"] = out.get("ms", 0)
                if out.get("cost_usd") is not None:
                    cost, priced = cost + out["cost_usd"], True
                yield line({"type": "answer", **out})
            rec["status"] = "ok"
        finally:
            # 정상·오류·멈춤(화면이 연결을 끊음) 모두 여기서 한 번 기록한다
            rec["latency_ms"]["total"] = round((time.perf_counter() - t_start) * 1000)
            rec["cost_usd"] = round(cost, 8) if priced else None
            usage.record(env, rec)

    return StreamingResponse(closing_stream(stream()), media_type="application/x-ndjson",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# 문서 하나의 조각 목록 (기본 색인, 또는 index_id로 고른 색인). 벡터(embedding)는 크고 화면에 쓸 일이 없어서 뺀다.
@app.get("/documents/{doc_id}/chunks")
def list_chunks(doc_id: int, index_id: int | None = None) -> list[dict]:
    with connect(load_env()) as conn:
        if conn.execute("SELECT 1 FROM documents WHERE id=%s", (doc_id,)).fetchone() is None:
            raise HTTPException(404, f"document {doc_id} 없음")
        cur = conn.execute(
            """SELECT chunk_index, heading_path, token_count, content, embed_text
               FROM chunks WHERE document_id=%s
                 AND index_id = coalesce(%s, (SELECT id FROM indexes WHERE is_base))
               ORDER BY chunk_index""",
            (doc_id, index_id),
        )
        cols = [c.name for c in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]


# ---------- 단계 구현·색인·현재 설정 (웹의 Pipeline 단계 패널) ----------

# 단계 설정 하나: {"id": 구현 이름, "params": {...}}
class StageSetting(BaseModel):
    id: str
    params: dict[str, str] = {}


class IndexRequest(BaseModel):
    chunker: StageSetting
    embedder: StageSetting
    apply: bool = True   # 다 만들어지면 현재 설정으로 바꾼다


def normalized(req: IndexRequest) -> tuple[dict, dict]:
    try:
        return (comp.normalize("chunker", req.chunker.model_dump()), comp.normalize("embedder", req.embedder.model_dump()))
    except comp.ComponentError as e:
        raise HTTPException(400, str(e))


# 단계마다 고를 수 있는 구현과 파라미터, 지금 쓸 수 있는지와 이유. 비밀값(API 키)은 있음/없음만 알려 준다.
@app.get("/components")
def components_catalog() -> dict:
    return comp.catalog(load_env())


@app.get("/indexes")
def list_indexes() -> list[dict]:
    return indexes.list_indexes()


# 조합을 고르면 바로 보여 줄 미리보기 (색인이 있는지, 만들면 얼마나 걸리는지, 막힌 문서가 있는지). 아무것도 바꾸지 않는다.
@app.post("/indexes/estimate")
def estimate_index(req: IndexRequest) -> dict:
    chunker, embedder = normalized(req)
    return indexes.estimate(chunker, embedder)


# 색인 만들기·갱신 작업을 문서마다 하나씩 대기열에 넣는다. 필요한 문서가 없으면 작업 없이 (apply면) 바로 적용한다.
def queue_build(index: dict, apply: bool) -> dict:
    batch = uuid.uuid4().hex
    created = []
    with connect(load_env()) as conn:
        busy = conn.execute("""SELECT count(*) FROM ingest_jobs WHERE params->>'kind' = 'build'
                               AND (params->>'index_id')::bigint = %s AND status IN ('queued', 'running')""",
                            (index["id"],)).fetchone()[0]
        if busy:
            raise HTTPException(409, f"이 색인을 만드는 작업이 이미 진행 중입니다 ({busy}개 남음)")
        docs = indexes.pending_documents(conn, index["id"])
        for d in docs:
            params = {"kind": "build", "index_id": index["id"], "document_id": d["id"], "apply": apply, "batch": batch}
            job_id = conn.execute("INSERT INTO ingest_jobs (path, params) VALUES (%s, %s) RETURNING id",
                                  (f"{d['source_repo']}/{d['source_path']}", Jsonb(params))).fetchone()[0]
            created.append({"job_id": job_id, "path": f"{d['source_repo']}/{d['source_path']}"})
        if not docs and apply:
            conn.execute("UPDATE active_setup SET index_id=%s, updated_at=now() WHERE id=1", (index["id"],))
    enqueue([j["job_id"] for j in created])
    return {"index_id": index["id"], "jobs": created, "skipped": [], "stages": STAGES, "applied": not docs and apply}


# 색인을 만든다 (같은 조합이 있으면 그 색인을 쓰고, 빠진 문서만 넣는다).
@app.post("/indexes", status_code=202)
def create_index(req: IndexRequest) -> dict:
    chunker, embedder = normalized(req)
    est = indexes.estimate(chunker, embedder)
    if not est["can_build"]:
        reason = (est["reason"] or (f"외부 전송이 허용되지 않은 문서 {len(est['blocked'])}개" if est["blocked"] else "")
                  or (f"원문이 없는 문서 {len(est['missing_content'])}개" if est["missing_content"] else "")
                  or f"토큰 한도를 넘는 조각 {est['over_limit']}개")
        raise HTTPException(409, reason)
    return queue_build(indexes.ensure_index(chunker, embedder), req.apply)


# 뒤처진 색인 갱신: 바뀌었거나 빠진 문서만 다시 넣는다. 외부 전송 검사는 문서마다 작업 안에서 다시 한다.
@app.post("/indexes/{index_id}/refresh", status_code=202)
def refresh_index(index_id: int) -> dict:
    with connect(load_env()) as conn:
        try:
            index = indexes.get_index(conn, index_id)
        except IngestError as e:
            raise HTTPException(404, str(e))
    return queue_build(index, apply=False)


# 현재 설정: 쓰는 색인(상태 포함)과 검색 설정. 같은 값으로 저장된 설정이 있으면 그 이름도 알려 준다.
@app.get("/setup")
def get_setup() -> dict:
    with connect(load_env()) as conn:
        index_id, query, updated = conn.execute("SELECT index_id, query, updated_at FROM active_setup WHERE id=1").fetchone()
        saved = conn.execute("SELECT name FROM setups WHERE index_id=%s AND query=%s ORDER BY id LIMIT 1",
                             (index_id, Jsonb(query))).fetchone()
    index = next(i for i in indexes.list_indexes() if i["id"] == index_id)
    q = query_defaults(query)
    q["reranker_label"] = comp.describe("reranker", q["reranker"]) if q["reranker"] else None
    q["generator_label"] = comp.describe("generator", q["generator"]) if q["generator"] else None
    q["keyword_label"] = comp.describe("keyword", q["keyword"]) if q["keyword"] else None
    return {"index": index, "query": q, "saved_as": saved[0] if saved else None, "updated_at": updated}


class SetupUpdate(BaseModel):
    index_id: int | None = None
    top_k: int | None = None
    # 리랭크: {"id", "params"}면 켜고, "off"면 끈다. 주지 않으면 그대로 둔다.
    reranker: dict | Literal["off"] | None = None
    generator: dict | Literal["off"] | None = None   # 답변 생성: 리랭크와 같은 방식
    keyword: dict | Literal["off"] | None = None     # 키워드 검색(BM25): 리랭크와 같은 방식


# 현재 설정을 바꾼다. 색인은 조각이 하나라도 있어야 고를 수 있다. 검색 설정은 바로 적용된다.
@app.put("/setup")
def update_setup(req: SetupUpdate) -> dict:
    with connect(load_env()) as conn:
        if req.index_id is not None:
            if conn.execute("SELECT 1 FROM chunks WHERE index_id=%s LIMIT 1", (req.index_id,)).fetchone() is None:
                raise HTTPException(409, "아직 만들어지지 않은 색인입니다. 먼저 만드세요")
            conn.execute("UPDATE active_setup SET index_id=%s, updated_at=now() WHERE id=1", (req.index_id,))
        if req.top_k is not None:
            if not 1 <= req.top_k <= 20:
                raise HTTPException(400, "top_k는 1~20 사이여야 합니다")
            conn.execute("""UPDATE active_setup SET query = query || jsonb_build_object('top_k', %s::int), updated_at=now()
                            WHERE id=1""", (req.top_k,))
        if req.reranker is not None:
            conn.execute("""UPDATE active_setup SET query = query || jsonb_build_object('reranker', %s::jsonb), updated_at=now()
                            WHERE id=1""", (Jsonb(check_reranker(req.reranker)),))
        if req.generator is not None:
            conn.execute("""UPDATE active_setup SET query = query || jsonb_build_object('generator', %s::jsonb), updated_at=now()
                            WHERE id=1""", (Jsonb(check_generator(req.generator)),))
        if req.keyword is not None:
            conn.execute("""UPDATE active_setup SET query = query || jsonb_build_object('keyword', %s::jsonb), updated_at=now()
                            WHERE id=1""", (Jsonb(check_stage("keyword", comp.KEYWORDS, req.keyword)),))
    return get_setup()


# 켜고 끄는 검색 단계 설정을 검사한다. "off"는 None(끔). 쓸 수 없는 상태면 켤 수 없다.
def check_stage(stage: str, registry: dict, value: dict | str) -> dict | None:
    if value == "off":
        return None
    try:
        setting = comp.normalize(stage, value)
    except comp.ComponentError as e:
        raise HTTPException(400, str(e))
    ok, reason = registry[setting["id"]].availability(load_env())
    if not ok:
        raise HTTPException(409, reason)
    return setting


# 답변 생성 설정을 검사한다. "off"는 None(끔). 키가 없으면 켤 수 없다.
def check_generator(value: dict | str) -> dict | None:
    if value == "off":
        return None
    try:
        setting = comp.normalize("generator", value)
    except comp.ComponentError as e:
        raise HTTPException(400, str(e))
    ok, reason = comp.GENERATORS[setting["id"]].availability(load_env())
    if not ok:
        raise HTTPException(409, reason)
    return setting


# 리랭크 설정을 검사한다. "off"는 None(끔). 리랭커 서버가 꺼져 있으면 켤 수 없다.
def check_reranker(value: dict | str) -> dict | None:
    if value == "off":
        return None
    try:
        setting = comp.normalize("reranker", value)
    except comp.ComponentError as e:
        raise HTTPException(400, str(e))
    ok, reason = comp.RERANKERS[setting["id"]].availability(load_env())
    if not ok:
        raise HTTPException(409, reason)
    return setting


@app.get("/setups")
def list_setups() -> list[dict]:
    with connect(load_env()) as conn:
        cur = conn.execute("SELECT id, name, index_id, query, created_at FROM setups ORDER BY id")
        return [dict(zip([c.name for c in cur.description], r)) for r in cur.fetchall()]


class SetupSave(BaseModel):
    name: str


# 현재 설정을 이름 붙여 저장한다. 같은 이름이 있으면 덮어쓴다.
@app.post("/setups")
def save_setup(req: SetupSave) -> dict:
    name = req.name.strip()
    if not name or len(name) > 60:
        raise HTTPException(400, "이름은 1~60자로 적어 주세요")
    with connect(load_env()) as conn:
        conn.execute("""INSERT INTO setups (name, index_id, query) SELECT %s, index_id, query FROM active_setup WHERE id=1
                        ON CONFLICT (name) DO UPDATE SET index_id=EXCLUDED.index_id, query=EXCLUDED.query""", (name,))
    return get_setup()


# 저장된 설정을 현재 설정으로 불러온다.
@app.post("/setups/{setup_id}/load")
def load_saved_setup(setup_id: int) -> dict:
    with connect(load_env()) as conn:
        row = conn.execute("SELECT index_id, query FROM setups WHERE id=%s", (setup_id,)).fetchone()
        if row is None:
            raise HTTPException(404, f"setup {setup_id} 없음")
        conn.execute("UPDATE active_setup SET index_id=%s, query=%s, updated_at=now() WHERE id=1", (row[0], Jsonb(row[1])))
    return get_setup()


@app.delete("/setups/{setup_id}")
def delete_setup(setup_id: int) -> dict:
    with connect(load_env()) as conn:
        conn.execute("DELETE FROM setups WHERE id=%s", (setup_id,))
    return {"deleted": setup_id}


class DocumentUpdate(BaseModel):
    external_ok: bool


# 문서의 외부 전송 허용을 바꾼다 (Knowledge 화면 토글). 이미 만든 외부 색인의 조각은 지우지 않는다.
@app.patch("/documents/{doc_id}")
def update_document(doc_id: int, req: DocumentUpdate) -> dict:
    with connect(load_env()) as conn:
        row = conn.execute("UPDATE documents SET external_ok=%s WHERE id=%s RETURNING id, external_ok",
                           (req.external_ok, doc_id)).fetchone()
    if row is None:
        raise HTTPException(404, f"document {doc_id} 없음")
    return {"id": row[0], "external_ok": row[1]}


# ---------- 평가 ----------

class EvalSide(BaseModel):
    index_id: int | None = None                       # 비우면 현재 설정의 색인
    reranker: dict | Literal["off"] | None = None     # 비우면 현재 설정의 리랭크, "off"면 끔
    keyword: dict | Literal["off"] | None = None      # 비우면 현재 설정의 키워드 검색, "off"면 끔


class EvalRequest(BaseModel):
    label: str = ""
    index_ids: list[int] = []      # 예전 방식: 색인만 바꿔 평가
    sides: list[EvalSide] = []     # 비교 화면의 A·B: 색인과 리랭크를 함께 정한다
    answers: bool = False          # 답변까지 쓰게 하고 인용·보류를 채점한다 (외부 LLM 호출, 질문마다 한 번)


# 평가 작업을 대기열에 넣는다. 색인을 여러 개 주면 색인마다 하나씩, 준 순서대로 넣는다 (worker가 하나라 차례로 돈다).
# 결과는 끝나면 /evals에 나타난다.
@app.post("/evals", status_code=202)
def create_eval(req: EvalRequest) -> dict:
    sides = req.sides or [EvalSide(index_id=i) for i in req.index_ids] or [EvalSide()]
    if len(sides) > 2:
        raise HTTPException(400, "한 번에 설정 두 개까지 평가할 수 있습니다")
    rerankers = [check_reranker(s.reranker) if s.reranker is not None else None for s in sides]
    keywords = [check_stage("keyword", comp.KEYWORDS, s.keyword) if s.keyword is not None else None for s in sides]
    with connect(load_env()) as conn:
        busy = conn.execute("""SELECT id FROM ingest_jobs WHERE params->>'kind'='eval' AND status IN ('queued','running')""").fetchone()
        if busy:
            raise HTTPException(409, f"평가가 이미 진행 중입니다 (job {busy[0]})")
        for side in sides:
            if side.index_id is not None and conn.execute("SELECT 1 FROM chunks WHERE index_id=%s LIMIT 1", (side.index_id,)).fetchone() is None:
                raise HTTPException(409, f"색인 #{side.index_id}이 아직 만들어지지 않았습니다. 먼저 만드세요")
        batch = uuid.uuid4().hex
        job_ids = []
        for side, rr, kwd in zip(sides, rerankers, keywords):
            params = {"kind": "eval", "label": req.label[:60], "batch": batch}
            if req.answers:
                params["answers"] = True
            if side.index_id is not None:
                params["index_id"] = side.index_id
            if side.reranker is not None:
                params["reranker"] = rr or "off"
            if side.keyword is not None:
                params["keyword"] = kwd or "off"
            name = (f"eval: {req.label or 'current setup'}" + (f" · index {side.index_id}" if side.index_id is not None else "")
                    + (f" · rerank {'off' if rr is None else rr['params']['candidates']}" if side.reranker is not None else "")
                    + (f" · keyword {'off' if kwd is None else kwd['params']['mode']}" if side.keyword is not None else ""))
            job_ids.append(conn.execute("INSERT INTO ingest_jobs (path, params) VALUES (%s, %s) RETURNING id",
                                        (name, Jsonb(params))).fetchone()[0])
    enqueue(job_ids)
    return {"job_id": job_ids[0], "job_ids": job_ids}


# 사용 기록: 오늘·이번 달·전체 요약, 최근 14일 일별, 최근 질문 50개.
@app.get("/usage")
def get_usage(service: str = "playground", days: int = Query(14, ge=1, le=90)) -> dict:
    env = load_env()
    return usage.overview(env, service, days) | {"grafana_url": env.get("GRAFANA_PUBLIC_URL", "http://localhost:3000")}


# 평가 시험지와 점검 결과. index_id를 주지 않으면 현재 설정의 색인으로 조각 경계를 본다.
@app.get("/questions")
def get_questions(index_id: int | None = None) -> dict:
    try:
        return questions.check(index_id)
    except IngestError as e:
        raise HTTPException(404, str(e))


# 근거 문장 찾기: 원문에서 검색어가 든 문장. 고르면 그대로 quote로 들어간다.
@app.get("/questions/evidence-search")
def evidence_search(q: str = Query("", max_length=200)) -> list[dict]:
    return questions.search_evidence(q)


class QuestionSave(BaseModel):
    sha: str                   # 불러올 때의 시험지 해시. 그사이 파일이 바뀌었으면 덮어쓰지 않는다
    question: dict


def _question_call(fn, *args) -> dict:
    try:
        return fn(*args)
    except questions.QuestionError as e:
        raise HTTPException(e.status, str(e))
    except IngestError as e:
        raise HTTPException(404, str(e))


@app.post("/questions")
def add_question(req: QuestionSave) -> dict:
    return _question_call(questions.save, req.sha, req.question)


@app.put("/questions/{qid}")
def edit_question(qid: str, req: QuestionSave) -> dict:
    return _question_call(questions.save, req.sha, req.question, qid)


@app.delete("/questions/{qid}")
def delete_question(qid: str, sha: str) -> dict:
    return _question_call(questions.delete, sha, qid)


@app.get("/evals")
def list_evals(limit: int = Query(50, ge=1, le=200)) -> list[dict]:
    return evaluate.list_runs(limit)


@app.get("/evals/{run_id}")
def get_eval(run_id: int) -> dict:
    run = evaluate.get_run(run_id)
    if run is None:
        raise HTTPException(404, f"evaluation {run_id} 없음")
    return run
