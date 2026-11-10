// 사용 기록: 질문마다 남긴 비용·지연·결과를 모아 본다. 엔진 GET /usage.
// 화면 나누기: 제목 = Fixed, 요약 카드 4개 = Hybrid(넓으면 4열, 좁으면 2열·1열), 일별 막대 = Fluid 폭 + Fixed 높이, 최근 질문 표 = Fluid(가로 스크롤).
import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { ArrowUpRight, Coins, MessageSquareText, RefreshCw, Timer, TriangleAlert } from 'lucide-react';
import { api, Card, ColorIcon, DetailRows, Heading, IconButton, Modal } from './ui';

type Summary = { questions: number; cost_usd: number; avg_ms: number | null; p95_ms: number | null; errors: number; tokens: number };
type Day = { day: string; questions: number; cost_usd: number; avg_ms: number | null; errors: number };
type Row = {
  id: number; created_at: string; status: 'ok' | 'error' | 'stopped'; question: string;
  setup: { embedder: string; reranker: string | null; generator: string | null; top_k: number; index_id: number };
  hits: { chunk_id: number; document_id: number; title: string | null; heading: string }[];
  answer: string | null; sources: number[] | null; embed_tokens: number; input_tokens: number; cached_tokens: number; output_tokens: number;
  cost_usd: number | null; latency_ms: { embed?: number; db?: number; rerank?: number; answer?: number; total?: number }; error: string | null;
  trace_id: string | null;
};
type Usage = { service: string; summary: { today: Summary; month: Summary; all: Summary }; daily: Day[]; recent: Row[]; grafana_url: string };

const statusTone: Record<Row['status'], { label: string; color: string }> = {
  ok: { label: '완료', color: 'lime' }, error: { label: '오류', color: 'peach' }, stopped: { label: '멈춤', color: 'neutral' },
};
const usd = (v: number | null | undefined) => {
  if (v == null) return '—';
  if (v === 0) return '$0';
  if (v < 0.000001) return '$0.000001 미만';
  return `$${v < 0.01 ? Number(v.toPrecision(2)).toFixed(Math.max(2, 1 - Math.floor(Math.log10(v)))) : v.toFixed(4)}`;
};
const ms = (v: number | null | undefined) => (v == null ? '—' : v < 1000 ? `${v}ms` : `${(v / 1000).toFixed(v < 10000 ? 1 : 0)}초`);
const when = (iso: string) => new Date(iso).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
// Grafana Explore에서 Tempo로 trace id 하나를 여는 주소. 보관 기간(72시간)이 지나면 빈 결과가 나온다.
const traceUrl = (base: string, id: string) => `${base.replace(/\/$/, '')}/explore?schemaVersion=1&orgId=1&panes=${encodeURIComponent(JSON.stringify({ a: { datasource: 'tempo', queries: [{ refId: 'A', datasource: { type: 'tempo', uid: 'tempo' }, queryType: 'traceql', query: id }], range: { from: 'now-7d', to: 'now' } } }))}`;
const clean = (s: string | null | undefined) => (s ?? '').replace(/^"(.*)"$/, '$1');

export function UsagePage({ openPlayground }: { openPlayground: () => void }) {
  const [data, setData] = useState<Usage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<Row | null>(null);

  async function load() {
    setLoading(true);
    try { setData(await api<Usage>('/usage')); setError(null); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    setLoading(false);
  }
  useEffect(() => { void load(); }, []);

  const s = data?.summary;
  return <>
    <Heading title="사용 기록" subtitle="Playground에서 한 질문마다 비용, 걸린 시간, 결과를 남겨요. 하루 경계는 한국 시간이에요.">
      <button className="subtle-button" onClick={() => void load()} disabled={loading}><RefreshCw size={15} className={loading ? 'spin' : ''} />새로고침</button>
    </Heading>

    <div className="queue-cards">
      <Card className="queue-card" delay={0}><ColorIcon icon={MessageSquareText} color="purple" small />
        <div><small>오늘 질문</small><strong>{s ? `${s.today.questions}개` : '—'}</strong><em>{s ? `이번 달 ${s.month.questions}개 · 전체 ${s.all.questions}개` : '불러오는 중'}</em></div></Card>
      <Card className="queue-card" delay={0.05}><ColorIcon icon={Coins} color="lime" small />
        <div><small>오늘 비용</small><strong>{s ? usd(s.today.cost_usd) : '—'}</strong><em>{s ? `토큰 ${s.today.tokens.toLocaleString()}개` : ' '}</em></div></Card>
      <Card className="queue-card" delay={0.1}><ColorIcon icon={Coins} color="blue" small />
        <div><small>이번 달 비용</small><strong>{s ? usd(s.month.cost_usd) : '—'}</strong><em>{s ? `전체 ${usd(s.all.cost_usd)}` : ' '}</em></div></Card>
      <Card className="queue-card" delay={0.15}><ColorIcon icon={s?.month.errors ? TriangleAlert : Timer} color={s?.month.errors ? 'peach' : 'neutral'} small />
        <div><small>이번 달 걸린 시간</small><strong>{s ? `평균 ${ms(s.month.avg_ms)}` : '—'}</strong><em>{s ? `느린 쪽(95%) ${ms(s.month.p95_ms)} · 오류 ${s.month.errors}개` : ' '}</em></div></Card>
    </div>
    {error && <p className="source-error queue-problems">{error}</p>}

    {data && <DailyChart days={data.daily} />}

    <div className="table-toolbar"><h2 className="usage-h2">최근 질문</h2><span className="tag">최근 50개</span></div>
    <Card className="table-card documents-table usage-table" delay={0.2}>
      <table>
        <thead><tr><th>시간</th><th>질문</th><th>상태</th><th>비용</th><th>걸린 시간</th><th>토큰</th><th /></tr></thead>
        <tbody>{(data?.recent ?? []).map((r, i) => <motion.tr key={r.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i, 14) * 0.02, duration: 0.3 }} onClick={() => setOpen(r)}>
          <td className="num">{when(r.created_at)}</td>
          <td><span className="doc-name"><b>{r.question}</b><small>{[r.setup.embedder, r.setup.reranker && `리랭크 ${r.setup.reranker}`, r.setup.generator ?? '답변 없음'].filter(Boolean).join(' · ')}</small></span></td>
          <td><span className={`pill ${statusTone[r.status].color}`}>{statusTone[r.status].label}</span></td>
          <td className="num">{usd(r.cost_usd)}</td>
          <td className="num">{ms(r.latency_ms.total)}</td>
          <td className="num">{(r.embed_tokens + r.input_tokens + r.output_tokens).toLocaleString()}</td>
          <td><IconButton icon={ArrowUpRight} label={`질문 ${r.id} 자세히`} onClick={() => setOpen(r)} /></td>
        </motion.tr>)}</tbody>
      </table>
      {data && !data.recent.length && <div className="empty-state compact"><p>아직 기록이 없어요. <button className="text-button" onClick={openPlayground}>Playground에서 질문하기</button></p></div>}
      {!data && <div className="empty-state compact"><p>{error ?? '불러오는 중…'}</p></div>}
    </Card>
    <div className="table-footer"><span>{data?.recent.length ?? 0}개</span><span>usage_log 표에 저장 · 금액은 엔진 단가표 기준</span></div>

    {open && <UsageModal row={open} grafana={data?.grafana_url} close={() => setOpen(null)} />}
  </>;
}

// 최근 14일 비용 막대. 막대 높이는 그 기간 최대 비용 기준, 아래에 질문 수.
function DailyChart({ days }: { days: Day[] }) {
  const max = Math.max(...days.map(d => d.cost_usd), 0);
  const total = days.reduce((a, d) => a + d.questions, 0);
  return <Card className="usage-chart" delay={0.18}>
    <div className="usage-chart-head"><h2>최근 {days.length}일</h2><small>막대: 하루 비용 · 숫자: 질문 수 {total ? '' : '(아직 없음)'}</small></div>
    <div className="usage-bars" role="img" aria-label={`최근 ${days.length}일 비용과 질문 수`}>
      {days.map(d => <div key={d.day} className="usage-bar" title={`${d.day} · 질문 ${d.questions}개 · ${usd(d.cost_usd)} · 평균 ${ms(d.avg_ms)}${d.errors ? ` · 오류 ${d.errors}개` : ''}`}>
        <span className="usage-bar-track"><motion.i initial={{ height: 0 }} animate={{ height: `${max ? Math.max(d.cost_usd / max * 100, d.cost_usd ? 4 : 0) : 0}%` }} transition={{ duration: 0.5 }} className={d.errors ? 'has-error' : ''} /></span>
        <b>{d.questions || ''}</b><small>{Number(d.day.slice(8))}</small>
      </div>)}
    </div>
  </Card>;
}

function UsageModal({ row: r, grafana, close }: { row: Row; grafana?: string; close: () => void }) {
  const l = r.latency_ms;
  return <Modal title={`질문 #${r.id}`} close={close}>
    <div className="usage-modal">
      <p className="usage-q">{r.question}</p>
      {r.answer && <div className="usage-answer"><small>답변{r.sources?.length ? ` · 보낸 근거 ${r.sources.join('·')}번` : ''}</small><p>{r.answer}</p></div>}
      {r.error && <p className="result-error">{r.error}</p>}
      <DetailRows rows={[
        ['시간', new Date(r.created_at).toLocaleString('ko-KR')],
        ['상태', statusTone[r.status].label],
        ['설정', [r.setup.embedder, `상위 ${r.setup.top_k}개`, r.setup.reranker ? `리랭크 ${r.setup.reranker}` : '리랭크 없음', r.setup.generator ?? '답변 없음'].join(' · ')],
        ['비용', usd(r.cost_usd)],
        ['토큰', `임베딩 ${r.embed_tokens.toLocaleString()} · 입력 ${r.input_tokens.toLocaleString()}${r.cached_tokens ? ` (캐시 ${r.cached_tokens.toLocaleString()})` : ''} · 출력 ${r.output_tokens.toLocaleString()}`],
        ['걸린 시간', [`전체 ${ms(l.total)}`, l.embed != null && `임베딩 ${ms(l.embed)}`, l.db != null && `DB ${ms(l.db)}`, l.rerank ? `리랭크 ${ms(l.rerank)}` : null, l.answer != null && `답변 ${ms(l.answer)}`].filter(Boolean).join(' · ')],
        ['추적', r.trace_id && grafana
          ? <a className="usage-trace" href={traceUrl(grafana, r.trace_id)} target="_blank" rel="noreferrer">Grafana에서 단계별 시간 보기 <ArrowUpRight size={12} /></a>
          : '기록 없음 (추적이 꺼져 있었어요)'],
      ]} />
      {r.hits.length > 0 && <div className="usage-hits"><small>근거 후보</small><ol>{r.hits.map(h => <li key={h.chunk_id}>{clean(h.title) || clean(h.heading.split(' > ')[0])}<span> › {clean(h.heading.split(' > ').pop())}</span></li>)}</ol></div>}
    </div>
  </Modal>;
}
