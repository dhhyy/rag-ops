"""사용 기록 (usage_log): 질문마다 비용·지연·결과를 남기고, 서비스별로 모아 보여 준다.

- 기록은 검색 스트림이 끝날 때 한 번 한다. 정상(ok), 오류(error), 화면이 끊음(stopped) 모두 남긴다.
- 기록에 실패해도 사용자의 질문 처리에는 영향을 주지 않는다 (로그만 남긴다).
"""
from __future__ import annotations

import logging

from psycopg.types.json import Jsonb

from ingest import connect

log = logging.getLogger("usage")


def record(env: dict[str, str], row: dict) -> None:
    try:
        with connect(env) as conn:
            conn.execute(
                """INSERT INTO usage_log (service, status, question, setup, hits, answer, sources, embed_tokens,
                       input_tokens, cached_tokens, output_tokens, cost_usd, latency_ms, error, trace_id)
                   VALUES (%(service)s, %(status)s, %(question)s, %(setup)s, %(hits)s, %(answer)s, %(sources)s,
                       %(embed_tokens)s, %(input_tokens)s, %(cached_tokens)s, %(output_tokens)s, %(cost_usd)s,
                       %(latency_ms)s, %(error)s, %(trace_id)s)""",
                {"service": row.get("service", "playground"), "status": row["status"], "question": row["question"],
                 "setup": Jsonb(row["setup"]), "hits": Jsonb(row.get("hits", [])), "answer": row.get("answer"),
                 "sources": row.get("sources"), "embed_tokens": row.get("embed_tokens", 0),
                 "input_tokens": row.get("input_tokens", 0), "cached_tokens": row.get("cached_tokens", 0),
                 "output_tokens": row.get("output_tokens", 0), "cost_usd": row.get("cost_usd"),
                 "latency_ms": Jsonb(row.get("latency_ms", {})), "error": row.get("error"),
                 "trace_id": row.get("trace_id")})
    except Exception:  # 기록 실패가 질문 처리를 깨면 안 된다
        log.exception("usage_log 기록 실패")


# 요약 한 묶음: 질문 수, 비용 합계, 평균·느린 쪽(p95) 전체 지연, 오류 수, 토큰 합계.
# 구간 시작은 아래 PERIODS의 고정 SQL 식만 쓴다 (밖에서 받은 값을 넣지 않는다).
PERIODS = {"today": "current_date", "month": "date_trunc('month', now())", "all": "'-infinity'::timestamptz"}
_SUMMARY = """
SELECT count(*), coalesce(sum(cost_usd), 0), avg((latency_ms->>'total')::numeric),
       percentile_cont(0.95) WITHIN GROUP (ORDER BY (latency_ms->>'total')::numeric),
       count(*) FILTER (WHERE status = 'error'), coalesce(sum(input_tokens + output_tokens + embed_tokens), 0)
FROM usage_log WHERE service = %(service)s AND created_at >= {since}
"""


def _summary(conn, service: str, period: str) -> dict:
    n, cost, avg_ms, p95_ms, errors, tokens = conn.execute(
        _SUMMARY.format(since=PERIODS[period]), {"service": service}).fetchone()
    return {"questions": n, "cost_usd": float(cost), "avg_ms": round(float(avg_ms)) if avg_ms is not None else None,
            "p95_ms": round(float(p95_ms)) if p95_ms is not None else None, "errors": errors, "tokens": int(tokens)}


# 하루·한 달 경계를 어느 시간대로 자를지. DB는 UTC라 그대로 두면 한국 시간 오전 9시에 "오늘"이 바뀐다.
def overview(env: dict[str, str], service: str = "playground", days: int = 14, limit: int = 50) -> dict:
    with connect(env) as conn:
        conn.execute("SELECT set_config('TimeZone', %s, false)", (env.get("USAGE_TZ", "Asia/Seoul"),))
        summary = {period: _summary(conn, service, period) for period in PERIODS}
        daily = conn.execute(
            """SELECT d::date, count(u.id), coalesce(sum(u.cost_usd), 0), avg((u.latency_ms->>'total')::numeric),
                      count(u.id) FILTER (WHERE u.status = 'error')
               FROM generate_series(current_date - (%(days)s - 1), current_date, interval '1 day') d
               LEFT JOIN usage_log u ON u.service = %(service)s AND u.created_at >= d AND u.created_at < d + interval '1 day'
               GROUP BY d ORDER BY d""", {"days": days, "service": service}).fetchall()
        cur = conn.execute(
            """SELECT id, created_at, status, question, setup, hits, answer, sources, embed_tokens, input_tokens,
                      cached_tokens, output_tokens, cost_usd, latency_ms, error, trace_id
               FROM usage_log WHERE service = %(service)s ORDER BY id DESC LIMIT %(limit)s""",
            {"service": service, "limit": limit})
        cols = [c.name for c in cur.description]
        recent = [dict(zip(cols, r)) for r in cur.fetchall()]
    for r in recent:
        r["cost_usd"] = float(r["cost_usd"]) if r["cost_usd"] is not None else None
    return {
        "service": service, "summary": summary,
        "daily": [{"day": d.isoformat(), "questions": n, "cost_usd": float(c),
                   "avg_ms": round(float(a)) if a is not None else None, "errors": e} for d, n, c, a, e in daily],
        "recent": recent,
    }

