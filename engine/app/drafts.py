"""평가 질문 초안 (시험지 3단계).

질문이 적은 문서의 조각부터 골라 LLM에 보내고, 조각 하나에서 "직접" 질문과 "표현 바꿈" 질문을 하나씩 받는다.
- 외부 전송이 허용된 문서(external_ok)의 조각만 보낸다. 나머지는 고르지 않는다.
- 근거 문장(quote)이 조각 원문과 글자 그대로 맞지 않으면 버린다 (LLM이 문장을 고쳐 쓰는 일이 흔해서).
- "답 없음" 질문은 만들지 않는다. 문서에 없는 것을 아는 건 사람이라서.
- 초안은 eval_drafts 표에 두고, 사람이 [넣기]를 고른 것만 시험지 파일에 들어간다 (넣는 길은 questions.save와 같다).
"""
from __future__ import annotations

import json
import re
from collections import Counter, defaultdict
from typing import Callable

import components as comp
import usage
from evaluate import load_questions, norm
from ingest import IngestError, connect, load_env
from questions import SIMILAR, _bigrams, _similarity
from search import load_setup

MODEL = "gpt-6-luna"           # 가장 싼 모델. 조각 하나에 약 $0.0002
MAX_CHUNKS = 20                # 한 번에 보낼 조각 수 상한 (비용·검토 부담)
MIN_BODY = 80                  # 본문이 이보다 짧은 조각(제목만 있는 조각 등)은 고르지 않는다
MIN_QUOTE = 8
# 목차 조각: 줄 대부분이 "- [제목](파일.md)" 같은 링크 목록이면 고르지 않는다.
# 여기서 나온 질문은 "어느 항목에서 다루나요?"처럼 문서 구조를 묻게 되어 실제 질문이 아니고, 목차만 찾아와도 정답이 되어 점수가 부푼다.
LINK_LINE = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s*\[[^\]]+\]\([^)]+\)")
LINK_SHARE = 0.5

RULES = """너는 RAG 검색 평가에 쓸 질문을 만든다. 아래 문서 조각 하나만 보고 JSON 객체 하나만 출력한다. 설명이나 코드 블록 없이 JSON만.
- question: 이 조각을 읽어야 답할 수 있는 질문 하나. 실제 사람이 물어볼 말투로, 한국어로. 조각의 문장을 그대로 옮기지 않는다.
- answer: 한두 문장의 정답.
- quote: 정답의 근거가 되는 조각 속 문장. 조각에서 글자 그대로 복사한다. 고치거나 바꿔 쓰지 않는다. 한 문장, 되도록 120자 이내.
- paraphrase: question과 같은 것을 묻지만, 조각에 나온 핵심 단어를 되도록 쓰지 않고 다른 말로 바꾼 질문.
- 문서의 구조(몇 번 항목, 어느 문서·어느 절에서 다루는지)를 묻지 않는다. 내용 자체를 묻는다.
조각에 질문을 만들 만한 사실이 없으면(목차, 링크 목록, 인사말 등) {"skip": true}만 출력한다.
형식: {"question": "...", "answer": "...", "quote": "...", "paraphrase": "..."}"""


def _parse(text: str) -> dict | None:
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        return None
    try:
        data = json.loads(m.group(0))
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


def is_link_list(body: str) -> bool:
    lines = [line for line in body.splitlines() if line.strip()]
    return len(lines) >= 2 and sum(bool(LINK_LINE.match(line)) for line in lines) / len(lines) >= LINK_SHARE


def pick_chunks(conn, count: int) -> tuple[list[dict], int]:
    """초안을 만들 조각을 고른다. 질문이 적은 문서부터 한 조각씩 돌아가며 고르고, 근거가 이미 닿은 조각은 건너뛴다.
    돌려주는 두 번째 값은 외부 전송이 막혀 고르지 않은 문서 수."""
    questions, _ = load_questions()
    index = load_setup(conn)["index"]
    rows = conn.execute(
        """SELECT c.id, d.source_path, d.title, d.external_ok, c.chunk_index, c.heading_path, c.content
           FROM chunks c JOIN documents d ON d.id = c.document_id
           WHERE c.index_id = %s ORDER BY d.source_path, c.chunk_index""", (index["id"],)).fetchall()
    taken = {r[0] for r in conn.execute("SELECT DISTINCT chunk_id FROM eval_drafts WHERE status <> 'discarded' AND chunk_id IS NOT NULL")}
    quotes = defaultdict(list)
    for q in questions:
        for e in q.get("evidence") or []:
            if e.get("quote"):
                quotes[e.get("path")].append(norm(e["quote"]))
    per_doc = Counter(p for q in questions for p in {e.get("path") for e in q.get("evidence") or []})

    blocked, by_doc = set(), defaultdict(list)
    for cid, path, title, external_ok, idx, heading, content in rows:
        if not external_ok:
            blocked.add(path)
            continue
        text = norm(content)
        body = content.split("\n", 1)[-1].strip()
        if cid in taken or len(body) < MIN_BODY or is_link_list(body) or any(qt in text for qt in quotes.get(path, [])):
            continue
        by_doc[path].append({"id": cid, "path": path, "title": title, "heading": heading.split(" > ")[-1], "content": content,
                              "external_ok": external_ok})

    order = sorted(by_doc, key=lambda p: (per_doc.get(p, 0), p))
    picked: list[dict] = []
    while len(picked) < count and any(by_doc[p] for p in order):
        for p in order:
            if by_doc[p] and len(picked) < count:
                picked.append(by_doc[p].pop(0))
    return picked, len(blocked)


def make_drafts(count: int, batch: str, on_step: Callable[[str, int | None, int | None], None] | None = None,
                model: str = MODEL) -> dict:
    """worker가 부르는 작업. 조각마다 LLM을 한 번 부르고, 확인을 통과한 초안만 저장한다."""
    env = load_env()
    gen = comp.make_generator({"id": "openai-llm", "params": {"model": model, "sources": "3", "max_output": "400"}}, env)
    count = max(1, min(MAX_CHUNKS, count))
    with connect(env) as conn:
        chunks, blocked = pick_chunks(conn, count)
    if not chunks:
        raise IngestError("초안을 만들 조각이 없어요. 근거가 닿지 않은 조각이 없거나, 외부 전송이 허용된 문서가 없어요")

    stats = Counter()
    tin = tout = cached = 0
    cost = 0.0
    for i, c in enumerate(chunks):
        if on_step:
            on_step("초안 만들기", i, len(chunks))
        # 외부 전송 검사는 다른 곳과 같은 함수로 한 번 더 (고를 때 이미 걸렀지만, 막힌 문서가 새지 않게)
        comp.check_external({"id": "openai-llm", "params": {}}, c["title"], bool(c["external_ok"]), stage="generator")
        body = {"model": model, "instructions": RULES,
                "input": f"문서: {c['title']}\n제목: {c['heading']}\n\n조각:\n{c['content']}",
                "max_output_tokens": 400, "reasoning": {"effort": "none"}, "store": False}
        try:
            data = comp.openai_post(gen.base, "/responses", gen.key, body, timeout=90)
        except comp.ComponentError:
            stats["api_error"] += 1
            continue
        text = "".join(x.get("text", "") for o in data.get("output", []) if o.get("type") == "message"
                       for x in o.get("content", []) if x.get("type") == "output_text")
        u = data.get("usage", {})
        a, b = u.get("input_tokens", 0), u.get("output_tokens", 0)
        k = (u.get("input_tokens_details") or {}).get("cached_tokens", 0)
        price = comp.cost_usd(model, a, b, k) or 0.0
        tin, tout, cached, cost = tin + a, tout + b, cached + k, cost + price

        d = _parse(text)
        if d is None:
            stats["bad_format"] += 1
            continue
        if d.get("skip"):
            stats["skipped"] += 1
            continue
        quote = " ".join(str(d.get("quote", "")).split()).strip().strip('"“”')
        question = str(d.get("question", "")).strip()
        if not question or len(norm(quote)) < MIN_QUOTE or norm(quote) not in norm(c["content"]):
            stats["quote_mismatch"] += 1          # 원문과 글자 그대로 맞지 않는 근거는 채점을 틀어지게 하므로 버린다
            continue
        with connect(env) as conn:
            first = conn.execute(
                """INSERT INTO eval_drafts (batch, kind, question, answer, path, heading, quote, chunk_id, model,
                       input_tokens, output_tokens, cost_usd)
                   VALUES (%s, '직접', %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING id""",
                (batch, question, str(d.get("answer", "")).strip(), c["path"], c["heading"], quote, c["id"], model,
                 a, b, price)).fetchone()[0]
            stats["made"] += 1
            para = str(d.get("paraphrase", "")).strip()
            if para:
                conn.execute(
                    """INSERT INTO eval_drafts (batch, kind, question, answer, path, heading, quote, chunk_id, pair_id, model)
                       VALUES (%s, '표현 바꿈', %s, %s, %s, %s, %s, %s, %s, %s)""",
                    (batch, para, str(d.get("answer", "")).strip(), c["path"], c["heading"], quote, c["id"], first, model))
                stats["made"] += 1
    if on_step:
        on_step("초안 만들기", len(chunks), len(chunks))

    # 비용 확인용으로 사용 기록에도 한 줄 남긴다 (Playground 사용량과는 service로 나뉜다)
    usage.record(env, {"service": "eval-drafts", "status": "ok", "question": f"평가 초안 · 조각 {len(chunks)}개",
                       "setup": {"generator": {"id": "openai-llm", "params": {"model": model}}},
                       "input_tokens": tin, "cached_tokens": cached, "output_tokens": tout, "cost_usd": round(cost, 8)})
    return {"chunks": len(chunks), "made": stats["made"], "quote_mismatch": stats["quote_mismatch"],
            "skipped": stats["skipped"], "bad_format": stats["bad_format"], "api_error": stats["api_error"],
            "blocked_documents": blocked, "input_tokens": tin, "output_tokens": tout, "cost_usd": round(cost, 8)}


def list_drafts() -> dict:
    """고르기 전 초안과 확인 결과. 문서가 바뀌었을 수 있어서, 원문·조각 확인은 볼 때마다 다시 한다."""
    questions, _ = load_questions()
    grams = {q["id"]: _bigrams(q.get("question", "")) for q in questions if q.get("id")}
    with connect(load_env()) as conn:
        index = load_setup(conn)["index"]
        docs = {p: norm(t) for p, t in conn.execute("SELECT source_path, content FROM documents WHERE content IS NOT NULL")}
        chunks = defaultdict(list)
        for cid, path, content in conn.execute(
                """SELECT c.id, d.source_path, c.content FROM chunks c JOIN documents d ON d.id = c.document_id
                   WHERE c.index_id = %s""", (index["id"],)):
            chunks[path].append((cid, norm(content)))
        cur = conn.execute("""SELECT id, batch, created_at, kind, question, answer, path, heading, quote, chunk_id, pair_id
                              FROM eval_drafts WHERE status = 'pending' ORDER BY id""")
        rows = [dict(zip([c.name for c in cur.description], r)) for r in cur.fetchall()]
        totals = dict(conn.execute("SELECT status, count(*) FROM eval_drafts GROUP BY status").fetchall())
        spent = conn.execute("SELECT coalesce(sum(cost_usd), 0) FROM eval_drafts").fetchone()[0]

    out = []
    for r in rows:
        quote = norm(r["quote"])
        mine = _bigrams(r["question"])
        similar = [f"{qid} {round(s * 100)}%" for qid, g in grams.items() if (s := _similarity(mine, g)) >= SIMILAR]
        similar += [f"초안 {o['id']} {round(s * 100)}%" for o in rows
                    if o["id"] != r["id"] and (s := _similarity(mine, _bigrams(o["question"]))) >= SIMILAR]
        out.append({**r, "created_at": r["created_at"].isoformat(),
                    "in_document": quote in docs.get(r["path"], ""),
                    "chunk_ids": [cid for cid, text in chunks.get(r["path"], []) if quote in text],
                    "elsewhere": sorted(p for p, t in docs.items() if p != r["path"] and quote in t),
                    "similar": similar})
    return {"drafts": out, "totals": {k: totals.get(k, 0) for k in ("pending", "accepted", "discarded")},
            "spent_usd": float(spent), "model": MODEL, "max_chunks": MAX_CHUNKS}


def get_pending(conn, draft_id: int) -> dict:
    cur = conn.execute("SELECT id, status FROM eval_drafts WHERE id = %s", (draft_id,))
    row = cur.fetchone()
    if row is None:
        raise IngestError(f"초안 {draft_id}이 없어요")
    if row[1] != "pending":
        raise IngestError(f"초안 {draft_id}은 이미 {'넣었어요' if row[1] == 'accepted' else '버렸어요'}")
    return {"id": row[0]}


def decide(draft_id: int, status: str, question_id: str | None = None) -> None:
    with connect(load_env()) as conn:
        conn.execute("UPDATE eval_drafts SET status = %s, question_id = %s, decided_at = now() WHERE id = %s AND status = 'pending'",
                     (status, question_id, draft_id))


def undo(draft_id: int, sha: str) -> dict:
    """[되돌리기]: 넣은 초안이면 시험지에서 그 질문을 지우고, 버린 초안이면 그대로 "고를 것"으로 돌린다."""
    import questions
    with connect(load_env()) as conn:
        row = conn.execute("SELECT status, question_id FROM eval_drafts WHERE id = %s", (draft_id,)).fetchone()
    if row is None:
        raise IngestError(f"초안 {draft_id}이 없어요")
    status, question_id = row
    if status == "pending":
        raise IngestError(f"초안 {draft_id}은 아직 고르기 전이에요")
    result = questions.delete(sha, question_id) if status == "accepted" and question_id else None
    with connect(load_env()) as conn:
        conn.execute("UPDATE eval_drafts SET status = 'pending', question_id = NULL, decided_at = NULL WHERE id = %s", (draft_id,))
    return {"questions": result}

