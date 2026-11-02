"""문서 1개를 적재한다: 읽기 → 제목 단위로 자르기 → TEI 임베딩 → pgvector 저장.

사용:
  python app/ingest.py <문서 경로> --dry-run          # 자르기 결과만 보기 (DB·임베딩 안 함)
  python app/ingest.py <문서 경로> --env 혼합 --doc-type 해설 --verification 미확인

- 문서는 원래 위치(git 저장소)에서 읽고, 그 저장소의 커밋을 출처로 기록한다.
- 다시 돌려도 결과가 같다: 내용 해시가 같으면 건너뛰고, 다르면 옛 조각을 지우고 새로 넣는다.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
import urllib.request
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MAX_TOKENS = 2048   # .env의 EMBED_MAX_BATCH_TOKENS와 같아야 한다. 넘으면 TEI가 조용히 자른다
EMBED_BATCH = 8     # TEI CPU 백엔드는 한 번에 8개까지 묶는다


@dataclass
class Section:
    heading_path: list[str]  # [문서 제목, ## 제목, ### 제목]
    body: str                # 제목 줄을 포함한 원문


# ---------- 설정 ----------

def load_env() -> dict[str, str]:
    env = {}
    for line in (ROOT / ".env").read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip()
    return env


# ---------- 출처 ----------

def git_source(path: Path) -> tuple[str, str, str]:
    """(저장소 이름, 저장소 안 경로, 커밋). 커밋 후 고친 내용이 있으면 커밋 뒤에 -dirty를 붙인다."""
    top = Path(subprocess.check_output(["git", "-C", str(path.parent), "rev-parse", "--show-toplevel"], text=True).strip())
    rel = path.resolve().relative_to(top.resolve()).as_posix()
    commit = subprocess.check_output(["git", "-C", str(top), "log", "-1", "--format=%H", "--", rel], text=True).strip()
    dirty = subprocess.check_output(["git", "-C", str(top), "status", "--porcelain", "--", rel], text=True).strip()
    if not commit:
        commit = "uncommitted"
    if dirty:
        commit += "-dirty"
    return top.name, rel, commit


# ---------- 자르기 ----------

def parse_front_matter(text: str) -> tuple[dict[str, str], str]:
    """맨 위 --- ... --- 머리말에서 한 줄짜리 값만 읽는다 (title, status 등)."""
    meta: dict[str, str] = {}
    if text.startswith("---\n"):
        end = text.find("\n---\n", 4)
        if end != -1:
            for line in text[4:end].splitlines():
                m = re.match(r"^(\w+):\s*(.+)$", line)
                if m:
                    meta[m.group(1)] = m.group(2).strip()
            text = text[end + 5:]
    return meta, text


def split_sections(text: str, title: str) -> list[Section]:
    """## / ### 제목마다 자른다. ``` 코드 블록 안의 # 줄은 제목으로 보지 않는다."""
    sections: list[Section] = []
    h2: str | None = None
    h3: str | None = None
    buf: list[str] = []
    in_code = False

    def flush():
        body = "\n".join(buf).strip()
        if body:
            path = [title] + [h for h in (h2, h3) if h]
            sections.append(Section(path, body))

    for line in text.splitlines():
        if line.lstrip().startswith("```"):
            in_code = not in_code
        m = None if in_code else re.match(r"^(#{2,3})\s+(.+?)\s*$", line)
        if m:
            flush()
            buf = []
            if len(m.group(1)) == 2:
                h2, h3 = m.group(2), None
            else:
                h3 = m.group(2)
        buf.append(line)
    flush()
    return sections


def make_embed_text(heading_path: list[str], body: str) -> str:
    """임베딩할 글을 만든다. 방식 B: 조각 앞에 제목 경로를 붙인다.

    heading_path 예: ["공인 IP 하나로 ... 이해하기", "서비스가 늘어날 때 추가되는 설정", "웹 서비스를 추가하는 경우"]
    body 예: "### 웹 서비스를 추가하는 경우\n\n기존 웹 진입점을 공유하는 구성이라면 ..."

    결정:
      - 경로는 "B > C" 한 줄. 문서 제목은 넣지 않는다 (문서가 하나일 때 모든 조각이 같은 글로 시작해 구분에 도움이 안 됨).
        단, 제목 아래 도입부처럼 섹션 경로가 없으면 문서 제목을 쓴다.
      - body 첫 줄의 "##/### 제목"은 경로 끝과 같으므로 지운다 (같은 글이 두 번 들어가 비중이 커지는 것을 막음).
    """
    lines = body.splitlines()
    if lines and re.match(r"^#{2,3}\s", lines[0]):
        body = "\n".join(lines[1:]).strip()
    path = " > ".join(heading_path[1:]) or heading_path[0]
    return f"{path}\n\n{body}" if body else path


# ---------- 임베딩 ----------

def tei_post(url: str, payload: dict) -> list:
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


def count_tokens(base: str, texts: list[str]) -> list[int]:
    out = []
    for t in texts:
        out.append(len(tei_post(f"{base}/tokenize", {"inputs": t, "add_special_tokens": True})[0]))
    return out


def embed(base: str, texts: list[str]) -> list[list[float]]:
    vecs: list[list[float]] = []
    for i in range(0, len(texts), EMBED_BATCH):
        vecs.extend(tei_post(f"{base}/embed", {"inputs": texts[i:i + EMBED_BATCH]}))
    return vecs


# ---------- 저장 ----------

def connect(env: dict[str, str]):
    import psycopg  # 미리보기에서는 필요 없어서 여기서 불러온다

    return psycopg.connect(f"host=127.0.0.1 port={env['DB_PORT']} dbname={env['POSTGRES_DB']} "
                           f"user={env['POSTGRES_USER']} password={env['POSTGRES_PASSWORD']}")


def unchanged(env: dict[str, str], doc: dict) -> bool:
    """이미 같은 내용이 들어 있으면 True. 임베딩 전에 확인해서 계산을 아낀다."""
    with connect(env) as conn:
        row = conn.execute(
            "SELECT content_hash FROM documents WHERE source_repo=%s AND source_path=%s",
            (doc["source_repo"], doc["source_path"]),
        ).fetchone()
    return bool(row and row[0] == doc["content_hash"])


def save(env: dict[str, str], doc: dict, rows: list[tuple]) -> str:
    with connect(env) as conn:  # 블록이 끝나면 커밋, 오류면 전부 되돌린다
        old = conn.execute(
            "SELECT id, content_hash FROM documents WHERE source_repo=%s AND source_path=%s",
            (doc["source_repo"], doc["source_path"]),
        ).fetchone()
        if old and old[1] == doc["content_hash"]:
            return "skip (내용 같음)"
        if old:
            conn.execute("DELETE FROM documents WHERE id=%s", (old[0],))  # 조각도 함께 지워진다
        doc_id = conn.execute(
            """INSERT INTO documents (source_repo, source_path, source_commit, content_hash, title,
                                      env, doc_type, verification, checked_at, external_ok)
               VALUES (%(source_repo)s, %(source_path)s, %(source_commit)s, %(content_hash)s, %(title)s,
                       %(env)s, %(doc_type)s, %(verification)s, %(checked_at)s, %(external_ok)s)
               RETURNING id""",
            doc,
        ).fetchone()[0]
        with conn.cursor() as cur:
            cur.executemany(
                """INSERT INTO chunks (document_id, chunk_index, heading_path, content, embed_text, token_count, embedding)
                   VALUES (%s, %s, %s, %s, %s, %s, %s::vector)""",
                [(doc_id, *r) for r in rows],
            )
        return f"{'replaced' if old else 'inserted'} document_id={doc_id}, chunks={len(rows)}"


# ---------- 실행 ----------

def main() -> None:
    ap = argparse.ArgumentParser(description="문서 1개 적재")
    ap.add_argument("path", type=Path)
    ap.add_argument("--dry-run", action="store_true", help="자르기 결과만 출력")
    ap.add_argument("--env", default=None, help="운영 / 개발 / 샘플 / 혼합")
    ap.add_argument("--doc-type", default=None, help="설정 / 실행 결과 / 해설 / 장애 기록")
    ap.add_argument("--verification", default="미확인", help="확인 / 추정 / 미확인 / 폐기")
    ap.add_argument("--checked-at", default=None, help="확인일 YYYY-MM-DD")
    ap.add_argument("--external-ok", action="store_true", help="외부 LLM 전송 가능")
    a = ap.parse_args()

    raw = a.path.read_text(encoding="utf-8")
    meta, text = parse_front_matter(raw)
    title = meta.get("title") or a.path.stem
    sections = split_sections(text, title)
    repo, rel, commit = git_source(a.path)
    print(f"{repo}/{rel} @ {commit[:12]}  title={title!r}  sections={len(sections)}")

    if a.dry_run:
        for i, s in enumerate(sections):
            print(f"[{i:02d}] {len(s.body):5d}자  {' > '.join(s.heading_path[1:]) or '(머리말·도입)'}")
        try:
            sample = make_embed_text(sections[1].heading_path, sections[1].body)
            print("\n--- 임베딩할 글 예시 [01] ---\n" + sample[:400])
        except NotImplementedError as e:
            print(f"\n(make_embed_text 미작성: {e})")
        return

    env = load_env()
    doc = {
        "source_repo": repo, "source_path": rel, "source_commit": commit,
        "content_hash": hashlib.sha256(raw.encode()).hexdigest(), "title": title,
        "env": a.env, "doc_type": a.doc_type, "verification": a.verification,
        "checked_at": a.checked_at, "external_ok": a.external_ok,
    }
    if unchanged(env, doc):
        print("skip (내용 같음)")
        return

    base = f"http://127.0.0.1:{env['EMBED_PORT']}"
    embed_texts = [make_embed_text(s.heading_path, s.body) for s in sections]
    tokens = count_tokens(base, embed_texts)
    over = [i for i, t in enumerate(tokens) if t > MAX_TOKENS]
    if over:
        sys.exit(f"{MAX_TOKENS}토큰을 넘는 조각: {over}. 잘림을 막기 위해 중단")
    vecs = embed(base, embed_texts)
    rows = [
        (i, " > ".join(s.heading_path), s.body, t, n, json.dumps(v))
        for i, (s, t, n, v) in enumerate(zip(sections, embed_texts, tokens, vecs))
    ]
    print(save(env, doc, rows))
    print(f"tokens: min={min(tokens)} max={max(tokens)} total={sum(tokens)}")


if __name__ == "__main__":
    main()
