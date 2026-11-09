"""검색 평가: 평가 질문으로 실제 검색을 돌려 지표를 재고, 화면에서 볼 결과 파일을 만든다.

사용 (저장소 루트에서, DB·임베딩 서버가 떠 있어야 한다):
  .venv/bin/python eval/run.py
  .venv/bin/python eval/run.py --label "baseline"     # 결과 이름에 붙일 메모

결과: eval/results/<시각>_<모델>_<청킹>.json, 목록은 eval/results/index.json
- 검색은 search.py와 같은 pgvector 코사인 거리 SQL을 쓴다. 평가 대상이 실제 시스템 경로여야 하므로 numpy로 다시 계산하지 않는다.
- 정답 판정: 꺼낸 조각의 (문서 경로, 마지막 제목)이 질문의 근거 위치 중 하나와 같으면 정답.
- 답 없는 질문(abstain)은 성공률 계산에서 빼고, 무엇이 몇 점으로 올라왔는지만 기록한다. 보류 기준은 사용자가 정한다.
- 그림 좌표: 조각 벡터로 PCA 축을 정하고, 질문은 같은 축에 투영한다. 질문을 바꿔도 조각 배치가 움직이지 않게 하려는 것이다.
- 결과 파일에는 조각 앞부분 글이 들어간다. 회사 문서가 섞여 있으면 결과 파일을 커밋하지 않는다.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import statistics
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "engine" / "app"))
from ingest import connect, embed_url, load_env, tei_post  # noqa: E402

QUESTIONS = ROOT / "eval" / "questions.jsonl"
RESULTS = ROOT / "eval" / "results"
MODEL = "bge-m3"
CHUNKING = "heading-b"   # ##/### 제목 단위 + 임베딩 글에 제목 경로를 붙임 (방식 B)
TOP_K = 10               # 저장은 10개까지, 성공률은 1·3·5에서 본다
RECALL_AT = (1, 3, 5)

SEARCH_SQL = """
SELECT c.id, 1 - (c.embedding <=> %(q)s::vector) AS score
FROM chunks c
ORDER BY c.embedding <=> %(q)s::vector
LIMIT %(k)s
"""

CHUNKS_SQL = """
SELECT c.id, d.source_path, d.title, c.chunk_index, c.heading_path, c.content, c.embedding::text
FROM chunks c JOIN documents d ON d.id = c.document_id
ORDER BY d.source_path, c.chunk_index
"""


def load_questions() -> list[dict]:
    return [json.loads(line) for line in QUESTIONS.read_text().splitlines() if line.strip()]


# 저장된 조각 전체와 벡터를 읽는다. 정답 판정용 키(경로, 마지막 제목)도 만든다.
def load_chunks(env: dict) -> tuple[list[dict], np.ndarray]:
    with connect(env) as conn:
        rows = conn.execute(CHUNKS_SQL).fetchall()
    chunks, vecs = [], []
    for cid, path, title, idx, heading_path, content, emb in rows:
        heading = heading_path.split(" > ")[-1]
        chunks.append({"id": cid, "path": path, "title": title, "index": idx, "heading": heading,
                       "heading_path": heading_path, "snippet": content[:240]})
        vecs.append(json.loads(emb))
    return chunks, np.array(vecs, dtype=np.float64)


# 질문 하나를 임베딩하고 검색한다. 임베딩 시간과 DB 시간을 따로 잰다.
def run_query(env: dict, question: str) -> tuple[list[float], list[tuple[int, float]], float, float]:
    t0 = time.perf_counter()
    vec = tei_post(f"{embed_url(env)}/embed", {"inputs": question})[0]
    t1 = time.perf_counter()
    with connect(env) as conn:
        hits = conn.execute(SEARCH_SQL, {"q": json.dumps(vec), "k": TOP_K}).fetchall()
    t2 = time.perf_counter()
    return vec, [(cid, float(score)) for cid, score in hits], (t1 - t0) * 1000, (t2 - t1) * 1000


# 조각 벡터로 PCA 2축을 구하고, 조각·질문 좌표와 2축이 담은 정보 비율을 돌려준다.
def pca_2d(chunk_vecs: np.ndarray, question_vecs: np.ndarray) -> tuple[np.ndarray, np.ndarray, list[float]]:
    mean = chunk_vecs.mean(axis=0)
    centered = chunk_vecs - mean
    _, s, vt = np.linalg.svd(centered, full_matrices=False)
    axes = vt[:2]
    # 축 방향(부호)은 SVD 결과마다 뒤집힐 수 있어, 조각 좌표 합이 양수가 되게 맞춘다 (같은 데이터면 같은 그림).
    for i in range(2):
        if (centered @ axes[i]).sum() < 0:
            axes[i] = -axes[i]
    explained = (s ** 2) / (s ** 2).sum()
    return centered @ axes.T, (question_vecs - mean) @ axes.T, [float(explained[0]), float(explained[1])]


def git_commit() -> str:
    try:
        out = subprocess.run(["git", "-C", str(ROOT), "rev-parse", "--short", "HEAD"],
                             capture_output=True, text=True, check=True).stdout.strip()
        dirty = subprocess.run(["git", "-C", str(ROOT), "status", "--porcelain", "--", "engine", "eval/run.py"],
                               capture_output=True, text=True).stdout.strip()
        return out + ("-dirty" if dirty else "")
    except (OSError, subprocess.CalledProcessError):
        return "unknown"


def mean(xs: list[float]) -> float | None:
    return round(statistics.fmean(xs), 4) if xs else None


def p95(xs: list[float]) -> float | None:
    if not xs:
        return None
    s = sorted(xs)
    return s[min(len(s) - 1, int(round(0.95 * (len(s) - 1))))]


# 정답이 있는 질문 묶음의 지표: recall@k, MRR, 질문 수.
def summarize(results: list[dict]) -> dict:
    graded = [r for r in results if not r["abstain"]]
    out: dict = {"questions": len(graded)}
    for k in RECALL_AT:
        out[f"recall@{k}"] = mean([1.0 if r["rank"] and r["rank"] <= k else 0.0 for r in graded])
    out["mrr"] = mean([1.0 / r["rank"] if r["rank"] else 0.0 for r in graded])
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description="검색 평가")
    ap.add_argument("--label", default="", help="결과에 붙일 짧은 메모")
    a = ap.parse_args()

    env = load_env()
    questions = load_questions()
    chunks, chunk_vecs = load_chunks(env)
    if not chunks:
        sys.exit("저장된 조각이 없습니다. 먼저 문서를 가져오세요.")
    by_id = {c["id"]: c for c in chunks}

    # 질문마다 검색하고, 근거 위치와 같은 조각이 몇 위에 나왔는지 찾는다.
    results, qvecs = [], []
    for q in questions:
        vec, hits, t_embed, t_db = run_query(env, q["question"])
        qvecs.append(vec)
        gold = {(e["path"], e["heading"]) for e in q.get("evidence", [])}
        gold_ids = [c["id"] for c in chunks if (c["path"], c["heading"]) in gold]
        retrieved = [{"chunk_id": cid, "score": round(score, 4),
                      "correct": (by_id[cid]["path"], by_id[cid]["heading"]) in gold} for cid, score in hits]
        rank = next((i for i, h in enumerate(retrieved, 1) if h["correct"]), None)
        results.append({**{k: q.get(k) for k in ("id", "kind", "question", "answer", "env", "abstain", "use")},
                        "evidence": q.get("evidence", []), "gold_chunk_ids": gold_ids,
                        "missing_evidence": len(gold_ids) < len(gold),
                        "rank": rank, "top1_score": retrieved[0]["score"] if retrieved else None,
                        "retrieved": retrieved,
                        "latency_ms": {"embed": round(t_embed, 1), "db": round(t_db, 1),
                                       "total": round(t_embed + t_db, 1)}})
        mark = "보류" if q.get("abstain") else (f"{rank}위" if rank else "실패")
        print(f"{q['id']} {mark:>4}  top1 {results[-1]['top1_score']:.3f}  {q['question'][:40]}")

    chunk_xy, q_xy, explained = pca_2d(chunk_vecs, np.array(qvecs, dtype=np.float64))
    for c, (x, y) in zip(chunks, chunk_xy):
        c["x"], c["y"] = round(float(x), 5), round(float(y), 5)
    for r, (x, y) in zip(results, q_xy):
        r["x"], r["y"] = round(float(x), 5), round(float(y), 5)

    totals = [r["latency_ms"]["total"] for r in results]
    summary = {
        "all": summarize(results),
        "by_kind": {kind: summarize([r for r in results if r["kind"] == kind])
                    for kind in dict.fromkeys(r["kind"] for r in results) if not all(
                        r["abstain"] for r in results if r["kind"] == kind)},
        "abstain": {"questions": sum(r["abstain"] for r in results),
                    "top1_scores": [r["top1_score"] for r in results if r["abstain"]]},
        "latency_ms": {"mean": round(statistics.fmean(totals), 1), "p95": p95(totals)},
    }

    created = datetime.now().astimezone()
    run_id = f"{created:%Y%m%d-%H%M%S}_{MODEL}_{CHUNKING}"
    meta = {
        "run_id": run_id, "created_at": created.isoformat(timespec="seconds"), "label": a.label,
        "model": MODEL, "model_revision": env.get("EMBED_MODEL_REVISION", ""), "chunking": CHUNKING,
        "top_k": TOP_K, "recall_at": list(RECALL_AT), "code_commit": git_commit(),
        "questions_file": str(QUESTIONS.relative_to(ROOT)),
        "questions_sha256": hashlib.sha256(QUESTIONS.read_bytes()).hexdigest()[:12],
        "documents": len({c["path"] for c in chunks}), "chunks": len(chunks),
        "projection": {"method": "pca", "fit_on": "chunks", "explained": explained},
    }

    RESULTS.mkdir(parents=True, exist_ok=True)
    (RESULTS / f"{run_id}.json").write_text(
        json.dumps({"meta": meta, "summary": summary, "questions": results, "chunks": chunks},
                   ensure_ascii=False, indent=1))

    # 목록 파일: 화면에서 실행 결과를 고르고 지표를 나란히 보는 데 쓴다. 최신이 먼저.
    index_path = RESULTS / "index.json"
    index = json.loads(index_path.read_text()) if index_path.exists() else []
    index = [e for e in index if e["run_id"] != run_id and (RESULTS / f"{e['run_id']}.json").exists()]
    index.insert(0, {**{k: meta[k] for k in ("run_id", "created_at", "label", "model", "chunking",
                                             "questions_sha256", "chunks")}, "summary": summary["all"],
                     "latency_ms": summary["latency_ms"]})
    index_path.write_text(json.dumps(index, ensure_ascii=False, indent=1))

    s = summary["all"]
    print(f"\n정답 있는 질문 {s['questions']}개: "
          + " · ".join(f"recall@{k} {s[f'recall@{k}']:.2f}" for k in RECALL_AT)
          + f" · MRR {s['mrr']:.2f} · 평균 {summary['latency_ms']['mean']}ms")
    print(f"그림 2축이 담은 정보: {sum(explained) * 100:.1f}%")
    print(f"저장: {(RESULTS / f'{run_id}.json').relative_to(ROOT)}")


if __name__ == "__main__":
    main()
