// 설정 바꾸기: 한 화면에 질문 하나씩 묻고, 마지막에 바뀌는 것만 모아 한 번에 적용한다.
// 화면 나누기: 서랍 폭·진행 표시·아래 영향 줄과 버튼 = Fixed, 가운데 선택지 = Fluid, 뒤의 Pipelines 화면 = Hybrid.
// 선택지는 엔진의 GET /components 목록에서 만든다. 아는 구현(id)만 한국어 설명을 덧붙이고, 모르는 것은 엔진 설명을 그대로 쓴다.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ArrowUpRight, Check, CircleAlert, LoaderCircle, Minus, Plus } from 'lucide-react';
import { api } from './ui';
import { Drawer } from './questionset';
import {
  defaults, settingKey, type BuildResponse, type Catalog, type Estimate, type PanelStage, type SetupApi, type Spec, type StageSetting,
} from './setup';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const SEC_PER_CHUNK = 3.4;   // Mac CPU에서 리랭크 조각 1개에 걸린 평균 시간 (2026-11-10 측정)

export const FLOW_STEPS = ['chunker', 'embedder', 'query', 'keyword', 'reranker', 'generator', 'review'] as const;
type StepKey = typeof FLOW_STEPS[number];
export const stepOf = (stage: PanelStage) => Math.max(0, FLOW_STEPS.indexOf(stage));

type Draft = { chunker: StageSetting; embedder: StageSetting; top_k: number; keyword: StageSetting | null; reranker: StageSetting | null; generator: StageSetting | null };
// 선택지 카드 하나. primary가 있으면 그 파라미터 값까지 같아야 "같은 선택"이다 (예: OpenAI small / large).
type Choice = { key: string; title: string; desc: string; where?: 'Local' | 'External'; meta?: string; spec: Spec | null; primary?: [string, string]; dim?: string };

const QUESTIONS: Record<StepKey, { q: string; sub: string }> = {
  chunker: { q: '문서를 어떻게 자를까요?', sub: '조각 하나가 검색의 단위예요. 바꾸면 조각을 전부 다시 만들어요.' },
  embedder: { q: '어떤 모델로 뜻을 비교할까요?', sub: '조각과 질문을 숫자(벡터)로 바꿔 비슷한 것끼리 찾아요. 모델이 바뀌면 조각을 전부 다시 바꿔야 해요.' },
  query: { q: '질문 하나에 조각을 몇 개 찾아올까요?', sub: '많으면 근거가 많아지지만 엉뚱한 조각도 섞여요.' },
  keyword: { q: '낱말이 똑같은 글도 같이 찾을까요?', sub: '벡터 검색은 뜻이 비슷한 글, 키워드 검색은 질문의 낱말이 그대로 있는 글을 찾아요. 명령어·설정 이름·포트 번호를 물을 때 도움이 돼요.' },
  reranker: { q: '찾은 조각을 다시 줄 세울까요?', sub: '리랭커가 질문과 조각을 같이 읽고 순서를 다시 매겨요. 정확해질 수 있지만 느려요.' },
  generator: { q: '찾은 조각으로 답을 써 줄까요?', sub: 'LLM이 위쪽 조각 몇 개를 읽고 짧게 답하고, [1] [2]로 근거를 달아요.' },
  review: { q: '이렇게 바꿀까요?', sub: '' },
};
const NAMES: Record<Exclude<StepKey, 'review'>, string> = {
  chunker: '자르기', embedder: '뜻 비교 모델', query: '찾을 개수', keyword: '낱말 검색', reranker: '다시 줄 세우기', generator: '답 쓰기',
};
// [자세히]에 접어 두는 값의 한국어 이름과 선택지 이름
const PARAM_LABEL: Record<string, string> = { dimensions: '차원 수', candidates: '다시 볼 후보 수', max_output: '답 길이', model: '모델', sources: '보낼 근거 수' };
const CHOICE_LABEL: Record<string, Record<string, string>> = {
  dimensions: { default: '모델 기본' },
  max_output: { '200': '짧게 · 200토큰', '400': '보통 · 400토큰', '800': '길게 · 800토큰' },
  sources: { '3': '3개', '5': '5개' },
};

const where = (spec: Spec): 'Local' | 'External' => (spec.external ? 'External' : 'Local');
const fromSpec = (spec: Spec): Choice => ({ key: spec.id, title: spec.label, desc: spec.description, where: where(spec), spec, dim: spec.status !== 'ready' || !spec.available ? spec.reason || '준비 중' : undefined });
const off = (desc: string): Choice => ({ key: 'off', title: desc.split('|')[0], desc: desc.split('|')[1], spec: null });

function choicesFor(step: StepKey, catalog: Catalog): Choice[] {
  if (step === 'chunker') return catalog.chunker.flatMap(spec => spec.id === 'heading'
    ? [{ key: 'heading:path', title: '제목마다 자르고, 위 제목들을 앞에 붙이기', desc: '“TLS › 인증서 갱신 › 와일드카드”처럼 어느 절인지 같이 들어가요. 짧은 절도 뜻이 살아요.', spec, primary: ['prefix', 'path'] as [string, string] },
       { key: 'heading:none', title: '제목마다 자르고, 본문만', desc: '조각에 그 절의 글만 들어가요.', spec, primary: ['prefix', 'none'] as [string, string] }]
    : [fromSpec(spec)]);
  if (step === 'embedder') return catalog.embedder.flatMap(spec => {
    if (spec.id === 'tei-bge-m3') return [{ ...fromSpec(spec), title: 'bge-m3', desc: '이 컴퓨터에서 돌아요. 한국어 지원, 비용 없음.', meta: `조각당 최대 ${(spec.max_tokens ?? 0).toLocaleString()} 토큰` }];
    if (spec.id === 'openai') return [
      { ...fromSpec(spec), key: 'openai:small', title: 'OpenAI small', desc: '조각 원문이 OpenAI로 나가요. 빠르고 저렴해요.', meta: `text-embedding-3-small · 조각당 최대 ${(spec.max_tokens ?? 0).toLocaleString()} 토큰`, primary: ['model', 'text-embedding-3-small'] as [string, string] },
      { ...fromSpec(spec), key: 'openai:large', title: 'OpenAI large', desc: '더 정확할 수 있지만 비용이 small의 약 6배예요.', meta: `text-embedding-3-large · 조각당 최대 ${(spec.max_tokens ?? 0).toLocaleString()} 토큰`, primary: ['model', 'text-embedding-3-large'] as [string, string] },
    ];
    return [fromSpec(spec)];
  });
  if (step === 'keyword') return [off('안 쓰기|뜻으로만 찾아요.'), ...catalog.keyword.flatMap(spec => spec.id === 'bm25-kiwi'
    ? [{ ...fromSpec(spec), key: 'bm25:hybrid', title: '뜻 + 낱말 순위 합치기', desc: '두 검색의 순위를 섞어요(RRF). 질문 10개 시험에서 1등 적중 70% → 80%.', primary: ['mode', 'hybrid'] as [string, string] },
       { ...fromSpec(spec), key: 'bm25:keyword', title: '낱말로만 찾기', desc: '벡터 순위를 쓰지 않아요. 비교 실험용이에요.', primary: ['mode', 'keyword'] as [string, string] }]
    : [fromSpec(spec)])];
  if (step === 'reranker') return [off('안 하기|검색 순서 그대로 써요.'), ...catalog.reranker.map(spec => spec.id === 'tei-bge-reranker'
    ? { ...fromSpec(spec), title: 'bge-reranker로 다시 줄 세우기', desc: '이 컴퓨터에서 돌아요. 이 Mac(CPU)에서는 많이 느려요.' } : fromSpec(spec))];
  if (step === 'generator') return [off('안 쓰기|조각만 보여 줘요.'), ...catalog.generator.map(spec => spec.id === 'openai-llm'
    ? { ...fromSpec(spec), title: 'OpenAI LLM으로 답 쓰기', desc: '질문과 위쪽 조각이 OpenAI로 나가요. 외부 전송을 허용한 문서만 보내요.' } : fromSpec(spec))];
  return [];
}

const matches = (c: Choice, s: StageSetting | null) =>
  c.spec === null ? s === null : !!s && s.id === c.spec.id && (!c.primary || s.params[c.primary[0]] === c.primary[1]);
// 카드를 고르면: 같은 구현이면 나머지 값은 두고 대표 값만 바꾸고, 다른 구현이면 기본값에서 시작한다.
function pickSetting(c: Choice, cur: StageSetting | null): StageSetting | null {
  if (!c.spec) return null;
  const base = cur?.id === c.spec.id ? cur.params : defaults(c.spec);
  return { id: c.spec.id, params: c.primary ? { ...base, [c.primary[0]]: c.primary[1] } : base };
}
const same = (a: StageSetting | null, b: StageSetting | null) => (a && b ? settingKey(a) === settingKey(b) : a === b);

// 확인 화면에 쓰는 짧은 이름
function label(step: Exclude<StepKey, 'review'>, d: Draft, catalog: Catalog): string {
  const v = step === 'query' ? null : d[step];
  if (step === 'query') return `${d.top_k}개`;
  if (!v) return step === 'reranker' ? '안 함' : '안 씀';
  const c = choicesFor(step, catalog).find(x => matches(x, v));
  const name = c?.title ?? v.id;
  const extra = Object.entries(v.params).filter(([k, val]) => k !== c?.primary?.[0] && k !== 'mode' && k !== 'prefix'
    && val !== catalog[step === 'chunker' ? 'chunker' : step].find(s => s.id === v.id)?.params.find(p => p.name === k)?.default)
    .map(([k, val]) => `${PARAM_LABEL[k] ?? k} ${CHOICE_LABEL[k]?.[val] ?? val}`);
  const short = step === 'chunker' ? (v.params.prefix === 'none' ? '제목, 본문만' : '제목 + 위 제목 붙임')
    : step === 'keyword' ? (v.params.mode === 'keyword' ? '낱말로만' : '뜻 + 낱말')
    : step === 'reranker' ? `켬 · 후보 ${v.params.candidates}개`
    : step === 'generator' ? `켬 · ${v.params.model} · 근거 ${v.params.sources}개` : name;
  return [short, ...(step === 'reranker' || step === 'generator' ? [] : extra)].join(' · ');
}

export function SetupFlow({ open, start, s, catalog, busy, onClose, onBuild, openKnowledge }: {
  open: boolean; start: number; s: SetupApi; catalog: Catalog | null; busy: boolean;
  onClose: () => void; onBuild: (r: BuildResponse) => void; openKnowledge: () => void;
}) {
  const setup = s.setup;
  const [at, setAt] = useState(start);
  const [dir, setDir] = useState(1);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [checking, setChecking] = useState(false);
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [naming, setNaming] = useState<string | null>(null);   // [이름 붙여 저장]을 누르면 이름 칸이 열린다
  const asked = useRef(0);

  // 열 때마다 지금 설정에서 시작한다.
  const base: Draft | null = useMemo(() => setup ? {
    chunker: setup.index.chunker, embedder: setup.index.embedder, top_k: setup.query.top_k,
    keyword: setup.query.keyword, reranker: setup.query.reranker, generator: setup.query.generator,
  } : null, [setup]);
  useEffect(() => {
    if (!open) return;
    setAt(start); setDir(1); setDraft(base); setProblem(null); setNaming(null);
  }, [open]);   // eslint-disable-line react-hooks/exhaustive-deps
  // 다른 화면에서 바로 열면 설정이 아직 안 왔을 수 있다. 도착하면 그때 채운다.
  useEffect(() => { if (open && !draft && base) setDraft(base); }, [open, base, draft]);

  const indexKey = draft ? `${settingKey(draft.chunker)}|${settingKey(draft.embedder)}` : '';
  const indexChanged = !!draft && !!setup && indexKey !== setup.index.key;
  // 자르기·모델이 지금 색인과 다르면, 그 조합이 이미 있는지·만들려면 무엇이 드는지 엔진에 묻는다.
  useEffect(() => {
    if (!open || !draft || !indexChanged) { setEstimate(null); setChecking(false); return; }
    const ticket = ++asked.current;
    setChecking(true);
    const timer = setTimeout(() => {
      api<Estimate>('/indexes/estimate', { method: 'POST', body: { chunker: draft.chunker, embedder: draft.embedder, apply: true } })
        .then(e => { if (asked.current === ticket) setEstimate(e); })
        .catch(e => { if (asked.current === ticket) setProblem(message(e)); })
        .finally(() => { if (asked.current === ticket) setChecking(false); });
    }, 200);
    return () => clearTimeout(timer);
  }, [open, indexKey]);   // eslint-disable-line react-hooks/exhaustive-deps

  const changes = useMemo(() => !draft || !base ? [] : (Object.keys(NAMES) as (keyof typeof NAMES)[]).filter(k =>
    k === 'query' ? draft.top_k !== base.top_k : !same(draft[k], base[k])), [draft, base]);
  const needsBuild = indexChanged && !!estimate && !estimate.ready;

  function go(next: number) {
    if (next < 0 || next >= FLOW_STEPS.length) return;
    setDir(next > at ? 1 : -1); setAt(next); setProblem(null);
  }
  function close() {
    if (changes.length && !working && !window.confirm('바꾼 설정을 적용하지 않고 닫을까요?')) return;
    onClose();
  }
  // Esc 닫기 · 글 쓰는 중이 아니면 ←→로 단계 이동
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = e => {
    if (!open || e.isComposing) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  };
  useEffect(() => {
    const on = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);

  async function apply(saveName?: string) {
    if (!draft || !base || !setup) return;
    setWorking(true); setProblem(null);
    const body: Parameters<SetupApi['update']>[0] = {};
    if (draft.top_k !== base.top_k) body.top_k = draft.top_k;
    for (const k of ['keyword', 'reranker', 'generator'] as const) if (!same(draft[k], base[k])) body[k] = draft[k] ?? 'off';
    if (indexChanged && estimate?.ready && estimate.index_id) body.index_id = estimate.index_id;
    let err = Object.keys(body).length ? await s.update(body) : null;
    if (!err && needsBuild) {
      const r = await s.buildIndex(draft.chunker, draft.embedder);
      if (typeof r === 'string') err = r; else onBuild(r);
    }
    if (!err && saveName) err = await s.saveAs(saveName);
    setWorking(false);
    if (err) setProblem(err); else onClose();
  }

  const step = FLOW_STEPS[at];
  const ready = !!catalog && !!draft && !!setup && !!base;
  return <Drawer open={open} title="설정 바꾸기" contentKey={step} dir={dir} onClose={close}>
    {!ready ? <p className="muted">{s.error ?? '설정을 불러오는 중…'}</p> : <>
      <div className="sf-steps" aria-label={`${at + 1} / ${FLOW_STEPS.length} 단계`}>
        {FLOW_STEPS.map((k, i) => <button key={k} className={i === at ? 'on' : i < at ? 'past' : ''} aria-label={k === 'review' ? '확인' : NAMES[k]} title={k === 'review' ? '확인' : NAMES[k]} onClick={() => go(i)} />)}
        <span>{at + 1} / {FLOW_STEPS.length}</span>
      </div>
      {step === 'review'
        ? <Review draft={draft!} base={base!} catalog={catalog!} changes={changes} goTo={go} />
        : <Step step={step} draft={draft!} base={base!} catalog={catalog!} set={next => setDraft(next)} />}
      <div className="qs-wiz-foot sf-foot">
        <Impact step={step} draft={draft!} indexChanged={indexChanged} checking={checking} estimate={estimate}
          current={setup!} changes={changes} busy={busy} openKnowledge={openKnowledge} />
        {problem && <p className="qs-check error" role="alert"><CircleAlert size={13} />{problem}</p>}
        {naming !== null && <form className="sf-name" onSubmit={e => { e.preventDefault(); if (naming.trim()) void apply(naming.trim()); }}>
          <input aria-label="설정 이름" autoFocus maxLength={60} value={naming} onChange={e => setNaming(e.target.value)} placeholder="예: OpenAI small + 키워드" />
          <button className="qs-btn qs-btn-dark" disabled={!naming.trim() || working}>저장하고 적용</button>
          <button type="button" className="qs-btn qs-btn-ghost" onClick={() => setNaming(null)}>취소</button>
        </form>}
        <div className="sf-nav">
          {at > 0 ? <button className="qs-btn qs-btn-ghost" onClick={() => go(at - 1)}><ArrowLeft size={13} />이전</button> : <span />}
          {step !== 'review'
            ? <button className="qs-btn qs-btn-dark" onClick={() => go(at + 1)}>{stepChanged(step, draft!, base!) ? '다음' : '그대로 두기'}<ArrowRight size={13} /></button>
            : !changes.length ? <button className="qs-btn qs-btn-dark" onClick={onClose}>닫기</button>
            : <button className="qs-btn qs-btn-dark" disabled={working || checking || (indexChanged && (!estimate || (needsBuild && (!estimate.can_build || busy))))} onClick={() => void apply()}>
                {working ? <LoaderCircle size={13} className="spin" /> : <Check size={13} />}{needsBuild ? '색인 만들고 적용' : '적용'}</button>}
        </div>
        {step === 'review' && changes.length > 0 && naming === null && (needsBuild
          ? <small className="sf-hint">색인을 다 만든 뒤 위 띠의 [Save as]로 이름을 붙일 수 있어요.</small>
          : <button className="text-button sf-save" onClick={() => setNaming('')}>이름 붙여 저장하고 적용</button>)}
      </div>
    </>}
  </Drawer>;
}

const stepChanged = (step: StepKey, d: Draft, b: Draft) => step === 'review' ? false : step === 'query' ? d.top_k !== b.top_k : !same(d[step], b[step]);

function Step({ step, draft, base, catalog, set }: { step: Exclude<StepKey, 'review'>; draft: Draft; base: Draft; catalog: Catalog; set: (d: Draft) => void }) {
  const text = QUESTIONS[step];
  if (step === 'query') return <div className="qs-step sf-step">
    <h3>{text.q}</h3><p className="sf-sub">{text.sub}</p>
    <div className="sf-stepper">
      <button aria-label="하나 줄이기" disabled={draft.top_k <= 1} onClick={() => set({ ...draft, top_k: draft.top_k - 1 })}><Minus size={16} /></button>
      <b aria-live="polite">{draft.top_k}</b>
      <button aria-label="하나 늘리기" disabled={draft.top_k >= 20} onClick={() => set({ ...draft, top_k: draft.top_k + 1 })}><Plus size={16} /></button>
      {draft.top_k === base.top_k && <span className="sf-now">지금</span>}
    </div>
    <p className="sf-note">평가 점수는 늘 위 10개로 매겨서, 이 값은 점수를 바꾸지 않아요. Playground에 보이는 조각 수와 답에 쓸 후보가 바뀌어요.</p>
  </div>;

  const cur = draft[step];
  const list = choicesFor(step, catalog);
  const spec = cur ? catalog[step].find(x => x.id === cur.id) ?? null : null;
  const picked = list.find(c => matches(c, cur));
  // 대표 값과 보낼 근거 수는 겉에, 나머지 값은 [자세히]에 둔다.
  const shownOutside = step === 'generator' ? ['sources'] : [];
  const inner = spec?.params.filter(p => p.name !== picked?.primary?.[0] && !shownOutside.includes(p.name)) ?? [];
  const setParam = (name: string, value: string) => cur && set({ ...draft, [step]: { ...cur, params: { ...cur.params, [name]: value } } });

  return <div className="qs-step sf-step">
    <h3>{text.q}</h3><p className="sf-sub">{text.sub}</p>
    <div className="sf-opts" role="radiogroup" aria-label={NAMES[step]}>{list.map(c => {
      const on = matches(c, cur);
      return <button key={c.key} role="radio" aria-checked={on} disabled={!!c.dim} className={`sf-opt ${on ? 'is-on' : ''} ${c.dim ? 'is-dim' : ''}`}
        onClick={() => set({ ...draft, [step]: pickSetting(c, cur) } as Draft)}>
        <span className="sf-radio" />
        <span className="sf-opt-body">
          <span className="sf-opt-head"><b>{c.title}</b>{c.where && <span className={`where-badge ${c.where === 'External' ? 'is-external' : ''}`}>{c.where}</span>}{matches(c, base[step]) && <span className="sf-now">지금</span>}</span>
          <small>{c.desc}</small>
          {c.meta && <span className="sf-meta">{c.meta}</span>}
          {c.dim && <em className="sf-dim"><CircleAlert size={11} />{c.dim}</em>}
        </span>
      </button>;
    })}</div>
    {spec && cur && shownOutside.map(name => { const p = spec.params.find(x => x.name === name); return p && <Seg key={name} label={PARAM_LABEL[name] ?? p.label} name={name} param={p} value={cur.params[name] ?? p.default} set={v => setParam(name, v)} />; })}
    {spec && cur && inner.length > 0 && <details className="sf-more"><summary>자세히</summary>
      {inner.map(p => <Seg key={p.name} label={PARAM_LABEL[p.name] ?? p.label} name={p.name} param={p} value={cur.params[p.name] ?? p.default} set={v => setParam(p.name, v)} help={p.help} />)}
    </details>}
    {step === 'chunker' && <p className="sf-note">다른 자르는 방식(고정 길이, 의미 단위)은 직접 만들 차례예요.</p>}
  </div>;
}

function Seg({ label: text, name, param, value, set, help }: { label: string; name: string; param: Spec['params'][number]; value: string; set: (v: string) => void; help?: string }) {
  return <div className="sf-seg-row"><small>{text}</small>
    <div className="segmented" role="radiogroup" aria-label={text}>{param.choices.map(([v, l]) => <button key={v} role="radio" aria-checked={value === v} className={value === v ? 'is-on' : ''} onClick={() => set(v)}>
      <span>{CHOICE_LABEL[name]?.[v] ?? l}</span></button>)}</div>
    {help && <small className="sf-help">{help}</small>}
  </div>;
}

function Review({ draft, base, catalog, changes, goTo }: { draft: Draft; base: Draft; catalog: Catalog; changes: string[]; goTo: (i: number) => void }) {
  return <div className="qs-step sf-step">
    <h3>{changes.length ? QUESTIONS.review.q : '바뀐 게 없어요'}</h3>
    <p className="sf-sub">{changes.length ? `${changes.length}가지가 바뀌어요. [고치기]로 그 단계에 돌아갈 수 있어요.` : '고친 단계가 없어서 지금 설정 그대로예요.'}</p>
    <div className="sf-diff">{(Object.keys(NAMES) as (keyof typeof NAMES)[]).map((k, i) => {
      const ch = changes.includes(k);
      return <div key={k} className={`sf-drow ${ch ? 'is-changed' : ''}`}>
        <span className="sf-dk">{NAMES[k]}</span>
        <span className="sf-dv">{ch ? <><s>{label(k, base, catalog)}</s><ArrowRight size={12} /><b>{label(k, draft, catalog)}</b></> : label(k, base, catalog)}</span>
        <button className="sf-edit" onClick={() => goTo(i)}>고치기</button>
      </div>;
    })}</div>
  </div>;
}

// 아래 영향 줄: 지금 고른 값이 무엇을 바꾸는지 (바로 바뀜 / 색인 만들기 / 외부로 나감 / 느려짐).
function Impact({ step, draft, indexChanged, checking, estimate, current, changes, busy, openKnowledge }: {
  step: StepKey; draft: Draft; indexChanged: boolean; checking: boolean; estimate: Estimate | null;
  current: NonNullable<SetupApi['setup']>; changes: string[]; busy: boolean; openKnowledge: () => void;
}) {
  const lines: React.ReactNode[] = [];
  const indexLine = () => {
    if (!indexChanged) return <p key="i" className="sf-impact is-ok"><Check size={13} />지금 쓰는 색인 #{current.index.id} 그대로예요 · 조각 {current.index.chunks}개</p>;
    if (checking || !estimate) return <p key="i" className="sf-impact"><LoaderCircle size={13} className="spin" />이 조합의 색인이 있는지 보는 중…</p>;
    if (estimate.ready) return <p key="i" className="sf-impact is-ok"><Check size={13} />이미 만든 색인 #{estimate.index_id}이 있어요 · 적용하면 바로 바뀌어요</p>;
    const e = estimate;
    const facts = [`문서 ${e.documents_pending}/${e.documents_total}개`, `조각 약 ${e.chunks_pending.toLocaleString()}개`, e.tokens != null ? `약 ${e.tokens.toLocaleString()} 토큰` : null].filter(Boolean).join(' · ');
    return <div key="i" className={`sf-impact ${e.external ? 'is-warn' : ''}`}><CircleAlert size={13} /><span>
      <b>{e.index_id ? '색인에 빠진 문서를 채워야 해요' : '색인을 새로 만들어야 해요'}</b> · {facts}
      {e.external && <><br />조각 원문이 {e.label.embedder.split(' · ')[0]}로 나가요. 외부 전송을 허용한 문서만 보낼 수 있어요.</>}
      {!e.available && <><br />{e.reason}</>}
      {e.blocked.length > 0 && <><br />외부 전송 불가 문서 {e.blocked.length}개 <button className="text-button" onClick={openKnowledge}>Knowledge에서 허용하기 <ArrowUpRight size={11} /></button></>}
      {e.missing_content.length > 0 && <><br />원문이 없는 문서 {e.missing_content.length}개 · 다시 넣어야 해요</>}
      {e.over_limit > 0 && <><br />이 모델 길이 한도를 넘는 조각 {e.over_limit}개</>}
      {busy && <><br />다른 작업이 돌고 있어요. 끝난 뒤에 만들 수 있어요.</>}
    </span></div>;
  };
  if (step === 'chunker' || step === 'embedder') lines.push(indexLine());
  else if (step === 'query' || step === 'keyword') lines.push(<p key="q" className="sf-impact is-ok"><Check size={13} />바로 바뀌어요 · 색인을 다시 만들 필요 없어요{step === 'keyword' && draft.keyword ? ' · 내 컴퓨터에서 계산해요' : ''}</p>);
  else if (step === 'reranker') lines.push(draft.reranker
    ? <p key="r" className="sf-impact is-warn"><CircleAlert size={13} />바로 바뀌어요 · 이 Mac(CPU)에서 질문 하나에 약 {Math.max(1, Math.round(Number(draft.reranker.params.candidates ?? 50) * SEC_PER_CHUNK / 60))}분 걸려요</p>
    : <p key="r" className="sf-impact is-ok"><Check size={13} />바로 바뀌어요</p>);
  else if (step === 'generator') lines.push(draft.generator
    ? <p key="g" className="sf-impact is-warn"><CircleAlert size={13} />바로 바뀌어요 · 질문과 위쪽 조각 {draft.generator.params.sources}개가 OpenAI로 나가요</p>
    : <p key="g" className="sf-impact is-ok"><Check size={13} />바로 바뀌어요</p>);
  else {
    if (!changes.length) lines.push(<p key="n" className="sf-impact"><Check size={13} />닫아도 아무것도 바뀌지 않아요</p>);
    if (changes.includes('chunker') || changes.includes('embedder')) lines.push(indexLine());
    if (changes.some(c => !['chunker', 'embedder'].includes(c))) lines.push(<p key="s" className="sf-impact is-ok"><Check size={13} />검색·답변 설정은 적용하는 즉시 바뀌어요</p>);
  }
  return <div className="sf-impacts" aria-live="polite">{lines}</div>;
}
