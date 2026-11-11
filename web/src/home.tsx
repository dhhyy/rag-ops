// Home: 지금 시스템 상태를 한눈에 보고, 바로 질문하거나 평가로 가는 화면. 설정은 Pipelines의 [설정 바꾸기]에서 바꾼다.
// 화면 나누기: 상태 줄 = Fixed, 아래 카드 묶음 = Fluid(큰 화면에서 남는 높이를 나눠 가짐), 질문 카드 = Hybrid.
import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowUp, ArrowUpRight, ChartNoAxesCombined, CircleAlert, Database, LoaderCircle, Receipt, Settings2,
} from 'lucide-react';
import { api, Card, ColorIcon, pct } from './ui';
import { useSetup, type IndexInfo } from './setup';
import type { AnswerSummary, EvalEntry, EvalJob } from './evaluations';

type Summary = { questions: number; cost_usd: number; avg_ms: number | null; errors: number };
type Day = { day: string; questions: number };
type Recent = { id: number; created_at: string; status: 'ok' | 'error' | 'stopped'; question: string; cost_usd: number | null; latency_ms: { total?: number } };
type Usage = { summary: { month: Summary }; daily: Day[]; recent: Recent[] };
type EvalWithAnswer = EvalEntry & { answer?: AnswerSummary | null };

const RECENT_KEY = 'playground-recent';   // Playground가 브라우저에 남기는 최근 질문 (playground.tsx와 같은 키)

const usd = (v: number | null | undefined) => (v == null ? '—' : v === 0 ? '$0' : v < 0.0001 ? '$0.0001 미만' : `$${v.toFixed(4)}`);
const sec = (ms: number | null | undefined) => (ms == null ? '—' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}초`);
// 11/10 18:25 처럼 짧게
const day = (iso: string) => { const d = new Date(iso); const two = (n: number) => String(n).padStart(2, '0'); return `${d.getMonth() + 1}/${d.getDate()} ${two(d.getHours())}:${two(d.getMinutes())}`; };

// 색인 이름을 짧은 한국어로: "제목 × OpenAI small"
function chunkerName(i: IndexInfo) { return i.chunker.id === 'heading' ? (i.chunker.params.prefix === 'none' ? '제목(절만)' : '제목') : i.label.chunker; }
function embedderName(i: IndexInfo) {
  const model = i.embedder.params.model;
  if (i.embedder.id === 'openai' && model) return `OpenAI ${model.replace('text-embedding-3-', '')}`;
  return i.label.embedder.split(' · ').pop() ?? i.embedder.id;
}
const indexName = (i: IndexInfo) => `${chunkerName(i)} × ${embedderName(i)}`;

export function Home({ openPipeline, openSetup, openPlayground, openEvaluations, openUsage, openKnowledge }: {
  openPipeline: () => void; openSetup: () => void; openPlayground: (question?: string) => void; openEvaluations: () => void; openUsage: () => void; openKnowledge: () => void;
}) {
  const s = useSetup();
  const [usage, setUsage] = useState<Usage | null>(null);
  const [evals, setEvals] = useState<EvalWithAnswer[] | null>(null);

  const loadUsage = () => api<Usage>('/usage').then(setUsage).catch(() => setUsage(null));
  const loadEvals = () => api<EvalWithAnswer[]>('/evals').then(setEvals).catch(() => setEvals([]));
  useEffect(() => { void loadUsage(); void loadEvals(); }, []);

  const setup = s.setup;
  const q = setup?.query;
  const docs = setup?.index.documents ?? 0;
  const stale = s.indexes.reduce((a, i) => a + i.pending, 0);
  const last = evals?.[0] ?? null;
  const month = usage?.summary.month;

  return <div className="home">
    {s.error && <p className="home-error"><CircleAlert size={14} />설정을 불러오지 못했어요 ({s.error})</p>}

    {/* 1. 상태 줄 (Fixed) */}
    <section className="home-status">
      <StatusTile icon={Settings2} color="lilac" onClick={openSetup} title={setup ? indexName(setup.index) : '불러오는 중…'}
        badge={setup?.index.external ? 'External' : undefined} note="현재 설정 · 눌러서 바꾸기" />
      <StatusTile icon={Database} color="lime" onClick={openKnowledge} title={setup ? `문서 ${docs}개 · 조각 ${setup.index.chunks}개` : '—'}
        note={`색인 ${s.indexes.length}개 · ${stale ? `뒤처진 문서 ${stale}개` : '뒤처진 문서 없음'}`} />
      <StatusTile icon={ChartNoAxesCombined} color="blue" onClick={openEvaluations} title={last ? `1등으로 찾음 ${pct(last.summary['recall@1'])}` : evals ? '평가 기록 없음' : '—'}
        note={last ? `최근 평가 · ${day(last.created_at)} · 질문 ${last.summary.questions}개` : '아래에서 평가를 돌려 보세요'} />
      <StatusTile icon={Receipt} color="peach" onClick={openUsage} title={month ? `이번 달 질문 ${month.questions}개 · ${usd(month.cost_usd)}` : '—'}
        note={month ? `평균 ${sec(month.avg_ms)} · ${month.errors ? `오류 ${month.errors}개` : '오류 없음'}` : '사용 기록을 불러오지 못했어요'} />
    </section>

    {/* 3·4. 카드 묶음 (Fluid) */}
    <section className="home-grid">
      <AskCard openPlayground={openPlayground} setupNote={setup && q ? `검색: ${embedderName(setup.index)} · 답변: ${q.generator ? `${q.generator.params.model ?? '답변 모델'} (근거 ${q.generator.params.sources}개)` : '끔, 근거만 보여 줘요'}` : ''}
        external={!!setup?.index.external} />
      <EvalCard last={last} loading={!evals} open={openEvaluations} reload={loadEvals} />
      <FlowCard setup={setup} open={openPipeline} />
      <RecentCard usage={usage} open={openUsage} />
      <WeekCard usage={usage} indexes={s.indexes} activeId={setup?.index.id} open={openKnowledge} />
    </section>
  </div>;
}

// ---------- 조각들 ----------

function StatusTile({ icon, color, title, note, badge, onClick }: { icon: typeof Database; color: string; title: string; note: string; badge?: string; onClick: () => void }) {
  return <button className="home-tile" onClick={onClick}>
    <ColorIcon icon={icon} color={color} />
    <span className="home-tile-text"><b><span>{title}</span>{badge && <em>{badge}</em>}</b><small>{note}</small></span>
  </button>;
}

function CardHead({ title, link, onClick }: { title: string; link: string; onClick: () => void }) {
  return <div className="home-card-head"><h2>{title}</h2><button className="home-link" onClick={onClick}>{link} <ArrowUpRight size={13} /></button></div>;
}

function AskCard({ openPlayground, setupNote, external }: { openPlayground: (q?: string) => void; setupNote: string; external: boolean }) {
  const [text, setText] = useState('');
  const recent = useRef<string[]>((() => { try { return (JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as string[]).slice(0, 3); } catch { return []; } })());
  const go = (question: string) => { if (question.trim()) openPlayground(question.trim()); };
  return <Card className="home-card home-ask" delay={0.08}>
    <CardHead title="문서에 물어보기" link="Playground" onClick={() => openPlayground()} />
    <form className="home-ask-box" onSubmit={e => { e.preventDefault(); go(text); }}>
      <input aria-label="질문" placeholder="운영 문서에 대해 물어보세요" maxLength={2000} value={text} onChange={e => setText(e.target.value)} />
      <button aria-label="질문 보내기" disabled={!text.trim()}><ArrowUp size={16} /></button>
    </form>
    {recent.current.length > 0 && <div className="home-chips">{recent.current.map(r => <button key={r} onClick={() => go(r)}>{r}</button>)}</div>}
    <p className="home-ask-meta">{setupNote}{external && <><br />질문이 OpenAI로 보내져요.</>}</p>
  </Card>;
}

function EvalCard({ last, loading, open, reload }: { last: EvalWithAnswer | null; loading: boolean; open: () => void; reload: () => void }) {
  const [job, setJob] = useState<EvalJob | null>(null);
  const [problem, setProblem] = useState('');
  const active = job && (job.status === 'queued' || job.status === 'running');
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => {
      api<EvalJob>(`/jobs/${job.id}`).then(next => {
        setJob(next);
        if (next.status === 'done') reload();
        if (next.status === 'failed') setProblem(next.error ?? '평가가 실패했어요');
      }).catch(e => setProblem(String(e instanceof Error ? e.message : e)));
    }, 1000);
    return () => clearInterval(t);
  }, [active, job?.id]);
  async function start() {
    setProblem('');
    try {
      const { job_id } = await api<{ job_id: number }>('/evals', { method: 'POST', body: { label: 'Home에서 평가', answers: false } });
      setJob({ id: job_id, status: 'queued', progress_done: null, progress_total: null, error: null, result: null });
    } catch (e) { setProblem(e instanceof Error ? e.message : String(e)); }
  }
  const r1 = last?.summary['recall@1'] ?? null;
  const a = last?.answer;
  return <Card className="home-card" delay={0.12}>
    <CardHead title="최근 평가" link="Evaluations" onClick={open} />
    {loading ? <p className="home-empty">불러오는 중…</p> : !last ? <p className="home-empty">아직 평가 기록이 없어요.</p> : <div className="home-gauge">
      <div className="home-ring" style={{ '--p': `${Math.round((r1 ?? 0) * 100)}%` } as React.CSSProperties}><div><b>{pct(r1)}</b><small>1등으로 찾음</small></div></div>
      <div className="home-mets">
        <div><b>{pct(last.summary['recall@3'])}</b><small>3등 안</small></div>
        <div><b>{last.summary.mrr?.toFixed(2) ?? '—'}</b><small>MRR</small></div>
        <div><b>{a ? `${a.correct} / ${a.graded}` : '—'}</b><small>근거 맞게 인용</small></div>
        <div><b>{a ? `${a.proper_abstain} / ${a.abstain}` : '—'}</b><small>보류 맞음</small></div>
      </div>
    </div>}
    <div className="home-foot">
      <small>{problem ? <span className="home-warn">{problem}</span> : active ? `평가 중 ${job.progress_done ?? 0} / ${job.progress_total ?? '…'}` : last ? `"${last.label}" · ${day(last.created_at)}` : ''}</small>
      <button className="home-btn" disabled={!!active} onClick={start}>{active ? <LoaderCircle size={13} className="spin" /> : null}현재 설정으로 평가</button>
    </div>
  </Card>;
}

function FlowCard({ setup, open }: { setup: ReturnType<typeof useSetup>['setup']; open: () => void }) {
  const q = setup?.query;
  const steps: { name: string; detail: string; on: boolean; external?: boolean }[] = setup && q ? [
    { name: '청킹', detail: setup.index.chunker.params.prefix === 'none' ? '제목 단위 · 절만' : '제목 단위 · 경로 붙임', on: true },
    { name: '임베딩', detail: embedderName(setup.index), on: true, external: setup.index.external },
    { name: '벡터 검색', detail: `상위 ${q.top_k}개`, on: true },
    { name: '키워드', detail: q.keyword ? (q.keyword.params.mode === 'keyword' ? '키워드만' : '벡터 + 키워드 (RRF)') : '꺼짐', on: !!q.keyword },
    { name: '리랭크', detail: q.reranker ? `후보 ${q.reranker.params.candidates}개` : '꺼짐', on: !!q.reranker },
    { name: '답변', detail: q.generator ? `${q.generator.params.model ?? q.generator_label} · 근거 ${q.generator.params.sources}개` : '꺼짐', on: !!q.generator, external: !!q.generator },
  ] : [];
  return <Card className="home-card" delay={0.16}>
    <CardHead title="지금 파이프라인" link="Pipelines" onClick={open} />
    <div className="home-flow">{steps.length ? steps.map(st => <div key={st.name} className={`home-step ${st.on ? '' : 'is-off'}`}>
      <i /><b>{st.name}</b><small>{st.detail}</small>{st.external && st.on && <em>External</em>}
    </div>) : <p className="home-empty">불러오는 중…</p>}</div>
  </Card>;
}

function RecentCard({ usage, open }: { usage: Usage | null; open: () => void }) {
  const rows = (usage?.recent ?? []).slice(0, 5);   // 카드 높이에 맞춰 5개만
  return <Card className="home-card home-span2" delay={0.2}>
    <CardHead title="최근 질문" link="사용 기록" onClick={open} />
    {rows.length ? <table className="home-table"><tbody>{rows.map(r => <tr key={r.id}>
      <td><span className={`home-dot ${r.status}`} />{r.question}</td>
      <td className="home-n home-hide">{day(r.created_at)}</td>
      <td className="home-n">{sec(r.latency_ms.total)}</td>
      <td className="home-n home-hide">{usd(r.cost_usd)}</td>
    </tr>)}</tbody></table> : <p className="home-empty">아직 질문이 없어요. 위에서 물어보세요.</p>}
  </Card>;
}

function WeekCard({ usage, indexes, activeId, open }: { usage: Usage | null; indexes: IndexInfo[]; activeId?: number; open: () => void }) {
  const week = (usage?.daily ?? []).slice(-7);
  const max = Math.max(1, ...week.map(d => d.questions));
  const total = week.reduce((a, d) => a + d.questions, 0);
  const label = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
  return <Card className="home-card" delay={0.24}>
    <CardHead title="최근 7일" link="Knowledge" onClick={open} />
    <div>
      <div className="home-spark" aria-label={`최근 7일 질문 ${total}개`}>{week.map((d, i) => <i key={d.day} title={`${label(d.day)} · ${d.questions}개`}
        className={i === week.length - 1 ? 'is-today' : ''} style={{ height: `${Math.max(4, (d.questions / max) * 100)}%` }} />)}</div>
      {week.length > 0 && <div className="home-days"><span>{label(week[0].day)}</span><span>질문 {total}개</span><span>{label(week[week.length - 1].day)}</span></div>}
    </div>
    <div className="home-idx">{indexes.map(i => <div key={i.id} className={i.id === activeId ? 'is-active' : ''}>
      <span>{i.is_base ? '★ ' : i.id === activeId ? '● ' : ''}{indexName(i)}{i.is_base ? ' (기본)' : ''}{i.id === activeId ? ' · 사용 중' : ''}</span>
      <small>{i.pending ? `${i.pending}개 뒤처짐` : `${i.chunks}조각`}</small>
    </div>)}</div>
  </Card>;
}
