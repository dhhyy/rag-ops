// Evaluations › 시험지: 평가 질문(eval/questions.jsonl)과 자동 점검 결과. 오른쪽 패널에서 고치면 엔진이 파일을 다시 쓴다.
// 화면 나누기
// - 목록 모드: 제목·요약 줄 = Fixed, 본문 = Fluid (화면 폭 전체). 질문을 누르면 오른쪽에서 서랍(Hybrid)이 열린다.
// - 초안 고르기 모드: Hybrid (배경 Fluid + 가운데 카드 폭 600px Fixed). 한 번에 초안 하나만 보여 준다.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowDown, ArrowLeft, ArrowUp, CircleAlert, CircleCheck, LoaderCircle, Plus, RefreshCw, Search, Sparkles, TriangleAlert, X } from 'lucide-react';
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
  sha: string; path: string;
  target: { questions: number; kinds: Record<string, number>; uses: Record<string, number>; per_document: number; coverage: number };
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
const message = (e: unknown) => e instanceof Error ? e.message : String(e);
// 엔진 questions._next_id와 같은 규칙: 가장 큰 qNN + 1
const nextId = (qs: Question[]) => `q${String(Math.max(0, ...qs.map(q => Number(/^q(\d+)$/.exec(q.id)?.[1] ?? 0))) + 1).padStart(2, '0')}`;

export function QuestionSet({ tabs }: { tabs: React.ReactNode }) {
  const [data, setData] = useState<QuestionSetData | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);   // 서랍에 열린 질문 (NEW = 새 질문)
  const [dir, setDir] = useState(1);   // 서랍 안에서 다음(1)·이전(-1) 질문으로 넘어간 방향
  const [reviewing, setReviewing] = useState(false);   // 초안 하나씩 고르기 화면
  const [draftsVersion, setDraftsVersion] = useState(0);  // 바뀌면 초안 카드를 다시 불러온다
  const dirty = useRef(false);   // 서랍에 저장하지 않은 변경이 있는지
  const leaveOk = () => !dirty.current || window.confirm('저장하지 않은 변경이 있어요. 버리고 넘어갈까요?');

  async function load() {
    setLoading(true);
    try { setData(await api<QuestionSetData>('/questions')); setError(''); }
    catch (e) { setError(message(e)); }
    setLoading(false);
  }
  useEffect(() => { void load(); }, []);

  const shown = useMemo(() => {
    const words = query.trim().toLowerCase();
    return (data?.questions ?? []).filter(q =>
      (filter === 'all' || (filter === 'final' ? q.use === '최종 평가용' : filter === 'flagged' ? q.checks.length > 0 : q.kind === filter))
      && (!words || `${q.id} ${q.question} ${q.answer ?? ''} ${q.evidence.map(e => `${e.path} ${e.quote ?? ''}`).join(' ')}`.toLowerCase().includes(words)));
  }, [data, filter, query]);
  // 열린 질문이 지워졌으면 서랍을 닫는다.
  useEffect(() => { if (data && openId && openId !== NEW && !data.questions.some(q => q.id === openId)) setOpenId(null); }, [data]);
  const opened = data?.questions.find(q => q.id === openId) ?? null;
  const at = shown.findIndex(q => q.id === openId);

  function open(id: string) {
    if (id === openId || !leaveOk()) return;
    dirty.current = false;
    const from = shown.findIndex(q => q.id === openId), to = shown.findIndex(q => q.id === id);
    setDir(from >= 0 && to < from ? -1 : 1);
    setOpenId(id);
  }
  function close() {
    if (!openId || !leaveOk()) return;
    const was = openId;
    dirty.current = false;
    setOpenId(null);
    // 닫으면 보던 줄로 돌아간다 (키보드로 이어서 고를 수 있게)
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`.qs-table tr[data-qid="${was}"]`)?.focus({ preventScroll: true }));
  }
  // 저장·삭제가 끝나면 엔진이 새 점검 결과를 돌려준다. 그걸로 화면 전체를 바꾼다. 지웠으면 서랍을 닫는다.
  function applySaved(next: QuestionSetData, id: string | null) {
    dirty.current = false;
    setData(next);
    setOpenId(id);
  }

  // 서랍 키보드: Esc 닫기 · ↑↓ 이전·다음 질문 (글을 쓰는 중에는 ↑↓를 듣지 않는다)
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = e => {
    if (!openId || e.isComposing) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if ((e.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"]')) return;
    if (e.key === 'ArrowDown' && at >= 0 && at < shown.length - 1) { e.preventDefault(); open(shown[at + 1].id); }
    if (e.key === 'ArrowUp' && at > 0) { e.preventDefault(); open(shown[at - 1].id); }
  };
  useEffect(() => {
    const on = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);

  const head = <Heading title="Evaluations" subtitle={data ? `평가에 쓰는 질문과 정답 근거 · ${data.path} @ ${data.sha}` : '평가에 쓰는 질문과 정답 근거'}>
    {tabs}
    {!reviewing && <button className="qs-btn" onClick={() => void load()} disabled={loading} aria-label="다시 점검"><RefreshCw size={14} className={loading ? 'spin' : ''} />다시 점검</button>}
  </Heading>;

  if (!data) return <>{head}{error ? <p className="source-error">{error}</p> : <p className="muted">불러오는 중…</p>}</>;
  if (reviewing) return <>{head}
    <Review data={data} onChange={setData} onClose={() => { setReviewing(false); setDraftsVersion(v => v + 1); }} />
  </>;

  const s = data.summary;
  const t = data.target;
  const thin = data.documents.filter(d => d.questions < t.per_document).length;
  const counts: [Filter, string, number][] = [
    ['all', '전체', s.questions], ['직접', '직접', s.kinds['직접'] ?? 0], ['표현 바꿈', '표현 바꿈', s.kinds['표현 바꿈'] ?? 0],
    ['답 없음', '답 없음', s.kinds['답 없음'] ?? 0], ['final', '최종 평가용', s.uses['최종 평가용'] ?? 0], ['flagged', '문제 있음', s.flagged],
  ];
  const panelProps = { sha: data.sha, onDirty: (d: boolean) => { dirty.current = d; }, onSaved: applySaved };

  return <>
    {head}
    {error && <p className="source-error">{error}</p>}
    {data.last_eval && !data.last_eval.same_set && <p className="qs-banner"><CircleAlert size={14} />마지막 평가(#{data.last_eval.id}) 뒤에 시험지가 바뀌었어요. 기준점을 다시 잡으려면 평가 기록 탭에서 평가를 다시 돌려 주세요.</p>}

    {/* 요약 줄 (Fixed) */}
    <section className="qs-sum">
      <Card className="qs-tile" delay={0.02}><small>질문 수 · 목표 {t.questions}</small><b>{s.questions}<small> / {t.questions}</small></b>
        <span className="qs-goal"><i style={{ width: `${Math.min(100, (s.questions / t.questions) * 100)}%` }} /></span></Card>
      <Card className="qs-tile" delay={0.05}><small>질문 종류 · 지금 / 목표</small>
        <span className="qs-bar">{Object.entries(s.kinds).map(([k, n]) => <i key={k} style={{ width: `${(n / Math.max(1, s.questions)) * 100}%`, background: KIND_COLOR[k] }} />)}</span>
        <span className="qs-legend">{Object.entries(s.kinds).map(([k, n]) => <span key={k}><i style={{ background: KIND_COLOR[k] }} />{k} {n}/{t.kinds[k] ?? '—'}</span>)}</span></Card>
      <Card className="qs-tile" delay={0.08}><small>용도 · 지금 / 목표</small><b>{s.uses['개선용'] ?? 0}<small>/{t.uses['개선용']}</small> · {s.uses['최종 평가용'] ?? 0}<small>/{t.uses['최종 평가용']}</small></b><small>개선용 · 최종 평가용</small></Card>
      <Card className="qs-tile" delay={0.11}><small>근거가 닿은 조각 · 목표 {Math.round(t.coverage * 100)}%</small><b>{s.covered_chunks}<small> / {data.index.chunks} 조각</small></b>
        <span className="qs-goal"><i style={{ width: `${Math.min(100, (s.covered_chunks / Math.max(1, data.index.chunks)) / t.coverage * 100)}%` }} /></span>
        <small>{Math.round((s.covered_chunks / Math.max(1, data.index.chunks)) * 100)}% · 현재 색인 기준</small></Card>
      <Card className="qs-tile" delay={0.14}><small>자동 점검</small>
        {s.errors || s.warnings
          ? <b className={s.errors ? 'qs-bad' : 'qs-warn'}>{s.errors ? `오류 ${s.errors}` : ''}{s.errors && s.warnings ? ' · ' : ''}{s.warnings ? `경고 ${s.warnings}` : ''}</b>
          : <b className="qs-good">문제 없음</b>}
        <small>근거 {s.evidence}개 · {s.errors ? '오류가 있으면 채점이 틀어져요' : '모두 원문·조각에서 찾음'}</small></Card>
    </section>

    {/* 본문 (Fluid, 화면 폭 전체). 질문을 누르면 서랍이 열린다 */}
    <section className="qs-main">
      <div className="qs-duo">
        <DraftsCard version={draftsVersion} onReview={() => setReviewing(true)} />
        <Card className="qs-card" delay={0.18}>
          <div className="qs-card-head"><h2>문서별로 고른가</h2><small>문서마다 최소 {t.per_document}문제 · {thin ? `부족한 문서 ${thin}개` : '모두 채움'} · 오른쪽은 근거가 닿은 조각 / 전체</small></div>
          <div className="qs-cover">{data.documents.map(d => <React.Fragment key={d.path}>
            <span className={d.questions < t.per_document ? 'qs-low' : ''} title={`${d.path} · ${d.title} · 질문 ${d.questions}개`}>{d.path.includes('/') && <em className="qs-dir">{d.path.slice(0, d.path.lastIndexOf('/') + 1)}</em>}{file(d.path)}<em className="qs-count"> · {d.questions}문제</em></span>
            <span className="qs-goal"><i style={{ width: `${d.chunks ? (d.covered / d.chunks) * 100 : 0}%` }} /></span>
            <small className={d.questions < t.per_document ? 'qs-low' : ''}>{d.covered} / {d.chunks}</small>
          </React.Fragment>)}</div>
        </Card>
      </div>

      <Card className="qs-card" delay={0.2}>
        <div className="qs-card-head"><h2>질문 {s.questions}개</h2><span className="qs-head-right"><small>누르면 서랍에서 고쳐요</small>
          <button className="qs-btn qs-btn-dark" onClick={() => open(NEW)}><Plus size={13} />새 질문</button></span></div>
        <div className="qs-filters">
          {counts.map(([f, label, n]) => <button key={f} className={`qs-chip ${filter === f ? 'is-on' : ''}`} aria-pressed={filter === f} onClick={() => setFilter(f)}>{label} {n}</button>)}
          <label className="qs-search"><Search size={13} /><input aria-label="질문·근거 검색" placeholder="질문·근거 검색" value={query} onChange={e => setQuery(e.target.value)} /></label>
        </div>
        <table className="qs-table">
          <thead><tr><th>질문</th><th className="qs-col-kind">종류</th><th className="qs-col-use">용도</th><th className="qs-col-ev">근거</th><th className="qs-col-st">점검</th></tr></thead>
          <tbody>{shown.map(q => {
            const level = worst(q);
            return <tr key={q.id} data-qid={q.id} className={q.id === openId ? 'is-selected' : ''} onClick={() => open(q.id)} tabIndex={0}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(q.id); } }}>
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
    </section>

    <Drawer open={!!openId && (openId === NEW || !!opened)} title={openId === NEW ? '새 질문' : openId ?? ''} contentKey={openId ?? ''} dir={dir} onClose={close}
      onPrev={at > 0 ? () => open(shown[at - 1].id) : undefined} onNext={at >= 0 && at < shown.length - 1 ? () => open(shown[at + 1].id) : undefined}>
      {openId === NEW
        ? <Wizard key={`new@${data.sha}`} nextId={nextId(data.questions)} {...panelProps} />
        : opened && <Summary key={`${opened.id}@${data.sha}`} q={opened} {...panelProps}
            indexLabel={`${data.index.label.chunker} × ${data.index.label.embedder.split(' · ').pop()}`} />}
    </Drawer>
  </>;
}

// ── 서랍 ─────────────────────────────────────────────────────────────────
// 화면 나누기: 폭 Fixed(화면의 약 42%, 520~680px), 높이 Fluid(화면 전체) / 안쪽은 머리 Fixed · 본문 스크롤 Fluid · 아래 버튼 Fixed(sticky).
// 폰(760px 이하)에서는 아래에서 올라오는 판. 움직임은 motion 스프링, "동작 줄이기"를 켠 사람에게는 앱 전체 설정(MotionConfig)이 줄여 준다.
const EASE_IN = [0.4, 0, 1, 1] as const;
const DRAWER_SPRING = { type: 'spring' as const, stiffness: 300, damping: 26, mass: 0.9 };
const POP = { hide: { opacity: 0, scale: 0.6 }, show: { opacity: 1, scale: 1, transition: { type: 'spring' as const, stiffness: 420, damping: 18 } } };
const SWAP = {
  enter: { opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' },
  center: { opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' },
  exit: (dir: number) => ({ opacity: 0, y: -24 * dir, scale: 0.97, filter: 'blur(4px)', transition: { duration: 0.16, ease: EASE_IN } }),
};

function useNarrow() {
  const query = '(max-width: 760px)';
  const [narrow, setNarrow] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setNarrow(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return narrow;
}

function Drawer({ open, title, contentKey, dir, onClose, onPrev, onNext, children }: {
  open: boolean; title: string; contentKey: string; dir: number; onClose: () => void; onPrev?: () => void; onNext?: () => void; children: React.ReactNode;
}) {
  const narrow = useNarrow();
  // 열려 있는 동안: 뒤 화면을 살짝 물러나게 하고(보던 자리를 기준으로), 뒤 화면 스크롤을 막는다.
  useEffect(() => {
    if (!open) return;
    const root = document.documentElement;
    root.style.setProperty('--qs-origin', `${window.scrollY + window.innerHeight / 2}px`);
    root.classList.add('qs-drawer-open');
    return () => root.classList.remove('qs-drawer-open');
  }, [open]);

  return createPortal(<AnimatePresence>{open && <React.Fragment key="drawer">
    <motion.div className="qs-scrim" onClick={onClose}
      initial={{ opacity: 0 }} animate={{ opacity: 1, transition: { duration: 0.3 } }} exit={{ opacity: 0, transition: { duration: 0.22, ease: EASE_IN } }} />
    <motion.aside className="qs-drawer" role="dialog" aria-modal="true" aria-label={title}
      initial={narrow ? { y: '100%' } : { x: '108%', scale: 0.94, rotate: 1.2, opacity: 0.6 }}
      animate={{ x: 0, y: 0, scale: 1, rotate: 0, opacity: 1, transition: DRAWER_SPRING }}
      exit={narrow ? { y: '100%', transition: { duration: 0.28, ease: EASE_IN } } : { x: '108%', scale: 0.96, opacity: 0.6, transition: { duration: 0.3, ease: EASE_IN } }}>
      <motion.div className="qs-drawer-head" initial="hide" animate="show" variants={{ show: { transition: { delayChildren: 0.18, staggerChildren: 0.05 } } }}>
        <motion.h2 key={title} variants={POP}>{title}</motion.h2>
        {(onPrev || onNext) && <>
          <motion.button variants={POP} className="qs-ib" aria-label="이전 질문" title="이전 질문 (↑)" onClick={onPrev} disabled={!onPrev}><ArrowUp size={15} /></motion.button>
          <motion.button variants={POP} className="qs-ib" aria-label="다음 질문" title="다음 질문 (↓)" onClick={onNext} disabled={!onNext}><ArrowDown size={15} /></motion.button>
        </>}
        <motion.button variants={POP} className="qs-ib" aria-label="닫기" title="닫기 (Esc)" onClick={onClose} autoFocus><X size={15} /></motion.button>
      </motion.div>
      <div className="qs-drawer-body">
        <AnimatePresence mode="wait" initial={false} custom={dir}>
          <motion.div key={contentKey} className="qs-drawer-content" custom={dir} variants={SWAP} initial="enter" animate="center" exit="exit">
            {children}
          </motion.div>
        </AnimatePresence>
      </div>
    </motion.aside>
  </React.Fragment>}</AnimatePresence>, document.body);
}

// ── 편집에 함께 쓰는 것 ──────────────────────────────────────────────────
type EvDraft = { path: string; heading: string; quote: string };
type Draft = { question: string; answer: string; kind: string; use: string; env: string; evidence: EvDraft[] };
type Hit = { path: string; title: string; quote: string; heading: string; in_chunk: boolean };
type Saved = (data: QuestionSetData, id: string | null) => void;
const ENVS = ['혼합', '운영', '개발', '샘플'];
const KINDS: [string, string][] = [
  ['직접', '문서에 있는 말 그대로 묻기'],
  ['표현 바꿈', '같은 내용을 다른 말로 묻기 — 검색이 뜻을 이해하는지 봐요'],
  ['답 없음', '문서에 답이 없는 질문 — "모른다"고 하는지 봐요'],
];

function toDraft(q: Question | null): Draft {
  return q
    ? { question: q.question, answer: q.answer ?? '', kind: q.kind, use: q.use, env: q.env ?? '혼합',
        evidence: q.evidence.map(e => ({ path: e.path, heading: e.heading ?? '', quote: e.quote ?? '' })) }
    : { question: '', answer: '', kind: '', use: '개선용', env: '혼합', evidence: [] };
}

function Seg({ value, options, onChange, label }: { value: string; options: string[]; onChange: (v: string) => void; label: string }) {
  return <span className="qs-seg" role="radiogroup" aria-label={label}>{options.map(o =>
    <button key={o} type="button" role="radio" aria-checked={value === o} className={value === o ? 'is-on' : ''} onClick={() => onChange(o)}>{o}</button>)}</span>;
}

// 저장·지우기. 저장하면 엔진이 다시 점검하고, 오류가 있으면 쓰지 않고 이유를 돌려준다.
function useSave(q: Question | null, sha: string, draftId: number | undefined, onSaved: Saved) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save(next: Draft) {
    setBusy(true); setError('');
    // 답 없는 질문은 근거를 넣지 않는다 (종류를 나중에 바꿨을 때 남은 근거를 버림)
    const question = next.kind === '답 없음' ? { ...next, evidence: [] } : next;
    try {
      const res = q
        ? await api<QuestionSetData & { id: string }>(`/questions/${q.id}`, { method: 'PUT', body: { sha, question } })
        : await api<QuestionSetData & { id: string }>('/questions', { method: 'POST', body: { sha, question, draft_id: draftId } });
      onSaved(res, res.id);
    } catch (e) { setError(message(e)); setBusy(false); }
  }
  async function remove() {
    if (!q) return;
    setBusy(true); setError('');
    try { onSaved(await api<QuestionSetData>(`/questions/${q.id}?sha=${sha}`, { method: 'DELETE' }), null); }
    catch (e) { setError(message(e)); setBusy(false); }
  }
  return { busy, error, setError, save, remove };
}

// 근거 목록 (읽기). 저장된 근거면 원문·조각 점검 결과를 함께 보여 준다.
function EvidenceView({ evidence, saved }: { evidence: EvDraft[]; saved?: Evidence[] }) {
  if (!evidence.length) return <span className="qs-sum-val muted">—</span>;
  return <>{evidence.map((e, i) => {
    const s = saved?.find(x => x.path === e.path && (x.quote ?? '') === e.quote);
    const bad = s && (s.in_document === false || (s.quote && !s.chunk_ids.length));
    return <span key={i} className="qs-sum-ev">{e.quote || '(문장 없음)'}
      <small className={bad ? 'qs-bad' : ''}>{file(e.path)}{s ? (s.in_document === false ? ' · 원문에 없음' : s.chunk_ids.length ? ` · ✓ 조각 #${s.chunk_ids.join(', #')}` : ' · 어느 조각에도 통째로 안 들어감') : ''}</small></span>;
  })}</>;
}

// 근거 고치기: 문장 다듬기·빼기 + 원문에서 찾아 더하기
function EvidenceEdit({ evidence, onChange }: { evidence: EvDraft[]; onChange: (ev: EvDraft[]) => void }) {
  return <>
    {evidence.map((e, i) => <div key={i} className="qs-ev">
      <span className="qs-ev-top"><span className="qs-path">{e.path}{e.heading ? ` › ${e.heading}` : ''}</span>
        <button className="qs-x" aria-label={`근거 ${i + 1} 빼기`} title="근거 빼기" onClick={() => onChange(evidence.filter((_, j) => j !== i))}><X size={13} /></button></span>
      <textarea className="qs-quote-input" rows={2} aria-label={`근거 ${i + 1} 문장`} value={e.quote}
        onChange={ev => onChange(evidence.map((x, j) => j === i ? { ...x, quote: ev.target.value } : x))} />
    </div>)}
    <EvidenceSearch have={evidence} onPick={h => onChange([...evidence, { path: h.path, heading: h.heading, quote: h.quote }])} />
  </>;
}

// ── 새 질문: 한 화면에 하나씩 묻는다 (종류 → 질문 → 정답 → 근거 → 확인) ─────────────
type Step = 'kind' | 'question' | 'answer' | 'evidence' | 'check';
function Wizard({ sha, nextId, onDirty, onSaved }: { sha: string; nextId: string; onDirty: (d: boolean) => void; onSaved: Saved }) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(null));
  const [at, setAt] = useState(0);
  const { busy, error, setError, save } = useSave(null, sha, undefined, onSaved);
  const abstain = draft.kind === '답 없음';
  const steps: Step[] = abstain ? ['kind', 'question', 'answer', 'check'] : ['kind', 'question', 'answer', 'evidence', 'check'];
  const step = steps[Math.min(at, steps.length - 1)];
  const dirty = !!(draft.kind || draft.question || draft.answer || draft.evidence.length);
  useEffect(() => { onDirty(dirty); }, [dirty]);
  const set = (patch: Partial<Draft>) => { setDraft(d => ({ ...d, ...patch })); setError(''); };
  const go = (to: Step) => setAt(steps.indexOf(to));
  const canNext = step === 'kind' ? !!draft.kind : step === 'question' ? !!draft.question.trim() : step === 'evidence' ? draft.evidence.length > 0 : true;
  const next = () => { if (canNext) setAt(a => Math.min(a + 1, steps.length - 1)); };
  // 글을 쓰는 칸에서는 ⌘/Ctrl+Enter로 다음
  const nextKey = (e: React.KeyboardEvent) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); next(); } };

  return <div className="qs-wiz">
    <div className="qs-card-head"><span className="qs-dots" aria-hidden>{steps.map((_, k) => <i key={k} className={k === at ? 'on' : k < at ? 'past' : ''} />)}</span>
      <small>새 질문 · {at + 1}/{steps.length}</small></div>

    <div className="qs-step">
      {step === 'kind' && <>
        <h3>어떤 질문을 만들까요?</h3>
        <div className="qs-kinds" role="radiogroup" aria-label="질문 종류">{KINDS.map(([k, help]) =>
          <button key={k} type="button" role="radio" aria-checked={draft.kind === k} className={`qs-kind ${draft.kind === k ? 'is-on' : ''}`}
            onClick={() => set(k === '답 없음' ? { kind: k, evidence: [] } : { kind: k })}><b>{k}</b><span>{help}</span></button>)}</div>
      </>}
      {step === 'question' && <>
        <h3>질문을 적어 주세요</h3><p className="qs-sub">사람이 실제로 물어볼 말투로 적어요.</p>
        <textarea autoFocus className="qs-field-big" aria-label="질문" value={draft.question} onKeyDown={nextKey}
          onChange={e => set({ question: e.target.value })} placeholder="예: 개발 서버 2에 SSH로 들어가는 포트는?" />
      </>}
      {step === 'answer' && <>
        <h3>정답은 뭔가요?</h3>
        <p className="qs-sub">{abstain ? '문서에 답이 없으니 "문서에 나와 있지 않다"처럼 적어요. ' : ''}채점에는 안 쓰고, 나중에 사람이 볼 때와 답변 평가 참고용이에요. 비워도 돼요.</p>
        <textarea autoFocus className="qs-field-big" aria-label="정답" value={draft.answer} onKeyDown={nextKey}
          onChange={e => set({ answer: e.target.value })} placeholder={abstain ? '예: 문서에 나와 있지 않습니다' : '예: 2224번 포트'} />
      </>}
      {step === 'evidence' && <>
        <h3>근거 문장을 골라 주세요</h3>
        <p className="qs-sub">문서에서 정답이 적힌 문장을 찾아 눌러요. 원문 그대로 들어가요. 검색한 조각에 이 문장이 들어 있으면 정답으로 채점해요.</p>
        <EvidenceEdit evidence={draft.evidence} onChange={evidence => set({ evidence })} />
      </>}
      {step === 'check' && <>
        <h3>이대로 넣을까요?</h3>
        <div className="qs-sum-rows">
          <SumRow label="종류" onEdit={() => go('kind')}><span className="qs-sum-val">{draft.kind}</span></SumRow>
          <SumRow label="질문" onEdit={() => go('question')}><span className="qs-sum-val">{draft.question}</span></SumRow>
          <SumRow label="정답" onEdit={() => go('answer')}><span className="qs-sum-val">{draft.answer || '—'}</span></SumRow>
          {abstain
            ? <SumRow label="근거"><span className="qs-sum-val muted">없음 — 보류가 정답</span></SumRow>
            : <SumRow label={`근거 ${draft.evidence.length}개`} onEdit={() => go('evidence')}><EvidenceView evidence={draft.evidence} /></SumRow>}
          <SumRow label="용도 · 환경"><span className="qs-sum-segs">
            <Seg label="용도" value={draft.use} options={['개선용', '최종 평가용']} onChange={use => set({ use })} />
            <Seg label="환경" value={draft.env} options={ENVS} onChange={env => set({ env })} /></span></SumRow>
        </div>
        {draft.use === '최종 평가용' && <p className="qs-check warn"><TriangleAlert size={13} />최종 평가용은 결과를 본 뒤에는 고치지 않는 질문이에요. 사람이 직접 쓴 질문만 넣어 주세요.</p>}
        <p className="qs-note">저장하면 자동 점검을 하고, 통과하면 {nextId}가 돼요.</p>
      </>}
    </div>

    {error && <p className="qs-check error" role="alert"><CircleAlert size={13} />{error}</p>}
    <div className="qs-wiz-foot">
      {at > 0 && <button className="qs-btn qs-btn-ghost" onClick={() => setAt(a => a - 1)} disabled={busy}><ArrowLeft size={13} />이전</button>}
      {step === 'answer' && !draft.answer && <button className="qs-btn" onClick={next}>건너뛰기</button>}
      {step === 'check'
        ? <button className="qs-btn qs-btn-dark" onClick={() => void save(draft)} disabled={busy}>{busy ? '저장 중…' : '저장'}</button>
        : !(step === 'answer' && !draft.answer) && <button className="qs-btn qs-btn-dark" onClick={next} disabled={!canNext}>다음</button>}
    </div>
  </div>;
}

// 요약 한 줄: 이름 + [고치기]. 열리면 그 자리에서 고친다.
function SumRow({ label, onEdit, action = '고치기', children }: { label: string; onEdit?: () => void; action?: string; children: React.ReactNode }) {
  return <div className="qs-sum-row"><div className="qs-sum-top"><small>{label}</small>{onEdit && <button className="qs-edit" onClick={onEdit}>{action}</button>}</div>{children}</div>;
}
function InlineEdit({ label, onCancel, onDone, children }: { label: string; onCancel: () => void; onDone: () => void; children: React.ReactNode }) {
  return <div className="qs-sum-row"><div className="qs-inline"><small>{label} 고치기</small>{children}
    <span className="qs-inline-foot"><button className="qs-btn" onClick={onCancel}>취소</button><button className="qs-btn qs-btn-dark" onClick={onDone}>완료</button></span></div></div>;
}

// ── 기존 질문(또는 초안 고쳐서 넣기): 요약을 보여 주고, 고칠 줄만 연다 ─────────────
type Part = 'question' | 'answer' | 'meta' | 'evidence';
type Seed = { draftId: number; draft: Draft };
function Summary({ q, seed, sha, indexLabel, onDirty, onSaved, onCancel }: {
  q: Question | null; seed?: Seed; sha: string; indexLabel?: string; onDirty: (d: boolean) => void; onSaved: Saved; onCancel?: () => void;
}) {
  const original = useMemo(() => seed?.draft ?? toDraft(q), [q, seed]);
  const [draft, setDraft] = useState<Draft>(original);
  const [open, setOpen] = useState<Part | null>(null);
  const before = useRef<Draft>(original);   // 줄을 열 때의 값. [취소]하면 여기로 돌린다.
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { busy, error, setError, save, remove } = useSave(q, sha, seed?.draftId, onSaved);
  const dirty = JSON.stringify(draft) !== JSON.stringify(original);
  useEffect(() => { onDirty(dirty); }, [dirty]);
  const set = (patch: Partial<Draft>) => { setDraft(d => ({ ...d, ...patch })); setError(''); };
  const edit = (part: Part) => { before.current = draft; setOpen(part); };
  const cancel = () => { setDraft(before.current); setOpen(null); };
  const abstain = draft.kind === '답 없음';
  // 경고의 [근거에 함께 추가]: 같은 문장을 그 문서 근거로 더하고 바로 저장한다.
  function addElsewhere(path: string, quote: string) {
    const next = { ...draft, evidence: [...draft.evidence, { path, heading: '', quote }] };
    setDraft(next);
    void save(next);
  }

  return <>
    {seed
      ? <><div className="qs-card-head"><h2>초안 고쳐서 넣기</h2><small>고칠 곳만 눌러요</small></div>
          <p className="qs-check warn"><Sparkles size={13} />LLM이 만든 초안이에요. 질문 말투와 답만 보면 돼요. 근거는 원문과 맞는 걸 확인했어요. 초안은 개선용으로만 넣어요.</p></>
      : q && <><small className="qs-meta">{q.use} · {q.kind} · {q.env ?? '혼합'}</small>
          {q.use === '최종 평가용' && <p className="qs-check warn"><TriangleAlert size={13} />최종 평가용 질문이에요. 평가 결과를 보고 고치면 최종 평가의 의미가 없어져요. 오타나 근거 오류만 고쳐 주세요.</p>}
          {q.checks.length === 0
            ? <p className="qs-check ok"><CircleCheck size={13} />자동 점검 통과 · {q.abstain ? '근거 없음, 보류가 정답' : `근거 ${q.evidence.length}개 모두 원문·조각에 있음`}</p>
            : <div className="qs-checks">{q.checks.map((c, i) => {
                const ev = c.evidence != null ? q.evidence[c.evidence] : null;
                return <div key={i} className={`qs-check ${c.level}`}>
                  {c.level === 'error' ? <CircleAlert size={13} /> : <TriangleAlert size={13} />}
                  <span>{c.evidence != null ? `근거 ${c.evidence + 1}: ` : ''}{c.message}
                    {c.code === 'quote_elsewhere' && ev?.quote && ev.elsewhere.filter(p => !draft.evidence.some(e => e.path === p)).map(p =>
                      <button key={p} className="qs-link" disabled={busy} onClick={() => addElsewhere(p, ev.quote!)}>[{file(p)}를 근거에 함께 추가]</button>)}
                  </span></div>;
              })}</div>}</>}

    <div className="qs-sum-rows">
      {open === 'question'
        ? <InlineEdit label="질문" onCancel={cancel} onDone={() => setOpen(null)}>
            <textarea autoFocus className="qs-field-big qs-field-sm" aria-label="질문" value={draft.question} onChange={e => set({ question: e.target.value })} /></InlineEdit>
        : <SumRow label="질문" onEdit={() => edit('question')}><span className="qs-sum-val">{draft.question || '—'}</span></SumRow>}
      {open === 'answer'
        ? <InlineEdit label="정답" onCancel={cancel} onDone={() => setOpen(null)}>
            <textarea autoFocus className="qs-field-big qs-field-sm" aria-label="정답" value={draft.answer} onChange={e => set({ answer: e.target.value })} /></InlineEdit>
        : <SumRow label="정답" onEdit={() => edit('answer')}><span className="qs-sum-val">{draft.answer || '—'}</span></SumRow>}
      {open === 'meta'
        ? <InlineEdit label="종류 · 용도 · 환경" onCancel={cancel} onDone={() => setOpen(null)}>
            <Seg label="종류" value={draft.kind} options={KINDS.map(([k]) => k)} onChange={kind => set({ kind })} />
            <Seg label="용도" value={draft.use} options={seed ? ['개선용'] : ['개선용', '최종 평가용']} onChange={use => set({ use })} />
            <Seg label="환경" value={draft.env} options={ENVS.includes(draft.env) ? ENVS : [...ENVS, draft.env]} onChange={env => set({ env })} />
            {abstain && draft.evidence.length > 0 && <small className="qs-warn">답 없는 질문으로 저장하면 근거 {draft.evidence.length}개는 빠져요.</small>}
          </InlineEdit>
        : <SumRow label="종류 · 용도 · 환경" action="바꾸기" onEdit={() => edit('meta')}><span className="qs-sum-val">{draft.kind} · {draft.use} · {draft.env}</span></SumRow>}
      {abstain
        ? <SumRow label="근거"><span className="qs-sum-val muted">없음 — 문서에 답이 없어서 보류가 정답</span></SumRow>
        : open === 'evidence'
          ? <InlineEdit label="근거" onCancel={cancel} onDone={() => setOpen(null)}><EvidenceEdit evidence={draft.evidence} onChange={evidence => set({ evidence })} /></InlineEdit>
          : <SumRow label={`근거 ${draft.evidence.length}개`} onEdit={() => edit('evidence')}><EvidenceView evidence={draft.evidence} saved={q?.evidence} /></SumRow>}
    </div>

    {indexLabel && <p className="qs-note">저장하면 eval/questions.jsonl이 바뀌고, 점검을 통과하지 못하면 저장하지 않아요. 조각 번호는 현재 색인({indexLabel}) 기준이에요.</p>}
    {error && <p className="qs-check error" role="alert"><CircleAlert size={13} />{error}</p>}
    {seed
      ? <div className="qs-wiz-foot">
          <button className="qs-btn qs-btn-ghost" onClick={onCancel} disabled={busy}>취소</button>
          <button className="qs-btn qs-btn-dark" onClick={() => void save(draft)} disabled={busy || !draft.question.trim()}>{busy ? '넣는 중…' : '넣고 다음 초안'}</button>
        </div>
      : <div className="qs-foot">
          {q && (confirmDelete
            ? <span className="qs-actions"><small>{q.id}를 지울까요?</small><button className="qs-btn" onClick={() => setConfirmDelete(false)} disabled={busy}>아니요</button><button className="qs-btn qs-btn-bad" onClick={() => void remove()} disabled={busy}>지우기</button></span>
            : <button className="qs-btn qs-btn-ghost" onClick={() => setConfirmDelete(true)} disabled={busy}>질문 지우기</button>)}
          <span className="qs-actions">
            {dirty && <button className="qs-btn" onClick={() => { setDraft(original); setOpen(null); setError(''); }} disabled={busy}>되돌리기</button>}
            <button className="qs-btn qs-btn-dark" onClick={() => void save(draft)} disabled={!dirty || busy || !draft.question.trim()}>{busy ? '저장 중…' : dirty ? '저장' : '바뀐 게 없어요'}</button>
          </span>
        </div>}
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
        .catch(e => { if (!stale) setError(message(e)); });
    }, 250);
    return () => { stale = true; window.clearTimeout(timer); };
  }, [text]);
  const mark = (quote: string) => {
    const at = quote.toLowerCase().indexOf(text.trim().toLowerCase());
    return at < 0 ? quote : <>{quote.slice(0, at)}<mark>{quote.slice(at, at + text.trim().length)}</mark>{quote.slice(at + text.trim().length)}</>;
  };
  return <div className="qs-add-ev">
    <small>{have.length ? '근거 하나 더 — ' : ''}원문에서 찾을 말을 적어요. 넣은 뒤 필요한 부분만 남기고 지워도 돼요.</small>
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

// ── LLM 초안 (3단계) ─────────────────────────────────────────────────────
type DraftItem = {
  id: number; kind: string; question: string; answer: string | null; path: string; heading: string | null; quote: string;
  chunk_id: number | null; pair_id: number | null; in_document: boolean; chunk_ids: number[]; elsewhere: string[]; similar: string[];
};
type DraftList = { drafts: DraftItem[]; totals: Record<'pending' | 'accepted' | 'discarded', number>; spent_usd: number; model: string; max_chunks: number };
type DraftJob = { id: number; status: string; progress_done: number | null; progress_total: number | null; error: string | null;
  result: { chunks: number; made: number; quote_mismatch: number; skipped: number; bad_format: number; api_error: number; cost_usd: number } | null };

// 같은 문장이 다른 문서에도 있으면 그 문서도 근거로 함께 넣는다 (그래야 어느 문서를 꺼내도 정답으로 채점된다).
function draftToEditor(d: DraftItem): Draft {
  return { question: d.question, answer: d.answer ?? '', kind: d.kind, use: '개선용', env: '혼합',
    evidence: [{ path: d.path, heading: d.heading ?? '', quote: d.quote }, ...d.elsewhere.map(p => ({ path: p, heading: '', quote: d.quote }))] };
}

// 시험지 화면의 초안 카드: 숫자와 버튼만. 초안은 [하나씩 고르기]에서 본다.
function DraftsCard({ version, onReview }: { version: number; onReview: () => void }) {
  const [list, setList] = useState<DraftList | null>(null);
  const [making, setMaking] = useState(false);   // [초안 더 만들기]를 펼쳤는지
  const [count, setCount] = useState(10);
  const [job, setJob] = useState<DraftJob | null>(null);
  const [error, setError] = useState('');

  async function load() {
    try { setList(await api<DraftList>('/drafts')); setError(''); }
    catch (e) { setError(message(e)); }
  }
  useEffect(() => { void load(); }, [version]);

  // 만드는 중이면 1.5초마다 작업 상태를 본다. 끝나면 숫자를 다시 불러온다.
  useEffect(() => {
    if (!job || job.status === 'done' || job.status === 'failed') return;
    const timer = window.setTimeout(() => {
      api<DraftJob>(`/jobs/${job.id}`).then(next => { setJob(next); if (next.status === 'done' || next.status === 'failed') void load(); })
        .catch(e => setError(message(e)));
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [job]);
  const running = !!job && job.status !== 'done' && job.status !== 'failed';

  async function start() {
    setError('');
    try {
      const { job_id } = await api<{ job_id: number }>('/drafts', { method: 'POST', body: { count } });
      setJob({ id: job_id, status: 'queued', progress_done: 0, progress_total: count, error: null, result: null });
    } catch (e) { setError(message(e)); }
  }

  const pending = list?.totals.pending ?? 0;
  const r = job?.result;
  const dropped = r ? r.quote_mismatch + r.bad_format + r.api_error : 0;
  return <Card className="qs-card" delay={0.16}>
    <div className="qs-drafts-compact">
      <div className="qs-big"><b>{list ? pending : '—'}</b><small>고를 초안</small></div>
      <div className="qs-drafts-txt"><b>{pending ? `LLM 초안이 ${pending}개 있어요` : 'LLM 초안이 없어요'}</b>
        <small>{pending ? '한 장씩 보고 넣을지 정해요. ' : '문서 조각에서 질문 초안을 만들 수 있어요. '}
          {list && `넣음 ${list.totals.accepted} · 버림 ${list.totals.discarded} · 지금까지 $${list.spent_usd.toFixed(4)}`}</small></div>
      <button className="qs-btn" onClick={() => setMaking(m => !m)} aria-expanded={making}>
        {running ? <><LoaderCircle size={13} className="spin" />조각 {job?.progress_done ?? 0}/{job?.progress_total ?? count}</> : <><Plus size={13} />초안 더 만들기</>}</button>
      <button className="qs-btn qs-btn-dark" onClick={onReview} disabled={!pending}>하나씩 고르기 →</button>
    </div>
    {making && <div className="qs-draft-make">
      <div className="qs-draft-run">
        <label className="qs-draft-count">조각
          <select value={count} onChange={e => setCount(Number(e.target.value))} disabled={running} aria-label="보낼 조각 수">
            {[5, 10, 20].map(n => <option key={n} value={n}>{n}개</option>)}
          </select></label>
        <small>질문이 적은 문서의 조각부터 골라 {list?.model ?? 'gpt-6-luna'}에 보내요. 조각 하나에서 직접·표현 바꿈 질문이 하나씩 나와요. 예상 약 ${(count * 0.00013).toFixed(4)}</small>
        <button className="qs-btn qs-btn-dark" onClick={() => void start()} disabled={running}>
          {running ? <><LoaderCircle size={13} className="spin" />만드는 중</> : <><Sparkles size={13} />만들기</>}</button>
      </div>
      <p className="qs-note qs-draft-note">외부 전송이 허용된 문서만 보내요. "답 없음" 질문은 만들지 않아요(문서에 없는 걸 아는 건 사람이라서). 근거 문장이 원문과 글자 그대로 맞지 않는 초안은 자동으로 버려요.</p>
    </div>}
    {job?.status === 'failed' && <p className="qs-check error"><CircleAlert size={13} />초안을 만들지 못했어요: {job.error}</p>}
    {r && job?.status === 'done' && <p className="qs-check ok"><CircleCheck size={13} />조각 {r.chunks}개에서 초안 {r.made}개를 만들었어요{dropped ? ` · ${dropped}개는 버림(근거 문장 불일치 ${r.quote_mismatch}, 형식 ${r.bad_format}, API 오류 ${r.api_error})` : ''}{r.skipped ? ` · 질문거리 없는 조각 ${r.skipped}개` : ''} · ${r.cost_usd.toFixed(4)}</p>}
    {error && <p className="qs-check error"><CircleAlert size={13} />{error}</p>}
  </Card>;
}

// 초안 고르기. 한 조각에서 나온 "직접"·"표현 바꿈" 두 질문을 한 장(짝)으로 보여 주고, 넣을 것만 남겨 넣는다.
// 마지막 결정 하나(짝 한 장)는 [되돌리기]로 통째로 무를 수 있다.
type Group = DraftItem[];
function groupDrafts(ds: DraftItem[]): Group[] {
  const para = new Map<number, DraftItem>();
  ds.forEach(d => { if (d.pair_id != null) para.set(d.pair_id, d); });
  const used = new Set<number>(), out: Group[] = [];
  for (const d of ds) {
    if (used.has(d.id)) continue;
    used.add(d.id);
    const g = [d];
    const p = d.pair_id == null ? para.get(d.id) : undefined;   // 짝이 이미 골라졌으면 혼자 나온다
    if (p && !used.has(p.id)) { g.push(p); used.add(p.id); }
    out.push(g);
  }
  return out;
}
type Pick = { d: DraftItem; question: string; answer: string };
type Last = { draftIds: number[]; text: string };
const toEditor = (p: Pick): Draft => ({ ...draftToEditor(p.d), question: p.question, answer: p.answer });

function Review({ data, onChange, onClose }: { data: QuestionSetData; onChange: (d: QuestionSetData) => void; onClose: () => void }) {
  const [list, setList] = useState<DraftList | null>(null);
  const [made, setMade] = useState({ accepted: 0, discarded: 0, cards: 0 });   // 이번에 고른 수
  const [startCount] = useState(data.summary.questions);
  const [last, setLast] = useState<Last | null>(null);
  const [editing, setEditing] = useState<Pick | null>(null);   // [근거까지 고치기]로 연 초안
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const editDirty = useRef(false);

  async function load() {
    try { setList(await api<DraftList>('/drafts')); setError(''); }
    catch (e) { setError(message(e)); }
  }
  useEffect(() => { void load(); }, []);
  const groups = useMemo(() => groupDrafts(list?.drafts ?? []), [list]);
  const g = groups[0] ?? null;
  const total = made.cards + groups.length;

  // 고른 질문은 넣고, 나머지는 버린다. 넣을 때마다 시험지 해시가 바뀌므로 다음 요청에는 새 해시를 쓴다.
  async function decide(put: Pick[], drop: DraftItem[]) {
    if (busy) return;
    setBusy(true); setError('');
    let sha = data.sha;
    const ids: string[] = [], touched: number[] = [];
    try {
      for (const p of put) {
        const res = await api<QuestionSetData & { id: string }>('/questions', { method: 'POST', body: { sha, question: toEditor(p), draft_id: p.d.id } });
        sha = res.sha; onChange(res); ids.push(res.id); touched.push(p.d.id);
      }
      for (const d of drop) { await api<DraftList>(`/drafts/${d.id}/discard`, { method: 'POST' }); touched.push(d.id); }
    } catch (e) { setError(message(e)); }
    // 중간에 실패해도 이미 한 것은 [되돌리기]로 무를 수 있게 남긴다.
    if (touched.length) {
      setMade(m => ({ accepted: m.accepted + ids.length, discarded: m.discarded + touched.length - ids.length, cards: m.cards + 1 }));
      setLast({ draftIds: touched, text: ids.length ? `${ids.join('·')}로 넣었어요${drop.length ? ' · 나머지는 버림' : ''}` : drop.length > 1 ? '둘 다 버렸어요' : '버렸어요' });
    }
    setEditing(null); editDirty.current = false;
    await load();
    setBusy(false);
  }
  async function undo() {
    if (!last || busy) return;
    setBusy(true); setError('');
    let sha = data.sha, back = 0, kept = 0;
    try {
      for (const id of [...last.draftIds].reverse()) {
        const res = await api<{ questions: QuestionSetData | null }>(`/drafts/${id}/undo`, { method: 'POST', body: { sha } });
        if (res.questions) { sha = res.questions.sha; onChange(res.questions); back++; } else kept++;
      }
      setLast(null);
    } catch (e) { setError(message(e)); }
    setMade(m => ({ accepted: m.accepted - back, discarded: m.discarded - kept, cards: Math.max(0, m.cards - 1) }));
    await load();
    setBusy(false);
  }
  function close() {
    if (editDirty.current && !window.confirm('고치던 초안이 있어요. 버리고 시험지로 갈까요?')) return;
    onClose();
  }
  // Esc: 근거 고치기 중이면 카드로, 아니면 시험지로
  const esc = useRef<(e: KeyboardEvent) => void>(() => {});
  esc.current = e => { if (e.key === 'Escape' && !e.isComposing) { e.preventDefault(); if (editing) setEditing(null); else close(); } };
  useEffect(() => {
    const on = (e: KeyboardEvent) => esc.current(e);
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);

  return <section className="qs-focus">
    <div className="qs-focus-top">
      <span className="qs-progress" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={made.cards}><i style={{ width: `${total ? (made.cards / total) * 100 : 0}%` }} /></span>
      <span className="qs-focus-count">{g ? `${made.cards + 1} / ${total}장` : `${made.cards} / ${total}장`}</span>
      <button className="qs-ib" aria-label="시험지로 닫기" title="시험지로 닫기 (Esc)" onClick={close}><X size={15} /></button>
    </div>
    {last && <p className="qs-toast" role="status"><span>{last.text}</span><button onClick={() => void undo()} disabled={busy}>되돌리기</button></p>}
    {error && <p className="qs-check error qs-focus-w" role="alert"><CircleAlert size={13} />{error}</p>}

    {!list ? <p className="muted">불러오는 중…</p>
      : editing
        ? <article className="qs-one qs-one-edit">
            <Summary key={editing.d.id} q={null} seed={{ draftId: editing.d.id, draft: toEditor(editing) }} sha={data.sha}
              onDirty={v => { editDirty.current = v; }}
              onSaved={(next, id) => { onChange(next); setMade(m => ({ ...m, accepted: m.accepted + 1, cards: m.cards + 1 }));
                setLast({ draftIds: [editing.d.id], text: `${id}로 넣었어요` }); setEditing(null); editDirty.current = false; void load(); }}
              onCancel={() => { if (!editDirty.current || window.confirm('고친 내용을 버릴까요?')) { editDirty.current = false; setEditing(null); } }} />
          </article>
        : g
          ? <PairCard key={g.map(d => d.id).join('-')} group={g} busy={busy}
              onDecide={(put, drop) => void decide(put, drop)} onEditEvidence={p => setEditing(p)} />
          : <div className="qs-one qs-done">
              <b>다 골랐어요</b>
              <small>넣음 {made.accepted} · 버림 {made.discarded} · 질문 {startCount} → {data.summary.questions}개</small>
            </div>}
  </section>;
}

// 짝 카드: 근거·답은 한 번만, 질문 두 개는 줄을 눌러 넣기/빼기. 말투는 [고치기]로 그 자리에서 고친다.
function PairCard({ group, busy, onDecide, onEditEvidence }: {
  group: Group; busy: boolean; onDecide: (put: Pick[], drop: DraftItem[]) => void; onEditEvidence: (p: Pick) => void;
}) {
  const head = group[0];
  const [on, setOn] = useState<Record<number, boolean>>(() => Object.fromEntries(group.map(d => [d.id, true])));
  const [texts, setTexts] = useState<Record<number, string>>(() => Object.fromEntries(group.map(d => [d.id, d.question])));
  const [answer, setAnswer] = useState(head.answer ?? '');
  const [editing, setEditing] = useState<number | 'answer' | null>(null);
  const usable = group.every(d => d.in_document && d.chunk_ids.length > 0);
  const chosen = group.filter(d => on[d.id]);
  const pick = (d: DraftItem): Pick => ({ d, question: texts[d.id].trim() || d.question, answer });
  const pair = group.length > 1;
  const putLabel = !chosen.length ? '넣을 질문이 없어요' : !pair ? '넣기' : chosen.length === 2 ? '2개 넣기' : `${chosen[0].kind}만 넣기`;
  const toggle = (id: number) => { if (pair) setOn(o => ({ ...o, [id]: !o[id] })); };

  return <>
    <article className="qs-one" aria-live="polite">
      <div className="qs-one-src"><span>#{group.map(d => d.id).join('·#')} · {file(head.path)}{head.heading ? ` › ${head.heading}` : ''}</span></div>
      <div><p className="qs-one-lbl">근거 — 문서에서 이 문장을 찾아오면 정답</p><p className="qs-one-quote">“{head.quote}”</p></div>

      <div><p className="qs-one-lbl">{pair ? '질문 두 개 — 넣을 것만 남겨요' : '질문'}</p>
        <div className="qs-pq-list">{group.map(d => {
          const off = !on[d.id];
          return <div key={d.id} className={`qs-pq ${off ? 'is-off' : ''} ${pair ? '' : 'is-single'}`} role={pair ? 'checkbox' : undefined} aria-checked={pair ? !off : undefined}
            tabIndex={pair ? 0 : undefined} onClick={e => { if (!(e.target as HTMLElement).closest('button, textarea')) toggle(d.id); }}
            onKeyDown={e => { if ((e.key === ' ' || e.key === 'Enter') && e.target === e.currentTarget) { e.preventDefault(); toggle(d.id); } }}>
            {pair && <span className="qs-tick" aria-hidden>{off ? '' : '✓'}</span>}
            <span className="qs-pq-body">
              <span className="qs-pq-head"><span className={`qs-pill ${KIND_TONE[d.kind] ?? ''}`}>{d.kind === '직접' ? '직접 · 문서 말 그대로' : '표현 바꿈 · 다른 말로'}</span>
                <button className="qs-edit" onClick={() => setEditing(editing === d.id ? null : d.id)}>{editing === d.id ? '완료' : '고치기'}</button></span>
              {editing === d.id
                ? <textarea autoFocus className="qs-field-big qs-field-sm" aria-label={`${d.kind} 질문`} value={texts[d.id]} onChange={e => setTexts(t => ({ ...t, [d.id]: e.target.value }))} />
                : <span className="qs-pq-text">{texts[d.id]}</span>}
              {d.similar.length > 0 && <small className="qs-warn">비슷한 질문이 이미 있어요: {d.similar.join(', ')}</small>}
            </span>
          </div>;
        })}</div></div>

      <div><span className="qs-pq-head"><p className="qs-one-lbl">{pair ? '답 (두 질문 같음)' : '답'}</p>
        <button className="qs-edit" onClick={() => setEditing(editing === 'answer' ? null : 'answer')}>{editing === 'answer' ? '완료' : '고치기'}</button></span>
        {editing === 'answer'
          ? <textarea autoFocus className="qs-field-big qs-field-sm" aria-label="답" value={answer} onChange={e => setAnswer(e.target.value)} />
          : <p className="qs-one-a">{answer || '—'}</p>}</div>

      <div className="qs-one-checks">
        {usable ? <span className="ok"><CircleCheck size={12} />원문에 있음 · 조각 #{head.chunk_ids.join(', #')}에 들어감</span>
          : <span className="bad"><CircleAlert size={12} />{head.in_document ? '조각 경계에 걸려 이대로는 넣을 수 없어요. 아래 [근거까지 고치기]로 근거를 다시 골라 주세요' : '원문에 없어요 (문서가 바뀜). 버려 주세요'}</span>}
        {head.elsewhere.length > 0 && <span className="warn">같은 문장이 {head.elsewhere.map(file).join(', ')}에도 있어요 → 넣으면 그 문서도 근거로 함께 들어가요</span>}
      </div>
    </article>
    <p className="qs-ask">사람이 실제로 물어볼 만한 질문만 남기고 넣어요.</p>
    <div className="qs-choices qs-choices-2">
      <button className="qs-btn" onClick={() => onDecide([], group)} disabled={busy}>{pair ? '둘 다 버리기' : '버리기'}</button>
      <button className="qs-btn qs-btn-dark" onClick={() => onDecide(chosen.map(pick), group.filter(d => !on[d.id]))} disabled={busy || !usable || !chosen.length}>
        {busy ? '처리 중…' : putLabel}</button>
    </div>
    <p className="qs-more"><button className="qs-link" onClick={() => onEditEvidence(pick(chosen[0] ?? head))} disabled={busy}>근거까지 고치기</button> · 근거 문장이 틀렸을 때만</p>
  </>;
}
