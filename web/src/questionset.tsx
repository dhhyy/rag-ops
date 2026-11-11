// Evaluations › 시험지: 평가 질문(eval/questions.jsonl)과 자동 점검 결과. 1단계라 읽기만 한다.
// 화면 나누기: 제목·요약 줄 = Fixed, 본문 = Hybrid (왼쪽 문서별·질문 목록 Fluid + 오른쪽 상세 420px Fixed).
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CircleAlert, CircleCheck, RefreshCw, Search, TriangleAlert } from 'lucide-react';
import { api, Card, Heading } from './ui';

type Level = 'error' | 'warn';
type Check = { level: Level; code: string; message: string; evidence: number | null };
type Evidence = { path: string; heading?: string; quote?: string; in_document: boolean | null; chunk_ids: number[]; elsewhere: string[] };
type Question = {
  id: string; kind: string; question: string; answer?: string; env?: string; abstain: boolean; use: string;
  evidence: Evidence[]; checks: Check[];
};
type DocCover = { path: string; title: string; chunks: number; covered: number; questions: number; empty_chunks: number };
type QuestionSetData = {
  sha: string; path: string; target: number;
  index: { id: number; chunks: number; label: { chunker: string; embedder: string } };
  summary: { questions: number; kinds: Record<string, number>; uses: Record<string, number>; evidence: number; covered_chunks: number; errors: number; warnings: number; flagged: number };
  last_eval: { id: number; sha: string | null; created_at: string; same_set: boolean } | null;
  documents: DocCover[]; questions: Question[];
};
type Filter = 'all' | '직접' | '표현 바꿈' | '답 없음' | 'final' | 'flagged';

const KIND_TONE: Record<string, string> = { '직접': 'direct', '표현 바꿈': 'para', '답 없음': 'none' };
const KIND_COLOR: Record<string, string> = { '직접': '#dfe88a', '표현 바꿈': '#b5c6f8', '답 없음': '#f6c3a3' };
const file = (p: string) => p.split('/').pop() ?? p;
const worst = (q: Question): Level | null => q.checks.some(c => c.level === 'error') ? 'error' : q.checks.length ? 'warn' : null;

export function QuestionSet({ tabs }: { tabs: React.ReactNode }) {
  const [data, setData] = useState<QuestionSetData | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const detail = useRef<HTMLDivElement>(null);
  // 좁은 화면에서는 상세가 목록 아래에 있어서, 고르면 그쪽으로 내려 준다.
  function choose(id: string) {
    setSelectedId(id);
    if (window.innerWidth <= 1200) requestAnimationFrame(() => detail.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }

  async function load() {
    setLoading(true);
    try { const d = await api<QuestionSetData>('/questions'); setData(d); setError(''); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    setLoading(false);
  }
  useEffect(() => { void load(); }, []);

  const shown = useMemo(() => {
    const words = query.trim().toLowerCase();
    return (data?.questions ?? []).filter(q =>
      (filter === 'all' || (filter === 'final' ? q.use === '최종 평가용' : filter === 'flagged' ? q.checks.length > 0 : q.kind === filter))
      && (!words || `${q.id} ${q.question} ${q.answer ?? ''} ${q.evidence.map(e => `${e.path} ${e.quote ?? ''}`).join(' ')}`.toLowerCase().includes(words)));
  }, [data, filter, query]);
  useEffect(() => { if (data && !data.questions.some(q => q.id === selectedId)) setSelectedId(data.questions[0]?.id ?? null); }, [data]);
  const selected = data?.questions.find(q => q.id === selectedId) ?? null;

  const head = <Heading title="Evaluations" subtitle={data ? `평가에 쓰는 질문과 정답 근거 · ${data.path} @ ${data.sha}` : '평가에 쓰는 질문과 정답 근거'}>
    {tabs}
    <button className="qs-btn" onClick={() => void load()} disabled={loading} aria-label="다시 점검"><RefreshCw size={14} className={loading ? 'spin' : ''} />다시 점검</button>
  </Heading>;

  if (!data) return <>{head}{error ? <p className="source-error">{error}</p> : <p className="muted">불러오는 중…</p>}</>;
  const s = data.summary;
  const counts: [Filter, string, number][] = [
    ['all', '전체', s.questions], ['직접', '직접', s.kinds['직접'] ?? 0], ['표현 바꿈', '표현 바꿈', s.kinds['표현 바꿈'] ?? 0],
    ['답 없음', '답 없음', s.kinds['답 없음'] ?? 0], ['final', '최종 평가용', s.uses['최종 평가용'] ?? 0], ['flagged', '문제 있음', s.flagged],
  ];

  return <>
    {head}
    {error && <p className="source-error">{error}</p>}
    {data.last_eval && !data.last_eval.same_set && <p className="qs-banner"><CircleAlert size={14} />마지막 평가(#{data.last_eval.id}) 뒤에 시험지가 바뀌었어요. 기준점을 다시 잡으려면 평가 기록 탭에서 평가를 다시 돌려 주세요.</p>}

    {/* 요약 줄 (Fixed) */}
    <section className="qs-sum">
      <Card className="qs-tile" delay={0.02}><small>질문 수 · 목표 {data.target} (제안)</small><b>{s.questions}<small> / {data.target}</small></b>
        <span className="qs-goal"><i style={{ width: `${Math.min(100, (s.questions / data.target) * 100)}%` }} /></span></Card>
      <Card className="qs-tile" delay={0.05}><small>질문 종류</small>
        <span className="qs-bar">{Object.entries(s.kinds).map(([k, n]) => <i key={k} style={{ width: `${(n / Math.max(1, s.questions)) * 100}%`, background: KIND_COLOR[k] }} />)}</span>
        <span className="qs-legend">{Object.entries(s.kinds).map(([k, n]) => <span key={k}><i style={{ background: KIND_COLOR[k] }} />{k} {n}</span>)}</span></Card>
      <Card className="qs-tile" delay={0.08}><small>용도</small><b>{s.uses['개선용'] ?? 0} · {s.uses['최종 평가용'] ?? 0}</b><small>개선용 · 최종 평가용</small></Card>
      <Card className="qs-tile" delay={0.11}><small>근거가 닿은 조각</small><b>{s.covered_chunks}<small> / {data.index.chunks} 조각</small></b>
        <small>{Math.round((s.covered_chunks / Math.max(1, data.index.chunks)) * 100)}% · 현재 색인 기준</small></Card>
      <Card className="qs-tile" delay={0.14}><small>자동 점검</small>
        {s.errors || s.warnings
          ? <b className={s.errors ? 'qs-bad' : 'qs-warn'}>{s.errors ? `오류 ${s.errors}` : ''}{s.errors && s.warnings ? ' · ' : ''}{s.warnings ? `경고 ${s.warnings}` : ''}</b>
          : <b className="qs-good">문제 없음</b>}
        <small>근거 {s.evidence}개 · {s.errors ? '오류가 있으면 채점이 틀어져요' : '모두 원문·조각에서 찾음'}</small></Card>
    </section>

    {/* 본문 (Hybrid) */}
    <section className="qs-body">
      <div className="qs-left">
        <Card className="qs-card" delay={0.16}>
          <div className="qs-card-head"><h2>문서별로 고른가</h2><small>근거가 닿은 조각 / 전체 조각 · 질문이 적은 문서가 위</small></div>
          <div className="qs-cover">{data.documents.map(d => <React.Fragment key={d.path}>
            <span className={d.questions === 0 ? 'qs-low' : ''} title={`${d.path} · ${d.title}`}>{d.path.includes('/') && <em className="qs-dir">{d.path.slice(0, d.path.lastIndexOf('/') + 1)}</em>}{file(d.path)}</span>
            <span className="qs-goal"><i style={{ width: `${d.chunks ? (d.covered / d.chunks) * 100 : 0}%` }} /></span>
            <small className={d.questions === 0 ? 'qs-low' : ''}>{d.covered} / {d.chunks}</small>
          </React.Fragment>)}</div>
        </Card>

        <Card className="qs-card" delay={0.2}>
          <div className="qs-card-head"><h2>질문 {s.questions}개</h2><small>누르면 오른쪽에 자세히 보여요</small></div>
          <div className="qs-filters">
            {counts.map(([f, label, n]) => <button key={f} className={`qs-chip ${filter === f ? 'is-on' : ''}`} aria-pressed={filter === f} onClick={() => setFilter(f)}>{label} {n}</button>)}
            <label className="qs-search"><Search size={13} /><input aria-label="질문·근거 검색" placeholder="질문·근거 검색" value={query} onChange={e => setQuery(e.target.value)} /></label>
          </div>
          <table className="qs-table">
            <thead><tr><th>질문</th><th className="qs-col-kind">종류</th><th className="qs-col-use">용도</th><th className="qs-col-ev">근거</th><th className="qs-col-st">점검</th></tr></thead>
            <tbody>{shown.map(q => {
              const level = worst(q);
              return <tr key={q.id} className={q.id === selectedId ? 'is-selected' : ''} onClick={() => choose(q.id)} tabIndex={0}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(q.id); } }}>
                <td className="qs-q"><div>{q.id} · {q.question}</div>
                  <small>{q.abstain ? '근거 없음 · 보류가 정답' : q.evidence.length ? `${file(q.evidence[0].path)}${q.evidence.length > 1 ? ` 외 ${q.evidence.length - 1}` : ''}` : '—'}</small></td>
                <td><span className={`qs-pill ${KIND_TONE[q.kind] ?? ''}`}>{q.kind}</span></td>
                <td className="qs-col-use"><span className={`qs-pill ${q.use === '최종 평가용' ? 'final' : ''}`}>{q.use === '최종 평가용' ? '최종' : q.use}</span></td>
                <td className="qs-col-ev">{q.evidence.length || '—'}</td>
                <td><span className={`qs-st ${level ?? 'ok'}`}>{level === 'error' ? `! 오류 ${q.checks.filter(c => c.level === 'error').length}` : level === 'warn' ? `! 경고 ${q.checks.length}` : '✓ 통과'}</span></td>
              </tr>;
            })}</tbody>
          </table>
          {!shown.length && <p className="muted">조건에 맞는 질문이 없어요.</p>}
        </Card>
      </div>

      <div ref={detail} className="qs-detail-wrap"><Card className="qs-card qs-detail" delay={0.22}>
        {selected ? <Detail q={selected} indexLabel={`${data.index.label.chunker} × ${data.index.label.embedder.split(' · ').pop()}`} /> : <p className="muted">질문을 고르세요.</p>}
      </Card></div>
    </section>
  </>;
}

function Detail({ q, indexLabel }: { q: Question; indexLabel: string }) {
  return <>
    <div className="qs-card-head"><h2>{q.id}</h2><small>{q.use} · {q.kind}{q.env ? ` · ${q.env}` : ''}</small></div>
    {q.checks.length > 0 && <div className="qs-checks">{q.checks.map((c, i) => <p key={i} className={`qs-check ${c.level}`}>
      {c.level === 'error' ? <CircleAlert size={13} /> : <TriangleAlert size={13} />}{c.evidence != null ? `근거 ${c.evidence + 1}: ` : ''}{c.message}</p>)}</div>}
    <div className="qs-field"><label>질문</label><p className="qs-input">{q.question}</p></div>
    <div className="qs-field"><label>정답 (채점에는 안 쓰고, 사람이 볼 때와 답변 평가 참고용)</label><p className="qs-input">{q.answer || '—'}</p></div>
    <div className="qs-field"><label>{q.abstain ? '근거 없음 — 문서에 답이 없어서 보류가 정답이에요' : `정답 근거 ${q.evidence.length}개 — 조각에 이 문장이 들어 있으면 정답`}</label>
      {q.evidence.map((e, i) => <div key={i} className="qs-ev">
        <span className="qs-path">{e.path}{e.heading ? ` › ${e.heading}` : ''}</span>
        {e.quote ? <span className="qs-quote">“{e.quote}”</span> : <span className="qs-quote muted">근거 문장 없음 (제목으로 채점)</span>}
        <span className={`qs-ev-state ${e.in_document === false || (e.quote && !e.chunk_ids.length) ? 'bad' : ''}`}>
          {e.in_document === false ? '원문에 없음' : e.in_document == null ? '원문 확인 불가' : <><CircleCheck size={11} />원문에 있음</>}
          {e.quote && e.in_document !== false && (e.chunk_ids.length ? ` · 조각 ${e.chunk_ids.map(c => `#${c}`).join(', ')}에 들어감` : ' · 어느 조각에도 통째로 안 들어감')}
        </span>
        {e.elsewhere.length > 0 && <span className="qs-ev-state warn">같은 문장이 있는 다른 문서: {e.elsewhere.map(file).join(', ')}</span>}
      </div>)}
    </div>
    <p className="qs-note">조각 번호는 현재 색인({indexLabel}) 기준이에요. 고치기는 다음 단계에서 추가돼요. 지금은 eval/questions.jsonl을 직접 고친 뒤 [다시 점검]을 눌러요.</p>
  </>;
}
