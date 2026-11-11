// Evaluations › 시험지: 평가 질문(eval/questions.jsonl)과 자동 점검 결과. 오른쪽 패널에서 고치면 엔진이 파일을 다시 쓴다.
// 화면 나누기: 제목·요약 줄 = Fixed, 본문 = Hybrid (왼쪽 문서별·질문 목록 Fluid + 오른쪽 편집 420px Fixed).
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CircleAlert, CircleCheck, Plus, RefreshCw, Search, TriangleAlert, X } from 'lucide-react';
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
const NEW = '__new__';
const worst = (q: Question): Level | null => q.checks.some(c => c.level === 'error') ? 'error' : q.checks.length ? 'warn' : null;

export function QuestionSet({ tabs }: { tabs: React.ReactNode }) {
  const [data, setData] = useState<QuestionSetData | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const detail = useRef<HTMLDivElement>(null);
  const dirty = useRef(false);   // 편집 패널에 저장하지 않은 변경이 있는지
  // 좁은 화면에서는 편집 패널이 목록 아래에 있어서, 고르면 그쪽으로 내려 준다.
  function choose(id: string) {
    if (id === selectedId) return;
    if (dirty.current && !window.confirm('저장하지 않은 변경이 있어요. 버리고 다른 질문으로 갈까요?')) return;
    dirty.current = false;
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
  useEffect(() => { if (data && selectedId !== NEW && !data.questions.some(q => q.id === selectedId)) setSelectedId(data.questions[0]?.id ?? null); }, [data]);
  const selected = data?.questions.find(q => q.id === selectedId) ?? null;
  // 저장·삭제가 끝나면 엔진이 새 점검 결과를 돌려준다. 그걸로 화면 전체를 바꾼다.
  function applySaved(next: QuestionSetData, id: string | null) {
    dirty.current = false;
    setData(next);
    setSelectedId(id ?? next.questions[0]?.id ?? null);
  }

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
          <div className="qs-card-head"><h2>질문 {s.questions}개</h2><span className="qs-head-right"><small>누르면 오른쪽에서 고쳐요</small>
            <button className="qs-btn qs-btn-dark" onClick={() => choose(NEW)}><Plus size={13} />새 질문</button></span></div>
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
        {selected || selectedId === NEW
          ? <Editor key={`${selectedId}@${data.sha}`} q={selected} sha={data.sha} onDirty={d => { dirty.current = d; }} onSaved={applySaved}
              indexLabel={`${data.index.label.chunker} × ${data.index.label.embedder.split(' · ').pop()}`} />
          : <p className="muted">질문을 고르세요.</p>}
      </Card></div>
    </section>
  </>;
}

type EvDraft = { path: string; heading: string; quote: string };
type Draft = { question: string; answer: string; kind: string; use: string; env: string; evidence: EvDraft[] };
type Hit = { path: string; title: string; quote: string; heading: string; in_chunk: boolean };
const ENVS = ['혼합', '운영', '개발', '샘플'];
const KINDS = ['직접', '표현 바꿈', '답 없음'];

function toDraft(q: Question | null): Draft {
  return q
    ? { question: q.question, answer: q.answer ?? '', kind: q.kind, use: q.use, env: q.env ?? '혼합',
        evidence: q.evidence.map(e => ({ path: e.path, heading: e.heading ?? '', quote: e.quote ?? '' })) }
    : { question: '', answer: '', kind: '직접', use: '개선용', env: '혼합', evidence: [] };
}

function Seg({ value, options, onChange, label }: { value: string; options: string[]; onChange: (v: string) => void; label: string }) {
  return <span className="qs-seg" role="radiogroup" aria-label={label}>{options.map(o =>
    <button key={o} type="button" role="radio" aria-checked={value === o} className={value === o ? 'is-on' : ''} onClick={() => onChange(o)}>{o}</button>)}</span>;
}

// 편집 패널. 저장하면 엔진이 다시 점검하고, 오류가 있으면 쓰지 않고 이유를 돌려준다.
function Editor({ q, sha, indexLabel, onDirty, onSaved }: {
  q: Question | null; sha: string; indexLabel: string;
  onDirty: (dirty: boolean) => void; onSaved: (data: QuestionSetData, id: string | null) => void;
}) {
  const original = useMemo(() => toDraft(q), [q]);
  const [draft, setDraft] = useState<Draft>(original);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(original);
  useEffect(() => { onDirty(dirty); }, [dirty]);
  const set = (patch: Partial<Draft>) => { setDraft(d => ({ ...d, ...patch })); setError(''); };
  const abstain = draft.kind === '답 없음';

  async function save(next: Draft = draft) {
    setBusy(true); setError('');
    try {
      const body = { sha, question: next };
      const res = q
        ? await api<QuestionSetData & { id: string }>(`/questions/${q.id}`, { method: 'PUT', body })
        : await api<QuestionSetData & { id: string }>('/questions', { method: 'POST', body });
      onSaved(res, res.id);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(false); }
  }
  async function remove() {
    if (!q) return;
    setBusy(true); setError('');
    try { onSaved(await api<QuestionSetData>(`/questions/${q.id}?sha=${sha}`, { method: 'DELETE' }), null); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(false); setConfirmDelete(false); }
  }
  // 경고의 [근거에 함께 추가]: 같은 문장을 그 문서 근거로 더하고 바로 저장한다.
  function addElsewhere(path: string, quote: string) {
    const next = { ...draft, evidence: [...draft.evidence, { path, heading: '', quote }] };
    setDraft(next);
    void save(next);
  }
  const savedEv = (e: EvDraft) => q?.evidence.find(x => x.path === e.path && (x.quote ?? '') === e.quote);

  return <>
    <div className="qs-card-head"><h2>{q ? `${q.id} 고치기` : '새 질문'}</h2><small>{q ? `${q.use} · ${q.kind}` : '저장하면 다음 번호가 붙어요'}</small></div>
    {q?.use === '최종 평가용' && <p className="qs-check warn"><TriangleAlert size={13} />최종 평가용 질문이에요. 평가 결과를 보고 고치면 최종 평가의 의미가 없어져요. 오타나 근거 오류만 고쳐 주세요.</p>}
    {q && q.checks.length > 0 && <div className="qs-checks">{q.checks.map((c, i) => {
      const ev = c.evidence != null ? q.evidence[c.evidence] : null;
      return <div key={i} className={`qs-check ${c.level}`}>
        {c.level === 'error' ? <CircleAlert size={13} /> : <TriangleAlert size={13} />}
        <span>{c.evidence != null ? `근거 ${c.evidence + 1}: ` : ''}{c.message}
          {c.code === 'quote_elsewhere' && ev?.quote && ev.elsewhere.filter(p => !draft.evidence.some(e => e.path === p)).map(p =>
            <button key={p} className="qs-link" disabled={busy} onClick={() => addElsewhere(p, ev.quote!)}>[{file(p)}를 근거에 함께 추가]</button>)}
        </span></div>;
    })}</div>}

    <div className="qs-field"><label htmlFor="qs-question">질문</label>
      <textarea id="qs-question" className="qs-input" rows={2} value={draft.question} onChange={e => set({ question: e.target.value })} placeholder="사람이 실제로 물어볼 말투로" /></div>
    <div className="qs-field"><label htmlFor="qs-answer">정답 (채점에는 안 쓰고, 사람이 볼 때와 답변 평가 참고용)</label>
      <textarea id="qs-answer" className="qs-input" rows={2} value={draft.answer} onChange={e => set({ answer: e.target.value })} /></div>
    <div className="qs-row2">
      <div className="qs-field"><label>종류</label><Seg label="종류" value={draft.kind} options={KINDS} onChange={kind => set({ kind })} /></div>
      <div className="qs-field"><label>용도</label><Seg label="용도" value={draft.use} options={['개선용', '최종 평가용']} onChange={use => set({ use })} /></div>
    </div>
    <div className="qs-field"><label>환경</label><Seg label="환경" value={draft.env} options={ENVS.includes(draft.env) ? ENVS : [...ENVS, draft.env]} onChange={env => set({ env })} /></div>

    <div className="qs-field"><label>{abstain ? '근거 없음 — 문서에 답이 없어서 보류가 정답이에요' : `정답 근거 ${draft.evidence.length}개 — 조각에 이 문장이 들어 있으면 정답`}</label>
      {draft.evidence.map((e, i) => {
        const saved = savedEv(e);
        return <div key={i} className="qs-ev">
          <span className="qs-ev-top"><span className="qs-path">{e.path}{e.heading ? ` › ${e.heading}` : ''}</span>
            <button className="qs-x" aria-label={`근거 ${i + 1} 빼기`} title="근거 빼기" onClick={() => set({ evidence: draft.evidence.filter((_, j) => j !== i) })}><X size={13} /></button></span>
          <textarea className="qs-quote-input" rows={2} aria-label={`근거 ${i + 1} 문장`} value={e.quote}
            onChange={ev => set({ evidence: draft.evidence.map((x, j) => j === i ? { ...x, quote: ev.target.value } : x) })} />
          {saved ? <span className={`qs-ev-state ${saved.in_document === false || (saved.quote && !saved.chunk_ids.length) ? 'bad' : ''}`}>
              {saved.in_document === false ? '원문에 없음' : saved.in_document == null ? '원문 확인 불가' : <><CircleCheck size={11} />원문에 있음</>}
              {saved.quote && saved.in_document !== false && (saved.chunk_ids.length ? ` · 조각 ${saved.chunk_ids.map(c => `#${c}`).join(', ')}에 들어감` : ' · 어느 조각에도 통째로 안 들어감')}
            </span>
            : <span className="qs-ev-state muted">저장하면 점검해요</span>}
        </div>;
      })}
      {abstain && draft.evidence.length > 0 && <p className="qs-check error"><CircleAlert size={13} />답 없는 질문에는 근거를 넣지 않아요. 위 근거를 빼거나 종류를 바꿔 주세요.</p>}
      {!abstain && <EvidenceSearch have={draft.evidence} onPick={h => set({ evidence: [...draft.evidence, { path: h.path, heading: h.heading, quote: h.quote }] })} />}
    </div>

    {error && <p className="qs-check error" role="alert"><CircleAlert size={13} />{error}</p>}
    <div className="qs-foot">
      {q ? (confirmDelete
        ? <span className="qs-actions"><small>{q.id}를 지울까요?</small><button className="qs-btn" onClick={() => setConfirmDelete(false)} disabled={busy}>아니요</button><button className="qs-btn qs-btn-bad" onClick={() => void remove()} disabled={busy}>지우기</button></span>
        : <button className="qs-btn" onClick={() => setConfirmDelete(true)} disabled={busy}>질문 지우기</button>) : <span />}
      <span className="qs-actions">
        <button className="qs-btn" onClick={() => { setDraft(original); setError(''); }} disabled={!dirty || busy}>되돌리기</button>
        <button className="qs-btn qs-btn-dark" onClick={() => void save()} disabled={!dirty || busy || !draft.question.trim()}>{busy ? '저장 중…' : '저장'}</button>
      </span>
    </div>
    <p className="qs-note">저장하면 eval/questions.jsonl이 바뀌고, 점검을 통과하지 못하면 저장하지 않아요. 조각 번호는 현재 색인({indexLabel}) 기준이에요.</p>
  </>;
}

// 근거 추가: 원문에서 문장을 찾아 고르면 글자 그대로 들어간다 (손으로 옮겨 적다 틀리는 일을 막음).
function EvidenceSearch({ have, onPick }: { have: EvDraft[]; onPick: (hit: Hit) => void }) {
  const [text, setText] = useState('');
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const words = text.trim();
    if (words.length < 2) { setHits(null); return; }
    let stale = false;
    const timer = window.setTimeout(() => {
      api<Hit[]>(`/questions/evidence-search?q=${encodeURIComponent(words)}`)
        .then(h => { if (!stale) { setHits(h); setError(''); } })
        .catch(e => { if (!stale) setError(e instanceof Error ? e.message : String(e)); });
    }, 250);
    return () => { stale = true; window.clearTimeout(timer); };
  }, [text]);
  const mark = (quote: string) => {
    const at = quote.toLowerCase().indexOf(text.trim().toLowerCase());
    return at < 0 ? quote : <>{quote.slice(0, at)}<mark>{quote.slice(at, at + text.trim().length)}</mark>{quote.slice(at + text.trim().length)}</>;
  };
  return <div className="qs-add-ev">
    <small>근거 추가 — 문장을 검색해서 고르면 원문 그대로 들어가요. 넣은 뒤 필요한 부분만 남기고 지워도 돼요.</small>
    <label className="qs-search"><Search size={13} /><input aria-label="근거 문장 검색" placeholder="원문에서 찾을 말 (두 글자 이상)" value={text} onChange={e => setText(e.target.value)} /></label>
    {error && <small className="qs-bad">{error}</small>}
    {hits && !hits.length && <small className="muted">원문에서 찾지 못했어요.</small>}
    {hits && hits.length > 0 && <div className="qs-hits">{hits.map((h, i) => {
      const added = have.some(e => e.path === h.path && e.quote === h.quote);
      return <div key={i} className="qs-hit">
        <span className="qs-path">{file(h.path)}{h.heading ? ` › ${h.heading}` : ''}</span>
        <span className="qs-quote">{mark(h.quote)}</span>
        <span className="qs-hit-foot">{h.in_chunk ? <small /> : <small className="qs-warn">조각 경계에 걸려 이대로는 정답이 될 수 없어요</small>}
          <button className="qs-link" disabled={added} onClick={() => onPick(h)}>{added ? '넣음' : '[근거로 넣기]'}</button></span>
      </div>;
    })}</div>}
  </div>;
}
