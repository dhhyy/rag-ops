"""서비스용 엔진 API v1 (규약: docs/api-v1.md).

- 서비스는 게이트웨이(Kong)를 거쳐 부른다. 키 확인과 호출 횟수 제한은 Kong이 하고,
  엔진은 Kong이 붙여 준 서비스 이름(X-Consumer-Username)으로 사용 기록을 나눈다.
- 응답 모양은 고정이다. 필드를 더하는 것만 하고, 지우거나 뜻을 바꾸려면 /v2를 만든다.
- 답변은 만들지 않는다. 근거와 근거 정보(위치·판·환경·검증 상태·외부 전송 가능 여부)만 준다. 보류 판단은 서비스가 한다.
- 관리 콘솔의 /search(JSON Lines 스트림)와 같은 검색 함수(retrieve)를 쓰므로 순위가 같다.
"""
from __future__ import annotations

import re
import time
from typing import Literal

from fastapi import APIRouter, Request
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
    if req.project_id is not None and scope is None:
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
