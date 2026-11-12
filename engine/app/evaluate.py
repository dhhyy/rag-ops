"""검색 평가: 평가 질문으로 설정 하나(색인 + 검색 설정)를 돌려 지표를 재고 eval_runs에 저장한다.

웹의 [현재 설정으로 평가]는 Celery 작업(jobs.py의 kind=eval)으로 이 파일의 run_eval을 부른다.
명령줄은 eval/run.py를 쓴다.

- 검색은 search.py와 같은 함수(같은 SQL, 같은 임베딩 구현)를 쓴다. 평가 대상이 실제 검색 경로여야 하기 때문이다.
- 정답 판정: 꺼낸 조각이 근거와 같은 문서이고, 근거 문장(quote)을 포함하면 정답.
  청킹 방식이 달라도 같은 기준을 쓸 수 있다. 비교 전에 마크다운 기호(*, `)와 공백 차이는 지운다.
  quote가 없는 근거는 예전 방식(마지막 제목이 같은지)으로 보고, 결과에 match_by로 남긴다.
- 답 없는 질문(abstain)은 성공률 계산에서 빼고, 무엇이 몇 점으로 올라왔는지만 기록한다. 보류 기준은 사용자가 정한다.
- 답변 평가(answers=True): 검색 결과로 실제 답을 쓰게 하고, 규칙으로만 채점한다 (LLM 채점 없음).
  · 답이 있는 질문: 답에 붙은 [n] 근거 가운데 정답 조각이 있는지.
  · 답 없는 질문: "문서에 없다"고 말했는지 (MISSING 문구). 보류 기준을 정하는 게 아니라, 모델이 규칙대로 말했는지만 본다.
- 그림 좌표: 그 색인의 조각 벡터로 PCA 축을 정하고 질문은 같은 축에 투영한다. 색인(모델)이 다르면 벡터 공간도 달라 그림끼리 직접 겹쳐 볼 수 없다.
"""
from __future__ import annotations

import hashlib
import json
import re
import statistics
import subprocess
from pathlib import Path

import numpy as np
from psycopg.types.json import Jsonb

import components as comp
from ingest import ROOT, IngestError, OnStep, connect, load_env
from indexes import get_index
from search import answer, load_setup, query_defaults, retrieve

QUESTIONS = ROOT / "eval" / "questions.jsonl"
TOP_K = 10               # 기록은 10개까지, 성공률은 1·3·5에서 본다
RECALL_AT = (1, 3, 5)

# 답변 평가용. 답에 붙은 근거 번호 [n]과 "문서에 없다"는 말을 찾는다.
CITE = re.compile(r"\[(\d+)\]")
# 규칙으로 찾는 거라 다른 말투("알 수 없어요" 등)는 놓칠 수 있다. 놓친 답은 결과의 답 원문으로 확인한다.
MISSING = re.compile(r"(?:문서|자료|출처|근거)(?:에|에는|에서는?)[^.\n]{0,60}?"
                     r"(?:없(?:습니다|어요|다|음)|나와\s*있지\s*않|포함되어\s*있지\s*않|언급되어\s*있지\s*않|찾을\s*수\s*없)"
                     r"|not (?:in|mentioned in|covered by) the (?:documents|sources)", re.I)
DEFAULT_GENERATOR = {"id": "openai-llm", "params": {}}   # 설정에 답변 생성이 꺼져 있으면 가장 싼 기본값으로


# 답 하나를 채점한다. sent: LLM에 보낸 근거 번호, ranked: 검색 순서대로 정답 여부.
def grade_answer(text: str, sent: list[int], ranked: list[dict], abstain: bool) -> dict:
    cited = sorted({int(n) for n in CITE.findall(text)})
    valid = [n for n in cited if n in sent]
    correct = [n for n in valid if ranked[n - 1]["correct"]]
    missing = MISSING.search(text)
    if abstain:
        verdict = "보류 맞음" if missing else "보류 안 함"
    elif missing and not valid:
        verdict = "잘못된 보류"
    elif correct:
        verdict = "근거 맞음"
    elif valid:
        verdict = "근거 틀림"
    else:
        verdict = "인용 없음"
    return {"verdict": verdict, "cited": cited, "cited_correct": correct, "invalid_cites": [n for n in cited if n not in sent],
            "says_missing": missing.group(0) if missing else None,
            "gold_in_sent": any(ranked[n - 1]["correct"] for n in sent)}


# 답변 평가 묶음 지표. 질문 수와 판정별 개수, 비용.
def summarize_answers(results: list[dict]) -> dict | None:
    done = [r["answer_eval"] for r in results if r.get("answer_eval")]
    if not done:
        return None
    graded = [a for r, a in ((r, r.get("answer_eval")) for r in results) if a and not r["abstain"]]
    count = lambda v: sum(a.get("verdict") == v for a in done)
    costs = [a["cost_usd"] for a in done if a.get("cost_usd") is not None]
    return {"answered": len(done), "graded": len(graded), "abstain": len(done) - len(graded),
            "correct": count("근거 맞음"), "wrong": count("근거 틀림"), "no_cite": count("인용 없음"),
            "wrong_abstain": count("잘못된 보류"), "proper_abstain": count("보류 맞음"), "missed_abstain": count("보류 안 함"),
            "errors": count("오류"), "gold_in_sent": sum(bool(a.get("gold_in_sent")) for a in graded),
            "cost_usd": round(sum(costs), 8) if costs else None,
            "input_tokens": sum(a.get("input_tokens", 0) for a in done), "output_tokens": sum(a.get("output_tokens", 0) for a in done),
            "mean_ms": round(statistics.fmean([a.get("ms", 0) for a in done])), "model": next((a["model"] for a in done if a.get("model")), None)}


def norm(text: str) -> str:
    return " ".join(re.sub(r"[*`]", "", text).split())


def load_questions() -> tuple[list[dict], str]:
    if not QUESTIONS.is_file():
        raise IngestError(f"평가 질문 파일이 없습니다: {QUESTIONS}")
    raw = QUESTIONS.read_bytes()
    return [json.loads(line) for line in raw.decode().splitlines() if line.strip()], hashlib.sha256(raw).hexdigest()[:12]


# 색인 안의 조각 전체와 벡터. 지도 좌표와 정답 판정에 쓴다.
def load_chunks(conn, index_id: int) -> tuple[list[dict], np.ndarray]:
    rows = conn.execute("""
        SELECT c.id, d.source_path, d.title, c.chunk_index, c.heading_path, c.content, c.embedding::text,
               coalesce((SELECT array_agg(p.name ORDER BY p.name) FROM project_documents pd JOIN projects p ON p.id = pd.project_id
                         WHERE pd.document_id = d.id), '{}')
        FROM chunks c JOIN documents d ON d.id = c.document_id
        WHERE c.index_id = %s ORDER BY d.source_path, c.chunk_index""", (index_id,)).fetchall()
    chunks, vecs = [], []
    for cid, path, title, idx, heading_path, content, emb, projects in rows:
        chunks.append({"id": cid, "path": path, "title": title, "index": idx, "heading": heading_path.split(" > ")[-1],
                       "heading_path": heading_path, "snippet": content[:240], "projects": list(projects), "_norm": norm(content)})
        vecs.append(json.loads(emb))
    return chunks, np.array(vecs, dtype=np.float64)


# 근거 하나에 맞는 조각인지. quote가 있으면 문장 포함, 없으면 마지막 제목 비교.
# project를 주면 그 프로젝트에 든 문서의 조각만 맞는다 (다른 프로젝트에 같은 경로의 문서가 있어도 섞이지 않게).
def matches(chunk: dict, evidence: dict, project: str | None = None) -> bool:
    if chunk["path"] != evidence["path"] or (project and project not in chunk.get("projects", ())):
        return False
    if evidence.get("quote"):
        return norm(evidence["quote"]) in chunk["_norm"]
    return chunk["heading"] == evidence.get("heading")


# 조각 벡터로 PCA 2축을 구하고, 조각·질문 좌표와 2축이 담은 정보 비율을 돌려준다.
def pca_2d(chunk_vecs: np.ndarray, question_vecs: np.ndarray) -> tuple[np.ndarray, np.ndarray, list[float]]:
    mean = chunk_vecs.mean(axis=0)
    centered = chunk_vecs - mean
    _, s, vt = np.linalg.svd(centered, full_matrices=False)
    axes = vt[:2].copy()
    # 축 방향(부호)은 SVD 결과마다 뒤집힐 수 있어, 조각 좌표 합이 양수가 되게 맞춘다 (같은 데이터면 같은 그림).
    for i in range(2):
        if (centered @ axes[i]).sum() < 0:
            axes[i] = -axes[i]
    explained = (s ** 2) / (s ** 2).sum()
    return centered @ axes.T, (question_vecs - mean) @ axes.T, [float(explained[0]), float(explained[1])]


def code_commit() -> str:
    try:
        out = subprocess.run(["git", "-C", str(ROOT), "rev-parse", "--short", "HEAD"],
                             capture_output=True, text=True, check=True).stdout.strip()
        dirty = subprocess.run(["git", "-C", str(ROOT), "status", "--porcelain", "--", "engine"],
                               capture_output=True, text=True).stdout.strip()
        return out + ("-dirty" if dirty else "")
    except (OSError, subprocess.CalledProcessError):
        return "unknown"   # 컨테이너 안에는 이 저장소의 .git이 없다


def _mean(xs: list[float]) -> float | None:
    return round(statistics.fmean(xs), 4) if xs else None


def _p95(xs: list[float]) -> float | None:
    if not xs:
        return None
    s = sorted(xs)
    return s[min(len(s) - 1, int(round(0.95 * (len(s) - 1))))]


# 정답이 있는 질문 묶음의 지표: recall@k, MRR, 질문 수.
def summarize(results: list[dict]) -> dict:
    graded = [r for r in results if not r["abstain"]]
    out: dict = {"questions": len(graded)}
    for k in RECALL_AT:
        out[f"recall@{k}"] = _mean([1.0 if r["rank"] and r["rank"] <= k else 0.0 for r in graded])
    out["mrr"] = _mean([1.0 / r["rank"] if r["rank"] else 0.0 for r in graded])
    return out


# 설정 하나로 평가를 돌리고 eval_runs에 저장한다. setup_name이 없으면 현재 설정.
# index_id를 주면 검색 설정은 그대로 두고 색인만 그것으로 바꿔 평가한다 (비교 화면의 A·B).
# reranker를 주면 검색 설정의 리랭크만 그것으로 바꾼다. "off"면 끈다 (None이면 설정 그대로).
def run_eval(label: str = "", setup_name: str | None = None, on_step: OnStep | None = None,
             index_id: int | None = None, reranker: dict | str | None = None, keyword: dict | str | None = None,
             answers: bool = False, project_id: int | None = None, scope: str = "project") -> dict:
    """project_id를 주면 그 프로젝트 질문만 채점한다.
    scope="project": 그 프로젝트 문서 안에서만 찾는다 (Playground 범위와 같음).
    scope="all": 전체에서 찾고, 다른 프로젝트 조각이 끼어든 정도(혼동)를 함께 센다."""
    env = load_env()
    questions, questions_sha = load_questions()
    with connect(env) as conn:
        project = None
        if project_id is not None:
            row = conn.execute("SELECT id, name FROM projects WHERE id=%s", (project_id,)).fetchone()
            if row is None:
                raise IngestError(f"프로젝트 #{project_id}가 없습니다")
            project = {"id": row[0], "name": row[1], "scope": "all" if scope == "all" else "project"}
            questions = [q for q in questions if q.get("project") == project["name"]]
            if not questions:
                raise IngestError(f"프로젝트 {project['name']}에 평가 질문이 없습니다. 시험지에서 질문에 프로젝트를 붙여 주세요")
        setup = load_setup(conn, setup_name)
        if index_id is not None:
            setup["index"] = get_index(conn, index_id)
        if reranker is not None:
            setup["query"] = query_defaults({**setup["query"], "reranker": None if reranker == "off" else reranker})
        if keyword is not None:
            setup["query"] = query_defaults({**setup["query"], "keyword": None if keyword == "off" else keyword})
        index = setup["index"]
        chunks, chunk_vecs = load_chunks(conn, index["id"])
    if project and project["scope"] == "project":
        # 범위 안에서만 찾으므로 지도와 정답 후보도 그 프로젝트 조각만
        keep = [i for i, c in enumerate(chunks) if project["name"] in c["projects"]]
        chunks, chunk_vecs = [chunks[i] for i in keep], chunk_vecs[keep]
    generator = (setup["query"].get("generator") or comp.normalize("generator", DEFAULT_GENERATOR)) if answers else None
    if generator:
        ok, reason = comp.GENERATORS[generator["id"]].availability(env)
        if not ok:
            raise IngestError(f"답변 평가를 할 수 없습니다: {reason}")
    if not chunks:
        raise IngestError(f"색인 #{index['id']}에 조각이 없습니다. 먼저 색인을 만드세요")
    by_id = {c["id"]: c for c in chunks}

    results, qvecs = [], []
    for i, q in enumerate(questions):
        if on_step:
            on_step("평가", i, len(questions))
        out = retrieve(env, index, setup["query"], q["question"], TOP_K,
                       project_id=project["id"] if project and project["scope"] == "project" else None)
        vec, lat = out["vec"], out["latency"]
        qvecs.append(vec)
        evidence = q.get("evidence", [])
        qp = q.get("project")
        gold_ids = [c["id"] for c in chunks if any(matches(c, e, qp) for e in evidence)]
        missing = [e for e in evidence if not any(matches(c, e, qp) for c in chunks)]
        ranked = [{"chunk_id": h["row"][0], "score": round(h["score"], 4),
                   "vector_score": round(h["vector_score"], 4), "vector_rank": h["vector_rank"],
                   "keyword_rank": h.get("keyword_rank"),
                   # 질문의 프로젝트 밖 조각이면 False (혼동). 질문에 프로젝트가 없으면 None
                   "in_project": (qp in by_id[h["row"][0]]["projects"]) if qp else None,
                   "correct": any(matches(by_id[h["row"][0]], e, qp) for e in evidence)} for h in out["hits"]]
        retrieved = ranked[:TOP_K]
        rank = next((n for n, h in enumerate(retrieved, 1) if h["correct"]), None)
        # 리랭크 전(벡터 검색) 순위. 리랭크가 꺼져 있으면 rank와 같다. 후보 N개 안에 없으면 None.
        rank_vector = min((h["vector_rank"] for h in ranked if h["correct"] and h["vector_rank"]), default=None)
        results.append({**{k: q.get(k) for k in ("id", "kind", "question", "answer", "env", "abstain", "use", "project")},
                        "evidence": [{**e, "match_by": "quote" if e.get("quote") else "heading"} for e in evidence],
                        "gold_chunk_ids": gold_ids, "missing_evidence": len(missing) > 0,
                        "rank": rank, "rank_vector": rank_vector, "top1_score": retrieved[0]["score"] if retrieved else None,
                        "retrieved": retrieved,
                        "latency_ms": {"embed": round(lat["embed"] * 1000, 1), "db": round(lat["db"] * 1000, 1),
                                       "rerank": round(lat["rerank"] * 1000, 1),
                                       "keyword": round(lat.get("keyword", 0) * 1000, 1),
                                       "total": round(sum(lat.values()) * 1000, 1)}})
        if generator:
            # 검색과 같은 hits로 답을 쓰게 한다. 근거 번호는 검색 순위와 같다.
            try:
                a = answer(env, generator, q["question"], out["hits"])
                results[-1]["answer_eval"] = {
                    "text": a.get("text", ""), "sent": a["sources"], "skipped": a["skipped"], "model": a.get("model"),
                    **{k: a.get(k, 0) for k in ("input_tokens", "cached_tokens", "output_tokens", "ms")},
                    "cost_usd": a.get("cost_usd"),
                } | grade_answer(a.get("text", ""), a["sources"], ranked, bool(q.get("abstain")))
            except comp.ComponentError as e:
                results[-1]["answer_eval"] = {"verdict": "오류", "error": str(e)}
    if on_step:
        on_step("평가", len(questions), len(questions))

    chunk_xy, q_xy, explained = pca_2d(chunk_vecs, np.array(qvecs, dtype=np.float64))
    for c, (x, y) in zip(chunks, chunk_xy):
        c["x"], c["y"] = round(float(x), 5), round(float(y), 5)
        c.pop("_norm")
    for r, (x, y) in zip(results, q_xy):
        r["x"], r["y"] = round(float(x), 5), round(float(y), 5)

    totals = [r["latency_ms"]["total"] for r in results]
    kinds = list(dict.fromkeys(r["kind"] for r in results))
    summary = {
        "all": summarize(results),
        "by_kind": {k: summarize([r for r in results if r["kind"] == k]) for k in kinds
                    if not all(r["abstain"] for r in results if r["kind"] == k)},
        "abstain": {"questions": sum(bool(r["abstain"]) for r in results),
                    "top1_scores": [r["top1_score"] for r in results if r["abstain"]]},
        "latency_ms": {"mean": round(statistics.fmean(totals), 1), "p95": _p95(totals)},
    }
    # 혼동: 질문의 프로젝트 밖 조각이 상위 결과에 들어온 정도. 범위를 걸고 찾았으면 0이라 세지 않는다.
    tagged = [r for r in results if r.get("project") and r["retrieved"]]
    if tagged and not (project and project["scope"] == "project"):
        hits = [h for r in tagged for h in r["retrieved"]]
        summary["confusion"] = {"questions": len(tagged),
                                "top1_foreign": sum(r["retrieved"][0]["in_project"] is False for r in tagged),
                                "foreign_rate": round(sum(h["in_project"] is False for h in hits) / len(hits), 4)}
    if not project:
        names = list(dict.fromkeys(r.get("project") or "" for r in results))
        if len(names) > 1 or names != [""]:
            summary["by_project"] = {n: summarize([r for r in results if (r.get("project") or "") == n]) for n in names
                                     if not all(r["abstain"] for r in results if (r.get("project") or "") == n)}
    if generator:
        summary["answer"] = summarize_answers(results)
    snapshot = {
        "name": setup["name"], "query": setup["query"], "project": project,
        "index": {"id": index["id"], "key": index["key"], "chunker": index["chunker"], "embedder": index["embedder"],
                  "dims": index["dims"], "is_base": index["is_base"],
                  "label": {"chunker": comp.describe("chunker", index["chunker"]),
                            "embedder": comp.describe("embedder", index["embedder"])},
                  "external": comp.is_external("embedder", index["embedder"])},
        "reranker_label": comp.describe("reranker", setup["query"]["reranker"]) if setup["query"]["reranker"] else None,
        "keyword_label": comp.describe("keyword", setup["query"]["keyword"]) if setup["query"]["keyword"] else None,
        "generator_label": comp.describe("generator", generator) if generator else None,
    }
    meta = {"top_k": TOP_K, "recall_at": list(RECALL_AT), "code_commit": code_commit(),
            "questions_file": "eval/questions.jsonl", "questions_sha256": questions_sha,
            "project": project, "question_count": len(questions),
            "documents": len({c["path"] for c in chunks}), "chunks": len(chunks),
            "projection": {"method": "pca", "fit_on": "chunks", "explained": explained},
            "external_query_calls": len(questions) if comp.is_external("embedder", index["embedder"]) else 0}
    with connect(env) as conn:
        run_id = conn.execute(
            """INSERT INTO eval_runs (label, setup, index_id, questions_sha, summary, detail)
               VALUES (%s, %s, %s, %s, %s, %s) RETURNING id""",
            (label, Jsonb(snapshot), index["id"], questions_sha, Jsonb(summary),
             Jsonb({"meta": meta, "questions": results, "chunks": chunks}))).fetchone()[0]
    return {"status": "evaluated", "eval_run_id": run_id, "summary": summary["all"],
            "title": f"Evaluation #{run_id}" + (f" · {project['name']}" if project else "")}


# 저장된 평가 결과 하나를 화면·파일에 쓰는 모양으로 읽는다.
def get_run(run_id: int) -> dict | None:
    with connect(load_env()) as conn:
        row = conn.execute("SELECT id, label, setup, summary, detail, created_at FROM eval_runs WHERE id=%s", (run_id,)).fetchone()
    if row is None:
        return None
    rid, label, setup, summary, detail, created = row
    meta = {**detail["meta"], "run_id": rid, "label": label, "created_at": created.isoformat(), "setup": setup}
    return {"meta": meta, "summary": summary, "questions": detail["questions"], "chunks": detail["chunks"]}


def list_runs(limit: int = 50) -> list[dict]:
    with connect(load_env()) as conn:
        rows = conn.execute("""SELECT id, label, setup, summary, created_at, detail->'meta'->>'questions_sha256'
                               FROM eval_runs ORDER BY id DESC LIMIT %s""", (limit,)).fetchall()
    return [{"run_id": r[0], "label": r[1], "setup": r[2], "summary": r[3]["all"], "latency_ms": r[3]["latency_ms"], "answer": r[3].get("answer"),
             "created_at": r[4].isoformat(), "questions_sha256": r[5], "project": r[2].get("project"),
             "confusion": r[3].get("confusion")} for r in rows]


def export_run(run_id: int, out_dir: Path) -> Path:
    run = get_run(run_id)
    if run is None:
        raise IngestError(f"Evaluation #{run_id} does not exist")
    out_dir.mkdir(parents=True, exist_ok=True)
    idx = run["meta"]["setup"]["index"]
    name = f"{run['meta']['created_at'][:19].replace(':', '').replace('-', '')}_{idx['key'].replace('|', '__')}.json"
    name = re.sub(r"[^\w.\-=,\[\]]", "_", name)
    path = out_dir / name
    path.write_text(json.dumps(run, ensure_ascii=False, indent=1))
    return path
