// Evaluations: run the evaluation set against the current setup and read stored runs (eval_runs) one at a time.
import React, { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { ArrowLeftRight, ChartNoAxesCombined, Check, ChevronDown, CircleAlert, Clock3, Layers3, LoaderCircle, Play } from 'lucide-react';
import { api, Card, ColorIcon, ease, Heading, MetricCard, pct, shortTime, useSize } from './ui';
import { SetupChips, useSetup, type StageSetting } from './setup';

export type Snapshot = {
  name: string | null; query: { top_k: number; reranker?: StageSetting | null; keyword?: StageSetting | null }; reranker_label?: string | null; keyword_label?: string | null;
  index: { id: number; key: string; chunker: StageSetting; embedder: StageSetting; dims: number; is_base: boolean; label: { chunker: string; embedder: string }; external: boolean };
};
export type EvalSummary = { questions: number; 'recall@1': number | null; 'recall@3': number | null; 'recall@5': number | null; mrr: number | null };
export type EvalHit = { chunk_id: number; score: number; correct: boolean; vector_score?: number; vector_rank?: number };
export type EvalQuestion = {
  id: string; kind: string; question: string; answer: string; env: string; abstain: boolean; use: string;
  evidence: { path: string; heading: string; quote?: string; match_by: 'quote' | 'heading' }[]; gold_chunk_ids: number[]; missing_evidence: boolean;
  rank: number | null; rank_vector?: number | null; top1_score: number | null; retrieved: EvalHit[];
  latency_ms: { embed: number; db: number; rerank?: number; total: number }; x: number; y: number;
  answer_eval?: AnswerEval;
};
export type AnswerVerdict = '근거 맞음' | '근거 틀림' | '인용 없음' | '잘못된 보류' | '보류 맞음' | '보류 안 함' | '오류';
export type AnswerEval = {
  verdict: AnswerVerdict; text?: string; error?: string; sent?: number[]; skipped?: number[]; cited?: number[]; cited_correct?: number[];
  invalid_cites?: number[]; says_missing?: string | null; gold_in_sent?: boolean; model?: string; cost_usd?: number | null; ms?: number;
};
export type AnswerSummary = {
  answered: number; graded: number; abstain: number; correct: number; wrong: number; no_cite: number; wrong_abstain: number;
  proper_abstain: number; missed_abstain: number; errors: number; gold_in_sent: number; cost_usd: number | null;
  input_tokens: number; output_tokens: number; mean_ms: number; model: string | null;
};
export type EvalChunk = { id: number; path: string; title: string; index: number; heading: string; heading_path: string; snippet: string; x: number; y: number };
export type EvalMeta = {
  run_id: number; label: string; created_at: string; setup: Snapshot;
  top_k: number; recall_at: number[]; code_commit: string; questions_file: string; questions_sha256: string;
  documents: number; chunks: number; projection: { method: string; fit_on: string; explained: number[] }; external_query_calls: number;
};
export type EvalRun = {
  meta: EvalMeta; questions: EvalQuestion[]; chunks: EvalChunk[];
  summary: { all: EvalSummary; by_kind: Record<string, EvalSummary>; abstain: { questions: number; top1_scores: number[] }; latency_ms: { mean: number; p95: number }; answer?: AnswerSummary | null };
};
export type EvalEntry = { run_id: number; label: string; setup: Snapshot; summary: EvalSummary; latency_ms: { mean: number; p95: number }; created_at: string; questions_sha256: string };
export type EvalJob = { id: number; status: 'queued' | 'running' | 'done' | 'failed'; progress_done: number | null; progress_total: number | null; error: string | null; result: { eval_run_id?: number } | null };

const SHOWN_HITS = 5;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const runName = (e: EvalEntry) => `#${e.run_id}${e.label ? ` ${e.label}` : ''} · ${e.setup.index.label.chunker} × ${e.setup.index.label.embedder}${e.setup.keyword_label ? ` + 키워드 ${e.setup.keyword_label.split(' · ')[1] ?? ''}` : ''}${e.setup.reranker_label ? ` + rerank ${e.setup.reranker_label}` : ''} · R@1 ${pct(e.summary['recall@1'])}`;

// Where a question landed: first place, top 5, lower, not found, or a question with no answer.
function evalOutcome(q: EvalQuestion): { label: string; tone: 'lime' | 'blue' | 'peach' | 'neutral'; color: string } {
  if (q.abstain) return { label: 'No answer', tone: 'neutral', color: '#b3a9bd' };
  if (q.rank === 1) return { label: '#1', tone: 'lime', color: '#b9c43c' };
  if (q.rank && q.rank <= SHOWN_HITS) return { label: `#${q.rank}`, tone: 'blue', color: '#8ea6ec' };
  if (q.rank) return { label: `#${q.rank}`, tone: 'peach', color: '#f29e70' };
  return { label: 'Missed', tone: 'peach', color: '#f29e70' };
}

// ---------- Data ----------

function useEvalRuns() {
  const [list, setList] = useState<EvalEntry[] | null>(null);
  const [runs, setRuns] = useState<Record<number, EvalRun>>({});
  const [error, setError] = useState('');
  const loading = useRef(new Set<number>());

  const reload = () => api<EvalEntry[]>('/evals').then(l => { setList(l); setError(''); return l; })
    .catch(e => { setError(`Could not load evaluation runs (${message(e)})`); return null; });
  useEffect(() => { void reload(); }, []);

  function want(id: number | null) {
    if (id == null || runs[id] || loading.current.has(id)) return;
    loading.current.add(id);
    api<EvalRun>(`/evals/${id}`).then(r => setRuns(m => ({ ...m, [id]: r }))).catch(e => setError(`Could not load run #${id} (${message(e)})`))
      .finally(() => loading.current.delete(id));
  }
  return { list, runs, want, reload, error };
}

// The evaluation job: start it, follow it, and notice one that is already running when the page opens.
function useEvalJob(onDone: (runId: number | undefined) => void) {
  const [job, setJob] = useState<EvalJob | null>(null);
  const [error, setError] = useState('');
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    api<EvalJob[]>('/jobs?kind=eval&limit=1').then(([last]) => { if (last && (last.status === 'queued' || last.status === 'running')) setJob(last); }).catch(() => undefined);
  }, []);
  const active = job && (job.status === 'queued' || job.status === 'running');
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      api<EvalJob>(`/jobs/${job.id}`).then(next => {
        setJob(next);
        if (next.status === 'done') done.current(next.result?.eval_run_id);
        if (next.status === 'failed') setError(next.error ?? 'Evaluation failed');
      }).catch(e => setError(message(e)));
    }, 800);
    return () => clearInterval(timer);
  }, [active, job?.id]);

  async function start(label: string, answers: boolean) {
    setError('');
    try {
      const { job_id } = await api<{ job_id: number }>('/evals', { method: 'POST', body: { label, answers } });
      setJob({ id: job_id, status: 'queued', progress_done: null, progress_total: null, error: null, result: null });
    } catch (e) { setError(message(e)); }
  }
  return { job, active: !!active, error, start };
}

// ---------- Pieces ----------

// Top-1 score spread: answerable and no-answer questions on one scale. Overlap means one score cannot decide when to decline.
function ScoreStrip({ run, selected, select }: { run: EvalRun; selected: string | null; select: (id: string) => void }) {
  const scored = run.questions.filter(q => q.top1_score != null);
  if (!scored.length) return null;
  const values = scored.map(q => q.top1_score!);
  const lo = Math.floor((Math.min(...values) - 0.02) * 50) / 50;
  const hi = Math.ceil((Math.max(...values) + 0.02) * 50) / 50;
  const pos = (v: number) => `${((v - lo) / (hi - lo)) * 100}%`;
  const answerable = scored.filter(q => !q.abstain).map(q => q.top1_score!);
  const noAnswer = scored.filter(q => q.abstain).map(q => q.top1_score!);
  const overlap = answerable.length && noAnswer.length && Math.max(...noAnswer) >= Math.min(...answerable);
  return <Card className="eval-score-card" delay={0.2}>
    <div className="eval-score-head"><small>Top-1 score · run #{run.meta.run_id}</small><em>{noAnswer.length ? overlap ? 'No-answer questions overlap answerable ones' : 'No-answer questions score lower' : 'No no-answer questions'}</em></div>
    {[{ label: 'Has answer', abstain: false }, { label: 'No answer', abstain: true }].map(row => <div className="eval-score-row" key={row.label}>
      <span>{row.label}</span>
      <div className="eval-score-track">
        {scored.filter(q => q.abstain === row.abstain).map(q => <button key={q.id} className={`eval-score-dot ${selected === q.id ? 'is-selected' : ''}`} style={{ left: pos(q.top1_score!), background: evalOutcome(q).color }} onClick={() => select(q.id)} aria-label={`${q.id} top-1 score ${q.top1_score!.toFixed(3)}`} title={`${q.id} · ${q.top1_score!.toFixed(3)}`} />)}
      </div>
    </div>)}
    <div className="eval-score-axis"><span>{lo.toFixed(2)}</span><span>{hi.toFixed(2)}</span></div>
  </Card>;
}

type MapTip = { x: number; y: number; title: string; sub: string } | null;

// Embedding map: chunks (dots) and questions (diamonds) on two PCA axes. The chosen question links to its top 5 chunks.
function EvalMap({ run, selected, select, focusChunk, setFocusChunk, tabs }: {
  run: EvalRun; selected: EvalQuestion | null; select: (id: string) => void;
  focusChunk: number | null; setFocusChunk: (id: number | null) => void; tabs?: React.ReactNode;
}) {
  const [ref, { width, height }] = useSize<HTMLDivElement>();
  const [tip, setTip] = useState<MapTip>(null);
  const reduced = useReducedMotion();
  const chunkById = new Map(run.chunks.map(c => [c.id, c]));
  const pts = [...run.chunks, ...run.questions];
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const pad = 26;
  // Same scale on x and y, so distance on screen is the projected distance.
  const scale = Math.min((width - pad * 2) / (x1 - x0 || 1), (height - pad * 2) / (y1 - y0 || 1));
  const ox = (width - (x1 - x0) * scale) / 2, oy = (height - (y1 - y0) * scale) / 2;
  const sx = (x: number) => ox + (x - x0) * scale;
  const sy = (y: number) => height - (oy + (y - y0) * scale);

  const top = selected ? selected.retrieved.slice(0, SHOWN_HITS) : [];
  const rankOf = new Map(top.map((h, i) => [h.chunk_id, i + 1]));
  const gold = new Set(selected?.gold_chunk_ids ?? []);
  const focusPath = focusChunk != null ? chunkById.get(focusChunk)?.path : undefined;
  const explained = run.meta.projection.explained.reduce((a, b) => a + b, 0);

  return <Card className="eval-map-card" delay={0.25}>
    <div className="card-heading"><div><h2>Embedding map</h2><small>Run #{run.meta.run_id} · {run.chunks.length} chunks · {run.questions.length} questions · PCA fitted on chunks</small></div>{tabs}<span className="tag" title="Share of the original variance the two axes keep">2 axes keep {Math.round(explained * 100)}%</span></div>
    <div className="eval-map" ref={ref} onMouseLeave={() => { setTip(null); setFocusChunk(null); }}>
      {width > 0 && height > 0 && <svg width={width} height={height} role="img" aria-label="Chunks and questions projected to two dimensions">
        {selected && top.map((h, i) => { const c = chunkById.get(h.chunk_id); if (!c) return null; return <motion.line key={`${run.meta.run_id}-${selected.id}-${h.chunk_id}`} x1={sx(selected.x)} y1={sy(selected.y)} x2={sx(c.x)} y2={sy(c.y)} className={`eval-link ${h.correct ? 'is-correct' : ''}`} initial={{ pathLength: reduced ? 1 : 0, opacity: 0 }} animate={{ pathLength: 1, opacity: 1 - i * 0.14 }} transition={{ duration: 0.45, delay: reduced ? 0 : i * 0.05, ease }} />; })}
        {run.chunks.map(c => {
          const rank = rankOf.get(c.id);
          const cls = ['eval-chunk', rank ? 'is-hit' : '', gold.has(c.id) ? 'is-gold' : '', focusPath && c.path === focusPath ? 'is-doc' : '', focusChunk === c.id ? 'is-focus' : ''].filter(Boolean).join(' ');
          return <g key={c.id} transform={`translate(${sx(c.x)} ${sy(c.y)})`} className={cls}
            onMouseEnter={() => { setFocusChunk(c.id); setTip({ x: sx(c.x), y: sy(c.y), title: c.heading, sub: `${c.title} · chunk ${c.index}${rank ? ` · rank ${rank}` : ''}` }); }}>
            {gold.has(c.id) && <circle r={8.5} className="eval-gold-ring" />}
            <circle r={rank ? 5.5 : 4} />
            {rank && <text y={-10} textAnchor="middle">{rank}</text>}
          </g>;
        })}
        {run.questions.map(q => {
          const on = selected?.id === q.id, o = evalOutcome(q), s = on ? 7 : 5;
          return <g key={q.id} transform={`translate(${sx(q.x)} ${sy(q.y)})`} className={`eval-question ${on ? 'is-selected' : ''} ${q.abstain ? 'is-abstain' : ''}`}
            onClick={() => select(q.id)} onMouseEnter={() => setTip({ x: sx(q.x), y: sy(q.y), title: q.question, sub: `${q.id} · ${q.kind} · ${o.label}` })}>
            <rect x={-s} y={-s} width={s * 2} height={s * 2} transform="rotate(45)" style={{ fill: q.abstain ? '#fff' : o.color, stroke: q.abstain ? o.color : undefined }} />
            {on && <text y={-13} textAnchor="middle">{q.id}</text>}
          </g>;
        })}
      </svg>}
      <AnimatePresence>{tip && <motion.div className="eval-tip" style={{ left: Math.min(tip.x, width - 230), top: tip.y + 14 }} initial={{ opacity: 0, y: -3 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.12 }}><b>{tip.title}</b><small>{tip.sub}</small></motion.div>}</AnimatePresence>
    </div>
    <div className="eval-legend">
      <span><i className="lg-chunk" />Chunk</span><span><i className="lg-hit" />Retrieved (rank)</span><span><i className="lg-gold" />Expected evidence</span>
      <span><i className="lg-q" style={{ background: '#b9c43c' }} />#1</span><span><i className="lg-q" style={{ background: '#8ea6ec' }} />#2–5</span><span><i className="lg-q" style={{ background: '#f29e70' }} />Missed</span><span><i className="lg-q is-hollow" />No answer</span>
    </div>
    <p className="eval-caption">Close on this map does not always mean close in search: search uses all {run.meta.setup.index.dims} dimensions, the map shows two. Each index has its own vector space, so maps of different models cannot be laid over each other.</p>
  </Card>;
}

function EvalDetail({ q, run, setFocusChunk }: { q: EvalQuestion | null; run: EvalRun; setFocusChunk: (id: number | null) => void }) {
  if (!q) return <Card className="eval-detail" delay={0.3}><div className="empty-state compact"><p>Select a question.</p></div></Card>;
  const chunkById = new Map(run.chunks.map(c => [c.id, c]));
  const o = evalOutcome(q);
  const hits = q.retrieved.slice(0, SHOWN_HITS);
  const rankOfChunk = new Map(q.retrieved.map((h, i) => [h.chunk_id, i + 1]));
  const scores = q.retrieved.map(h => h.score);
  const lo = Math.min(...scores) - 0.05, hi = Math.max(...scores);
  return <Card className="eval-detail" delay={0.3}>
    <AnimatePresence mode="wait" initial={false}>
      <motion.div key={`${run.meta.run_id}-${q.id}`} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.2 }}>
        <div className="eval-detail-head"><span className="eval-id">{q.id}</span><span className="tag">{q.kind}</span><span className="tag">{q.use}</span>
          <span className={`pill ${o.tone}`}>{o.label}</span></div>
        <h3 className="eval-detail-question">{q.question}</h3>
        <dl className="eval-answer"><dt>Expected</dt><dd>{q.answer}</dd></dl>

        <h4 className="eval-subhead">Evidence</h4>
        {q.evidence.length ? <ul className="eval-evidence">{q.evidence.map(e => {
          // Chunks counted as correct for this evidence: same document and (for quotes) containing the quote.
          const golds = q.gold_chunk_ids.map(id => chunkById.get(id)).filter((c): c is EvalChunk => !!c && c.path === e.path);
          const ranks = golds.map(c => rankOfChunk.get(c.id)).filter((r): r is number => r !== undefined);
          const rank = ranks.length ? Math.min(...ranks) : undefined;
          return <li key={`${e.path}#${e.heading}#${e.quote ?? ''}`} onMouseEnter={() => golds[0] && setFocusChunk(golds[0].id)} onMouseLeave={() => setFocusChunk(null)}>
            <span className={`eval-rank-badge ${rank ? (rank <= SHOWN_HITS ? 'is-in' : 'is-low') : 'is-out'}`}>{rank ?? '—'}</span>
            <span className="doc-name"><b>{e.heading}</b><small>{e.path}{golds.length ? '' : ' · not found in this index'}</small>{e.quote && <q className="eval-quote">{e.quote}</q>}</span>
          </li>;
        })}</ul> : <p className="eval-note">No evidence: this question should be declined. The decline rule is not set yet — the top-1 score was <b>{q.top1_score?.toFixed(3)}</b>.</p>}

        {q.answer_eval && <AnswerBlock a={q.answer_eval} />}

        <h4 className="eval-subhead">Retrieved · top {SHOWN_HITS} · run #{run.meta.run_id}</h4>
        <ol className="eval-hits">{hits.map((h, i) => { const c = chunkById.get(h.chunk_id); return <li key={h.chunk_id} className={h.correct ? 'is-correct' : ''} onMouseEnter={() => setFocusChunk(h.chunk_id)} onMouseLeave={() => setFocusChunk(null)}>
          <span className="eval-hit-rank">{i + 1}</span>
          <span className="doc-name"><b>{c?.heading ?? `chunk ${h.chunk_id}`}</b><small>{c?.title}</small></span>
          <span className="eval-hit-score"><em>{h.score.toFixed(3)}</em><i><motion.span initial={{ width: 0 }} animate={{ width: `${Math.max(4, ((h.score - lo) / (hi - lo || 1)) * 100)}%` }} transition={{ duration: 0.5, delay: i * 0.04, ease }} /></i></span>
          {h.correct ? <Check size={14} className="eval-hit-check" /> : <span className="eval-hit-check" />}
        </li>; })}</ol>
        <p className="eval-latency">Embed {q.latency_ms.embed.toFixed(0)} ms · DB {q.latency_ms.db.toFixed(0)} ms</p>
      </motion.div>
    </AnimatePresence>
  </Card>;
}

// ---------- 답변 평가 ----------

const verdictTone: Record<AnswerVerdict, string> = {
  '근거 맞음': 'lime', '보류 맞음': 'lime', '근거 틀림': 'peach', '잘못된 보류': 'peach', '보류 안 함': 'peach', '인용 없음': 'neutral', '오류': 'neutral',
};
const usd = (v: number | null | undefined) => (v == null ? '—' : v < 0.0001 ? '$0.0001 미만' : `$${v.toFixed(4)}`);

// 답변 평가 요약. 규칙으로 채점한다: 인용 [n]에 정답 조각이 있는지, 답 없는 질문에 "문서에 없다"고 했는지.
function AnswerSummaryCard({ a }: { a: AnswerSummary }) {
  const items: [string, string, string][] = [
    ['근거 맞게 인용', `${a.correct} / ${a.graded}`, `보낸 근거에 정답이 있던 질문 ${a.gold_in_sent}개`],
    ['다른 근거 인용', `${a.wrong}`, a.no_cite ? `인용 없이 답함 ${a.no_cite}개` : '인용 없는 답 없음'],
    ['답 없는 질문', `${a.proper_abstain} / ${a.abstain}`, `"문서에 없다"고 답함${a.missed_abstain ? ` · 규칙이 못 찾음 ${a.missed_abstain}개` : ''}`],
    ['잘못된 보류', `${a.wrong_abstain}`, '답이 있는데 없다고 함'],
    ['비용', usd(a.cost_usd), `${a.model ?? ''} · 입력 ${a.input_tokens.toLocaleString()} · 출력 ${a.output_tokens.toLocaleString()} 토큰`],
  ];
  return <Card className="eval-answer-summary" delay={0.18}>
    <div className="eval-answer-summary-head"><h2>답변 평가</h2><small>규칙 채점 · 질문마다 평균 {(a.mean_ms / 1000).toFixed(1)}초{a.errors ? ` · 오류 ${a.errors}개` : ''}</small></div>
    <div className="eval-answer-grid">{items.map(([k, v, n]) => <div key={k}><small>{k}</small><b>{v}</b><span>{n}</span></div>)}</div>
  </Card>;
}

function AnswerBlock({ a }: { a: AnswerEval }) {
  return <div className="eval-llm-answer">
    <div className="eval-llm-head"><h4 className="eval-subhead">LLM 답변</h4><span className={`pill ${verdictTone[a.verdict]}`}>{a.verdict}</span></div>
    {a.error ? <p className="result-error">{a.error}</p> : <p className="eval-llm-text">{a.text || '(빈 답)'}</p>}
    {!a.error && <small className="eval-llm-meta">
      보낸 근거 {a.sent?.join('·') || '없음'} · 인용 {a.cited?.length ? a.cited.join('·') : '없음'}
      {a.cited_correct?.length ? ` · 정답 인용 ${a.cited_correct.join('·')}` : ''}
      {a.gold_in_sent === false && (a.verdict === '근거 틀림' || a.verdict === '인용 없음' || a.verdict === '잘못된 보류') ? ' · 보낸 근거에 정답 조각 없음' : ''}
      {a.says_missing ? ` · "${a.says_missing}…"` : ''} · {usd(a.cost_usd)}
    </small>}
  </div>;
}

// ---------- Page ----------
// A/B 비교는 "비교" 페이지로 옮겼다. 여기서는 평가 기록 하나를 자세히 본다.

type EvalFilter = 'all' | 'missed' | string;

export function Evaluations({ openPipeline, openCompare }: { openPipeline: () => void; openCompare: () => void }) {
  const { list, runs, want, reload, error } = useEvalRuns();
  const { setup } = useSetup();
  const [runId, setRunId] = useState<number | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<EvalFilter>('all');
  const [focusChunk, setFocusChunk] = useState<number | null>(null);
  const [label, setLabel] = useState('');
  const [withAnswers, setWithAnswers] = useState(false);
  const evalJob = useEvalJob(async newId => {
    await reload();
    if (newId != null) { setRunId(newId); setLabel(''); }
  });

  // Open on the latest run.
  useEffect(() => { if (list?.length && runId == null) setRunId(list[0].run_id); }, [list]);
  useEffect(() => { want(runId); }, [runId]);

  const run = runId != null ? runs[runId] : undefined;

  // Keep the same question when the run changes; otherwise pick the first one.
  useEffect(() => {
    if (run && !run.questions.some(q => q.id === selectedId)) setSelectedId(run.questions[0]?.id ?? null);
  }, [run, selectedId]);

  const runner = <Card className="eval-runner">
    <div className="eval-runner-row">
      <div className="eval-runner-setup"><small>Current setup</small><SetupChips setup={setup} onChange={openPipeline} /></div>
      <form className="eval-runner-form" onSubmit={e => { e.preventDefault(); if (!evalJob.active) void evalJob.start(label.trim(), withAnswers); }}>
        <label className="eval-answer-toggle"><input type="checkbox" checked={withAnswers} onChange={e => setWithAnswers(e.target.checked)} disabled={evalJob.active} />답변까지 평가</label>
        <input className="eval-label-input" aria-label="Note for this run" placeholder="Note for this run (optional)" maxLength={60} value={label} onChange={e => setLabel(e.target.value)} disabled={evalJob.active} />
        <button className="primary-button" disabled={evalJob.active || !setup}>{evalJob.active ? <LoaderCircle size={15} className="spin" /> : <Play size={15} />}{evalJob.active ? 'Evaluating…' : 'Evaluate current setup'}</button>
      </form>
    </div>
    <AnimatePresence initial={false}>{evalJob.active && evalJob.job && <motion.div className="eval-runner-progress" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>
      <span className="progress-track"><motion.span animate={{ width: `${evalJob.job.progress_total ? ((evalJob.job.progress_done ?? 0) / evalJob.job.progress_total) * 100 : 0}%` }} transition={{ duration: 0.5, ease }} /></span>
      <span>{evalJob.job.status === 'queued' ? 'Waiting in queue' : `${evalJob.job.progress_done ?? 0} / ${evalJob.job.progress_total ?? '?'} questions`}</span>
    </motion.div>}</AnimatePresence>
    {withAnswers && <p className="eval-runner-note"><CircleAlert size={12} />질문마다 상위 근거를 {setup?.query.generator_label?.split(' · ')[1] ?? 'gpt-6-luna'}에 보내 답을 쓰게 해요. 13문제에 약 $0.002예요.</p>}
    {setup?.index.external && <p className="eval-runner-note"><CircleAlert size={12} />This setup uses an external model: every question is sent to {setup.index.label.embedder.split(' · ')[0]} once.</p>}
    {evalJob.error && <p className="source-error eval-runner-error">{evalJob.error}</p>}
  </Card>;

  if (list && !list.length) return <>
    <Heading title="Evaluations" subtitle="Retrieval quality on the evaluation set" />
    {runner}
    <Card className="empty-state"><ColorIcon icon={ChartNoAxesCombined} color="peach" /><h2>No evaluation runs yet</h2><p>Press “Evaluate current setup”. The result is stored and listed here.</p></Card>
  </>;

  const s = run?.summary;
  const kinds = run ? [...new Set(run.questions.map(q => q.kind))] : [];
  const shown = (run?.questions ?? []).filter(q => filter === 'all' ? true : filter === 'missed' ? !q.abstain && q.rank !== 1 : q.kind === filter);
  const selected = run?.questions.find(q => q.id === selectedId) ?? null;
  const graded = s?.all.questions ?? 0;
  const firstHits = run ? run.questions.filter(q => !q.abstain && q.rank === 1).length : 0;

  return <>
    <Heading title="Evaluations" subtitle={run ? `Run #${run.meta.run_id} · ${run.meta.documents} documents · ${run.meta.chunks} chunks · ${run.meta.questions_file} @ ${run.meta.questions_sha256}` : 'Retrieval quality on the evaluation set'} />
    {runner}

    <div className="eval-pickers">
      <label className="eval-run-select"><span>Run</span>
        <select value={runId ?? ''} onChange={e => setRunId(e.target.value ? Number(e.target.value) : null)} aria-label="Evaluation run">
          {list?.map(e => <option key={e.run_id} value={e.run_id}>{runName(e)} · {shortTime(e.created_at)}</option>)}
        </select><ChevronDown size={14} /></label>
      <button className="text-button" onClick={openCompare}>두 설정 비교는 비교 페이지에서 <ArrowLeftRight size={13} /></button>
    </div>
    {error && <p className="source-error queue-problems">{error}</p>}

    {run && s ? <>
      <div className="eval-metrics">
        <MetricCard icon={Check} color="lime" label="Recall@1" value={pct(s.all['recall@1'])} note={`${firstHits} of ${graded} · ${Object.entries(s.by_kind).map(([k, v]) => `${k} ${pct(v['recall@1'])}`).join(' · ')}`} delay={0} />
        <MetricCard icon={Layers3} color="blue" label="Recall@3 · @5" value={`${pct(s.all['recall@3'])} · ${pct(s.all['recall@5'])}`} note="Evidence anywhere in the top 3 / 5" delay={0.05} />
        <MetricCard icon={ChartNoAxesCombined} color="purple" label="MRR" value={s.all.mrr?.toFixed(2) ?? '—'} note="Mean of 1 / rank of first evidence" delay={0.1} />
        <MetricCard icon={Clock3} color="neutral" label="Latency" value={`${Math.round(s.latency_ms.mean)} ms`} note={`p95 ${Math.round(s.latency_ms.p95)} ms · embed + DB`} delay={0.15} />
        <ScoreStrip run={run} selected={selectedId} select={setSelectedId} />
      </div>
      {s.answer && <AnswerSummaryCard a={s.answer} />}

      <div className="eval-workspace">
        <Card className="eval-list" delay={0.2}>
          <div className="eval-filters" role="tablist" aria-label="Filter questions">
            {[{ id: 'all', label: `All ${run.questions.length}` },
              ...kinds.map(k => ({ id: k, label: `${k} ${run.questions.filter(q => q.kind === k).length}` })),
              { id: 'missed', label: `Not #1 ${run.questions.filter(q => !q.abstain && q.rank !== 1).length}` }].map(f =>
              <button key={f.id} role="tab" aria-selected={filter === f.id} className={`eval-filter ${filter === f.id ? 'is-active' : ''}`} onClick={() => setFilter(f.id)}>{f.label}</button>)}
          </div>
          <div className="eval-questions">
            {shown.map(q => { const o = evalOutcome(q); return <button key={q.id} className={`eval-q ${selectedId === q.id ? 'is-selected' : ''}`} onClick={() => setSelectedId(q.id)} aria-pressed={selectedId === q.id}>
              <span className="eval-id">{q.id}</span>
              <span className="eval-q-text"><b>{q.question}</b><small>{q.kind} · top-1 {q.top1_score?.toFixed(3)}</small></span>
              <span className={`pill ${o.tone}`}>{o.label}</span>
            </button>; })}
            {!shown.length && <div className="empty-state compact"><p>No questions in this filter.</p></div>}
          </div>
          <div className="eval-list-foot"><span>{run.meta.questions_file}</span><span>sha {run.meta.questions_sha256}</span></div>
        </Card>
        <EvalMap run={run} selected={selected} select={setSelectedId} focusChunk={focusChunk} setFocusChunk={setFocusChunk} />
        <EvalDetail q={selected} run={run} setFocusChunk={setFocusChunk} />
      </div>
    </> : !error && <Card className="empty-state compact"><p>Loading evaluation…</p></Card>}
  </>;
}
