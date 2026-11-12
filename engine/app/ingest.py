"""문서 1개를 적재한다: 읽기 → (기본 색인의 방식으로) 자르기 → 임베딩 → pgvector 저장.

사용:
  python engine/app/ingest.py <문서 경로> --dry-run          # 자르기 결과만 보기 (DB·임베딩 안 함)
  python engine/app/ingest.py <문서 경로> --env 혼합 --doc-type 해설 --verification 미확인

- 문서는 원래 위치(git 저장소)에서 읽고, 그 저장소의 커밋을 출처로 기록한다.
- 다시 돌려도 결과가 같다: 내용 해시가 같으면 건너뛰고, 다르면 옛 조각을 지우고 새로 넣는다.
"""
# 타입 힌트를 문자열로 늦게 해석한다 (list[str] | None 같은 표기를 쓰기 위해).
from __future__ import annotations

# 표준 라이브러리만 쓴다. DB 드라이버(psycopg)는 connect()에서 필요할 때 불러온다.
import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

# 경로와 한도 상수. 숫자를 바꾸면 TEI 설정(.env)도 같이 확인한다.
ROOT = Path(__file__).resolve().parents[2]  # 저장소 루트 (.env 위치). engine/app/ingest.py 기준
MAX_TOKENS = 2048   # .env의 EMBED_MAX_BATCH_TOKENS와 같아야 한다. 넘으면 TEI가 조용히 자른다
EMBED_BATCH = 8     # TEI CPU 백엔드는 한 번에 8개까지 묶는다


# 잘라 낸 조각 하나. 어느 제목 아래에 있었는지(경로)와 원문을 함께 들고 다닌다.
@dataclass
class Section:
    heading_path: list[str]  # [문서 제목, ## 제목, ### 제목]
    body: str                # 제목 줄을 포함한 원문


# ---------- 설정 ----------

# 루트 .env를 읽어 dict로 돌려준다. 주석·빈 줄은 건너뛰고 KEY=VALUE 줄만 본다.
# 컨테이너(worker)에는 .env 파일이 없고 같은 값이 환경 변수로 들어오므로, 환경 변수가 있으면 그 값을 쓴다.
def load_env() -> dict[str, str]:
    env = {}
    file = ROOT / ".env"
    if file.is_file():
        for line in file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip()
    env.update(os.environ)
    return env


# 임베딩 서버(TEI) 주소. Mac에서는 열어 둔 포트로, 컨테이너 안에서는 EMBED_URL(서비스 이름)로 간다.
def embed_url(env: dict[str, str]) -> str:
    return env.get("EMBED_URL") or f"http://127.0.0.1:{env['EMBED_PORT']}"


# ---------- 출처 ----------

# 문서가 들어 있는 git 저장소를 찾아 출처(저장소·경로·커밋)를 만든다.
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

# 문서 맨 위 머리말(YAML 비슷한 부분)을 떼어 내고, 메타데이터와 본문으로 나눈다.
# YAML 한 줄 값의 따옴표를 벗긴다. "..."는 \" 와 \\ 를, '...'는 '' 를 풀어 준다. 따옴표가 짝이 안 맞으면 그대로 둔다.
def unquote(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] == '"':
        return value[1:-1].replace('\\"', '"').replace("\\\\", "\\")
    if len(value) >= 2 and value[0] == value[-1] == "'":
        return value[1:-1].replace("''", "'")
    return value


def parse_front_matter(text: str) -> tuple[dict[str, str], str]:
    """맨 위 --- ... --- 머리말에서 한 줄짜리 값만 읽는다 (title, status 등)."""
    meta: dict[str, str] = {}
    if text.startswith("---\n"):
        end = text.find("\n---\n", 4)
        if end != -1:
            for line in text[4:end].splitlines():
                m = re.match(r"^(\w+):\s*(.+)$", line)
                if m:
                    meta[m.group(1)] = unquote(m.group(2).strip())
            text = text[end + 5:]
    return meta, text


# 청킹: 본문을 ##/### 제목 기준으로 잘라 Section 목록을 만든다.
def split_sections(text: str, title: str) -> list[Section]:
    """## / ### 제목마다 자른다. ``` 코드 블록 안의 # 줄은 제목으로 보지 않는다."""
    sections: list[Section] = []
    h2: str | None = None
    h3: str | None = None
    buf: list[str] = []
    in_code = False

    # 지금까지 모은 줄(buf)을 조각 하나로 확정한다. 빈 조각은 버린다.
    def flush():
        body = "\n".join(buf).strip()
        if body:
            path = [title] + [h for h in (h2, h3) if h]
            sections.append(Section(path, body))

    # 한 줄씩 보면서 코드 블록 안팎을 추적하고, 제목 줄을 만나면 이전 조각을 닫는다.
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


# 임베딩 모델에 넣을 글을 만든다. 조각 앞에 제목 경로를 붙여 문맥을 보탠다(방식 B).
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

# TEI(임베딩 서버)에 JSON을 POST하고 응답 JSON을 돌려준다. 외부 패키지 없이 urllib만 쓴다.
def tei_post(url: str, payload: dict, timeout: float = 120) -> list:
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


# 조각마다 토큰 수를 TEI /tokenize로 센다. 한도(MAX_TOKENS) 초과를 미리 잡기 위해서다.
def count_tokens(base: str, texts: list[str]) -> list[int]:
    out = []
    for t in texts:
        out.append(len(tei_post(f"{base}/tokenize", {"inputs": t, "add_special_tokens": True})[0]))
    return out


# 조각 글을 EMBED_BATCH개씩 묶어 TEI /embed로 보내고, 벡터 목록을 순서대로 돌려준다.
def embed(base: str, texts: list[str], on_batch: Callable[[int, int], None] | None = None) -> list[list[float]]:
    vecs: list[list[float]] = []
    for i in range(0, len(texts), EMBED_BATCH):
        vecs.extend(tei_post(f"{base}/embed", {"inputs": texts[i:i + EMBED_BATCH]}))
        if on_batch:  # 묶음 하나가 끝날 때마다 (끝낸 조각 수, 전체 조각 수)를 알린다
            on_batch(len(vecs), len(texts))
    return vecs


# ---------- 저장 ----------

# .env 값으로 PostgreSQL에 접속한다. search.py도 이 함수를 가져다 쓴다.
def connect(env: dict[str, str]):
    import psycopg  # 미리보기에서는 필요 없어서 여기서 불러온다

    # DB_HOST가 없으면 Mac에서 열어 둔 포트로 붙는다. 컨테이너 안에서는 DB_HOST=db (서비스 이름).
    return psycopg.connect(f"host={env.get('DB_HOST', '127.0.0.1')} port={env['DB_PORT']} dbname={env['POSTGRES_DB']} "
                           f"user={env['POSTGRES_USER']} password={env['POSTGRES_PASSWORD']}")


# 문서 1행을 저장한다. 같은 저장소·경로가 있으면 그 행을 고쳐 쓴다 (id가 그대로라 다른 색인의 조각이 남는다 → "뒤처짐"으로 보인다).
# 호출한 쪽의 트랜잭션 안에서 실행된다. (document_id, 새로 넣었는지)를 돌려준다.
def upsert_document(conn, doc: dict) -> tuple[int, bool]:
    row = conn.execute(
        """UPDATE documents SET source_commit=%(source_commit)s, content_hash=%(content_hash)s, content=%(content)s,
                  title=%(title)s, env=%(env)s, doc_type=%(doc_type)s, verification=%(verification)s,
                  checked_at=%(checked_at)s, external_ok=%(external_ok)s, ingested_at=now()
           WHERE source_repo=%(source_repo)s AND source_path=%(source_path)s RETURNING id""",
        doc,
    ).fetchone()
    if row:
        return row[0], False
    row = conn.execute(
        """INSERT INTO documents (source_repo, source_path, source_commit, content_hash, content, title,
                                  env, doc_type, verification, checked_at, external_ok)
           VALUES (%(source_repo)s, %(source_path)s, %(source_commit)s, %(content_hash)s, %(content)s, %(title)s,
                   %(env)s, %(doc_type)s, %(verification)s, %(checked_at)s, %(external_ok)s)
           RETURNING id""",
        doc,
    ).fetchone()
    return row[0], True


# ---------- 가져오기 (CLI·API 공용) ----------

# 진행 상황을 알릴 때 쓰는 6단계. API는 이 이름과 번호(1~6)를 그대로 화면·작업 기록에 쓴다.
STAGES = ["확인", "중복 확인", "청킹", "토큰 검사", "임베딩", "저장"]

# 단계 알림 함수의 모양: (단계 이름, 끝낸 수, 전체 수). 수는 임베딩처럼 나눠서 하는 단계에서만 쓴다.
OnStep = Callable[[str, "int | None", "int | None"], None]


# 가져오기 중 사용자에게 보여 줄 실패. API는 이 메시지를 그대로 응답에 담는다.
class IngestError(Exception):
    pass


# 문서 1개를 읽기 → 자르기 → 토큰 검사 → 임베딩 → 저장까지 한다. CLI와 API가 같은 함수를 부른다.
def ingest_file(path: Path, *, env_label: str | None = None, doc_type: str | None = None,
                verification: str = "미확인", checked_at: str | None = None,
                external_ok: bool = False, on_step: OnStep | None = None, project_id: int | None = None) -> dict:
    """결과를 dict로 돌려준다: status(inserted/replaced/skipped), document_id, 출처, 조각·토큰 수.

    on_step을 주면 6단계(STAGES)에 들어설 때마다 부른다. CLI는 주지 않는다.
    project_id를 주면 그 프로젝트를 문서의 원본으로 연결한다 (건너뛴 문서도 연결은 맞춘다).
    """
    def step(name: str, done: int | None = None, total: int | None = None) -> None:
        if on_step:
            on_step(name, done, total)

    # 1. 확인: 문서를 읽고 머리말을 떼고 출처(git 저장소·커밋)를 구한다. git 밖의 파일은 출처를 남길 수 없어 거절한다.
    step("확인")
    raw = path.read_text(encoding="utf-8")
    meta, _ = parse_front_matter(raw)
    title = meta.get("title") or path.stem
    try:
        repo, rel, commit = git_source(path)
    except subprocess.CalledProcessError:
        raise IngestError("git 저장소 안의 파일이 아닙니다. 출처(저장소·커밋)를 기록할 수 없습니다")

    # 2. 중복 확인: content_hash(원문 전체의 sha256)가 DB와 같으면 여기서 끝낸다.
    #    04 마이그레이션 전에 들어온 문서라 원문이 비어 있으면 원문만 채운다.
    step("중복 확인")
    from indexes import base_index, prepare, store  # indexes가 이 파일을 불러오므로 여기서 불러온다 (순환 import 방지)

    env = load_env()
    doc = {
        "source_repo": repo, "source_path": rel, "source_commit": commit,
        "content_hash": hashlib.sha256(raw.encode()).hexdigest(), "content": raw, "title": title,
        "env": env_label, "doc_type": doc_type, "verification": verification,
        "checked_at": checked_at, "external_ok": external_ok,
    }
    result = {"source_repo": repo, "source_path": rel, "source_commit": commit, "title": title}
    with connect(env) as conn:
        same = conn.execute("""SELECT id, content IS NULL FROM documents
                               WHERE source_repo=%s AND source_path=%s AND content_hash=%s""",
                            (repo, rel, doc["content_hash"])).fetchone()
        if same and same[1]:
            conn.execute("UPDATE documents SET content=%s WHERE id=%s", (raw, same[0]))
        base = base_index(conn)
        if same and project_id:
            from projects import link_origin
            link_origin(conn, project_id, same[0])
    if same:
        return {**result, "status": "skipped", "document_id": same[0], "chunks": None, "tokens": None}

    # 3~5. 청킹 → 토큰 검사 → 임베딩: 기본 색인의 청킹 방식·임베딩 모델로 한다 (indexes.prepare).
    rows, tokens = prepare(base, raw, title, external_ok, env, on_step)

    # 6. 저장: 문서 1행과 기본 색인의 조각을 한 트랜잭션으로. 다른 색인은 건드리지 않는다 (사용자가 갱신을 누르면 그때).
    step("저장")
    with connect(env) as conn:
        doc_id, created = upsert_document(conn, doc)
        store(conn, base["id"], doc_id, doc["content_hash"], rows)
        if project_id:
            from projects import link_origin
            link_origin(conn, project_id, doc_id)
    return {**result, "status": "inserted" if created else "replaced", "document_id": doc_id,
            "index_id": base["id"], "chunks": len(rows), "tokens": tokens}


# ---------- 실행 ----------

# 명령줄 진입점: 인자 읽기 → 자르기 → (미리보기 또는) 임베딩 → 저장 순서로 진행한다.
def main() -> None:
    # 명령줄 인자. 메타데이터(환경·자료 성격·검증 상태 등)는 여기서 받아 documents에 기록한다.
    ap = argparse.ArgumentParser(description="문서 1개 적재")
    ap.add_argument("path", type=Path)
    ap.add_argument("--dry-run", action="store_true", help="자르기 결과만 출력")
    ap.add_argument("--env", default=None, help="운영 / 개발 / 샘플 / 혼합")
    ap.add_argument("--doc-type", default=None, help="설정 / 실행 결과 / 해설 / 장애 기록")
    ap.add_argument("--verification", default="미확인", help="확인 / 추정 / 미확인 / 폐기")
    ap.add_argument("--checked-at", default=None, help="확인일 YYYY-MM-DD")
    ap.add_argument("--external-ok", action="store_true", help="외부 LLM 전송 가능")
    a = ap.parse_args()

    # --dry-run이면 조각 목록과 임베딩할 글 예시만 보여 주고 끝낸다. DB·TEI는 쓰지 않는다.
    if a.dry_run:
        raw = a.path.read_text(encoding="utf-8")
        meta, text = parse_front_matter(raw)
        title = meta.get("title") or a.path.stem
        sections = split_sections(text, title)
        repo, rel, commit = git_source(a.path)
        print(f"{repo}/{rel} @ {commit[:12]}  title={title!r}  sections={len(sections)}")
        for i, s in enumerate(sections):
            print(f"[{i:02d}] {len(s.body):5d}자  {' > '.join(s.heading_path[1:]) or '(머리말·도입)'}")
        try:
            sample = make_embed_text(sections[1].heading_path, sections[1].body)
            print("\n--- 임베딩할 글 예시 [01] ---\n" + sample[:400])
        except NotImplementedError as e:
            print(f"\n(make_embed_text 미작성: {e})")
        return

    # 실제 가져오기는 ingest_file에 맡기고, 결과만 사람이 읽기 좋게 출력한다.
    try:
        r = ingest_file(a.path, env_label=a.env, doc_type=a.doc_type, verification=a.verification,
                        checked_at=a.checked_at, external_ok=a.external_ok)
    except IngestError as e:
        sys.exit(str(e))
    print(f"{r['source_repo']}/{r['source_path']} @ {r['source_commit'][:12]}  title={r['title']!r}")
    chunks = f", chunks={r['chunks']}" if r["chunks"] is not None else ""
    print(f"{r['status']} document_id={r['document_id']}{chunks}")
    if r["tokens"]:
        print("tokens: min={min} max={max} total={total}".format(**r["tokens"]))


# 직접 실행할 때만 main()을 돈다. search.py에서 import할 때는 실행되지 않는다.
if __name__ == "__main__":
    main()
