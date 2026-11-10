// 비교: 설정 두 개(A·B)를 고르고, 같은 질문지로 함께 평가하고, 결과를 쉬운 말로 나란히 본다.
// 화면 나누기: 설정 카드 = Hybrid(최소 폭 + 남는 폭 나눔), 실행 줄 = Fixed, 결과 요약·질문별 표 = Fluid.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronRight, CircleAlert, LoaderCircle, Play, RefreshCw } from 'lucide-react';
import { api, Card, ease, Heading, shortTime } from './ui';
import { defaults, settingKey, useCatalog, useSetup, type Catalog, type Estimate, type IndexInfo, type StageSetting } from './setup';
import type { EvalEntry, EvalJob, EvalQuestion, EvalRun } from './evaluations';

type Side = 'A' | 'B';
type Pick = { chunker: StageSetting; embedder: StageSetting; reranker?: StageSetting | null };
type Option = { key: string; setting: StageSetting; label: string; external: boolean; available: boolean; reason: string };

const STORE = 'compare-ab';
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const pickKey = (p: Pick) => `${settingKey(p.chunker)}|${settingKey(p.embedder)}`;
// 리랭크는 색인이 아니라 검색 설정이라, 같은 색인으로 "끔 vs 켬"을 비교할 수 있다.
const rerankKey = (r?: StageSetting | null) => (r ? settingKey(r) : 'off');
const sameIndex = (i: IndexInfo, p: Pick) => settingKey(i.chunker) === settingKey(p.chunker) && settingKey(i.embedder) === settingKey(p.embedder);

// 몇 문제 차이까지 "비슷해요"로 볼지. 답 있는 질문이 10개면 한 문제가 10%p라, 두 문제 이하 차이는 우연일 수 있다.
const CLOSE = 2;

// ---------- 화면에 보이는 이름 ----------

function optionLabel(stage: 'chunker' | 'embedder' | 'reranker', s: StageSetting, catalog: Catalog | null): string {
  if (stage === 'reranker' && s.id === 'tei-bge-reranker') return `bge-reranker · 후보 ${s.params.candidates}개`;
  if (stage === 'chunker' && s.id === 'heading') return s.params.prefix === 'none' ? '제목 단위 · 절만' : '제목 단위 · 경로 붙임';
  if (stage === 'embedder' && s.id === 'tei-bge-m3') return 'bge-m3';
  if (stage === 'embedder' && s.id === 'openai') {
    const model = (s.params.model ?? '').replace('text-embedding-3-', '');
    const dims = s.params.dimensions && s.params.dimensions !== 'default' ? ` · ${s.params.dimensions}차원` : '';
    return `OpenAI ${model}${dims}`;
  }
  const spec = catalog?.[stage].find(x => x.id === s.id);
  return [spec?.label ?? s.id, ...Object.values(s.params)].join(' · ');
}

// 고를 수 있는 값: 구현마다 첫 번째 파라미터의 선택지를 펼치고(나머지는 기본값), 이미 만든 색인의 값도 넣는다.
function optionsFor(stage: 'chunker' | 'embedder' | 'reranker', catalog: Catalog | null, indexes: IndexInfo[]): Option[] {
  const out = new Map<string, Option>();
  const add = (setting: StageSetting) => {
    const key = settingKey(setting);
    if (out.has(key)) return;
    const spec = catalog?.[stage].find(x => x.id === setting.id);
    out.set(key, { key, setting, label: optionLabel(stage, setting, catalog), external: !!spec?.external,
      available: !spec || spec.available, reason: spec?.reason ?? '' });
  };
  for (const spec of catalog?.[stage] ?? []) {
    if (spec.status !== 'ready') continue;
    const base = defaults(spec);
    const first = spec.params[0];
    if (!first) add({ id: spec.id, params: base });
    else for (const [value] of first.choices) add({ id: spec.id, params: { ...base, [first.name]: value } });
  }
  if (stage !== 'reranker') for (const i of indexes) add(stage === 'chunker' ? i.chunker : i.embedder);
  return [...out.values()];
}

// ---------- 결과 계산 ----------

type Stats = { top1: number; top3: number; graded: number; latency: number };
const statsOf = (run: EvalRun): Stats => {
  const graded = run.questions.filter(q => !q.abstain);
  return { graded: graded.length, top1: graded.filter(q => q.rank === 1).length,
    top3: graded.filter(q => q.rank != null && q.rank <= 3).length, latency: run.summary.latency_ms.mean };
};
const rankOf = (q?: EvalQuestion) => q?.rank ?? Infinity;

// 판정: 1등으로 찾은 수를 먼저 보고, 비슷하면 3등 안에 찾은 수를 본다. 둘 다 CLOSE 이하 차이면 비슷하다.
function verdict(a: Stats, b: Stats): 'same' | Side {
  const d1 = b.top1 - a.top1, d3 = b.top3 - a.top3;
  if (Math.abs(d1) > CLOSE) return d1 > 0 ? 'B' : 'A';
  if (Math.abs(d3) > CLOSE) return d3 > 0 ? 'B' : 'A';
  return 'same';
}

function verdictLines(a: Stats, b: Stats): string[] {
  const lines: string[] = [];
  const d1 = b.top1 - a.top1, d3 = b.top3 - a.top3;
  lines.push(d1 === 0 ? '1등으로 찾은 질문 수는 같아요.' : `1등으로 찾은 질문은 ${d1 > 0 ? 'B' : 'A'}가 ${Math.abs(d1)}개 더 많아요.`);
  if (d3 !== 0) lines.push(`3등 안에 찾은 질문은 ${d3 > 0 ? 'B' : 'A'}가 ${Math.abs(d3)}개 더 많아요.`);
  const fast = Math.abs(a.latency - b.latency) >= 30 ? (a.latency < b.latency ? 'A' : 'B') : null;
  const times = Math.max(a.latency, b.latency) / Math.max(1, Math.min(a.latency, b.latency));
  lines.push(!fast ? '찾는 시간은 비슷해요.' : times >= 3 ? `${fast}가 약 ${Math.round(times)}배 빨라요.` : `${fast}가 조금 더 빨라요.`);
  return lines;
}

// ---------- 데이터 ----------

// 작업 몇 개를 1초마다 따라간다. 모두 끝나면 onDone.
function useJobs(onDone: () => void) {
  const [jobs, setJobs] = useState<EvalJob[]>([]);
  const done = useRef(onDone);
  done.current = onDone;
  const active = jobs.some(j => j.status === 'queued' || j.status === 'running');
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      Promise.all(jobs.map(j => api<EvalJob>(`/jobs/${j.id}`))).then(next => {
        setJobs(next);
        if (!next.some(j => j.status === 'queued' || j.status === 'running')) done.current();
      }).catch(() => undefined);
    }, 1000);
    return () => clearInterval(timer);
  }, [active, jobs.map(j => j.id).join(',')]);
  const follow = (ids: number[]) => setJobs(ids.map(id => ({ id, status: 'queued', progress_done: null, progress_total: null, error: null, result: null })));
  return { jobs, active, follow, failed: jobs.filter(j => j.status === 'failed') };
}

function loadPicks(): Partial<Record<Side, Pick>> {
  try { return JSON.parse(localStorage.getItem(STORE) ?? '{}'); } catch { return {}; }
}

// ---------- 설정 카드 (A·B) ----------

function SetupCard({ side, pick, setPick, catalog, indexes, lastRun, reload, locked }: {
  side: Side; pick: Pick; setPick: (p: Pick) => void; catalog: Catalog | null; indexes: IndexInfo[];
  lastRun?: EvalEntry; reload: () => Promise<void>; locked: boolean;
}) {
  const chunkers = useMemo(() => optionsFor('chunker', catalog, indexes), [catalog, indexes]);
  const embedders = useMemo(() => optionsFor('embedder', catalog, indexes), [catalog, indexes]);
  const rerankers = useMemo(() => optionsFor('reranker', catalog, indexes), [catalog, indexes]);
  const reranker = rerankers.find(o => o.key === rerankKey(pick.reranker));
  const embedder = embedders.find(o => o.key === settingKey(pick.embedder));
  const external = embedder?.external ?? false;
  const index = indexes.find(i => sameIndex(i, pick));
  const ready = !!index && index.chunks > 0 && index.pending === 0;
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [error, setError] = useState('');
  const build = useJobs(() => { void reload(); });

  // 색인이 없을 때만 "만들면 얼마나" 미리보기를 묻는다.
  useEffect(() => {
    setEstimate(null); setError('');
    if (index) return;
    let live = true;
    api<Estimate>('/indexes/estimate', { method: 'POST', body: { ...pick, apply: false } })
      .then(e => { if (live) setEstimate(e); }).catch(e => { if (live) setError(message(e)); });
    return () => { live = false; };
  }, [pickKey(pick), !!index]);

  async function make() {
    setError('');
    try {
      const r = index && index.pending > 0
        ? await api<{ jobs: { job_id: number }[] }>(`/indexes/${index.id}/refresh`, { method: 'POST' })
        : await api<{ jobs: { job_id: number }[] }>('/indexes', { method: 'POST', body: { ...pick, apply: false } });
      build.follow(r.jobs.map(j => j.job_id));
      await reload();
    } catch (e) { setError(message(e)); }
  }

  const doneDocs = build.jobs.filter(j => j.status === 'done').length;
  const select = (stage: 'chunker' | 'embedder', list: Option[]) => (
    <select className="cmp-select" disabled={locked || build.active} value={settingKey(pick[stage])}
      onChange={e => { const o = list.find(x => x.key === e.target.value); if (o) setPick({ ...pick, [stage]: o.setting }); }}>
      {list.map(o => <option key={o.key} value={o.key} disabled={!o.available}>{o.label}{o.external ? ' (외부)' : ''}{o.available ? '' : ` · ${o.reason || '쓸 수 없음'}`}</option>)}
    </select>);

  let status: React.ReactNode;
  if (build.active) status = <div className="cmp-status is-busy"><LoaderCircle size={14} className="spin" />만드는 중 · 문서 {doneDocs} / {build.jobs.length}
    <span className="progress-track"><motion.span animate={{ width: `${(doneDocs / Math.max(1, build.jobs.length)) * 100}%` }} transition={{ duration: 0.5, ease }} /></span></div>;
  else if (ready) status = <div className="cmp-status is-ready"><i />준비됨 · 문서 {index.documents}개 · 조각 {index.chunks}개
    {lastRun && <small>평가 #{lastRun.run_id} · {shortTime(lastRun.created_at)}</small>}</div>;
  else if (index && index.pending > 0) status = <div className="cmp-status is-todo">문서 {index.pending}개가 뒤처졌어요
    <button className="cmp-mini" disabled={locked} onClick={make}><RefreshCw size={12} />갱신</button></div>;
  else if (estimate) status = <div className="cmp-status is-todo">
    {estimate.can_build ? <>아직 없어요 · 문서 {estimate.documents_total}개 · 조각 약 {estimate.chunks_pending}개</>
      : <>만들 수 없어요 · {estimate.reason || (estimate.blocked.length ? `외부 전송이 허용되지 않은 문서 ${estimate.blocked.length}개` : '조건을 확인하세요')}</>}
    {estimate.can_build && <button className="cmp-mini" disabled={locked} onClick={make}>만들기</button>}</div>;
  else status = <div className="cmp-status">{error ? '' : '확인하는 중…'}</div>;

  return <Card className="cmp-setup">
    <div className="cmp-setup-head"><span className={`cmp-tag is-${side}`}>{side}</span>
      <b>{embedder?.label ?? '설정'}{pick.reranker ? ' + 리랭크' : ''}</b><span className={`cmp-where ${external ? 'is-external' : ''}`}>{external ? '외부 전송' : '내 컴퓨터'}</span></div>
    <label className="cmp-field"><span>나누기</span>{select('chunker', chunkers)}</label>
    <label className="cmp-field"><span>임베딩</span>{select('embedder', embedders)}</label>
    <label className="cmp-field"><span>리랭크</span>
      <select className="cmp-select" disabled={locked || build.active} value={rerankKey(pick.reranker)}
        onChange={e => setPick({ ...pick, reranker: rerankers.find(x => x.key === e.target.value)?.setting ?? null })}>
        <option value="off">끔</option>
        {rerankers.map(o => <option key={o.key} value={o.key} disabled={!o.available}>{o.label}{o.available ? '' : ` · ${o.reason || '쓸 수 없음'}`}</option>)}
      </select></label>
    {status}
    {reranker && <p className="cmp-note">리랭크는 이 컴퓨터(CPU)에서 조각 1개에 약 3초라, 평가가 질문당 {Math.round(Number(pick.reranker?.params.candidates ?? 0) * 3.4 / 60)}분쯤 걸려요.</p>}
    {build.failed.length > 0 && <p className="cmp-error">문서 {build.failed.length}개를 만들지 못했어요: {build.failed[0].error}</p>}
    {error && <p className="cmp-error">{error}</p>}
    <p className={`cmp-send ${external ? 'is-external' : ''}`}>{external ? `↗ 평가할 때 질문이 ${embedder?.label.split(' ')[0]}로 보내져요` : '✓ 질문과 문서가 밖으로 나가지 않아요'}</p>
  </Card>;
}

// ---------- 결과 ----------

function Bars({ title, a, b, fmt, note, max }: { title: string; a: number; b: number; fmt: (v: number) => string; note: string; max: number }) {
  return <div className="cmp-stat"><h3>{title}</h3>
    {([['A', a], ['B', b]] as const).map(([t, v]) => <div className="cmp-bar-row" key={t}><span className={`cmp-tag is-${t} is-small`}>{t}</span>
      <span className="cmp-bar"><motion.i className={`is-${t}`} initial={{ width: 0 }} animate={{ width: `${max ? (v / max) * 100 : 0}%` }} transition={{ duration: 0.6, ease }} /></span><b>{fmt(v)}</b></div>)}
    <small>{note}</small></div>;
}

function Summary({ a, b }: { a: EvalRun; b: EvalRun }) {
  const sa = statsOf(a), sb = statsOf(b);
  const v = verdict(sa, sb);
  const qb = new Map(b.questions.map(q => [q.id, q]));
  const graded = a.questions.filter(q => !q.abstain && qb.has(q.id));
  const bBetter = graded.filter(q => rankOf(qb.get(q.id)) < rankOf(q)).length;
  const aBetter = graded.filter(q => rankOf(q) < rankOf(qb.get(q.id))).length;
  const abstain = a.questions.filter(q => q.abstain).length;
  return <Card className="cmp-summary">
    <div className="cmp-verdict"><small>결과</small><h2>{v === 'same' ? '비슷해요' : `${v}가 더 잘 찾아요`}</h2>
      <p>{verdictLines(sa, sb).map(l => <React.Fragment key={l}>{l}<br /></React.Fragment>)}</p>
      <p className="cmp-why">답이 있는 질문이 {sa.graded}개라 한 문제 차이가 {Math.round(100 / Math.max(1, sa.graded))}%p예요. {CLOSE}문제 이하 차이는 우연일 수 있어서 "비슷해요"로 보여 줘요.</p></div>
    <div className="cmp-stats">
      <Bars title="1등으로 찾은 질문" a={sa.top1} b={sb.top1} max={sa.graded} fmt={n => `${n} / ${sa.graded}`} note="가장 중요한 숫자예요" />
      <Bars title="3등 안에 찾은 질문" a={sa.top3} b={sb.top3} max={sa.graded} fmt={n => `${n} / ${sa.graded}`} note="답변 모델에 조각 3개를 넘길 때 기준" />
      <Bars title="질문 하나 찾는 시간" a={sa.latency} b={sb.latency} max={Math.max(sa.latency, sb.latency)} fmt={n => `${(n / 1000).toFixed(2)}초`} note="짧을수록 좋아요 · 1회 측정" />
      <div className="cmp-moves">
        <span><b className="is-B">{bBetter}</b>B가 더 잘 찾은 질문</span>
        <span><b className="is-A">{aBetter}</b>A가 더 잘 찾은 질문</span>
        <span><b>{graded.length - aBetter - bBetter}</b>같은 순위</span>
        <span><b>{abstain}</b>답 없는 질문 (보류 기준 아직 없음)</span>
      </div>
    </div>
  </Card>;
}

function RankPill({ q, side }: { q?: EvalQuestion; side: Side }) {
  if (!q || q.abstain) return <span className="cmp-rank is-none" data-side={side}>—</span>;
  // 리랭크한 결과면 리랭크 전(벡터 검색) 순위를 작게 함께 보여 준다.
  const before = q.rank_vector !== undefined && q.rank_vector !== q.rank
    ? <small className="cmp-rank-before">{q.rank_vector == null ? '원래 후보 밖' : `원래 ${q.rank_vector}등`}</small> : null;
  if (q.rank == null) return <span className="cmp-rank is-none" data-side={side}>못 찾음{before}</span>;
  return <span className={`cmp-rank ${q.rank === 1 ? 'is-1' : q.rank <= 3 ? 'is-3' : 'is-low'}`} data-side={side}>{q.rank}등{before}</span>;
}

function Hits({ run, q, side }: { run: EvalRun; q: EvalQuestion; side: Side }) {
  const chunks = new Map(run.chunks.map(c => [c.id, c]));
  return <div><h4><span className={`cmp-tag is-${side} is-small`}>{side}</span>찾은 조각</h4>
    {q.retrieved.slice(0, 3).map((h, i) => { const c = chunks.get(h.chunk_id); return <div key={h.chunk_id} className={`cmp-hit ${h.correct ? 'is-ok' : ''}`}>
      <span className="cmp-hit-n">{i + 1}</span>
      <div><div>{c?.heading || '(제목만 있는 조각)'}{h.correct && <em>✓ 정답</em>}</div><small>{c?.title}</small></div>
      <span className="cmp-hit-s">{h.score.toFixed(2)}{h.vector_rank !== undefined && h.vector_rank !== i + 1 && <small>원래 {h.vector_rank}등</small>}</span></div>; })}</div>;
}

function Questions({ a, b }: { a: EvalRun; b: EvalRun }) {
  const qb = new Map(b.questions.map(q => [q.id, q]));
  const changed = (q: EvalQuestion) => !q.abstain && rankOf(q) !== rankOf(qb.get(q.id));
  const counts = { changed: a.questions.filter(changed).length, all: a.questions.length, abstain: a.questions.filter(q => q.abstain).length };
  const [filter, setFilter] = useState<keyof typeof counts>(counts.changed ? 'changed' : 'all');
  const [open, setOpen] = useState<string | null>(null);
  const rows = a.questions.filter(q => filter === 'all' || (filter === 'abstain' ? q.abstain : changed(q)));
  const labels = { changed: '달라진 질문', all: '전체', abstain: '답 없는 질문' };

  return <Card className="cmp-questions">
    <div className="cmp-q-head"><h2>질문별로 보기</h2>
      {(Object.keys(labels) as (keyof typeof counts)[]).map(k => <button key={k} className={`cmp-chip ${filter === k ? 'is-on' : ''}`} onClick={() => setFilter(k)}>{labels[k]} {counts[k]}</button>)}
      <span className="cmp-legend">순위 = 정답 조각을 몇 번째로 찾았는지 · 줄을 누르면 A·B가 찾은 조각을 나란히 봐요</span></div>
    <div className="cmp-table" role="table">
      <div className="cmp-row is-head" role="row"><span /><span>질문</span><span>A</span><span>B</span><span>더 잘 찾은 쪽</span></div>
      {rows.map(q => {
        const other = qb.get(q.id);
        const win = q.abstain ? '답 없는 질문' : rankOf(q) === rankOf(other) ? '같음' : rankOf(q) < rankOf(other) ? 'A' : 'B';
        const isOpen = open === q.id;
        return <React.Fragment key={q.id}>
          <button className={`cmp-row ${isOpen ? 'is-open' : ''}`} role="row" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : q.id)}>
            <span className="cmp-qid">{q.id}</span>
            <span className="cmp-qtext">{q.question}<small>{q.kind}</small></span>
            <RankPill q={q} side="A" /><RankPill q={other} side="B" />
            <span className={`cmp-win ${win === 'A' || win === 'B' ? `is-${win}` : ''}`}>{win === 'A' || win === 'B' ? `${win} ↑` : win}<ChevronRight size={14} className="cmp-caret" /></span>
          </button>
          <AnimatePresence initial={false}>{isOpen && <motion.div className="cmp-detail" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.25, ease }}>
            <p className="cmp-answer">{q.abstain ? '문서에 답이 없는 질문이에요. 지금은 둘 다 무언가를 찾아오고, 답변을 보류하는 기준은 아직 없어요.'
              : <>정답: {q.answer}{q.evidence[0]?.quote && <><br /><q>{q.evidence[0].quote}</q> <small>{q.evidence[0].path}</small></>}</>}</p>
            <div className="cmp-hits"><Hits run={a} q={q} side="A" />{other && <Hits run={b} q={other} side="B" />}</div>
          </motion.div>}</AnimatePresence>
        </React.Fragment>;
      })}
      {!rows.length && <p className="cmp-empty">이 조건에 맞는 질문이 없어요.</p>}
    </div>
  </Card>;
}

// ---------- 페이지 ----------

export function Compare() {
  const { catalog } = useCatalog();
  const { indexes, reload } = useSetup();
  const [picks, setPicks] = useState<Partial<Record<Side, Pick>>>(loadPicks);
  const [evals, setEvals] = useState<EvalEntry[] | null>(null);
  const [runs, setRuns] = useState<Record<number, EvalRun>>({});
  const [error, setError] = useState('');

  const reloadEvals = () => api<EvalEntry[]>('/evals').then(setEvals).catch(e => setError(message(e)));
  useEffect(() => { void reloadEvals(); }, []);
  const evalJobs = useJobs(() => { void reloadEvals(); });

  // 처음 열면: A는 기본 색인(★), B는 다른 색인 중 가장 최근 것.
  useEffect(() => {
    if (!indexes.length || (picks.A && picks.B)) return;
    const base = indexes.find(i => i.is_base) ?? indexes[0];
    const other = [...indexes].reverse().find(i => i.id !== base.id) ?? base;
    setPicks(p => ({ A: p.A ?? { chunker: base.chunker, embedder: base.embedder }, B: p.B ?? { chunker: other.chunker, embedder: other.embedder } }));
  }, [indexes]);
  useEffect(() => { try { localStorage.setItem(STORE, JSON.stringify(picks)); } catch { /* storage unavailable */ } }, [picks]);

  const idx = (s: Side) => { const p = picks[s]; return p ? indexes.find(i => sameIndex(i, p)) : undefined; };
  const ia = idx('A'), ib = idx('B');
  // 그 색인과 같은 리랭크 설정으로 돈 가장 최근 평가. 리랭크 기록이 없는 예전 평가는 "끔"으로 본다.
  const lastRunOf = (s: Side) => {
    const i = idx(s);
    return i ? evals?.find(e => e.setup.index.id === i.id && rerankKey(e.setup.query.reranker) === rerankKey(picks[s]?.reranker)) : undefined;
  };
  const ra = lastRunOf('A'), rb = lastRunOf('B');
  useEffect(() => {
    for (const r of [ra, rb]) if (r && !runs[r.run_id]) api<EvalRun>(`/evals/${r.run_id}`).then(x => setRuns(m => ({ ...m, [r.run_id]: x }))).catch(e => setError(message(e)));
  }, [ra?.run_id, rb?.run_id]);

  const ready = (i?: IndexInfo) => !!i && i.chunks > 0 && i.pending === 0;
  const same = ia && ib && ia.id === ib.id && rerankKey(picks.A?.reranker) === rerankKey(picks.B?.reranker);
  const canRun = ready(ia) && ready(ib) && !same && !evalJobs.active;

  async function runBoth() {
    setError('');
    try {
      const r = await api<{ job_ids: number[] }>('/evals', { method: 'POST', body: { label: '비교', sides: (['A', 'B'] as const).map(s => ({ index_id: idx(s)!.id, reranker: picks[s]?.reranker ?? 'off' })) } });
      evalJobs.follow(r.job_ids);
    } catch (e) { setError(message(e)); }
  }

  const a = ra ? runs[ra.run_id] : undefined, b = rb ? runs[rb.run_id] : undefined;
  const sameSheet = !ra || !rb || ra.questions_sha256 === rb.questions_sha256;
  const progress = evalJobs.jobs.map((j, n) => `${n ? 'B' : 'A'} ${j.status === 'done' ? '끝' : j.status === 'queued' ? '대기' : j.status === 'failed' ? '실패' : `${j.progress_done ?? 0}/${j.progress_total ?? '?'}`}`).join(' · ');

  return <>
    <Heading title="비교" subtitle="두 설정을 같은 질문지로 시험해서, 어느 쪽이 정답 조각을 더 잘 찾는지 봐요." />
    <div className="cmp-setups">
      {(['A', 'B'] as const).map(s => picks[s]
        ? <SetupCard key={s} side={s} pick={picks[s]!} setPick={p => setPicks(x => ({ ...x, [s]: p }))} catalog={catalog} indexes={indexes}
            lastRun={lastRunOf(s)} reload={reload} locked={evalJobs.active} />
        : <Card key={s} className="cmp-setup"><p className="muted">불러오는 중…</p></Card>)}
      <span className="cmp-vs">vs</span>
    </div>

    <div className="cmp-runbar">
      <button className="primary-button cmp-run" disabled={!canRun} onClick={runBoth}>
        {evalJobs.active ? <LoaderCircle size={15} className="spin" /> : <Play size={15} />}{evalJobs.active ? '평가하는 중…' : '두 설정으로 평가하기'}</button>
      <small>{evalJobs.active ? progress : same ? 'A와 B가 같은 설정이에요. 하나를 바꿔 주세요.'
        : !ready(ia) || !ready(ib) ? '준비 안 된 쪽을 먼저 만들어 주세요 (카드 안 [만들기]).'
        : '같은 질문지로 A와 B를 차례로 시험해요. 결과는 아래에 바로 바뀌어요.'}</small>
    </div>
    {(error || evalJobs.failed.length > 0) && <p className="cmp-error is-page"><CircleAlert size={13} />{error || `평가 실패: ${evalJobs.failed[0].error}`}</p>}

    {a && b && !same ? <>
      {!sameSheet && <p className="cmp-error is-page"><CircleAlert size={13} />A와 B의 마지막 평가가 서로 다른 질문지로 돌았어요. [두 설정으로 평가하기]를 다시 눌러 주세요.</p>}
      <Summary a={a} b={b} />
      <Questions a={a} b={b} />
    </> : <Card className="cmp-placeholder"><p>{same ? '' : !ra || !rb ? '아직 이 조합으로 평가한 기록이 없어요. 두 설정이 준비되면 [두 설정으로 평가하기]를 눌러 주세요.' : '결과를 불러오는 중…'}</p></Card>}
    <div className="cmp-foot"><span>질문지 eval/questions.jsonl · 각 설정의 가장 최근 평가를 보여 줘요</span><span>임베딩 지도, 점수 분포 같은 자세한 기록은 Evaluations에서</span></div>
  </>;
}
