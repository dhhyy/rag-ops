// Playground: 질문을 넣으면 현재 설정으로 근거 조각을 찾는다. 답변 생성은 다음 단계라 자리만 잡아 둔다.
// 화면 나누기: 제목 줄·질문 줄·진행 줄·답변 자리 = Fixed, 결과 = Hybrid(목록 Fluid + 상세 400px Fixed, 좁은 화면에서는 누른 카드 밑에 펼침).
// 엔진 POST /search가 단계마다 한 줄씩(JSON Lines) 보내 주므로, 리랭크가 1분 넘게 걸려도 어디까지 왔는지 보인다.
import React, { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowUp, ArrowUpRight, Check, CircleAlert, LoaderCircle, Sparkles, Square } from 'lucide-react';
import { Card, ease, RAG_API, readError } from './ui';
import { useSetup, type Setup } from './setup';

type Hit = {
  chunk_id: number; score: number; vector_score: number; vector_rank: number; chunk_index: number; heading_path: string; content: string;
  document_id: number; title: string | null; source_repo: string; source_path: string; source_commit: string;
  env: string | null; doc_type: string | null; verification: string | null; checked_at: string | null;
};
type Start = { top_k: number; index_id: number; embedder: string; external: boolean; reranker: string | null; candidates: number | null };
type Run = {
  question: string; phase: 'running' | 'done' | 'error' | 'stopped'; start?: Start;
  embedMs?: number; dbMs?: number; candidates?: number; rerankFrom?: number; rerank?: { done: number; total: number; ms: number };
  vectorHits?: Hit[]; hits?: Hit[]; latency?: { embed: number; db: number; rerank: number }; error?: string; startedAt: number;
};

const RECENT = 'playground-recent';
const SEC_PER_CHUNK = 3.4;   // 이 Mac(Docker, CPU)에서 잰 리랭크 시간. 첫 묶음이 끝나면 실제 속도로 바꿔 계산한다
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const clean = (s: string | null | undefined) => (s ?? '').replace(/^"(.*)"$/, '$1');
const lastHeading = (h: Hit) => clean(h.heading_path.split(' > ').pop());
const docTitle = (h: Hit) => clean(h.title) || clean(h.heading_path.split(' > ')[0]);
const body = (h: Hit) => h.content.replace(/^#{1,6} .*\n+/, '').replace(/\n\s*\n/g, '\n');
const plain = (s: string) => s.replace(/[#*`>|_-]/g, ' ').replace(/\s+/g, ' ').trim();
const secs = (ms: number) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)}초`);
const short = (s: number) => (s < 60 ? `${Math.round(s)}초` : `${Math.floor(s / 60)}분 ${Math.round(s % 60)}초`);
const doubtful = (v: string | null) => v !== '확인';

function loadRecent(): string[] {
  try { return JSON.parse(localStorage.getItem(RECENT) ?? '[]'); } catch { return []; }
}

// 다른 문서에 들어 있는 같은 절: 마지막 제목이 같고 본문 앞부분이 같으면 앞에 나온 순위를 돌려준다.
function sameAs(hits: Hit[], i: number): number | null {
  const key = (h: Hit) => `${lastHeading(h)}|${plain(body(h)).slice(0, 160)}`;
  const j = hits.findIndex(h => key(h) === key(hits[i]));
  return j >= 0 && j < i && hits[j].document_id !== hits[i].document_id ? j : null;
}

// ---------- 질문 보내기 (스트림 읽기) ----------

function useSearch() {
  const [run, setRun] = useState<Run | null>(null);
  const abort = useRef<AbortController | null>(null);

  async function ask(question: string, rerank: 'setting' | 'off') {
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    const startedAt = Date.now();
    let rerankStarted = 0;
    setRun({ question, phase: 'running', startedAt });
    const patch = (p: Partial<Run>) => setRun(r => (r && r.startedAt === startedAt ? { ...r, ...p } : r));
    try {
      const res = await fetch(`${RAG_API}/search`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question, rerank }), signal: ctrl.signal,
      });
      if (!res.ok || !res.body) throw new Error(await readError(res));
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const ev = JSON.parse(line);
          if (ev.type === 'start') patch({ start: ev });
          else if (ev.type === 'embedded') patch({ embedMs: ev.ms });
          else if (ev.type === 'candidates') { rerankStarted = Date.now(); patch({ dbMs: ev.ms, candidates: ev.count, vectorHits: ev.hits, rerankFrom: rerankStarted }); }
          else if (ev.type === 'rerank') patch({ rerank: { done: ev.done, total: ev.total, ms: Date.now() - rerankStarted } });
          else if (ev.type === 'done') patch({ phase: 'done', hits: ev.hits, latency: ev.latency_ms });
          else if (ev.type === 'error') patch({ phase: 'error', error: ev.message });
        }
      }
      setRun(r => (r && r.startedAt === startedAt && r.phase === 'running' ? { ...r, phase: 'error', error: '검색이 중간에 끊겼어요' } : r));
    } catch (e) {
      if (ctrl.signal.aborted) patch({ phase: 'stopped' });
      else patch({ phase: 'error', error: message(e) });
    }
  }
  const stop = () => abort.current?.abort();
  useEffect(() => () => abort.current?.abort(), []);
  return { run, ask, stop };
}

// ---------- 작은 조각들 ----------

function SetupLine({ setup, openPipeline }: { setup: Setup | null; openPipeline: () => void }) {
  if (!setup) return <div className="pg-chips"><span className="muted">설정을 불러오는 중…</span></div>;
  const i = setup.index, r = setup.query.reranker;
  return <div className="pg-chips">
    <span className="pg-chip">{i.chunker.id === 'heading' ? `제목 단위 · ${i.chunker.params.prefix === 'none' ? '절만' : '경로 붙임'}` : i.label.chunker}</span>
    <span className="pg-chip">{i.label.embedder.split(' · ').slice(-1)[0]} · {i.external ? '외부' : '내 컴퓨터'}</span>
    <span className="pg-chip">상위 {setup.query.top_k}개</span>
    <span className={`pg-chip ${r ? 'is-on' : 'is-off'}`}>{r ? `리랭크 · 후보 ${r.params.candidates}개` : '리랭크 꺼짐'}</span>
    <button className="pg-link" onClick={openPipeline}>Pipeline에서 바꾸기 <ArrowUpRight size={12} /></button>
  </div>;
}

function Badges({ h }: { h: Hit }) {
  return <span className="pg-badges">
    <span className="pg-b">환경 {h.env ?? '없음'}</span>
    {h.doc_type && <span className="pg-b">{h.doc_type}</span>}
    <span className={`pg-b ${h.verification === '확인' ? 'is-ok' : 'is-warn'}`}>검증 {h.verification ?? '없음'}</span>
  </span>;
}

function Move({ h, rank, reranked }: { h: Hit; rank: number; reranked: boolean }) {
  if (!reranked) return null;
  const d = h.vector_rank - rank;
  if (d === 0) return <span className="pg-move is-same">그대로</span>;
  return <span className={`pg-move ${d > 0 ? '' : 'is-down'}`}>{d > 0 ? `↑${d}` : `↓${-d}`}<br />원래 {h.vector_rank}등</span>;
}

function Detail({ h, rank, reranked, openKnowledge }: { h: Hit; rank: number; reranked: boolean; openKnowledge: () => void }) {
  return <div className="pg-detail-body">
    <div><small>{rank}번 근거 후보</small><h2>{lastHeading(h)}</h2><p className="pg-crumb">{h.heading_path.split(' > ').map(clean).join(' › ')}</p></div>
    <div className="pg-scores">
      {reranked && <div><small>리랭크 점수</small><b>{h.score.toFixed(3)}</b><small>{rank}등</small></div>}
      <div><small>벡터 유사도</small><b>{h.vector_score.toFixed(3)}</b><small>{reranked ? `원래 ${h.vector_rank}등` : `${rank}등`}</small></div>
    </div>
    {doubtful(h.verification) && <p className="pg-callout">검증 상태가 “{h.verification ?? '없음'}”이에요. 문서에 적힌 내용이고, 지금 실제로 그렇게 동작하는지는 확인되지 않았어요.</p>}
    <dl className="pg-dl">
      <dt>출처</dt><dd>{h.source_repo} / {h.source_path}</dd>
      <dt>커밋</dt><dd>{h.source_commit.slice(0, 12)}</dd>
      <dt>환경</dt><dd>{h.env ?? '—'}</dd>
      <dt>자료 성격</dt><dd>{h.doc_type ?? '—'}</dd>
      <dt>검증</dt><dd>{h.verification ?? '—'}{h.checked_at ? ` · ${h.checked_at} 확인` : ''}</dd>
      <dt>조각</dt><dd>{h.chunk_index + 1}번째 절</dd>
    </dl>
    <div><small>조각 원문</small><div className="pg-text">{body(h)}</div></div>
    <button className="subtle-button pg-open" onClick={openKnowledge}>Knowledge에서 문서 보기 <ArrowUpRight size={13} /></button>
  </div>;
}

// ---------- 진행 줄 ----------

function Progress({ run, now, stop }: { run: Run; now: number; stop: () => void }) {
  const s = run.start;
  const total = run.rerank?.total ?? s?.candidates ?? 0;
  const done = run.rerank?.done ?? 0;
  const rerankOn = !!s?.reranker;
  const rerankSince = run.rerankFrom ? Math.max(0, now - run.rerankFrom) / 1000 : 0;
  // 남은 시간: 첫 묶음이 끝나기 전에는 잰 값(조각 1개 약 3.4초), 그 뒤에는 지금까지의 실제 속도로 계산한다.
  const perChunk = run.rerank && run.rerank.done ? run.rerank.ms / 1000 / run.rerank.done : SEC_PER_CHUNK;
  const left = Math.max(0, total * perChunk - rerankSince);
  type Step = { key: string; title: string; note: string; state: 'done' | 'run' | 'wait'; bar?: number };
  const steps: Step[] = [
    { key: 'embed', title: '질문 임베딩', note: run.embedMs != null ? `${s?.embedder.split(' · ').slice(-1)[0] ?? ''} · ${secs(run.embedMs)}` : s?.external ? '외부 모델로 보내는 중' : '벡터로 바꾸는 중', state: run.embedMs != null ? 'done' : 'run' },
    { key: 'db', title: '후보 찾기', note: run.dbMs != null ? `벡터 검색 · ${run.candidates}개 · ${secs(run.dbMs)}` : '벡터 검색', state: run.dbMs != null ? 'done' : run.embedMs != null ? 'run' : 'wait' },
  ];
  if (rerankOn) steps.push({ key: 'rerank', title: `리랭크 ${done} / ${total}`, note: run.dbMs == null ? `후보 ${total}개 · 약 ${short(total * SEC_PER_CHUNK)}` : `${short(rerankSince)} 지남 · 약 ${short(left)} 남음`, state: run.dbMs != null ? 'run' : 'wait', bar: total ? done / total : 0 });
  steps.push({ key: 'sort', title: '정리', note: `상위 ${s?.top_k ?? ''}개`, state: 'wait' });
  return <Card className="pg-progress">
    {steps.map((st, i) => <div key={st.key} className={`pg-step is-${st.state}`}>
      <span className="pg-dot">{st.state === 'done' ? <Check size={13} /> : st.state === 'run' ? <LoaderCircle size={13} className="spin" /> : i + 1}</span>
      <div><b>{st.title}</b><small>{st.note}</small>{st.bar != null && <span className="pg-bar"><motion.i animate={{ width: `${st.bar * 100}%` }} transition={{ duration: 0.4, ease }} /></span>}</div>
    </div>)}
    <button className="subtle-button pg-stop" onClick={stop}><Square size={11} />멈추기</button>
  </Card>;
}

// ---------- 결과 ----------

function Results({ run, openKnowledge }: { run: Run; openKnowledge: () => void }) {
  const final = run.phase === 'done' && !!run.hits;
  const hits = (final ? run.hits : run.vectorHits) ?? [];
  const reranked = final && !!run.start?.reranker;
  const [sel, setSel] = useState(0);
  const [openInline, setOpenInline] = useState<number | null>(null);
  useEffect(() => { setSel(0); setOpenInline(null); }, [run.startedAt, final]);
  const lat = run.latency;

  if (!hits.length) return run.phase === 'running'
    ? <Card className="pg-list">{[0, 1, 2].map(i => <div key={i} className="pg-skel" />)}</Card>
    : <Card className="pg-list"><p className="pg-empty-note">찾은 조각이 없어요. 색인에 조각이 있는지 확인해 주세요.</p></Card>;

  return <div className={`pg-results ${final ? '' : 'is-solo'}`}>
    <Card className={`pg-list ${final ? '' : 'is-pending'}`}>
      <div className="pg-list-head"><h2>근거 후보{final ? ` ${hits.length}개` : ''}</h2>
        <small>{final
          ? `${reranked ? `후보 ${run.candidates}개 중 리랭크 점수 상위 ${hits.length}개` : `벡터 유사도 상위 ${hits.length}개`}${lat ? ` · ${secs(lat.embed + lat.db)}${reranked ? ` + 리랭크 ${secs(lat.rerank)}` : ''}` : ''}`
          : run.phase === 'running' ? '리랭크가 끝나면 순서가 정해져요. 지금은 벡터 검색 순서예요.' : '멈춘 검색이에요. 벡터 검색 순서까지만 나왔어요.'}</small></div>
      {hits.map((h, i) => {
        const dup = sameAs(hits, i);
        const isOpen = openInline === i;
        return <React.Fragment key={h.chunk_id}>
          <motion.button className={`pg-hit ${final && sel === i ? 'is-selected' : ''}`} disabled={!final} aria-expanded={final ? isOpen : undefined}
            onClick={() => { setSel(i); setOpenInline(isOpen ? null : i); }}
            initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04, duration: 0.3, ease }}>
            <span className="pg-rank-col"><span className="pg-rank">{i + 1}</span><Move h={h} rank={i + 1} reranked={reranked} /></span>
            <span className="pg-hit-main">
              <span className="pg-hit-title">{lastHeading(h)}</span>
              <span className="pg-hit-doc">{docTitle(h)}</span>
              {final && <span className="pg-hit-snip">{plain(body(h)).slice(0, 240)}</span>}
              {final && <Badges h={h} />}
            </span>
            <span className="pg-score"><b>{(reranked ? h.score : h.vector_score).toFixed(2)}</b><small>{reranked ? '리랭크 점수' : '벡터 유사도'}</small>
              <span className="pg-sbar"><i style={{ width: `${Math.max(0, Math.min(1, reranked ? h.score : h.vector_score)) * 100}%` }} /></span></span>
          </motion.button>
          {dup != null && <p className="pg-same">≈ {dup + 1}번과 같은 절이에요 (다른 문서에 같은 내용이 있어요)</p>}
          <AnimatePresence initial={false}>{final && isOpen && <motion.div className="pg-inline" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.25, ease }}>
            <Detail h={h} rank={i + 1} reranked={reranked} openKnowledge={openKnowledge} />
          </motion.div>}</AnimatePresence>
        </React.Fragment>;
      })}
    </Card>
    {final && <Card className="pg-detail"><AnimatePresence mode="wait" initial={false}>
      <motion.div key={hits[sel]?.chunk_id} initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -6 }} transition={{ duration: 0.2 }}>
        {hits[sel] && <Detail h={hits[sel]} rank={sel + 1} reranked={reranked} openKnowledge={openKnowledge} />}
      </motion.div></AnimatePresence></Card>}
  </div>;
}

// ---------- 페이지 ----------

export function Playground({ openPipeline, openKnowledge }: { openPipeline: () => void; openKnowledge: () => void }) {
  const { setup } = useSetup();
  const { run, ask, stop } = useSearch();
  const [input, setInput] = useState('');
  const [mode, setMode] = useState<'setting' | 'off'>('setting');
  const [recent, setRecent] = useState<string[]>(loadRecent);
  const [now, setNow] = useState(Date.now());
  const box = useRef<HTMLTextAreaElement>(null);
  const running = run?.phase === 'running';
  const rerankSetting = setup?.query.reranker;

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [running]);
  useEffect(() => {
    const el = box.current;
    if (el) { el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 120)}px`; }
  }, [input]);

  function submit(q = input) {
    const question = q.trim();
    if (!question || running) return;
    setInput(question);
    const next = [question, ...recent.filter(x => x !== question)].slice(0, 5);
    setRecent(next);
    try { localStorage.setItem(RECENT, JSON.stringify(next)); } catch { /* storage unavailable */ }
    void ask(question, rerankSetting ? mode : 'off');
  }

  const minutes = rerankSetting ? Math.max(1, Math.round(Number(rerankSetting.params.candidates) * SEC_PER_CHUNK / 60)) : 0;
  return <>
    <div className="pg-head"><div><h1>Playground</h1><p>질문을 넣으면 지금 설정으로 근거 조각을 찾아요. 답변 생성은 다음 단계예요.</p></div>
      <SetupLine setup={setup} openPipeline={openPipeline} /></div>

    <Card className="pg-ask">
      <form className="pg-ask-row" onSubmit={e => { e.preventDefault(); submit(); }}>
        <textarea ref={box} rows={1} aria-label="질문" placeholder="문서에 대해 물어보세요" maxLength={2000} value={input}
          onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }} />
        <button className="pg-send" disabled={!input.trim() || running} aria-label="검색">{running ? <LoaderCircle size={18} className="spin" /> : <ArrowUp size={18} />}</button>
      </form>
      <div className="pg-ask-foot">
        {rerankSetting ? <><span className="segmented pg-seg" role="radiogroup" aria-label="리랭크">
          {([['setting', `리랭크 켜고 (약 ${minutes}분)`], ['off', '리랭크 없이 (1초 안팎)']] as const).map(([v, label]) =>
            <button key={v} type="button" role="radio" aria-checked={mode === v} className={mode === v ? 'is-on' : ''} disabled={running} onClick={() => setMode(v)}>
              {mode === v && <motion.span className="segmented-bg" layoutId="pg-seg" transition={{ type: 'spring', stiffness: 360, damping: 30 }} />}<span>{label}</span></button>)}
        </span><small>이번 질문에만 적용돼요. 설정은 바뀌지 않아요.</small></>
          : <small>리랭크가 꺼져 있어요. Pipeline의 Rerank 카드에서 켤 수 있어요.</small>}
        {setup?.index.external && <small className="pg-ext"><CircleAlert size={12} />질문이 {setup.index.label.embedder.split(' ')[0]}로 보내져요 (임베딩)</small>}
      </div>
    </Card>

    {!run && <Card className="pg-empty"><div className="pg-orb" /><h2>문서에 물어보세요</h2>
      <p>질문과 가까운 조각을 찾고{rerankSetting ? ', 리랭커로 순서를 다시 매겨요' : '아요'}. 조각마다 어느 문서에서 왔는지와 검증 상태가 함께 나와요.</p>
      {recent.length > 0 && <div className="pg-recent"><small>최근 질문</small>{recent.map(q => <button key={q} onClick={() => submit(q)}>{q}</button>)}</div>}
    </Card>}

    {run && <>
      <AnimatePresence initial={false}>{running && <motion.div key="progress" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.25, ease }}>
        <Progress run={run} now={now} stop={stop} /></motion.div>}</AnimatePresence>
      {(run.phase === 'error' || run.phase === 'stopped') && <p className={`pg-note ${run.phase === 'error' ? 'is-error' : ''}`}><CircleAlert size={13} />{run.phase === 'error' ? run.error : '검색을 멈췄어요.'}</p>}
      <Card className="pg-answer"><span className="pg-answer-ic"><Sparkles size={15} /></span>
        <div><b>답변은 아직 만들지 않아요</b><small>지금은 근거가 될 조각만 보여 줘요. 답변 생성이 연결되면 여기에 답과 근거 번호가 나와요.</small></div></Card>
      <Results run={run} openKnowledge={openKnowledge} />
      {recent.length > 1 && !running && <div className="pg-recent is-foot"><small>최근 질문</small>{recent.filter(q => q !== run.question).map(q => <button key={q} onClick={() => submit(q)}>{q}</button>)}</div>}
    </>}
  </>;
}
