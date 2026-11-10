"""색인(청킹 방식 × 임베딩 모델) 만들기·갱신·추정.

- 색인 하나 = indexes 1행 + 그 색인의 조각(chunks.index_id) + 문서별로 어떤 판으로 만들었는지(index_documents).
- 기본 색인(is_base)은 문서를 가져올 때 자동으로 갱신한다 (ingest.ingest_file). 다른 색인은 사용자가 갱신을 눌러야 한다.
- 문서 원문은 documents.content에서 읽는다. 원본 파일이 바뀌어도 DB에 들어 있는 판으로 만든다.

사용:
  .venv/bin/python engine/app/indexes.py list
  .venv/bin/python engine/app/indexes.py backfill-content    # 04 마이그레이션 전에 들어온 문서의 원문 채우기
"""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

from psycopg.types.json import Jsonb

import components as comp
from ingest import IngestError, OnStep, connect, load_env, parse_front_matter

INDEX_COLUMNS = "id, key, chunker, embedder, dims, is_base, created_at"


def _row(cur, row) -> dict:
    return dict(zip([c.name for c in cur.description], row))


def get_index(conn, index_id: int) -> dict:
    cur = conn.execute(f"SELECT {INDEX_COLUMNS} FROM indexes WHERE id=%s", (index_id,))
    row = cur.fetchone()
    if row is None:
        raise IngestError(f"Index #{index_id} does not exist")
    return _row(cur, row)


def base_index(conn) -> dict:
    cur = conn.execute(f"SELECT {INDEX_COLUMNS} FROM indexes WHERE is_base")
    return _row(cur, cur.fetchone())


def find_index(conn, key: str) -> dict | None:
    cur = conn.execute(f"SELECT {INDEX_COLUMNS} FROM indexes WHERE key=%s", (key,))
    row = cur.fetchone()
    return _row(cur, row) if row else None


# 같은 조합이 있으면 그 색인을, 없으면 새로 만들어 돌려준다. 설정값은 normalize를 거친 것이어야 한다.
def ensure_index(chunker: dict, embedder: dict) -> dict:
    key = comp.index_key(chunker, embedder)
    with connect(load_env()) as conn:
        conn.execute("""INSERT INTO indexes (key, chunker, embedder, dims) VALUES (%s, %s, %s, %s)
                        ON CONFLICT (key) DO NOTHING""",
                     (key, Jsonb(chunker), Jsonb(embedder), comp.embedder_dims(embedder)))
        return find_index(conn, key)


# 청킹 → 토큰 검사 → 임베딩. content는 머리말을 포함한 원문. 저장할 행 목록과 토큰 통계를 돌려준다. 단계마다 on_step으로 알린다.
def prepare(index: dict, content: str, title: str, external_ok: bool, env: dict, on_step: OnStep | None = None) -> tuple[list[tuple], dict]:
    def step(name: str, done: int | None = None, total: int | None = None) -> None:
        if on_step:
            on_step(name, done, total)

    try:
        comp.check_external(index["embedder"], title, external_ok)

        step("청킹")
        _, text = parse_front_matter(content)   # 원문(머리말 포함)에서 머리말을 떼고 본문만 자른다
        chunks = comp.make_chunker(index["chunker"]).split(text, title)
        if not chunks:
            raise IngestError("잘라 낸 조각이 없습니다 (빈 문서)")

        step("토큰 검사")
        embedder = comp.make_embedder(index["embedder"], env)
        texts = [c.embed_text for c in chunks]
        tokens = embedder.count_tokens(texts)
        over = [i for i, t in enumerate(tokens) if t > embedder.max_tokens]
        if over:
            raise IngestError(f"{embedder.max_tokens}토큰을 넘는 조각: {over}. 잘림을 막기 위해 중단")

        step("임베딩", 0, len(texts))
        vecs = embedder.embed(texts, on_batch=lambda done, total: step("임베딩", done, total))
    except comp.ComponentError as e:
        raise IngestError(str(e)) from None
    if any(len(v) != index["dims"] for v in vecs):
        raise IngestError(f"벡터 차원이 색인({index['dims']})과 다릅니다")

    rows = [(i, " > ".join(c.heading_path), c.content, c.embed_text, t, json.dumps(v))
            for i, (c, t, v) in enumerate(zip(chunks, tokens, vecs))]
    stats = {"min": min(tokens), "max": max(tokens), "total": sum(tokens), "api_tokens": embedder.usage_tokens}
    return rows, stats


# 한 색인 안에서 문서 하나의 조각을 바꿔 넣고, 어떤 판으로 만들었는지 기록한다. 호출한 쪽의 트랜잭션 안에서 실행된다.
def store(conn, index_id: int, document_id: int, content_hash: str, rows: list[tuple]) -> None:
    conn.execute("DELETE FROM chunks WHERE index_id=%s AND document_id=%s", (index_id, document_id))
    with conn.cursor() as cur:
        cur.executemany(
            """INSERT INTO chunks (index_id, document_id, chunk_index, heading_path, content, embed_text, token_count, embedding)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s::vector)""",
            [(index_id, document_id, *r) for r in rows],
        )
    conn.execute("""INSERT INTO index_documents (index_id, document_id, content_hash) VALUES (%s, %s, %s)
                    ON CONFLICT (index_id, document_id) DO UPDATE SET content_hash=EXCLUDED.content_hash, built_at=now()""",
                 (index_id, document_id, content_hash))


# 저장된 문서 하나를 색인 하나에 넣는다 (색인 만들기·갱신 작업이 문서마다 부른다). 진행 단계는 가져오기와 같은 6단계.
def build_document(index_id: int, document_id: int, on_step: OnStep | None = None) -> dict:
    def step(name: str, done: int | None = None, total: int | None = None) -> None:
        if on_step:
            on_step(name, done, total)

    env = load_env()
    step("확인")
    with connect(env) as conn:
        index = get_index(conn, index_id)
        cur = conn.execute("""SELECT id, source_repo, source_path, source_commit, title, content, content_hash, external_ok
                              FROM documents WHERE id=%s""", (document_id,))
        row = cur.fetchone()
        if row is None:
            raise IngestError(f"Document #{document_id} does not exist")
        doc = _row(cur, row)
        built = conn.execute("SELECT content_hash FROM index_documents WHERE index_id=%s AND document_id=%s",
                             (index_id, document_id)).fetchone()
    if doc["content"] is None:
        raise IngestError("원문이 DB에 없습니다. 문서를 다시 가져오거나 backfill-content를 실행하세요")
    result = {k: doc[k] for k in ("source_repo", "source_path", "source_commit", "title")} | {"document_id": document_id, "index_id": index_id}

    step("중복 확인")
    if built and built[0] == doc["content_hash"]:
        return result | {"status": "skipped", "chunks": None, "tokens": None}

    rows, stats = prepare(index, doc["content"], doc["title"], doc["external_ok"], env, on_step)

    step("저장")
    with connect(env) as conn:
        store(conn, index_id, document_id, doc["content_hash"], rows)
    return result | {"status": "replaced" if built else "inserted", "chunks": len(rows), "tokens": stats}


# 이 색인을 새로 만들거나 갱신해야 하는 문서. 한 번도 안 넣었거나, 넣은 판과 지금 판이 다르면 포함한다.
def pending_documents(conn, index_id: int) -> list[dict]:
    cur = conn.execute("""
        SELECT d.id, d.title, d.source_repo, d.source_path, d.external_ok, d.content IS NOT NULL AS has_content,
               (x.document_id IS NOT NULL) AS built_before
        FROM documents d
        LEFT JOIN index_documents x ON x.document_id = d.id AND x.index_id = %s
        WHERE x.document_id IS NULL OR x.content_hash <> d.content_hash
        ORDER BY d.source_path""", (index_id,))
    return [_row(cur, r) for r in cur.fetchall()]


# 색인 목록과 상태: 조각 수, 들어간 문서 수, 뒤처진 문서 수, 사람이 읽을 이름.
def list_indexes() -> list[dict]:
    with connect(load_env()) as conn:
        cur = conn.execute(f"""
            SELECT {', '.join('i.' + c for c in INDEX_COLUMNS.split(', '))},
                   (SELECT count(*) FROM chunks c WHERE c.index_id = i.id) AS chunks,
                   (SELECT count(*) FROM index_documents x WHERE x.index_id = i.id) AS documents
            FROM indexes i ORDER BY i.is_base DESC, i.id""")
        rows = [_row(cur, r) for r in cur.fetchall()]
        for r in rows:
            r["pending"] = len(pending_documents(conn, r["id"]))
    for r in rows:
        r["label"] = {"chunker": comp.describe("chunker", r["chunker"]), "embedder": comp.describe("embedder", r["embedder"])}
        r["external"] = comp.is_external("embedder", r["embedder"])
    return rows


# 조합을 고르면 바로 보여 줄 미리보기: 색인이 있는지, 만들면 문서·조각·토큰이 얼마인지, 외부 전송이 막힌 문서가 있는지.
# 청킹만 실제로 해 보고 임베딩은 하지 않는다 (비용·시간이 들지 않게).
def estimate(chunker: dict, embedder: dict) -> dict:
    env = load_env()
    key = comp.index_key(chunker, embedder)
    impl = comp.EMBEDDERS[embedder["id"]]
    available, reason = impl.availability(env)
    out = {
        "key": key, "chunker": chunker, "embedder": embedder, "dims": comp.embedder_dims(embedder),
        "external": comp.is_external("embedder", embedder), "available": available, "reason": reason,
        "label": {"chunker": comp.describe("chunker", chunker), "embedder": comp.describe("embedder", embedder)},
    }
    with connect(env) as conn:
        index = find_index(conn, key)
        out["index_id"] = index["id"] if index else None
        out["is_base"] = bool(index and index["is_base"])
        cur = conn.execute("SELECT id, title, source_path, content, external_ok FROM documents ORDER BY source_path")
        docs = [_row(cur, r) for r in cur.fetchall()]
        pending_ids = {d["id"] for d in pending_documents(conn, index["id"])} if index else {d["id"] for d in docs}
        out["chunks_built"] = conn.execute("SELECT count(*) FROM chunks WHERE index_id=%s", (index["id"],)).fetchone()[0] if index else 0

    todo = [d for d in docs if d["id"] in pending_ids]
    out["documents_total"] = len(docs)
    out["documents_pending"] = len(todo)
    out["missing_content"] = [{"id": d["id"], "title": d["title"], "path": d["source_path"]} for d in todo if d["content"] is None]
    out["blocked"] = [{"id": d["id"], "title": d["title"], "path": d["source_path"]} for d in todo
                      if out["external"] and not d["external_ok"]]

    # 만들 문서만 잘라 보고 토큰을 센다. 토큰은 고른 임베딩 모델의 토크나이저로 센다 (외부 모델도 로컬에서 센다).
    chunker_impl = comp.make_chunker(chunker)
    texts = [c.embed_text for d in todo if d["content"] is not None
             for c in chunker_impl.split(parse_front_matter(d["content"])[1], d["title"])]
    out["chunks_pending"] = len(texts)
    out["tokens"] = None
    out["over_limit"] = 0
    if texts and available:
        try:
            e = comp.make_embedder(embedder, env)
            counts = e.count_tokens(texts)
            out["tokens"] = sum(counts)
            out["over_limit"] = sum(t > e.max_tokens for t in counts)
        except comp.ComponentError as err:
            out["available"], out["reason"] = False, str(err)
    out["ready"] = bool(index) and not todo
    out["can_build"] = available and not out["blocked"] and not out["missing_content"] and not out["over_limit"]
    return out


# 04 마이그레이션 전에 들어온 문서는 원문이 비어 있다. 그 문서를 가져왔던 작업의 경로에서 다시 읽어 채운다.
# 파일 내용이 저장된 해시와 다르면(그 뒤에 고쳐졌으면) 채우지 않고 알려 준다. 그 문서는 다시 가져오면 된다.
def backfill_content() -> None:
    with connect(load_env()) as conn:
        docs = conn.execute("SELECT id, source_path, content_hash FROM documents WHERE content IS NULL").fetchall()
        for doc_id, rel, digest in docs:
            paths = [r[0] for r in conn.execute(
                """SELECT DISTINCT path FROM ingest_jobs WHERE status='done' AND (result->>'document_id')::bigint = %s""",
                (doc_id,)).fetchall()]
            paths = [p for p in paths if Path(p).is_file()]
            filled = False
            for p in paths:
                raw = Path(p).read_text(encoding="utf-8")
                if hashlib.sha256(raw.encode()).hexdigest() == digest:
                    conn.execute("UPDATE documents SET content=%s WHERE id=%s", (raw, doc_id))
                    filled = True
                    break
            print(f"{'filled ' if filled else 'SKIPPED'} #{doc_id} {rel}" + ("" if filled else f"  (paths tried: {len(paths)}, re-ingest this file)"))


def main() -> None:
    cmd = sys.argv[1] if len(sys.argv) > 1 else "list"
    if cmd == "backfill-content":
        backfill_content()
    elif cmd == "list":
        for r in list_indexes():
            star = "★" if r["is_base"] else " "
            print(f"{star} #{r['id']} {r['label']['chunker']} × {r['label']['embedder']}  "
                  f"dims {r['dims']} · chunks {r['chunks']} · docs {r['documents']} · pending {r['pending']}")
    else:
        sys.exit(f"unknown command: {cmd}")


if __name__ == "__main__":
    main()
