"""서비스용 엔진 API v1 (규약: docs/api-v1.md).

- 서비스는 게이트웨이(Kong)를 거쳐 부른다. 키 확인과 호출 횟수 제한은 Kong이 하고,
  엔진은 Kong이 붙여 준 서비스 이름(X-Consumer-Username)으로 사용 기록을 나눈다.
- 응답 모양은 고정이다. 필드를 더하는 것만 하고, 지우거나 뜻을 바꾸려면 /v2를 만든다.
- 답변은 만들지 않는다. 근거와 근거 정보(위치·판·환경·검증 상태·외부 전송 가능 여부)만 준다. 보류 판단은 서비스가 한다.
- 관리 콘솔의 /search(JSON Lines 스트림)와 같은 검색 함수(retrieve)를 쓰므로 순위가 같다.
- 넣기(프로젝트·PDF·작업·지우기)는 콘솔 API 함수를 그대로 부르고, 앞에서 소유권만 확인한다.
  서비스가 만든 프로젝트는 source.service에 서비스 이름을 적는다. 그 서비스만 올리고·지우고·검색할 수 있다.
  콘솔에서 만든 프로젝트(source.service 없음)는 모든 서비스가 검색만 할 수 있다.
"""
from __future__ import annotations

import re
import time
from typing import Literal

from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

import components as comp
import projects
import telemetry
import usage
from ingest import IngestError, connect, load_env
from search import hit_dict, load_setup, retrieve

router = APIRouter(prefix="/v1")

# 게이트웨이를 거치지 않고 엔진 포트로 바로 부르면 서비스 이름이 없다 (로컬 시험용). 기록에서 구분되게 이름을 붙인다.
DIRECT = "direct"
PAGE = re.compile(r"^p\.(\d+)$")


# /v1 오류는 늘 {"error": {"code", "message"}} 모양으로 보낸다. api.py가 이 예외를 응답으로 바꾼다.
class V1Error(Exception):
    def __init__(self, status: int, code: str, message: str):
        self.status, self.code, self.message = status, code, message


def error_response(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse({"error": {"code": code, "message": message}}, status_code=status)


class SearchV1(BaseModel):
    query: str
    project_id: int | None = None
    top_k: int | None = Field(None, ge=1, le=20)
    rerank: Literal["setting", "off"] = "setting"


@router.get("/health")
def health() -> dict:
    return {"ok": True}


@router.post("/search")
def search_v1(req: SearchV1, request: Request) -> dict:
    t_start = time.perf_counter()
    service = request.headers.get("x-consumer-username") or DIRECT
    question = req.query.strip()
    if not question or len(question) > 2000:
        raise V1Error(400, "invalid_query", "질문은 1~2000자로 적어 주세요")
    env = load_env()
    with connect(env) as conn:
        setup = load_setup(conn)
        scope = projects.get_project(conn, req.project_id) if req.project_id is not None else None
    if req.project_id is not None and not _can_read(scope, service):
        raise V1Error(404, "project_not_found", f"프로젝트 {req.project_id}이(가) 없습니다")
    query = setup["query"] if req.rerank == "setting" else {**setup["query"], "reranker": None}
    index = setup["index"]
    k = req.top_k or setup["query"]["top_k"]
    if query["reranker"]:
        ok, reason = comp.RERANKERS[query["reranker"]["id"]].availability(env)
        if not ok:
            raise V1Error(503, "engine_unavailable", reason)

    setup_out = {"index_id": index["id"], "chunker": comp.describe("chunker", index["chunker"]),
                 "embedder": comp.describe("embedder", index["embedder"]),
                 "reranker": comp.describe("reranker", query["reranker"]) if query["reranker"] else None,
                 "keyword": comp.describe("keyword", query["keyword"]) if query["keyword"] else None,
                 "top_k": k}
    rec: dict = {"service": service, "status": "error", "question": question,
                 "setup": setup_out | {"api": "v1", "project": {"id": scope["id"], "name": scope["name"]} if scope else None},
                 "latency_ms": {}, "trace_id": telemetry.current_trace_id()}
    try:
        try:
            out = retrieve(env, index, query, question, k, req.project_id)
        except IngestError as e:
            rec["error"] = str(e)
            raise V1Error(503, "engine_unavailable", str(e)) from None
        shown = [hit_dict(h) for h in out["hits"][:k]]
        extra = _doc_extra(env, {h["document_id"] for h in shown})
        lat = out["latency"]
        latency = {"embed": round(lat["embed"] * 1000), "search": round((lat["db"] + lat.get("keyword", 0)) * 1000),
                   "rerank": round(lat["rerank"] * 1000)}
        rec.update(status="ok", hits=[{"chunk_id": h["chunk_id"], "document_id": h["document_id"], "title": h["title"],
                                       "heading": h["heading_path"]} for h in shown])
        hits = [_hit_v1(rank, h, extra.get(h["document_id"], (False, None))) for rank, h in enumerate(shown, 1)]
    finally:
        latency_total = round((time.perf_counter() - t_start) * 1000)
        rec["latency_ms"] = (latency if rec["status"] == "ok" else {}) | {"total": latency_total}
        usage_id = usage.record(env, rec)
    return {"query": question, "project_id": req.project_id, "setup": setup_out, "hits": hits,
            "latency_ms": latency | {"total": latency_total}, "usage_id": usage_id}


# 문서마다 외부 전송 가능 여부와 최신 판 번호 (판 기록이 없는 git 문서는 None).
def _doc_extra(env: dict[str, str], doc_ids: set[int]) -> dict[int, tuple[bool, int | None]]:
    if not doc_ids:
        return {}
    with connect(env) as conn:
        rows = conn.execute(
            """SELECT d.id, d.external_ok, max(v.version) FROM documents d
               LEFT JOIN document_versions v ON v.document_id = d.id
               WHERE d.id = ANY(%s) GROUP BY d.id""", (list(doc_ids),)).fetchall()
    return {doc_id: (ok, ver) for doc_id, ok, ver in rows}


def _hit_v1(rank: int, h: dict, extra: tuple[bool, int | None]) -> dict:
    path = h["heading_path"] or ""   # "제목 > 소제목" 문자열. PDF는 "제목 > p.3"
    m = PAGE.match(path.split(" > ")[-1].strip()) if path else None
    return {
        "rank": rank, "chunk_id": h["chunk_id"], "score": h["score"], "text": h["content"],
        "location": {"document_id": h["document_id"], "title": h["title"], "heading_path": path,
                     "page": int(m.group(1)) if m else None},
        "source": {"repo": h["source_repo"], "path": h["source_path"], "commit": h["source_commit"], "version": extra[1]},
        "meta": {"env": h["env"], "doc_type": h["doc_type"], "verification": h["verification"],
                 "checked_at": h["checked_at"], "external_ok": extra[0]},
    }


# ---------- 넣기: 프로젝트, PDF, 작업, 지우기 ----------

def _service(request: Request) -> str:
    return request.headers.get("x-consumer-username") or DIRECT


# 다른 서비스의 프로젝트는 "없음"으로 답한다 (있는지 여부도 알려 주지 않는다).
def _can_read(project: dict | None, service: str) -> bool:
    if project is None:
        return False
    owner = (project.get("source") or {}).get("service")
    return owner is None or owner == service


def _owned(project_id: int, service: str) -> dict:
    with connect(load_env()) as conn:
        project = projects.get_project(conn, project_id)
    if project is None or (project.get("source") or {}).get("service") != service:
        raise V1Error(404, "project_not_found", f"프로젝트 {project_id}이(가) 없습니다")
    return project


class ProjectV1(BaseModel):
    name: str = Field(min_length=1, max_length=40)
    external_ok: bool = False      # 올리는 문서를 외부 LLM에 보내도 되는지 (사용자 동의를 받은 서비스만 true)
    description: str = Field("", max_length=200)


def _project_out(p: dict) -> dict:
    return {"id": p["id"], "name": p["name"], "external_ok": bool((p.get("defaults") or {}).get("external_ok"))}


# 프로젝트 이름은 서비스 이름을 앞에 붙여 저장한다 (서비스끼리 이름이 부딪히지 않게, 콘솔에서 누구 것인지 보이게).
@router.post("/projects", status_code=201)
def create_project_v1(req: ProjectV1, request: Request) -> dict:
    service = _service(request)
    name = f"{service}-{req.name.strip()}"
    with connect(load_env()) as conn:
        try:
            pid = projects.create_project(conn, name, "managed", {"service": service},
                                          {"external_ok": req.external_ok}, req.description)
        except ValueError as e:
            code = "project_exists" if "이미 있습니다" in str(e) else "invalid_request"
            raise V1Error(409 if code == "project_exists" else 400, code, str(e)) from None
        project = projects.get_project(conn, pid)
    return {"project": _project_out(project)}


# 직접 관리 문서의 판 이름은 "v3" 꼴. 응답은 숫자(3)로 맞춘다
def _ver(name: str | None) -> int | None:
    s = str(name or "")
    return int(s[1:]) if s[:1] == "v" and s[1:].isdigit() else None


# PDF 하나를 원본 바이트로 올린다 (본문 = 파일, Content-Type: application/pdf, 20MB 이하). 넣기는 작업으로 돈다.
@router.post("/projects/{project_id}/pdf", status_code=202)
async def upload_pdf_v1(project_id: int, request: Request, name: str = Query(..., min_length=1, max_length=255)) -> dict:
    import api   # api.py가 이 모듈을 불러오므로 함수 안에서 부른다
    _owned(project_id, _service(request))
    out = await api.upload_pdf(project_id, request, name)
    if out["skipped"]:
        s = out["skipped"][0]
        return {"status": "skipped", "name": s["name"], "reason": s["reason"], "job_id": None}
    if out["unchanged"]:
        u = out["unchanged"][0]
        return {"status": "unchanged", "name": u["name"], "version": _ver(u["version"]), "job_id": None}
    item = (out["new"] or out["updated"])[0]
    info = out["pdf"][0] if out["pdf"] else {}
    return {"status": "queued", "name": item["name"], "job_id": item["job_id"], "replaces": _ver(item.get("from")),
            "pages": info.get("pages"), "empty_pages": info.get("empty_pages"), "suspect": info.get("suspect")}


# 넣기 작업 상태. status: queued → running → done | failed. done이면 document_id가 생긴다.
@router.get("/jobs/{job_id}")
def get_job_v1(job_id: int, request: Request) -> dict:
    from jobs import fetch_job
    job = fetch_job(job_id)
    params = (job or {}).get("params") or {}
    if job is None or params.get("project_id") is None:
        raise V1Error(404, "job_not_found", f"작업 {job_id}이(가) 없습니다")
    try:
        _owned(int(params["project_id"]), _service(request))
    except V1Error:
        raise V1Error(404, "job_not_found", f"작업 {job_id}이(가) 없습니다") from None
    result = job.get("result") or {}
    return {"job_id": job["id"], "project_id": params["project_id"], "name": params.get("filename"),
            "status": job["status"], "stage": job["stage"],
            "progress": _progress(job, result),
            "error": job["error"], "document_id": result.get("document_id"), "version": result.get("version"),
            "chunks": result.get("chunks")}


# 진행 수는 조각 기준이다 (PDF는 쪽마다 조각 하나라 쪽 수와 같다). 시간이 걸리는 건 임베딩이라 그 단계 수를 쓴다.
# 임베딩 전에는 전체 수를 아직 모른다 (done 0, total null). 끝나면 done = total = 조각 수.
def _progress(job: dict, result: dict) -> dict:
    if job["status"] == "done" and result.get("chunks") is not None:
        return {"done": result["chunks"], "total": result["chunks"]}
    if job["progress_total"] is None:
        return {"done": 0 if job["status"] in ("queued", "running") else None, "total": None}
    return {"done": job["progress_done"], "total": job["progress_total"]}


# 서비스가 만든 자기 프로젝트 목록 (남은 방 정리용). 콘솔 프로젝트와 다른 서비스 것은 보이지 않는다.
@router.get("/projects")
def list_projects_v1(request: Request) -> dict:
    service = _service(request)
    with connect(load_env()) as conn:
        rows = conn.execute(
            """SELECT p.id, p.name, p.defaults, p.created_at,
                      (SELECT count(*) FROM project_documents pd WHERE pd.project_id = p.id) AS documents,
                      (SELECT count(*) FROM ingest_jobs j
                        WHERE (j.params->>'project_id')::int = p.id AND j.status IN ('queued', 'running')) AS active_jobs
               FROM projects p WHERE p.source->>'service' = %s ORDER BY p.id""", (service,)).fetchall()
    return {"projects": [{"id": r[0], "name": r[1], "external_ok": bool((r[2] or {}).get("external_ok")),
                          "created_at": r[3].isoformat(), "documents": r[4], "active_jobs": r[5]} for r in rows]}


# 프로젝트와 그 문서·조각을 지운다 (방이 끝났을 때). 넣는 중인 작업이 있으면 409.
@router.delete("/projects/{project_id}")
def delete_project_v1(project_id: int, request: Request) -> dict:
    import api
    project = _owned(project_id, _service(request))
    out = api.delete_project(project_id, confirm=project["name"])
    return {"deleted": project_id, "name": project["name"], "documents": out.get("origin_documents"), "chunks": out.get("chunks")}


# ---------- 조각 읽기와 외부 LLM 호출 ----------

# 서비스가 읽을 수 있는 조각인지: 조각의 문서가 붙은 프로젝트 중 하나라도 그 서비스가 읽을 수 있으면 된다.
def _chunks_for(conn, chunk_ids: list[int], service: str) -> dict[int, dict]:
    rows = conn.execute(
        """SELECT c.id, c.document_id, c.content, c.heading_path, d.title, d.external_ok,
                  array_agg(p.source->>'service') AS owners, d.env, d.doc_type, d.verification, d.checked_at
           FROM chunks c JOIN documents d ON d.id = c.document_id
           JOIN project_documents pd ON pd.document_id = d.id JOIN projects p ON p.id = pd.project_id
           WHERE c.id = ANY(%s) GROUP BY c.id, d.id""", (chunk_ids,)).fetchall()
    out = {}
    for cid, doc_id, content, heading, title, ext, owners, env_, doc_type, verification, checked in rows:
        if any(o is None or o == service for o in owners):
            out[cid] = {"chunk_id": cid, "document_id": doc_id, "text": content, "title": title,
                        "heading_path": " > ".join(heading) if isinstance(heading, list) else (heading or ""),
                        "external_ok": bool(ext),
                        "meta": {"env": env_, "doc_type": doc_type, "verification": verification,
                                 "checked_at": checked.isoformat() if checked else None, "external_ok": bool(ext)}}
    return out


# 프로젝트의 조각 원문 목록 (지금 검색에 쓰는 색인 기준). 출제 재료처럼 검색 없이 전체를 읽을 때 쓴다.
@router.get("/projects/{project_id}/chunks")
def list_chunks_v1(project_id: int, request: Request, limit: int = Query(200, ge=1, le=500),
                   offset: int = Query(0, ge=0)) -> dict:
    service = _service(request)
    env = load_env()
    with connect(env) as conn:
        if not _can_read(projects.get_project(conn, project_id), service):
            raise V1Error(404, "project_not_found", f"프로젝트 {project_id}이(가) 없습니다")
        index_id = load_setup(conn)["index"]["id"]
        total = conn.execute(
            """SELECT count(*) FROM chunks c JOIN project_documents pd ON pd.document_id = c.document_id
               WHERE pd.project_id = %s AND c.index_id = %s""", (project_id, index_id)).fetchone()[0]
        ids = [r[0] for r in conn.execute(
            """SELECT c.id FROM chunks c JOIN project_documents pd ON pd.document_id = c.document_id
               WHERE pd.project_id = %s AND c.index_id = %s ORDER BY c.document_id, c.chunk_index
               LIMIT %s OFFSET %s""", (project_id, index_id, limit, offset)).fetchall()]
        found = _chunks_for(conn, ids, service)
    chunks = []
    for cid in ids:
        c = found[cid]
        m = PAGE.match(c["heading_path"].split(" > ")[-1].strip()) if c["heading_path"] else None
        chunks.append({"chunk_id": cid, "text": c["text"], "external_ok": c["external_ok"], "meta": c["meta"],
                       "location": {"document_id": c["document_id"], "title": c["title"],
                                    "heading_path": c["heading_path"], "page": int(m.group(1)) if m else None}})
    return {"project_id": project_id, "index_id": index_id, "total": total, "offset": offset, "chunks": chunks}


LLM_MODELS = ("gpt-6-luna", "gpt-6.1-terra")   # 단가를 아는 모델만 (components.PRICES). 금액을 늘 기록하려는 것


class LlmV1(BaseModel):
    instructions: str = Field(min_length=1, max_length=8000)   # 역할·규칙. 문서 원문은 넣지 않는다
    input: str = Field(min_length=1, max_length=8000)          # 서비스 입력 (예: 출제 초안 JSON)
    chunk_ids: list[int] = Field(default_factory=list, max_length=20)   # 근거. 원문은 엔진이 붙인다
    model: Literal["gpt-6-luna", "gpt-6.1-terra"] = "gpt-6-luna"
    max_output_tokens: int = Field(400, ge=16, le=2000)
    purpose: str = Field("", max_length=60)   # 사용 기록에 남길 용도 (예: "quiz.generate")


# 외부 LLM(OpenAI)을 엔진이 대신 부른다. 근거 조각은 chunk_ids로만 받고, 모두 외부 전송 가능일 때만 보낸다.
# 호출마다 모델·토큰·금액을 서비스 이름으로 사용 기록에 남긴다.
@router.post("/llm")
def llm_v1(req: LlmV1, request: Request) -> dict:
    t_start = time.perf_counter()
    service = _service(request)
    env = load_env()
    ok, reason = comp.OpenAIEmbedder.availability(env)
    if not ok:
        raise V1Error(503, "llm_unavailable", "엔진에 외부 LLM 키가 설정되어 있지 않습니다")
    ids = list(dict.fromkeys(req.chunk_ids))
    with connect(env) as conn:
        found = _chunks_for(conn, ids, service) if ids else {}
    missing = [i for i in ids if i not in found]
    if missing:
        raise V1Error(404, "chunk_not_found", f"조각이 없습니다: {missing}")
    blocked = [i for i in ids if not found[i]["external_ok"]]
    if blocked:
        raise V1Error(403, "external_not_allowed", f"외부 전송이 허용되지 않은 조각입니다: {blocked}")

    sources = "\n\n".join(f"[{n}] {found[i]['title']} > {found[i]['heading_path']}\n{found[i]['text']}"
                          for n, i in enumerate(ids, 1))
    text_in = req.input + (f"\n\nSources:\n{sources}" if ids else "")
    body = {"model": req.model, "instructions": req.instructions, "input": text_in,
            "max_output_tokens": req.max_output_tokens, "reasoning": {"effort": "none"}, "store": False}
    rec: dict = {"service": service, "status": "error", "question": (req.purpose or "llm")[:60],
                 "setup": {"api": "v1", "kind": "llm", "model": req.model, "purpose": req.purpose},
                 "hits": [{"chunk_id": i, "document_id": found[i]["document_id"]} for i in ids],
                 "trace_id": telemetry.current_trace_id()}
    result = None
    try:
        try:
            data = comp.openai_post(comp.openai_base(env), "/responses", env["OPENAI_API_KEY"], body, timeout=90)
        except comp.ComponentError as e:
            rec["error"] = str(e)
            raise V1Error(502, "llm_failed", str(e)) from None
        answer = "".join(c.get("text", "") for o in data.get("output", []) if o.get("type") == "message"
                         for c in o.get("content", []) if c.get("type") == "output_text").strip()
        u = data.get("usage", {})
        tin, tout = u.get("input_tokens", 0), u.get("output_tokens", 0)
        cached = (u.get("input_tokens_details") or {}).get("cached_tokens", 0)
        cost = comp.cost_usd(req.model, tin, tout, cached)
        rec.update(status="ok", answer=answer, input_tokens=tin, output_tokens=tout, cached_tokens=cached, cost_usd=cost)
        result = {"text": answer, "model": req.model, "status": data.get("status"),
                  "chunks": [{"ref": n, "chunk_id": i} for n, i in enumerate(ids, 1)],
                  "usage": {"input_tokens": tin, "cached_tokens": cached, "output_tokens": tout,
                            "cost_usd": cost, "price_checked": comp.PRICE_CHECKED}}
    finally:
        total = round((time.perf_counter() - t_start) * 1000)
        rec["latency_ms"] = {"total": total}
        usage_id = usage.record(env, rec)
    return result | {"latency_ms": {"total": total}, "usage_id": usage_id}
