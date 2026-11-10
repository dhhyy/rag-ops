"""Celery 대기열과 worker. 가져오기 작업을 Redis 대기열에 쌓아 두고, worker가 하나씩 꺼내 실행한다.

실행 (Docker Compose의 worker 서비스가 이 명령으로 뜬다):
  celery -A tasks worker --concurrency=1 --loglevel=INFO

- 작업 결과는 Celery에 따로 저장하지 않는다. 상태·결과는 모두 ingest_jobs 테이블에 남는다.
- --concurrency=1: 임베딩 서버(TEI)가 CPU를 나눠 쓰므로 문서를 동시에 돌리지 않고 차례로 처리한다.
"""
from __future__ import annotations

from celery import Celery
from celery.signals import worker_process_init, worker_ready

import jobs
import telemetry
from ingest import connect, load_env

celery = Celery("rag-ops", broker=load_env().get("REDIS_URL", "redis://127.0.0.1:6379/0"))
celery.conf.update(
    task_ignore_result=True,          # 결과 저장소(backend)를 쓰지 않는다
    worker_prefetch_multiplier=1,     # 미리 여러 개를 가져가 쥐고 있지 않게 한다
    broker_connection_retry_on_startup=True,
)



# 추적: worker 자식 프로세스가 뜰 때 켠다 (fork 전에 켜면 내보내는 스레드가 자식에 없다)
@worker_process_init.connect
def init_tracing(**_) -> None:
    if telemetry.setup("rag-ops-worker"):
        from opentelemetry.instrumentation.celery import CeleryInstrumentor
        CeleryInstrumentor().instrument()


# 대기열에서 꺼낸 작업 번호 하나를 실행한다.
@celery.task(name="ingest")
def ingest_task(job_id: int) -> None:
    jobs.run_job(job_id)


# worker가 켜질 때: 이전 worker가 하다 만 작업(running)은 실패로 정리하고, 대기(queued) 작업은 대기열에 다시 넣는다.
# 다시 넣은 작업이 대기열에 이미 있어도 claim_job이 한 번만 실행되게 막는다.
# worker가 하나라는 전제다. worker를 여러 개 띄우면 다른 worker가 진행 중인 작업까지 실패로 바꾸게 된다.
@worker_ready.connect
def recover_jobs(**_) -> None:
    with connect(load_env()) as conn:
        conn.execute("""UPDATE ingest_jobs SET status='failed', error='worker 재시작으로 중단', finished_at=now()
                        WHERE status='running'""")
        queued = [r[0] for r in conn.execute("SELECT id FROM ingest_jobs WHERE status='queued' ORDER BY id").fetchall()]
    for job_id in queued:
        ingest_task.delay(job_id)
