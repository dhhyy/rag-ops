// Current setup (index + search settings) and the stage panel that changes it.
// The engine describes every option (GET /components), so this file draws choices from that list instead of hard-coding them.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  ArrowUpRight, Box, Check, ChevronDown, CircleAlert, Layers3, LoaderCircle, Minus, Plus, RefreshCw, RotateCcw, Save,
  Search, Sparkles, Star, X, Zap, type LucideIcon,
} from 'lucide-react';
import { api, Card, ColorIcon, IconButton, Modal, spring } from './ui';

// ---------- Types (same shapes as engine/app/components.py and api.py) ----------

export type Param = { name: string; label: string; default: string; choices: [string, string][]; help: string; kind: 'choice'; always_shown: boolean };
export type Spec = {
  id: string; stage: string; label: string; description: string; provider: 'local' | 'external'; vendor: string;
  params: Param[]; status: 'ready' | 'planned'; external: boolean; available: boolean; reason: string; max_tokens?: number;
};
export type Catalog = { chunker: Spec[]; embedder: Spec[]; reranker: Spec[]; generator: Spec[] };
export type StageSetting = { id: string; params: Record<string, string> };
export type IndexInfo = {
  id: number; key: string; chunker: StageSetting; embedder: StageSetting; dims: number; is_base: boolean; created_at: string;
  chunks: number; documents: number; pending: number; label: { chunker: string; embedder: string }; external: boolean;
};
export type Query = { top_k: number; reranker: StageSetting | null; reranker_label?: string | null };
export type Setup = { index: IndexInfo; query: Query; saved_as: string | null; updated_at: string };
export type SavedSetup = { id: number; name: string; index_id: number; query: Partial<Query>; created_at: string };
type DocRef = { id: number; title: string; path: string };
export type Estimate = {
  key: string; dims: number; external: boolean; available: boolean; reason: string; label: { chunker: string; embedder: string };
  index_id: number | null; is_base: boolean; chunks_built: number; documents_total: number; documents_pending: number;
  missing_content: DocRef[]; blocked: DocRef[]; chunks_pending: number; tokens: number | null; over_limit: number;
  ready: boolean; can_build: boolean;
};
export type BuildResponse = { index_id: number; jobs: { job_id: number; path: string }[]; applied: boolean };
export type PanelStage = 'chunker' | 'embedder' | 'query' | 'reranker' | 'generator';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
// Index identity is the settings themselves, so two settings are "the same" when their sorted params match.
export const settingKey = (s: StageSetting) => `${s.id}[${Object.keys(s.params).sort().map(k => `${k}=${s.params[k]}`).join(',')}]`;
export const defaults = (spec: Spec) => Object.fromEntries(spec.params.map(p => [p.name, p.default]));

// ---------- Data hooks ----------

export function useCatalog() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api<Catalog>('/components').then(setCatalog).catch(e => setError(message(e))); }, []);
  return { catalog, error };
}

// Current setup, saved setups and every index. Actions return an error message, or null when they worked.
export function useSetup() {
  const [setup, setSetup] = useState<Setup | null>(null);
  const [saved, setSaved] = useState<SavedSetup[]>([]);
  const [indexes, setIndexes] = useState<IndexInfo[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [s, list, idx] = await Promise.all([api<Setup>('/setup'), api<SavedSetup[]>('/setups'), api<IndexInfo[]>('/indexes')]);
      setSetup(s); setSaved(list); setIndexes(idx); setError(null);
    } catch (e) { setError(message(e)); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  async function act(path: string, method: string, body?: unknown): Promise<string | null> {
    try { await api(path, { method, body }); await reload(); return null; } catch (e) { return message(e); }
  }
  async function build(path: string, body?: unknown): Promise<BuildResponse | string> {
    try { const r = await api<BuildResponse>(path, { method: 'POST', body }); await reload(); return r; } catch (e) { return message(e); }
  }
  return {
    setup, saved, indexes, error, reload,
    update: (body: { index_id?: number; top_k?: number; reranker?: StageSetting | 'off' }) => act('/setup', 'PUT', body),
    saveAs: (name: string) => act('/setups', 'POST', { name }),
    load: (id: number) => act(`/setups/${id}/load`, 'POST'),
    remove: (id: number) => act(`/setups/${id}`, 'DELETE'),
    buildIndex: (chunker: StageSetting, embedder: StageSetting) => build('/indexes', { chunker, embedder, apply: true }),
    refreshIndex: (id: number) => build(`/indexes/${id}/refresh`),
  };
}
export type SetupApi = ReturnType<typeof useSetup>;

// ---------- Small pieces ----------

export function WhereBadge({ external }: { external: boolean }) {
  return <span className={`where-badge ${external ? 'is-external' : ''}`}>{external ? 'External' : 'Local'}</span>;
}

// One-line summary of the current setup. Pipeline, Playground and Evaluations all show it.
export function SetupChips({ setup, onChange }: { setup: Setup | null; onChange?: () => void }) {
  if (!setup) return <div className="setup-chips"><span className="muted">Loading setup…</span></div>;
  const i = setup.index;
  return <div className="setup-chips">
    <span className="setup-chip"><Layers3 size={13} />{i.label.chunker}</span>
    <span className="setup-chip"><Box size={13} />{i.label.embedder}<WhereBadge external={i.external} />{i.is_base && <Star size={11} className="base-star" aria-label="Base index" />}</span>
    <span className="setup-chip"><Search size={13} />top-k {setup.query.top_k}</span>
    <span className={`setup-chip ${setup.query.reranker ? '' : 'is-off'}`}><Zap size={13} />{setup.query.reranker_label ? `Rerank ${setup.query.reranker_label}` : 'Rerank off'}</span>
    {onChange && <button className="text-button setup-change" onClick={onChange}>Change in Pipeline <ArrowUpRight size={13} /></button>}
  </div>;
}

// ---------- Setup bar (top of the Pipeline page) ----------

export function SetupBar({ s, onBuild }: { s: SetupApi; onBuild: (r: BuildResponse) => void }) {
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const setup = s.setup;
  const savedId = s.saved.find(x => x.name === setup?.saved_as)?.id;
  const baseline = s.saved.find(x => x.name === 'Baseline');
  const stale = s.indexes.filter(i => i.pending > 0);

  async function run(fn: () => Promise<string | null>) { setBusy(true); setProblem(await fn()); setBusy(false); }
  async function refresh(id: number) {
    setBusy(true);
    const r = await s.refreshIndex(id);
    setBusy(false);
    if (typeof r === 'string') setProblem(r); else { setProblem(null); onBuild(r); }
  }

  return <Card className="setup-bar">
    <div className="setup-bar-main">
      <div className="setup-bar-title"><small>Current setup</small><strong>{setup?.saved_as ?? 'Unsaved changes'}</strong></div>
      <SetupChips setup={setup} />
      <div className="setup-bar-actions">
        {s.saved.length > 0 && <label className="eval-run-select setup-select"><span>Saved</span>
          <select aria-label="Load a saved setup" value={savedId ?? ''} disabled={busy} onChange={e => e.target.value && run(() => s.load(Number(e.target.value)))}>
            {!savedId && <option value="">Choose…</option>}
            {s.saved.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select><ChevronDown size={14} /></label>}
        <button className="subtle-button" onClick={() => setSaving(true)} disabled={!setup || busy}><Save size={14} />Save as</button>
        {baseline && setup?.saved_as !== 'Baseline' && <button className="subtle-button" disabled={busy} onClick={() => run(() => s.load(baseline.id))}><RotateCcw size={14} />Back to Baseline</button>}
      </div>
    </div>
    <AnimatePresence initial={false}>{stale.length > 0 && <motion.div className="setup-stale" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>
      {stale.map(i => <span key={i.id} className="stale-chip">
        <CircleAlert size={13} /><b>{i.label.embedder}</b><small>{i.label.chunker}</small>
        <em>{i.pending} document{i.pending === 1 ? '' : 's'} behind</em>
        <button className="text-button" disabled={busy} onClick={() => refresh(i.id)}><RefreshCw size={12} />Refresh</button>
      </span>)}
    </motion.div>}</AnimatePresence>
    {(problem || s.error) && <p className="source-error setup-error">{problem ?? s.error}</p>}
    {saving && setup && <SaveSetupModal suggestion={`${setup.index.label.embedder} · top-k ${setup.query.top_k}`} existing={s.saved.map(x => x.name)}
      close={() => setSaving(false)} save={async name => { const err = await s.saveAs(name); if (!err) setSaving(false); return err; }} />}
  </Card>;
}

function SaveSetupModal({ suggestion, existing, close, save }: { suggestion: string; existing: string[]; close: () => void; save: (name: string) => Promise<string | null> }) {
  const [name, setName] = useState(suggestion);
  const [error, setError] = useState<string | null>(null);
  const clash = existing.includes(name.trim());
  return <Modal title="Save setup" close={close}>
    <form onSubmit={async e => { e.preventDefault(); if (name.trim()) setError(await save(name.trim())); }}>
      <label className="form-label">Name<input value={name} maxLength={60} required onChange={e => setName(e.target.value)} /></label>
      <p className="dialog-note">{clash ? `“${name.trim()}” already exists and will be replaced with the current setup.` : 'Saves the index and search settings in use now. Load it again from the Saved menu.'}</p>
      {error && <p className="result-error">{error}</p>}
      <div className="dialog-actions"><button type="button" className="subtle-button" onClick={close}>Cancel</button><button className="primary-button" disabled={!name.trim()}>{clash ? 'Replace' : 'Save'} <Check size={15} /></button></div>
    </form>
  </Modal>;
}

// ---------- Stage panel ----------

const stageInfo: Record<PanelStage, { title: string; icon: LucideIcon; color: string }> = {
  chunker: { title: 'Chunking', icon: Layers3, color: 'blue' },
  embedder: { title: 'Embedding', icon: Box, color: 'purple' },
  query: { title: 'Search', icon: Search, color: 'peach' },
  reranker: { title: 'Rerank', icon: Zap, color: 'neutral' },
  generator: { title: 'Answer', icon: Sparkles, color: 'neutral' },
};

type PanelProps = {
  title: string; icon: LucideIcon; color: string; settings: PanelStage | null; note?: string;
  lastRun: React.ReactNode | null; s: SetupApi; catalog: Catalog | null; busy: boolean;
  close: () => void; onBuild: (r: BuildResponse) => void; openKnowledge: () => void;
};

// Slides in from the right. Two tabs: what the stage is set to (and what changing it costs), and what it did in the last run.
export function StagePanel({ title, icon, color, settings, note, lastRun, s, catalog, busy, close, onBuild, openKnowledge }: PanelProps) {
  const [tab, setTab] = useState<'settings' | 'run'>(settings ? 'settings' : 'run');
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  return <>
    <motion.div className="panel-backdrop" onClick={close} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />
    <motion.aside className="stage-panel" role="dialog" aria-label={`${title} settings`} initial={{ x: '104%' }} animate={{ x: 0 }} exit={{ x: '104%' }} transition={spring}>
      <header className="panel-head">
        <ColorIcon icon={icon} color={color} small />
        <h2>{title}</h2>
        <IconButton icon={X} label="Close panel" onClick={close} />
      </header>
      {settings && lastRun && <div className="panel-tabs" role="tablist">
        {(['settings', 'run'] as const).map(t => <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'is-active' : ''} onClick={() => setTab(t)}>
          {tab === t && <motion.span className="panel-tab-bg" layoutId="panel-tab" transition={spring} />}<span>{t === 'settings' ? 'Settings' : 'Last run'}</span>
        </button>)}
      </div>}
      {tab === 'settings' && settings ? <SettingsTab stage={settings} note={note} s={s} catalog={catalog} busy={busy} onBuild={onBuild} openKnowledge={openKnowledge} />
        : <div className="panel-body">{lastRun ?? <p className="dialog-note">Nothing has run yet.</p>}</div>}
    </motion.aside>
  </>;
}

function SettingsTab({ stage, note, s, catalog, busy, onBuild, openKnowledge }: { stage: PanelStage; note?: string; s: SetupApi; catalog: Catalog | null; busy: boolean; onBuild: (r: BuildResponse) => void; openKnowledge: () => void }) {
  if (!catalog || !s.setup) return <div className="panel-body"><p className="dialog-note">Loading options…</p></div>;
  if (stage === 'chunker' || stage === 'embedder') return <IndexSettings key={s.setup.index.key} stage={stage} note={note} s={s} setup={s.setup} catalog={catalog} busy={busy} onBuild={onBuild} openKnowledge={openKnowledge} />;
  if (stage === 'query') return <QuerySettings s={s} setup={s.setup} />;
  if (stage === 'reranker') return <RerankSettings key={JSON.stringify(s.setup.query.reranker)} s={s} setup={s.setup} catalog={catalog} />;
  return <>
    <div className="panel-body">
      <p className="panel-note">Writes the answer from the retrieved chunks and cites them.</p>
      <OptionList specs={catalog[stage]} selected={null} pick={() => undefined} />
    </div>
    <footer className="panel-impact"><div className="impact-line is-muted"><CircleAlert size={15} /><span><b>Not connected yet</b><small>These options arrive in a later step. Nothing changes here today.</small></span></div></footer>
  </>;
}

function OptionList({ specs, selected, pick }: { specs: Spec[]; selected: string | null; pick: (spec: Spec) => void }) {
  return <div className="choice-list" role="radiogroup">{specs.map((spec, i) => {
    const on = spec.id === selected;
    const planned = spec.status === 'planned';
    return <motion.button key={spec.id} role="radio" aria-checked={on} disabled={planned}
      className={`choice-card ${on ? 'is-selected' : ''} ${!spec.available ? 'is-dim' : ''}`} onClick={() => pick(spec)}
      initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ ...spring, delay: i * 0.04 }}>
      <span className="choice-head"><b>{spec.label}</b><WhereBadge external={spec.external} />{on && <span className="choice-check"><Check size={12} /></span>}</span>
      <small>{spec.description}</small>
      <span className="choice-meta">{spec.vendor}{spec.max_tokens ? ` · up to ${spec.max_tokens.toLocaleString()} tokens` : ''}</span>
      {!spec.available && <em className="choice-reason"><CircleAlert size={12} />{spec.reason}</em>}
    </motion.button>;
  })}</div>;
}

function ParamInputs({ spec, values, set }: { spec: Spec; values: Record<string, string>; set: (name: string, value: string) => void }) {
  if (!spec.params.length) return null;
  return <div className="param-list">{spec.params.map(p => <div className="param" key={p.name}>
    <span className="param-label">{p.label}</span>
    <div className="segmented" role="radiogroup" aria-label={p.label}>{p.choices.map(([value, label]) => {
      const on = (values[p.name] ?? p.default) === value;
      return <button key={value} role="radio" aria-checked={on} className={on ? 'is-on' : ''} onClick={() => set(p.name, value)}>
        {on && <motion.span className="segmented-bg" layoutId={`seg-${spec.id}-${p.name}`} transition={spring} />}<span>{label}</span>
      </button>;
    })}</div>
    {p.help && <small className="param-help">{p.help}</small>}
  </div>)}</div>;
}

// Chunking and embedding together decide the index. Changing either one shows right away whether that index exists and what building it takes.
function IndexSettings({ stage, note, s, setup, catalog, busy, onBuild, openKnowledge }: {
  stage: 'chunker' | 'embedder'; note?: string; s: SetupApi; setup: Setup; catalog: Catalog; busy: boolean;
  onBuild: (r: BuildResponse) => void; openKnowledge: () => void;
}) {
  const current = setup.index;
  const [draft, setDraft] = useState({ chunker: current.chunker, embedder: current.embedder });
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [checking, setChecking] = useState(false);
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const draftKey = `${settingKey(draft.chunker)}|${settingKey(draft.embedder)}`;
  const changed = draftKey !== current.key;
  const spec = catalog[stage].find(x => x.id === draft[stage].id) ?? null;
  const asked = useRef(0);

  // Ask the engine about the drafted combination a moment after the last change.
  useEffect(() => {
    setProblem(null);
    if (!changed) { setEstimate(null); return; }
    const ticket = ++asked.current;
    setChecking(true);
    const timer = setTimeout(() => {
      api<Estimate>('/indexes/estimate', { method: 'POST', body: { ...draft, apply: true } })
        .then(e => { if (asked.current === ticket) setEstimate(e); })
        .catch(e => { if (asked.current === ticket) setProblem(message(e)); })
        .finally(() => { if (asked.current === ticket) setChecking(false); });
    }, 250);
    return () => clearTimeout(timer);
  }, [draftKey]);

  function pick(next: Spec) {
    if (next.status !== 'ready') return;
    setDraft(d => (d[stage].id === next.id ? d : { ...d, [stage]: { id: next.id, params: defaults(next) } }));
  }
  function setParam(name: string, value: string) {
    setDraft(d => ({ ...d, [stage]: { ...d[stage], params: { ...d[stage].params, [name]: value } } }));
  }
  async function apply() {
    if (!estimate?.index_id) return;
    setWorking(true);
    setProblem(await s.update({ index_id: estimate.index_id }));
    setWorking(false);
  }
  async function build() {
    setWorking(true);
    const r = await s.buildIndex(draft.chunker, draft.embedder);
    setWorking(false);
    if (typeof r === 'string') setProblem(r); else onBuild(r);
  }

  return <>
    <div className="panel-body">
      {note && <p className="panel-note">{note}</p>}
      <OptionList specs={catalog[stage]} selected={draft[stage].id} pick={pick} />
      {spec && <ParamInputs spec={spec} values={draft[stage].params} set={setParam} />}
    </div>
    <footer className="panel-impact" aria-live="polite">
      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={!changed ? 'current' : checking || !estimate ? 'checking' : estimate.key} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.18 }}>
          {!changed ? <div className="impact-line is-ok"><Check size={15} /><span><b>In use</b><small>{current.chunks.toLocaleString()} chunks from {current.documents} documents{current.is_base ? ' · base index, updates on every ingest' : ''}</small></span></div>
            : checking || !estimate ? <div className="impact-line is-muted"><LoaderCircle size={15} className="spin" /><span><b>Checking this combination…</b></span></div>
            : <Impact e={estimate} busy={busy || working} apply={apply} build={build} openKnowledge={openKnowledge} />}
        </motion.div>
      </AnimatePresence>
      {problem && <p className="result-error">{problem}</p>}
      {changed && <button className="text-button impact-reset" onClick={() => setDraft({ chunker: current.chunker, embedder: current.embedder })}><RotateCcw size={12} />Keep current setting</button>}
    </footer>
  </>;
}

// What happens if this combination is chosen: use it now, build it first, or why it cannot be built yet.
function Impact({ e, busy, apply, build, openKnowledge }: { e: Estimate; busy: boolean; apply: () => void; build: () => void; openKnowledge: () => void }) {
  if (e.ready) return <>
    <div className="impact-line is-ok"><Check size={15} /><span><b>Index ready</b><small>{e.chunks_built.toLocaleString()} chunks · {e.dims} dimensions · switching is instant</small></span></div>
    <button className="primary-button impact-action" disabled={busy} onClick={apply}><Check size={15} />Apply</button>
  </>;
  const partly = e.index_id !== null;
  const problems: React.ReactNode[] = [];
  if (!e.available) problems.push(<li key="avail">{e.reason}</li>);
  if (e.blocked.length) problems.push(<li key="blocked">
    {e.blocked.length} document{e.blocked.length === 1 ? ' is' : 's are'} not allowed to be sent outside: {e.blocked.slice(0, 2).map(d => d.path.split('/').pop()).join(', ')}{e.blocked.length > 2 ? '…' : ''}
    <button className="text-button impact-link" onClick={openKnowledge}>Allow in Knowledge <ArrowUpRight size={12} /></button>
  </li>);
  if (e.missing_content.length) problems.push(<li key="missing">{e.missing_content.length} document{e.missing_content.length === 1 ? ' has' : 's have'} no stored text. Ingest them again.</li>);
  if (e.over_limit) problems.push(<li key="over">{e.over_limit} chunk{e.over_limit === 1 ? ' is' : 's are'} over this model's token limit.</li>);
  const facts = [
    `${e.documents_pending} of ${e.documents_total} documents`,
    `about ${e.chunks_pending.toLocaleString()} chunks`,
    e.tokens != null ? `about ${e.tokens.toLocaleString()} tokens` : null,
    `${e.dims} dimensions`,
  ].filter(Boolean).join(' · ');
  return <>
    <div className="impact-line"><Layers3 size={15} /><span><b>{partly ? 'Index is missing documents' : 'Not built yet'}</b><small>{facts}</small></span></div>
    {e.external && <div className="impact-line is-warn"><ArrowUpRight size={15} /><span><b>Sends chunk text to {e.label.embedder.split(' · ')[0]}</b><small>Only documents marked “External allowed” can be sent.</small></span></div>}
    {problems.length > 0 && <ul className="impact-problems">{problems}</ul>}
    <button className="primary-button impact-action" disabled={busy || !e.can_build} onClick={build}>
      {busy ? <LoaderCircle size={15} className="spin" /> : <Plus size={15} />}{partly ? 'Finish and apply' : 'Build and apply'}
    </button>
    {busy && <small className="impact-hint">Another job is running. Wait for it to finish.</small>}
  </>;
}

// Rerank is a search setting, not part of the index, so it applies right away. "Off" is drawn as one more card.
const OFF: Spec = {
  id: 'off', stage: 'reranker', label: 'Off', description: 'Keep the vector search order as it is.', provider: 'local', vendor: '—',
  params: [], status: 'ready', external: false, available: true, reason: '',
};
function RerankSettings({ s, setup, catalog }: { s: SetupApi; setup: Setup; catalog: Catalog }) {
  const current = setup.query.reranker;
  const [draft, setDraft] = useState<StageSetting | null>(current);
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const spec = draft ? catalog.reranker.find(x => x.id === draft.id) ?? null : null;
  const changed = JSON.stringify(draft) !== JSON.stringify(current);
  const candidates = Number(draft?.params.candidates ?? 0);

  function pick(next: Spec) {
    if (next.status !== 'ready' || !next.available) return;
    setDraft(next.id === 'off' ? null : d => (d?.id === next.id ? d : { id: next.id, params: defaults(next) }));
  }
  async function apply() {
    setWorking(true);
    setProblem(await s.update({ reranker: draft ?? 'off' }));
    setWorking(false);
  }
  return <>
    <div className="panel-body">
      <p className="panel-note">Vector search finds candidates, then the reranker reads the question and each candidate together and puts them in a new order.</p>
      <OptionList specs={[OFF, ...catalog.reranker]} selected={draft?.id ?? 'off'} pick={pick} />
      {spec && draft && <ParamInputs spec={spec} values={draft.params} set={(name, value) => setDraft({ ...draft, params: { ...draft.params, [name]: value } })} />}
    </div>
    <footer className="panel-impact" aria-live="polite">
      {!changed ? <div className="impact-line is-ok"><Check size={15} /><span><b>In use</b><small>{current ? `${setup.query.reranker_label} · reorders ${current.params.candidates} candidates` : 'Results keep the vector search order.'}</small></span></div>
        : <>
          <div className="impact-line"><Zap size={15} /><span><b>{draft ? `Rerank ${candidates} candidates` : 'Turn rerank off'}</b>
            <small>{draft ? `Applies right away, no index to build. On this Mac (Docker, CPU) one chunk takes about 3 seconds, so each question waits about ${Math.round(candidates * 3.4 / 60 * 10) / 10} minutes.` : 'Applies right away.'}</small></span></div>
          <button className="primary-button impact-action" disabled={working} onClick={apply}>{working ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}Apply</button>
          <button className="text-button impact-reset" onClick={() => setDraft(current)}><RotateCcw size={12} />Keep current setting</button>
        </>}
      {problem && <p className="result-error">{problem}</p>}
    </footer>
  </>;
}

// Search settings apply right away. Evaluations score the top 10 regardless, so top-k changes what Playground shows, not the scores.
function QuerySettings({ s, setup }: { s: SetupApi; setup: Setup }) {
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const k = setup.query.top_k;
  async function set(next: number) {
    if (next < 1 || next > 20) return;
    setSaving(true);
    setProblem(await s.update({ top_k: next }));
    setSaving(false);
  }
  return <>
    <div className="panel-body">
      <p className="panel-note">The question is embedded with the index's own model ({setup.index.label.embedder}). Change the model on the Embedding card.</p>
      <div className="param-list"><div className="param">
        <span className="param-label">Chunks to retrieve (top-k)</span>
        <div className="stepper">
          <button aria-label="Fewer chunks" disabled={saving || k <= 1} onClick={() => set(k - 1)}><Minus size={14} /></button>
          <AnimatePresence mode="popLayout" initial={false}><motion.b key={k} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}>{k}</motion.b></AnimatePresence>
          <button aria-label="More chunks" disabled={saving || k >= 20} onClick={() => set(k + 1)}><Plus size={14} /></button>
        </div>
        <small className="param-help">How many chunks the search hands on. More gives the answer step more evidence and more noise.</small>
      </div></div>
    </div>
    <footer className="panel-impact">
      <div className="impact-line is-ok"><Check size={15} /><span><b>Applies right away</b><small>Evaluations always score the top 10 (recall@1, 3, 5), so this value does not change the scores.</small></span></div>
      {problem && <p className="result-error">{problem}</p>}
    </footer>
  </>;
}

export { stageInfo };
