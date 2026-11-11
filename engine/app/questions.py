"""평가 시험지(eval/questions.jsonl) 점검.

웹의 Evaluations › 시험지 탭이 GET /questions로 부른다. 1단계라 읽기만 한다 (고치기는 다음 단계).

점검은 "이 시험지로 채점하면 공정한가"를 본다. 채점 규칙은 evaluate.py와 같다:
꺼낸 조각이 근거 문서이고, 근거 문장(quote)을 글자 그대로 포함하면 정답.
- error: 이대로면 채점이 틀어진다 (근거 문서가 없음, quote가 원문에 없음, quote가 조각 경계에 걸림 등)
- warn:  채점은 되지만 손볼 만하다 (같은 문장이 근거 밖 문서에도 있음, quote 없음, 비슷한 질문)
"""
from __future__ import annotations

import re
from collections import Counter, defaultdict

import components as comp
from evaluate import load_questions, norm
from indexes import get_index
from ingest import connect, load_env
from search import load_setup

TARGET = 60                                   # 목표 질문 수 (제안값, 사용자가 정하면 바꾼다)
KINDS = ("직접", "표현 바꿈", "답 없음")
USES = ("개선용", "최종 평가용")
REQUIRED = ("id", "kind", "question", "evidence", "abstain", "use")
SIMILAR = 0.8                                 # 질문 글자 2개 묶음(bigram)이 이만큼 겹치면 "비슷한 질문"


def _bigrams(text: str) -> set[str]:
    t = re.sub(r"\s+", "", text.lower())
    return {t[i:i + 2] for i in range(len(t) - 1)}


def _similarity(a: set[str], b: set[str]) -> float:
    return len(a & b) / len(a | b) if a and b else 0.0


def check(index_id: int | None = None) -> dict:
    questions, sha = load_questions()
    with connect(load_env()) as conn:
        index = get_index(conn, index_id) if index_id else load_setup(conn)["index"]
        docs = {path: {"id": did, "title": title, "text": norm(content) if content else None}
                for did, path, title, content in conn.execute("SELECT id, source_path, title, content FROM documents")}
        chunks = [{"id": cid, "path": path, "index": idx, "text": norm(content), "body": len(content.split("\n", 1)[-1].strip())}
                  for cid, path, idx, content in conn.execute(
                      """SELECT c.id, d.source_path, c.chunk_index, c.content FROM chunks c JOIN documents d ON d.id = c.document_id
                         WHERE c.index_id = %s ORDER BY d.source_path, c.chunk_index""", (index["id"],))]
        last = conn.execute("SELECT id, detail->'meta'->>'questions_sha256', created_at FROM eval_runs ORDER BY id DESC LIMIT 1").fetchone()

    by_doc = defaultdict(list)
    for c in chunks:
        by_doc[c["path"]].append(c)
    covered: set[int] = set()                     # 근거 문장이 들어 있는 조각 (문서별 고르기 계산용)
    ids = Counter(q.get("id") for q in questions)
    grams = {q.get("id"): _bigrams(q.get("question", "")) for q in questions}
    out = []

    for q in questions:
        checks: list[dict] = []
        add = lambda level, code, msg, ev=None: checks.append({"level": level, "code": code, "message": msg, "evidence": ev})
        missing = [f for f in REQUIRED if f not in q]
        if missing:
            add("error", "format", f"빠진 항목: {', '.join(missing)}")
        if ids[q.get("id")] > 1:
            add("error", "duplicate_id", f"같은 id가 {ids[q.get('id')]}번 있어요")
        if q.get("kind") not in KINDS:
            add("error", "format", f"종류가 {KINDS} 중 하나가 아니에요: {q.get('kind')!r}")
        if q.get("use") not in USES:
            add("error", "format", f"용도가 {USES} 중 하나가 아니에요: {q.get('use')!r}")
        evidence = q.get("evidence") or []
        if q.get("abstain") and evidence:
            add("error", "abstain_with_evidence", "답 없는 질문인데 근거가 있어요")
        if not q.get("abstain") and not evidence:
            add("error", "no_evidence", "답 있는 질문인데 근거가 없어요")

        paths = {e.get("path") for e in evidence}
        ev_out = []
        for i, e in enumerate(evidence):
            path, quote = e.get("path"), norm(e.get("quote") or "")
            info = {**e, "in_document": None, "chunk_ids": [], "elsewhere": []}
            doc = docs.get(path)
            if doc is None:
                add("error", "doc_missing", f"근거 문서가 DB에 없어요: {path}", i)
            elif not quote:
                add("warn", "no_quote", "근거 문장(quote)이 없어 제목으로만 채점해요", i)
            else:
                info["in_document"] = None if doc["text"] is None else quote in doc["text"]
                info["chunk_ids"] = [c["id"] for c in by_doc.get(path, []) if quote in c["text"]]
                covered.update(info["chunk_ids"])
                if info["in_document"] is False:
                    add("error", "quote_not_in_document", f"근거 문장이 원문에 없어요 ({path.split('/')[-1]})", i)
                elif not info["chunk_ids"]:
                    add("error", "quote_split", f"근거 문장이 조각 경계에 걸려 이 색인에선 정답이 될 수 없어요 ({path.split('/')[-1]})", i)
                info["elsewhere"] = sorted(p for p, d in docs.items() if p not in paths and d["text"] and quote in d["text"])
                if info["elsewhere"]:
                    add("warn", "quote_elsewhere", f"같은 문장이 근거에 없는 문서에도 있어요: {', '.join(p.split('/')[-1] for p in info['elsewhere'])}", i)
            ev_out.append(info)

        for other in questions:
            if other is q or other.get("id") is None:
                continue
            score = _similarity(grams[q.get("id")], grams[other["id"]])
            if score >= SIMILAR:
                add("warn", "similar", f"{other['id']}와 질문이 거의 같아요 ({round(score * 100)}%)")
        out.append({**q, "evidence": ev_out, "checks": checks})

    # 문서별: 조각 수, 근거가 닿은 조각 수, 질문 수. 질문이 적은 문서가 위로.
    q_per_doc = Counter(p for q in questions for p in {e.get("path") for e in q.get("evidence") or []})
    documents = sorted(({"path": p, "title": d["title"], "chunks": len(by_doc.get(p, [])),
                         "covered": sum(c["id"] in covered for c in by_doc.get(p, [])), "questions": q_per_doc.get(p, 0),
                         "empty_chunks": sum(c["body"] < 20 for c in by_doc.get(p, []))}
                        for p, d in docs.items()), key=lambda d: (d["questions"], d["path"]))
    levels = Counter(c["level"] for q in out for c in q["checks"])
    return {
        "sha": sha, "path": "eval/questions.jsonl", "target": TARGET,
        "index": {"id": index["id"], "chunks": len(chunks), "label": {"chunker": comp.describe("chunker", index["chunker"]),
                                                                      "embedder": comp.describe("embedder", index["embedder"])}},
        "summary": {
            "questions": len(questions), "kinds": {k: sum(q.get("kind") == k for q in questions) for k in KINDS},
            "uses": {u: sum(q.get("use") == u for q in questions) for u in USES},
            "evidence": sum(len(q.get("evidence") or []) for q in questions),
            "covered_chunks": len(covered), "errors": levels.get("error", 0), "warnings": levels.get("warn", 0),
            "flagged": sum(bool(q["checks"]) for q in out),
        },
        "last_eval": {"id": last[0], "sha": last[1], "created_at": last[2].isoformat(), "same_set": last[1] == sha} if last else None,
        "documents": documents, "questions": out,
    }
