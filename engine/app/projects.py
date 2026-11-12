"""프로젝트: 문서를 묶는 단위. 검색 범위(Playground)와 문서 연결의 기준이 된다.

- 프로젝트마다 문서를 가져오는 방식(kind)이 하나로 정해진다.
  git: 로컬 git 폴더에서 가져온다 (판 = 커밋). managed: 파일을 올리면 원문을 DB에 둔다 (판 = 1, 2, …, document_versions).
- Git 프로젝트의 폴더는 서로 겹치지 않는다. 그래서 파일 경로 하나는 많아야 한 프로젝트에 속하고,
  가져오기 작업은 경로로 프로젝트를 찾는다 (project_for_path).
- 문서는 한 번만 저장한다. 다른 프로젝트에는 연결(project_documents)만 늘린다. 들여온 프로젝트가 원본(is_origin)이다.

이미 있는 문서를 프로젝트로 옮기기 (07-projects.sql 적용 뒤 한 번):
  docker compose exec engine python projects.py backfill
"""
from __future__ import annotations

import argparse
import subprocess
from pathlib import Path

from psycopg.types.json import Jsonb

from ingest import connect, load_env

KINDS = ("git", "managed")


# 폴더의 git 정보: 저장소 맨 위 폴더, 브랜치, 지금 커밋(짧게). git 저장소가 아니면 None.
def git_info(folder: Path) -> dict | None:
    def git(*args: str) -> str:
        return subprocess.check_output(["git", "-C", str(folder), *args], text=True, stderr=subprocess.DEVNULL).strip()
    try:
        top = git("rev-parse", "--show-toplevel")
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None
    try:
        commit = git("rev-parse", "--short=7", "HEAD")
    except subprocess.CalledProcessError:
        commit = None   # 커밋이 하나도 없는 저장소
    try:
        branch = git("rev-parse", "--abbrev-ref", "HEAD")
    except subprocess.CalledProcessError:
        branch = None
    return {"top": top, "repo": Path(top).name, "branch": branch, "commit": commit}


def project_path(source: dict) -> Path | None:
    p = (source or {}).get("path")
    return Path(p) if p else None


# 새 Git 프로젝트로 쓸 폴더를 검사한다. 통과하면 화면에 보여 줄 정보를 돌려주고, 아니면 ValueError.
#   roots: INGEST_ROOTS (api.allowed_roots), count_md: 폴더 안 .md 수를 세는 함수 (숨김 폴더 제외 규칙을 api와 같게)
def check_folder(conn, raw: str, roots: list[Path], count_md) -> dict:
    if not raw.strip():
        raise ValueError("폴더 경로를 적어 주세요")
    folder = Path(raw).expanduser().resolve()
    if not any(folder.is_relative_to(r.resolve()) for r in roots):
        raise ValueError("허용된 폴더(INGEST_ROOTS) 밖의 경로입니다")
    if not folder.is_dir():
        raise ValueError("폴더가 없습니다")
    info = git_info(folder)
    if info is None:
        raise ValueError("git 저장소 안의 폴더가 아닙니다. Git 프로젝트는 git 폴더만 연결할 수 있어요")
    # 다른 프로젝트 폴더와 겹치면 한 파일이 두 프로젝트의 원본이 될 수 있어 막는다
    for pid, name, source in conn.execute("SELECT id, name, source FROM projects WHERE kind='git'").fetchall():
        other = project_path(source)
        if other and (folder.is_relative_to(other) or other.is_relative_to(folder)):
            raise ValueError(f"프로젝트 '{name}'의 폴더와 겹칩니다")
    return {"path": str(folder), "repo": info["repo"], "branch": info["branch"], "commit": info["commit"],
            "md_count": count_md(folder)}


def create_project(conn, name: str, kind: str, source: dict, defaults: dict, description: str = "") -> int:
    name = name.strip()
    if not name or len(name) > 60:
        raise ValueError("이름은 1~60자로 적어 주세요")
    if kind not in KINDS:
        raise ValueError("알 수 없는 관리 방식입니다")
    if conn.execute("SELECT 1 FROM projects WHERE lower(name)=lower(%s)", (name,)).fetchone():
        raise ValueError(f"'{name}' 이름의 프로젝트가 이미 있습니다")
    return conn.execute(
        "INSERT INTO projects (name, kind, source, defaults, description) VALUES (%s, %s, %s, %s, %s) RETURNING id",
        (name, kind, Jsonb(source), Jsonb(defaults), description.strip()),
    ).fetchone()[0]


# 파일 경로가 들어 있는 Git 프로젝트. 폴더가 겹치지 않으므로 많아야 하나다. 없으면 None.
def project_for_path(conn, path: Path) -> tuple[int, str] | None:
    for pid, name, source in conn.execute("SELECT id, name, source FROM projects WHERE kind='git'").fetchall():
        folder = project_path(source)
        if folder and path.is_relative_to(folder):
            return pid, name
    return None


def get_project(conn, project_id: int) -> dict | None:
    row = conn.execute("SELECT id, name, kind, source, defaults, description FROM projects WHERE id=%s",
                       (project_id,)).fetchone()
    if row is None:
        return None
    return dict(zip(("id", "name", "kind", "source", "defaults", "description"), row))


# 프로젝트 목록. 문서 수(원본·연결), 기본 색인의 조각 수, Git이면 지금 브랜치·커밋을 붙인다.
def list_projects(conn) -> list[dict]:
    rows = conn.execute(
        """WITH per_doc AS (
               SELECT document_id, count(*) AS n FROM chunks
               WHERE index_id = (SELECT id FROM indexes WHERE is_base) GROUP BY document_id)
           SELECT p.id, p.name, p.kind, p.source, p.defaults, p.description, p.created_at,
                  count(pd.document_id) AS documents,
                  count(pd.document_id) FILTER (WHERE pd.is_origin) AS origin_documents,
                  coalesce(sum(c.n), 0)::int AS chunks,
                  max(d.ingested_at) AS last_ingested
           FROM projects p
           LEFT JOIN project_documents pd ON pd.project_id = p.id
           LEFT JOIN documents d ON d.id = pd.document_id
           LEFT JOIN per_doc c ON c.document_id = pd.document_id
           GROUP BY p.id ORDER BY p.created_at, p.id""").fetchall()
    cols = ("id", "name", "kind", "source", "defaults", "description", "created_at", "documents",
            "origin_documents", "chunks", "last_ingested")
    out = []
    for row in rows:
        p = dict(zip(cols, row))
        folder = project_path(p["source"]) if p["kind"] == "git" else None
        p["git"] = git_info(folder) if folder and folder.is_dir() else None
        if p["git"]:
            p["git"].pop("top", None)   # 저장소 맨 위 경로는 화면에 필요 없다
        out.append(p)
    return out


# 들여온 프로젝트를 원본으로 연결한다. 같은 문서를 다시 넣어도 그대로다.
def link_origin(conn, project_id: int, document_id: int) -> None:
    conn.execute("""INSERT INTO project_documents (project_id, document_id, is_origin) VALUES (%s, %s, true)
                    ON CONFLICT (project_id, document_id) DO UPDATE SET is_origin = true""",
                 (project_id, document_id))


# 문서를 연결할 프로젝트를 사람이 고른다. 원본 프로젝트는 항상 남고, 나머지는 받은 목록으로 맞춘다.
# 연결만 바뀌고 조각·벡터는 그대로다 (다시 임베딩하지 않는다).
def set_links(conn, document_id: int, project_ids: list[int]) -> list[dict]:
    if conn.execute("SELECT 1 FROM documents WHERE id=%s", (document_id,)).fetchone() is None:
        raise LookupError("문서가 없습니다")
    wanted = set(project_ids)
    known = {r[0] for r in conn.execute("SELECT id FROM projects WHERE id = ANY(%s)", (list(wanted),)).fetchall()}
    if wanted - known:
        raise ValueError(f"없는 프로젝트입니다: {sorted(wanted - known)}")
    conn.execute("DELETE FROM project_documents WHERE document_id=%s AND NOT is_origin AND NOT (project_id = ANY(%s))",
                 (document_id, list(wanted)))
    for pid in wanted:
        conn.execute("""INSERT INTO project_documents (project_id, document_id) VALUES (%s, %s)
                        ON CONFLICT DO NOTHING""", (pid, document_id))
    return document_projects(conn, document_id)


def document_projects(conn, document_id: int) -> list[dict]:
    rows = conn.execute("""SELECT p.id, p.name, pd.is_origin FROM project_documents pd JOIN projects p ON p.id = pd.project_id
                           WHERE pd.document_id=%s ORDER BY pd.is_origin DESC, p.name""", (document_id,)).fetchall()
    return [{"id": r[0], "name": r[1], "origin": r[2]} for r in rows]


# 07 적용 전에 들어온 문서를 옮긴다: 저장소(source_repo)마다, INGEST_ROOTS 안에서 같은 이름의 git 저장소를 찾아
# Git 프로젝트를 하나 만들고 그 저장소 문서를 원본으로 연결한다. 이미 원본이 있는 문서는 건드리지 않는다.
def backfill() -> None:
    env = load_env()
    roots = [Path(p).expanduser() for p in env.get("INGEST_ROOTS", "").split(":") if p.strip()]
    tops = {}
    for r in roots:
        info = git_info(r)
        if info:
            tops[info["repo"]] = Path(info["top"])
    with connect(env) as conn:
        repos = [r[0] for r in conn.execute(
            """SELECT DISTINCT d.source_repo FROM documents d
               WHERE NOT EXISTS (SELECT 1 FROM project_documents pd WHERE pd.document_id=d.id AND pd.is_origin)
               ORDER BY 1""").fetchall()]
        for repo in repos:
            top = tops.get(repo)
            if top is None:
                print(f"건너뜀 {repo}: INGEST_ROOTS 안에서 이 이름의 git 저장소를 찾지 못했습니다")
                continue
            row = conn.execute("SELECT id FROM projects WHERE name=%s", (repo,)).fetchone()
            pid = row[0] if row else create_project(conn, repo, "git", {"from": "local", "path": str(top)}, {})
            n = conn.execute(
                """INSERT INTO project_documents (project_id, document_id, is_origin)
                   SELECT %s, d.id, true FROM documents d
                   WHERE d.source_kind='git' AND d.source_repo=%s
                     AND NOT EXISTS (SELECT 1 FROM project_documents pd WHERE pd.document_id=d.id AND pd.is_origin)
                   ON CONFLICT (project_id, document_id) DO UPDATE SET is_origin = true""",
                (pid, repo)).rowcount
            print(f"{repo}: 프로젝트 #{pid}에 문서 {n}개를 원본으로 연결")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="프로젝트 관리")
    ap.add_argument("command", choices=["backfill"])
    if ap.parse_args().command == "backfill":
        backfill()
