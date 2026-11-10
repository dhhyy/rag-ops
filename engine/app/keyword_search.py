"""키워드 검색(BM25). 벡터 검색이 놓치는 정확한 낱말(명령어, 설정 이름, 오류 문구)을 잡으려고 둔다.

- 한국어는 띄어쓰기 단위로 자르면 "인증서를", "인증서가"가 다른 낱말이 된다. 그래서 kiwipiepy 형태소 분석으로
  조사·어미를 떼고 뜻이 있는 형태소만 남긴다 (KEEP 품사).
- 색인마다 조각의 embed_text(제목 경로 포함)로 BM25 표를 메모리에 만든다. 조각 수가 수백 개라 DB에 따로 저장하지 않는다.
  조각 수나 마지막 id가 바뀌면 다시 만든다.
- BM25 식은 직접 쓴다 (k1=1.2, b=0.75, Lucene과 같은 idf). 외부 라이브러리 없이 계산 과정을 볼 수 있게.
"""
from __future__ import annotations

import math
import threading
from collections import Counter

from ingest import connect

# 남길 품사: 일반·고유 명사(NNG, NNP), 수사(NR), 외국어(SL: nginx, DNS), 숫자(SN), 한자(SH), 어근(XR), 동사·형용사 어간(VV, VA).
# 조사(J*), 어미(E*), 접사(XS*), 문장 부호(S*)는 뺀다. 이 목록이 키워드 검색의 성격을 정한다.
KEEP = frozenset({"NNG", "NNP", "NR", "SL", "SN", "SH", "XR", "VV", "VA"})
K1, B = 1.2, 0.75

_kiwi = None
_kiwi_lock = threading.Lock()    # Kiwi 객체를 여러 스레드가 동시에 쓰지 않게 (FastAPI는 요청마다 스레드)
_tables: dict[int, tuple[tuple, "Bm25"]] = {}
_tables_lock = threading.Lock()


def tokens(text: str) -> list[str]:
    global _kiwi
    with _kiwi_lock:
        if _kiwi is None:
            from kiwipiepy import Kiwi
            _kiwi = Kiwi()
        return [t.form.lower() for t in _kiwi.tokenize(text) if t.tag in KEEP]


class Bm25:
    def __init__(self, ids: list[int], docs: list[list[str]]):
        self.ids = ids
        self.tf = [Counter(d) for d in docs]
        self.len = [len(d) for d in docs]
        self.avg = (sum(self.len) / len(docs)) if docs else 0.0
        df = Counter(t for d in self.tf for t in d)
        n = len(docs)
        self.idf = {t: math.log(1 + (n - f + 0.5) / (f + 0.5)) for t, f in df.items()}

    # 질문 낱말로 점수를 매겨 상위 n개 (조각 id, 점수). 질문 낱말이 하나도 없는 조각은 넣지 않는다.
    def top(self, query: list[str], n: int) -> list[tuple[int, float]]:
        terms = [t for t in dict.fromkeys(query) if t in self.idf]
        scored = []
        for i, tf in enumerate(self.tf):
            s = 0.0
            for t in terms:
                f = tf.get(t)
                if f:
                    s += self.idf[t] * f * (K1 + 1) / (f + K1 * (1 - B + B * self.len[i] / (self.avg or 1)))
            if s > 0:
                scored.append((self.ids[i], s))
        scored.sort(key=lambda x: -x[1])
        return scored[:n]


# 색인 하나의 BM25 표. 조각이 바뀌었으면(개수·마지막 id) 다시 만든다.
def table(env: dict[str, str], index_id: int) -> Bm25:
    with connect(env) as conn:
        sig = tuple(conn.execute("SELECT count(*), coalesce(max(id), 0) FROM chunks WHERE index_id=%s", (index_id,)).fetchone())
        with _tables_lock:
            hit = _tables.get(index_id)
            if hit and hit[0] == sig:
                return hit[1]
        rows = conn.execute("SELECT id, embed_text FROM chunks WHERE index_id=%s ORDER BY id", (index_id,)).fetchall()
    bm = Bm25([r[0] for r in rows], [tokens(r[1]) for r in rows])
    with _tables_lock:
        _tables[index_id] = (sig, bm)
    return bm


def search(env: dict[str, str], index_id: int, question: str, n: int) -> list[tuple[int, float]]:
    return table(env, index_id).top(tokens(question), n)
