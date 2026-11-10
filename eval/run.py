"""검색 평가 명령줄. 실제 계산은 engine/app/evaluate.py가 한다 (웹의 [현재 설정으로 평가]와 같은 코드).

사용 (저장소 루트에서, DB·임베딩 서버가 떠 있어야 한다):
  .venv/bin/python eval/run.py                          # 현재 설정으로 평가, 결과는 DB(eval_runs)에 저장
  .venv/bin/python eval/run.py --setup Baseline         # 저장된 설정으로
  .venv/bin/python eval/run.py --label "메모" --export   # 커밋용 JSON을 eval/results/에도 저장

결과 파일에는 조각 앞부분 글이 들어간다. 회사 문서가 섞인 색인이면 --export 결과를 커밋하지 않는다.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "engine" / "app"))
from evaluate import export_run, get_run, run_eval  # noqa: E402
from ingest import IngestError  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser(description="검색 평가")
    ap.add_argument("--setup", default=None, help="저장된 설정 이름 (기본: 현재 설정)")
    ap.add_argument("--label", default="", help="결과에 붙일 짧은 메모")
    ap.add_argument("--export", action="store_true", help="eval/results/에 JSON으로도 저장")
    a = ap.parse_args()

    try:
        out = run_eval(label=a.label, setup_name=a.setup,
                       on_step=lambda name, done, total: print(f"\r{name} {done}/{total}", end="", flush=True))
    except IngestError as e:
        sys.exit(f"\n{e}")
    run = get_run(out["eval_run_id"])
    for q in run["questions"]:
        mark = "보류" if q["abstain"] else (f"{q['rank']}위" if q["rank"] else "실패")
        print(f"\n{q['id']} {mark:>4}  top1 {q['top1_score']:.3f}  {q['question'][:40]}", end="")
    s, idx = run["summary"]["all"], run["meta"]["setup"]["index"]
    print(f"\n\n평가 #{out['eval_run_id']} · {idx['label']['chunker']} × {idx['label']['embedder']}")
    print(f"정답 있는 질문 {s['questions']}개: "
          + " · ".join(f"recall@{k} {s[f'recall@{k}']:.2f}" for k in run["meta"]["recall_at"])
          + f" · MRR {s['mrr']:.2f} · 평균 {run['summary']['latency_ms']['mean']}ms")
    print(f"그림 2축이 담은 정보: {sum(run['meta']['projection']['explained']) * 100:.1f}%")
    if a.export:
        print(f"저장: {export_run(out['eval_run_id'], ROOT / 'eval' / 'results').relative_to(ROOT)}")


if __name__ == "__main__":
    main()
