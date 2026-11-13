# doc-search 샘플 문서

doc-search의 답변 보류 규칙을 화면에서 확인하려고 만든 **가상** 문서 7개다. 실제 서버·회사와 관계없다. 외부 전송 가능.

| 파일 | 환경 | 성격 | 검증 | 확인일 | 확인하려는 상황 |
| --- | --- | --- | --- | --- | --- |
| nginx-prod.md | 운영 | 설정 | 확인 | 2026-11-01 | 정상 답변 |
| nginx-dev.md | 개발 | 설정 | 확인 | 2026-11-01 | 환경이 섞이면 되묻기 |
| nginx-prod-old.md | 운영 | 설정 | 폐기 | 2025-03-10 | 폐기 문서로 답하지 않기 |
| db-backup-config.md | 운영 | 설정 | 확인 | 2026-10-20 | "지금 동작하나?"에 부분 답 |
| db-backup-runbook.md | 운영 | 해설 | 확인 | 2026-09-15 | 위 문서와 백업 시각이 다름 (02:00 ↔ 03:00) |
| monitoring-check.md | 운영 | 실행 결과 | 확인 | 2026-11-10 | 현재 동작을 답할 수 있는 근거 |
| incident-disk-full.md | 운영 | 장애 기록 | 추정 | 2026-10-28 | 추정 자료만 있을 때 |

평가 질문: `eval/questions.jsonl`의 `project: "doc-search-sample"` 질문 (q25~q34). `expect`는 doc-search가 내려야 할 판단(`answer` / `abstain` / `ask_back` / `partial`)이고, 기획 5절 추천안으로 Claude가 채운 **임시 값**이다. 확정은 사용자가 한다.

## 엔진에 넣기

1. 관리 콘솔(또는 `POST /projects`)에서 직접 관리 프로젝트 `doc-search-sample`을 만든다 (외부 전송 기본값 허용).
2. 이 폴더의 `.md` 7개를 올린다 (`POST /projects/{id}/upload`).
3. 올리기 API는 문서마다 환경·검증 상태를 정할 수 없어서, 위 표의 값을 DB에 직접 넣는다:

```sql
UPDATE documents d SET env=m.env, doc_type=m.dt, verification=m.v, checked_at=m.c::date, external_ok=true
FROM (VALUES
 ('nginx-prod.md','운영','설정','확인','2026-11-01'),
 ('nginx-dev.md','개발','설정','확인','2026-11-01'),
 ('nginx-prod-old.md','운영','설정','폐기','2025-03-10'),
 ('db-backup-config.md','운영','설정','확인','2026-10-20'),
 ('db-backup-runbook.md','운영','해설','확인','2026-09-15'),
 ('monitoring-check.md','운영','실행 결과','확인','2026-11-10'),
 ('incident-disk-full.md','운영','장애 기록','추정','2026-10-28')) AS m(p,env,dt,v,c)
WHERE d.source_kind='managed' AND d.source_repo='doc-search-sample' AND d.source_path=m.p;
```
