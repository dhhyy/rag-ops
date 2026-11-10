"""질문 하나로 벡터 검색을 한다: 질문 임베딩 → pgvector 코사인 거리 → 상위 k개 조각.

사용:
  python engine/app/search.py "도메인을 만들면 포트포워딩이 필요 없나?"
  python engine/app/search.py "..." -k 10 --full          # 조각 원문 전체 보기
  python engine/app/search.py "..." --setup Baseline      # 저장된 설정으로 (기본은 현재 설정)

- 검색은 설정에 들어 있는 색인 하나 안에서만 한다. 질문도 그 색인과 같은 임베딩 모델로 임베딩해야 거리가 의미 있다.
- 점수는 코사인 유사도(1 - 거리). 값 자체보다 순위를 본다 (무관한 글도 0.3~0.4가 나온다).
- 리랭크를 켜면: 벡터 검색으로 후보 N개 → 리랭커가 질문과 조각을 함께 읽고 0~1 점수 → 그 점수 순으로 상위 k개.
  리랭커에는 조각의 embed_text(색인이 임베딩한 글, 제목 경로 방식도 색인을 따른다)를 보낸다.
- 답변 근거로 쓸 수 있도록 출처(저장소·경로·커밋)와 환경·검증 상태를 함께 보여 준다.
"""
from __future__ import annotations

import argparse
import json
import time

import components as comp
from ingest import IngestError, connect, load_env
from indexes import get_index

# 한 색인 안에서 코사인 거리(<=>)가 가까운 순으로 상위 k개 조각. 출처·환경·검증 상태를 함께 붙이려고 documents와 조인한다.
SQL = """
SELECT c.id, 1 - (c.embedding <=> %(q)s::vector) AS score,
       c.chunk_index, c.heading_path, c.content,
       d.source_repo, d.source_path, d.source_commit, d.env, d.doc_type, d.verification,
       d.id, d.title, d.checked_at, c.embed_text
FROM chunks c JOIN documents d ON d.id = c.document_id
WHERE c.index_id = %(index)s
ORDER BY c.embedding <=> %(q)s::vector
LIMIT %(k)s
"""


# 현재 설정(active_setup) 또는 이름 붙여 저장한 설정을 읽는다. 색인 정보까지 붙여 돌려준다.
def load_setup(conn, name: str | None = None) -> dict:
    if name:
        row = conn.execute("SELECT index_id, query FROM setups WHERE name=%s", (name,)).fetchone()
        if row is None:
            raise IngestError(f"Setup {name!r} does not exist")
    else:
        row = conn.execute("SELECT index_id, query FROM active_setup WHERE id=1").fetchone()
    index = get_index(conn, row[0])
    return {"name": name, "index": index, "query": query_defaults(row[1])}


# 검색 설정 기본값: top-k 5, 리랭크 끔. 리랭크 설정은 normalize로 기본값(후보 수)을 채운다.
def query_defaults(query: dict | None) -> dict:
    q = {"top_k": 5, "reranker": None, "generator": None, **(query or {})}
    for stage in ("reranker", "generator"):
        if q[stage]:
            q[stage] = comp.normalize(stage, q[stage])
    return q


# 질문을 그 색인의 임베딩 모델로 임베딩한 뒤 SQL로 검색한다.
# (조각 행, 임베딩 시간, DB 시간, 질문 벡터)를 돌려준다. 평가는 질문 벡터를 지도에 다시 쓴다 (외부 API에 두 번 보내지 않게).
def search(env: dict[str, str], index: dict, question: str, k: int) -> tuple[list[tuple], float, float, list[float]]:
    t0 = time.perf_counter()
    try:
        embedder = comp.make_embedder(index["embedder"], env)
        vec = embedder.embed_query(question)
    except comp.ComponentError as e:
        raise IngestError(str(e)) from None
    t1 = time.perf_counter()
    with connect(env) as conn:
        rows = conn.execute(SQL, {"q": json.dumps(vec), "k": k, "index": index["id"]}).fetchall()
    t2 = time.perf_counter()
    return rows, t1 - t0, t2 - t1, vec


# 검색 설정까지 적용한 검색을 단계마다 끊어서 진행한다. 단계가 끝날 때마다 (종류, 값)을 내보낸다.
#   ("embedded", (초, 토큰, 금액)) → ("candidates", 후보 hits, 초) → ("reranked", 끝난 수, 전체 수)… → ("done", 결과 dict)
# Playground는 이것을 그대로 화면에 흘려보내고, 평가·CLI는 retrieve()로 마지막 결과만 쓴다.
# 리랭크를 작은 묶음으로 나눠 보내므로, 받는 쪽이 중간에 멈추면 다음 묶음은 보내지 않는다.
def retrieve_steps(env: dict[str, str], index: dict, query: dict, question: str, k: int):
    reranker = query.get("reranker")
    rr = comp.make_reranker(reranker, env) if reranker else None
    n = max(k, rr.candidates) if rr else k
    t0 = time.perf_counter()
    try:
        embedder = comp.make_embedder(index["embedder"], env)
        vec = embedder.embed_query(question)
    except comp.ComponentError as e:
        raise IngestError(str(e)) from None
    t_embed = time.perf_counter() - t0
    # 외부 임베딩이면 API가 알려 준 토큰 수와 금액도 넘긴다 (로컬은 0, 금액 None).
    tokens = getattr(embedder, "usage_tokens", 0)
    yield "embedded", (t_embed, tokens, comp.cost_usd(getattr(embedder, "model", ""), tokens) if tokens else None)
    t1 = time.perf_counter()
    with connect(env) as conn:
        rows = conn.execute(SQL, {"q": json.dumps(vec), "k": n, "index": index["id"]}).fetchall()
    t_db = time.perf_counter() - t1
    hits = [{"row": r, "score": float(r[1]), "vector_score": float(r[1]), "vector_rank": i} for i, r in enumerate(rows, 1)]
    yield "candidates", (hits, t_db)
    t_rerank = 0.0
    if rr and rows:
        texts = [r[-1] for r in rows]
        for start in range(0, len(texts), comp.RERANK_BATCH):
            t2 = time.perf_counter()
            try:
                scores = rr.score(question, texts[start:start + comp.RERANK_BATCH])
            except comp.ComponentError as e:
                raise IngestError(str(e)) from None
            t_rerank += time.perf_counter() - t2
            for h, sc in zip(hits[start:], scores):
                h["score"] = sc
            yield "reranked", (min(start + comp.RERANK_BATCH, len(texts)), len(texts))
        hits.sort(key=lambda h: -h["score"])
    yield "done", {"hits": hits, "vec": vec, "candidates": len(rows) if rr else None,
                   "latency": {"embed": t_embed, "db": t_db, "rerank": t_rerank}}


# 검색 설정까지 적용한 검색. hits는 후보 전체(리랭크했으면 리랭크 순)이고 부르는 쪽이 앞에서 k개를 쓴다.
def retrieve(env: dict[str, str], index: dict, query: dict, question: str, k: int) -> dict:
    for kind, value in retrieve_steps(env, index, query, question, k):
        if kind == "done":
            return value
    raise IngestError("검색이 끝나지 않았습니다")


# 검색 결과 앞쪽 조각으로 답을 쓴다. 번호는 화면의 근거 순위와 같다.
# 외부 LLM이면 외부 전송이 막힌 문서의 조각은 빼고 보낸다(check_external). 뺀 번호는 skipped로 알려 준다.
def answer(env: dict[str, str], setting: dict, question: str, hits: list[dict]) -> dict:
    gen = comp.make_generator(setting, env)
    top = hits[:gen.sources]
    with connect(env) as conn:
        allowed = dict(conn.execute("SELECT id, external_ok FROM documents WHERE id = ANY(%s)",
                                    ([h["row"][11] for h in top],)).fetchall())
    sources, skipped = [], []
    for n, h in enumerate(top, 1):
        (_, _, _, path, content, _, spath, _, env_label, _, verif, doc_id, title, _, _) = h["row"]
        try:
            comp.check_external(setting, title or spath, allowed.get(doc_id, False), stage="generator")
        except comp.ComponentError:
            skipped.append(n)
            continue
        sources.append((n, f"{spath} > {path} (env: {env_label or '?'}, verification: {verif or '?'})", content))
    if not sources:
        return {"text": "", "sources": [], "skipped": skipped, "ms": 0}
    t0 = time.perf_counter()
    out = gen.generate(question, sources)
    return out | {"sources": [n for n, _, _ in sources], "skipped": skipped, "ms": round((time.perf_counter() - t0) * 1000)}


# 화면에 보낼 조각 하나. 출처·환경·검증 상태와 리랭크 전후 점수를 함께 담는다.
def hit_dict(h: dict) -> dict:
    (cid, _, idx, path, content, repo, spath, commit, env_label, dtype, verif, doc_id, title, checked, _) = h["row"]
    return {"chunk_id": cid, "score": round(h["score"], 4), "vector_score": round(h["vector_score"], 4),
            "vector_rank": h["vector_rank"], "chunk_index": idx, "heading_path": path, "content": content,
            "document_id": doc_id, "title": title, "source_repo": repo, "source_path": spath, "source_commit": commit,
            "env": env_label, "doc_type": dtype, "verification": verif, "checked_at": checked.isoformat() if checked else None}


# 명령줄 진입점: 질문을 받아 검색하고, 순위·점수·출처·조각 내용을 출력한다.
def main() -> None:
    ap = argparse.ArgumentParser(description="벡터 검색")
    ap.add_argument("question")
    ap.add_argument("-k", type=int, default=None, help="가져올 조각 수 (기본: 설정의 top_k)")
    ap.add_argument("--setup", default=None, help="저장된 설정 이름 (기본: 현재 설정)")
    ap.add_argument("--full", action="store_true", help="조각 원문 전체 출력")
    a = ap.parse_args()

    env = load_env()
    with connect(env) as conn:
        setup = load_setup(conn, a.setup)
    index = setup["index"]
    k = a.k or setup["query"]["top_k"]
    out = retrieve(env, index, setup["query"], a.question, k)
    lat = out["latency"]
    rr = setup["query"]["reranker"]
    print(f"Q: {a.question}   (색인 #{index['id']} {comp.describe('chunker', index['chunker'])} × "
          f"{comp.describe('embedder', index['embedder'])}"
          + (f" · 리랭크 {comp.describe('reranker', rr)}" if rr else "")
          + f" · 임베딩 {lat['embed']*1000:.0f}ms, 검색 {lat['db']*1000:.0f}ms"
          + (f", 리랭크 {lat['rerank']*1000:.0f}ms" if rr else "") + ")\n")
    for rank, h in enumerate(out["hits"][:k], 1):
        _, _, idx, path, content, repo, spath, commit, env_label, dtype, verif, *_ = h["row"]
        moved = f"  (벡터 {h['vector_rank']}위 {h['vector_score']:.3f})" if rr else ""
        print(f"{rank}. {h['score']:.3f}  [{idx:02d}] {path}{moved}")
        print(f"   출처 {repo}/{spath}@{commit[:12]} · 환경 {env_label} · {dtype} · 검증 {verif}")
        text = content if a.full else content.replace("\n", " ")[:160] + "…"
        print(f"   {text}\n")


# 직접 실행할 때만 main()을 돈다.
if __name__ == "__main__":
    main()
