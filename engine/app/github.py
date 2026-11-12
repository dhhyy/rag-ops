"""GitHub 저장소를 받아 Git 프로젝트로 쓴다.

- 저장소는 엔진·worker가 같이 보는 폴더(REPOS_DIR, compose의 repos 볼륨)에 프로젝트마다 하나씩 받는다:
    {REPOS_DIR}/{프로젝트 id}/{저장소 이름}
  받은 뒤에는 로컬 Git 프로젝트와 똑같이 읽는다 (출처 = 저장소 이름·경로·커밋).
- 비공개 저장소는 .env의 GITHUB_TOKEN으로 받는다.
  토큰은 주소나 .git/config에 남기지 않고, git을 부를 때마다 환경 변수(GIT_CONFIG_*)로 머리글만 넘긴다.
  오류 문장에 토큰이 섞여 나오지 않게 지운다. 화면에는 토큰이 있는지만 알린다.
- 새 커밋은 사람이 [새 커밋 확인]을 누를 때만 GitHub에 묻는다 (fetch). 받기는 [다시 받기]에서 한다.
"""
from __future__ import annotations

import base64
import json
import os
import re
import shutil
import subprocess
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

from ingest import load_env

REPOS_DIR = Path(os.environ.get("REPOS_DIR", "/srv/repos"))
API = "https://api.github.com"
# github.com/{owner}/{repo} 만 받는다. 다른 호스트로는 요청을 보내지 않는다.
URL_RE = re.compile(r"^(?:https?://)?(?:www\.)?github\.com/([A-Za-z0-9-]{1,39})/([A-Za-z0-9._-]{1,100}?)(?:\.git)?/?$")
BRANCH_RE = re.compile(r"^[A-Za-z0-9._/-]{1,200}$")


class GitHubError(ValueError):
    pass


def token() -> str:
    return load_env().get("GITHUB_TOKEN", "").strip()


def has_token() -> bool:
    return bool(token())


def parse_url(raw: str) -> tuple[str, str]:
    m = URL_RE.match(raw.strip())
    if not m:
        raise GitHubError("github.com/소유자/저장소 형식의 주소를 적어 주세요")
    return m.group(1), m.group(2)


def clean_folder(raw: str) -> str:
    folder = raw.strip().strip("/")
    if folder and any(part in ("", ".", "..") or part.startswith(".") for part in folder.split("/")):
        raise GitHubError("문서 폴더 이름이 올바르지 않아요 (., .., 숨김 폴더는 쓸 수 없어요)")
    return folder


def _scrub(text: str) -> str:
    tok = token()
    return text.replace(tok, "***") if tok else text


# ---------- GitHub API (확인 단계: 받기 전에 저장소·브랜치·문서 수를 본다) ----------

def _api(path: str) -> dict:
    req = urllib.request.Request(API + path, headers={"Accept": "application/vnd.github+json",
                                                      "X-GitHub-Api-Version": "2022-11-28",
                                                      "User-Agent": "rag-ops"})
    tok = token()
    if tok:
        req.add_header("Authorization", f"Bearer {tok}")
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        if e.code == 401:
            raise GitHubError("GITHUB_TOKEN이 맞지 않아요. 토큰을 확인해 주세요")
        if e.code == 403 and e.headers.get("X-RateLimit-Remaining") == "0":
            raise GitHubError("GitHub 요청 한도를 넘었어요. 잠시 뒤에 하거나 GITHUB_TOKEN을 넣어 주세요")
        if e.code in (403, 404):
            raise GitHubError("저장소나 브랜치를 찾을 수 없어요" +
                              ("" if tok else ". 비공개 저장소라면 .env에 GITHUB_TOKEN을 넣어야 해요"))
        raise GitHubError(f"GitHub 응답 오류 ({e.code})")
    except urllib.error.URLError as e:
        raise GitHubError(f"GitHub에 연결할 수 없어요 ({_scrub(str(e.reason))})")


# 받기 전에 저장소를 살펴본다: 공개/비공개, 기본 브랜치, 고른 브랜치의 지금 커밋, 문서 폴더 안 문서(.md·.pdf) 수 (md_count).
def inspect(url: str, branch: str = "", folder: str = "") -> dict:
    owner, repo = parse_url(url)
    folder = clean_folder(folder)
    info = _api(f"/repos/{owner}/{repo}")
    branch = branch.strip() or info["default_branch"]
    if not BRANCH_RE.match(branch):
        raise GitHubError("브랜치 이름이 올바르지 않아요")
    head = _api(f"/repos/{owner}/{repo}/branches/{quote(branch, safe='')}")
    sha = head["commit"]["sha"]
    tree = _api(f"/repos/{owner}/{repo}/git/trees/{sha}?recursive=1")
    entries = tree.get("tree", [])
    if folder and not any(e["type"] == "tree" and e["path"] == folder for e in entries):
        raise GitHubError(f"'{folder}' 폴더가 {branch} 브랜치에 없어요")
    prefix = f"{folder}/" if folder else ""
    # 숨김 폴더(.github 등)는 가져오기에서도 빼므로 세지 않는다 (api.expand_folder와 같은 규칙)
    md = [e for e in entries if e["type"] == "blob" and e["path"].lower().endswith((".md", ".pdf")) and e["path"].startswith(prefix)
          and not any(p.startswith(".") for p in e["path"][len(prefix):].split("/"))]
    return {"owner": owner, "repo": info["name"], "full_name": info["full_name"], "url": f"https://github.com/{info['full_name']}",
            "private": bool(info.get("private")), "default_branch": info["default_branch"],
            "branch": branch, "commit": sha[:7], "folder": folder,
            "md_count": len(md), "truncated": bool(tree.get("truncated")), "token": has_token()}


# ---------- git (받기·확인·맞추기) ----------

def _git(args: list[str], cwd: Path | None = None, timeout: int = 300) -> str:
    env = os.environ | {"GIT_TERMINAL_PROMPT": "0"}
    tok = token()
    if tok:
        basic = base64.b64encode(f"x-access-token:{tok}".encode()).decode()
        env |= {"GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "http.https://github.com/.extraheader",
                "GIT_CONFIG_VALUE_0": f"Authorization: Basic {basic}"}
    try:
        r = subprocess.run(["git", *args], cwd=cwd, env=env, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise GitHubError(f"git {args[0]}이 {timeout}초 안에 끝나지 않았어요")
    if r.returncode != 0:
        msg = _scrub(r.stderr.strip()).splitlines()
        last = msg[-1] if msg else f"git {args[0]} 실패"
        if "could not read Username" in last or "Authentication failed" in last or "not found" in last.lower():
            last = "저장소에 접근할 수 없어요" + ("" if tok else ". 비공개 저장소라면 .env에 GITHUB_TOKEN을 넣어야 해요")
        raise GitHubError(last)
    return r.stdout.strip()


def clone_dir(project_id: int, repo: str) -> Path:
    return REPOS_DIR / str(project_id) / repo


# 브랜치 하나만 받는다. 새 커밋 수를 세려면 기록이 필요해서 얕게(--depth) 받지 않는다.
def clone(project_id: int, owner: str, repo: str, branch: str) -> Path:
    dest = clone_dir(project_id, repo)
    if dest.parent.exists():
        shutil.rmtree(dest.parent)
    dest.parent.mkdir(parents=True)
    try:
        _git(["clone", "--single-branch", "--branch", branch, "--no-tags",
              f"https://github.com/{owner}/{repo}.git", str(dest)])
    except GitHubError:
        shutil.rmtree(dest.parent, ignore_errors=True)
        raise
    return dest


def remove(project_id: int) -> None:
    shutil.rmtree(REPOS_DIR / str(project_id), ignore_errors=True)


# 네트워크 없이 지금 상태만 본다: 받아 둔 커밋, 마지막 확인 때 본 원본 커밋, 뒤처진 커밋 수, 마지막 확인 시각.
def status(top: Path, branch: str) -> dict:
    def local(*args: str) -> str:
        return subprocess.check_output(["git", "-C", str(top), *args], text=True, stderr=subprocess.DEVNULL).strip()
    try:
        behind = int(local("rev-list", "--count", f"HEAD..origin/{branch}"))
        remote = local("rev-parse", "--short=7", f"origin/{branch}")
    except (subprocess.CalledProcessError, ValueError):
        behind, remote = 0, None
    fetched = top / ".git" / "FETCH_HEAD"
    checked = fetched if fetched.exists() else top / ".git" / "HEAD"
    return {"behind": behind, "remote_commit": remote,
            "checked_at": datetime.fromtimestamp(checked.stat().st_mtime, timezone.utc).isoformat()}


# [새 커밋 확인]: 원본에서 새 커밋을 받아 오기만 한다 (작업 폴더는 그대로).
def fetch(top: Path, branch: str) -> dict:
    _git(["fetch", "--no-tags", "origin", branch], cwd=top, timeout=120)
    return status(top, branch)


# [다시 받기] 전에: 원본 브랜치의 최신 커밋으로 작업 폴더를 맞춘다.
def update(top: Path, branch: str) -> dict:
    _git(["fetch", "--no-tags", "origin", branch], cwd=top, timeout=120)
    _git(["reset", "--hard", f"origin/{branch}"], cwd=top, timeout=60)
    return status(top, branch)
