"""평가 시험지(eval/questions.jsonl) 점검.

웹의 Evaluations › 시험지 탭이 부른다. GET /questions로 점검하고, POST·PUT·DELETE로 파일을 고친다.

점검은 "이 시험지로 채점하면 공정한가"를 본다. 채점 규칙은 evaluate.py와 같다:
꺼낸 조각이 근거 문서이고, 근거 문장(quote)을 글자 그대로 포함하면 정답.
- error: 이대로면 채점이 틀어진다 (근거 문서가 없음, quote가 원문에 없음, quote가 조각 경계에 걸림 등)
- warn:  채점은 되지만 손볼 만하다 (같은 문장이 근거 밖 문서에도 있음, quote 없음, 비슷한 질문)

질문마다 project(프로젝트 이름)를 붙인다. 프로젝트 평가는 그 프로젝트 질문만 골라 돌린다.
project가 없는 질문은 전체 평가에만 들어간다.
"""
from __future__ import annotations

import json
import os
import re
import threading
from collections import Counter, defaultdict

import components as comp
from evaluate import QUESTIONS, load_questions, norm
from indexes import get_index
from ingest import connect, load_env
from search import load_setup

# 시험지 목표 (2026-11-11 사용자 결정). 화면에서 지금 값과 나란히 보여 준다.
TARGET = {
    "questions": 60,
    "kinds": {"직접": 25, "표현 바꿈": 20, "답 없음": 15},
    "uses": {"개선용": 45, "최종 평가용": 15},   # 최종 평가용은 사람이 쓴 질문 위주로
    "per_document": 3,                            # 문서마다 최소 질문 수
    "coverage": 0.6,                              # 근거가 닿은 조각 비율 (현재 색인 기준)
}
KINDS = ("직접", "표현 바꿈", "답 없음")
USES = ("개선용", "최종 평가용")
REQUIRED = ("id", "kind", "question", "evidence", "abstain", "use")
SIMILAR = 0.8                                 # 질문 글자 2개 묶음(bigram)이 이만큼 겹치면 "비슷한 질문"


def _bigrams(text: str) -> set[str]:
    t = re.sub(r"\s+", "", text.lower())
    return {t[i:i + 2] for i in range(len(t) - 1)}


def _similarity(a: set[str], b: set[str]) -> float:
    return len(a & b) / len(a | b) if a and b else 0.0


class QuestionError(Exception):
    """저장을 거절한 이유. status는 API 응답 코드로 쓴다 (404 없음, 409 그사이 바뀜, 422 점검 오류)."""
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def check(index_id: int | None = None, questions: list[dict] | None = None, sha: str | None = None) -> dict:
    """시험지를 점검한다. questions를 주면 파일 대신 그 목록을 본다 (저장 전에 미리 점검할 때)."""
    if questions is None:
        questions, sha = load_questions()
    with connect(load_env()) as conn:
        index = get_index(conn, index_id) if index_id else load_setup(conn)["index"]
        docs = {path: {"id": did, "title": title, "text": norm(content) if content else None, "projects": projects or []}
                for did, path, title, content, projects in conn.execute(
                    """SELECT d.id, d.source_path, d.title, d.content,
                              array_agg(p.name ORDER BY p.name) FILTER (WHERE p.id IS NOT NULL)
                       FROM documents d LEFT JOIN project_documents pd ON pd.document_id = d.id
                       LEFT JOIN projects p ON p.id = pd.project_id GROUP BY d.id""")}
        project_names = [r[0] for r in conn.execute("SELECT name FROM projects ORDER BY created_at, id")]
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
        project = q.get("project")
        if project and project not in project_names:
            add("error", "unknown_project", f"없는 프로젝트예요: {project}")
        elif not project:
            add("warn", "no_project", "프로젝트가 없어 전체 평가에만 들어가요")
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
            elif project in project_names and project not in doc["projects"]:
                add("error", "doc_not_in_project", f"근거 문서가 프로젝트 {project}에 없어요 ({path.split('/')[-1]})", i)
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
    documents = sorted(({"path": p, "title": d["title"], "projects": d["projects"], "chunks": len(by_doc.get(p, [])),
                         "covered": sum(c["id"] in covered for c in by_doc.get(p, [])), "questions": q_per_doc.get(p, 0),
                         "empty_chunks": sum(c["body"] < 20 for c in by_doc.get(p, []))}
                        for p, d in docs.items()), key=lambda d: (d["questions"], d["path"]))
    levels = Counter(c["level"] for q in out for c in q["checks"])
    return {
        "sha": sha, "path": "eval/questions.jsonl", "target": TARGET, "project_names": project_names,
        "index": {"id": index["id"], "chunks": len(chunks), "label": {"chunker": comp.describe("chunker", index["chunker"]),
                                                                      "embedder": comp.describe("embedder", index["embedder"])}},
        "summary": {
            "questions": len(questions), "kinds": {k: sum(q.get("kind") == k for q in questions) for k in KINDS},
            "uses": {u: sum(q.get("use") == u for q in questions) for u in USES},
            "projects": dict(Counter(q.get("project") or "" for q in questions)),
            "evidence": sum(len(q.get("evidence") or []) for q in questions),
            "covered_chunks": len(covered), "errors": levels.get("error", 0), "warnings": levels.get("warn", 0),
            "flagged": sum(bool(q["checks"]) for q in out),
        },
        "last_eval": {"id": last[0], "sha": last[1], "created_at": last[2].isoformat(), "same_set": last[1] == sha} if last else None,
        "documents": documents, "questions": out,
    }


# ── 고치기 ───────────────────────────────────────────────────────────────
# 파일 하나를 통째로 다시 쓴다. 엔진 안에서 동시에 두 번 쓰지 않게 잠그고,
# 읽을 때의 해시(sha)가 지금 파일과 다르면 (그사이 다른 곳에서 고쳤으면) 덮어쓰지 않는다.
_lock = threading.Lock()
FIELDS = ("id", "kind", "question", "answer", "evidence", "env", "abstain", "use", "project")   # 파일에 쓰는 순서


def _chunk_headings(conn) -> dict[str, list[tuple[str, str]]]:
    """현재 색인의 조각을 문서별로: (정규화한 본문, 마지막 제목)."""
    index = load_setup(conn)["index"]
    out: dict[str, list[tuple[str, str]]] = defaultdict(list)
    for path, content, heading in conn.execute(
            """SELECT d.source_path, c.content, c.heading_path FROM chunks c JOIN documents d ON d.id = c.document_id
               WHERE c.index_id = %s ORDER BY d.source_path, c.chunk_index""", (index["id"],)):
        out[path].append((norm(content), heading.split(" > ")[-1]))
    return out


def _clean(raw: dict, qid: str, old: dict | None) -> dict:
    """화면에서 온 값을 파일에 쓸 모양으로. 모르는 항목은 버리고, 제목이 빈 근거는 조각에서 채운다."""
    kind = str(raw.get("kind", "")).strip()
    evidence = [{"path": str(e.get("path", "")).strip(), "heading": str(e.get("heading") or "").strip(),
                 "quote": " ".join(str(e.get("quote") or "").split())}
                for e in raw.get("evidence") or []]
    if any(not e["heading"] for e in evidence):
        with connect(load_env()) as conn:
            chunks = _chunk_headings(conn)
        for e in evidence:
            if not e["heading"]:
                e["heading"] = next((h for text, h in chunks.get(e["path"], []) if e["quote"] and norm(e["quote"]) in text), "")
    q = {"id": qid, "kind": kind, "question": str(raw.get("question", "")).strip(), "answer": str(raw.get("answer") or "").strip(),
         "evidence": evidence, "env": str(raw.get("env") or (old or {}).get("env") or "혼합").strip(),
         "abstain": kind == "답 없음",            # 답 없는 질문 = 문서에 답이 없어 보류가 정답
         "use": str(raw.get("use", "")).strip(),
         # 화면이 project를 보내지 않으면 원래 값을 그대로 둔다. 빈 값을 보내면 뗀다.
         "project": (str(raw["project"] or "").strip() if "project" in raw else str((old or {}).get("project") or "")) or None}
    if not q["question"]:
        raise QuestionError(422, "질문을 적어 주세요")
    if not q["project"] and evidence:
        # 프로젝트를 고르지 않았으면 근거 문서가 들어온(원본) 프로젝트로 정한다. 여러 곳이면 비워 둔다.
        with connect(load_env()) as conn:
            names = {r[0] for r in conn.execute(
                """SELECT DISTINCT p.name FROM documents d JOIN project_documents pd ON pd.document_id = d.id AND pd.is_origin
                   JOIN projects p ON p.id = pd.project_id WHERE d.source_path = ANY(%s)""", ([e["path"] for e in evidence],))}
        if len(names) == 1:
            q["project"] = names.pop()
    return {k: q[k] for k in FIELDS}


def _next_id(questions: list[dict]) -> str:
    nums = [int(m.group(1)) for q in questions if (m := re.fullmatch(r"q(\d+)", str(q.get("id", ""))))]
    return f"q{max(nums, default=0) + 1:02d}"


def _write(questions: list[dict]) -> None:
    """임시 파일에 다 쓴 뒤 바꿔치기한다. 쓰다가 멈춰도 원래 파일은 그대로 남는다."""
    tmp = QUESTIONS.with_name(f".{QUESTIONS.name}.tmp")
    tmp.write_text("".join(json.dumps(q, ensure_ascii=False) + "\n" for q in questions), encoding="utf-8")
    os.replace(tmp, QUESTIONS)


def _load_expected(sha: str) -> list[dict]:
    questions, current = load_questions()
    if current != sha:
        raise QuestionError(409, "그사이 시험지 파일이 바뀌었어요. [다시 점검]으로 새로 불러온 뒤 고쳐 주세요")
    return questions


def save(sha: str, raw: dict, qid: str | None = None) -> dict:
    """질문 하나를 추가(qid 없음)하거나 고친다. 저장 전에 점검하고, 그 질문에 오류가 있으면 쓰지 않는다."""
    with _lock:
        questions = _load_expected(sha)
        if qid is None:
            new_id = _next_id(questions)
            q = _clean(raw, new_id, None)
            after = questions + [q]
        else:
            pos = next((i for i, x in enumerate(questions) if x.get("id") == qid), None)
            if pos is None:
                raise QuestionError(404, f"질문 {qid}가 없어요")
            q = _clean(raw, qid, questions[pos])
            after = questions[:pos] + [q] + questions[pos + 1:]
        result = check(questions=after, sha=sha)
        mine = next(x for x in result["questions"] if x["id"] == q["id"])
        errors = [c for c in mine["checks"] if c["level"] == "error"]
        if errors:
            raise QuestionError(422, "저장하지 않았어요: " + " · ".join(
                (f"근거 {c['evidence'] + 1}: " if c["evidence"] is not None else "") + c["message"] for c in errors))
        _write(after)
    return {"id": q["id"], **check()}


def delete(sha: str, qid: str) -> dict:
    with _lock:
        questions = _load_expected(sha)
        after = [q for q in questions if q.get("id") != qid]
        if len(after) == len(questions):
            raise QuestionError(404, f"질문 {qid}가 없어요")
        _write(after)
    return check()


# ── 근거 문장 찾기 ─────────────────────────────────────────────────────────
# 문서 원문에서 검색어가 든 문장을 돌려준다. 고르면 그 문장이 그대로 quote가 되어, 손으로 옮겨 적다 틀리는 일을 막는다.
MARKER = re.compile(r"^\s*(?:#{1,6}|[-*+>]|\d+[.)])\s+")
SENTENCE = re.compile(r"(?<=[.!?])\s+")


def search_evidence(query: str, limit: int = 20) -> list[dict]:
    words = norm(query).lower()
    if len(words) < 2:
        return []
    out = []
    with connect(load_env()) as conn:
        chunks = _chunk_headings(conn)
        docs = conn.execute("SELECT source_path, title, content FROM documents WHERE content IS NOT NULL ORDER BY source_path").fetchall()
    for path, title, content in docs:
        seen = set()
        for line in content.splitlines():
            text = norm(MARKER.sub("", line))
            if words not in text.lower():
                continue
            # 긴 문단이면 검색어가 든 문장만. 검색어가 문장 경계를 넘으면 줄 전체를 쓴다.
            parts = [p for p in SENTENCE.split(text) if words in p.lower()] or [text]
            for part in parts:
                part = part.strip("| ").strip()
                if not part or part in seen:
                    continue
                seen.add(part)
                inside = [h for t, h in chunks.get(path, []) if part in t]
                out.append({"path": path, "title": title, "quote": part, "heading": inside[0] if inside else "",
                            "in_chunk": bool(inside)})
                if len(out) >= limit:
                    return out
    return out
