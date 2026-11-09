"""질문 하나로 벡터 검색을 한다: 질문 임베딩 → pgvector 코사인 거리 → 상위 k개 조각.

사용:
  python engine/app/search.py "도메인을 만들면 포트포워딩이 필요 없나?"
  python engine/app/search.py "..." -k 10 --full     # 조각 원문 전체 보기

- 점수는 코사인 유사도(1 - 거리). 값 자체보다 순위를 본다 (무관한 글도 0.3~0.4가 나온다).
- 답변 근거로 쓸 수 있도록 출처(저장소·경로·커밋)와 환경·검증 상태를 함께 보여 준다.
"""
# 타입 힌트를 문자열로 늦게 해석한다.
from __future__ import annotations

# 표준 라이브러리. DB 접속·.env 읽기·TEI 호출은 ingest.py의 함수를 재사용한다.
import argparse
import json
import time

from ingest import connect, load_env, tei_post

# 코사인 거리(<=>)가 가까운 순으로 상위 k개 조각을 가져온다. 출처·환경·검증 상태를 함께 붙이려고 documents와 조인한다.
SQL = """
SELECT 1 - (c.embedding <=> %(q)s::vector) AS score,
       c.chunk_index, c.heading_path, c.content,
       d.source_repo, d.source_path, d.source_commit, d.env, d.doc_type, d.verification
FROM chunks c JOIN documents d ON d.id = c.document_id
ORDER BY c.embedding <=> %(q)s::vector
LIMIT %(k)s
"""


# 질문을 임베딩한 뒤 SQL로 검색한다. 임베딩 시간과 DB 시간을 따로 재서 함께 돌려준다.
def search(env: dict[str, str], question: str, k: int) -> tuple[list[tuple], float, float]:
    t0 = time.perf_counter()
    vec = tei_post(f"http://127.0.0.1:{env['EMBED_PORT']}/embed", {"inputs": question})[0]
    t1 = time.perf_counter()
    with connect(env) as conn:
        rows = conn.execute(SQL, {"q": json.dumps(vec), "k": k}).fetchall()
    t2 = time.perf_counter()
    return rows, t1 - t0, t2 - t1


# 명령줄 진입점: 질문을 받아 검색하고, 순위·점수·출처·조각 내용을 출력한다.
def main() -> None:
    ap = argparse.ArgumentParser(description="벡터 검색")
    ap.add_argument("question")
    ap.add_argument("-k", type=int, default=5, help="가져올 조각 수 (기본 5)")
    ap.add_argument("--full", action="store_true", help="조각 원문 전체 출력")
    a = ap.parse_args()

    # 검색 결과를 순위대로 출력한다. --full이 아니면 조각을 160자로 줄여 보여 준다.
    rows, t_embed, t_db = search(load_env(), a.question, a.k)
    print(f"Q: {a.question}   (임베딩 {t_embed*1000:.0f}ms, 검색 {t_db*1000:.0f}ms)\n")
    for rank, (score, idx, path, content, repo, spath, commit, env, dtype, verif) in enumerate(rows, 1):
        print(f"{rank}. {score:.3f}  [{idx:02d}] {path}")
        print(f"   출처 {repo}/{spath}@{commit[:12]} · 환경 {env} · {dtype} · 검증 {verif}")
        text = content if a.full else content.replace("\n", " ")[:160] + "…"
        print(f"   {text}\n")


# 직접 실행할 때만 main()을 돈다.
if __name__ == "__main__":
    main()
