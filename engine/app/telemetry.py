"""추적(OpenTelemetry) 설정. 엔진 API와 worker가 시작할 때 setup()을 한 번 부른다.

- OTEL_EXPORTER_OTLP_ENDPOINT가 비어 있으면 아무것도 하지 않는다 (추적 끔). 그래도 tracer 코드는 그대로 동작한다(no-op).
- 자동 계측: FastAPI 요청, psycopg(DB), urllib(TEI·OpenAI 호출), Redis, Celery 작업.
- 질문·답·문서 원문은 구간(span)에 넣지 않는다. 사용 기록(usage_log)의 trace_id로 이어서 본다.
- DB 구간에는 SQL 문장만 남고 값(파라미터)은 남지 않는다. HTTP 구간에는 헤더(API 키)가 남지 않는다.
"""
from __future__ import annotations

import logging
import os

from opentelemetry import trace

log = logging.getLogger("telemetry")
tracer = trace.get_tracer("rag-ops")
_done = False


def setup(service_name: str) -> bool:
    global _done
    if _done:
        return True
    if not os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT"):
        return False
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
    from opentelemetry.instrumentation.psycopg import PsycopgInstrumentor
    from opentelemetry.instrumentation.redis import RedisInstrumentor
    from opentelemetry.instrumentation.urllib import URLLibInstrumentor
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor

    provider = TracerProvider(resource=Resource.create({"service.name": service_name}))
    provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))   # 주소는 환경 변수에서 읽고 /v1/traces를 붙인다
    trace.set_tracer_provider(provider)
    PsycopgInstrumentor().instrument()
    URLLibInstrumentor().instrument()
    RedisInstrumentor().instrument()
    _done = True
    log.info("추적 켜짐: %s → %s", service_name, os.environ["OTEL_EXPORTER_OTLP_ENDPOINT"])
    return True


# 지금 구간의 trace_id (32자리 16진수). 추적이 꺼져 있으면 None.
def current_trace_id() -> str | None:
    ctx = trace.get_current_span().get_span_context()
    return format(ctx.trace_id, "032x") if ctx.is_valid else None
