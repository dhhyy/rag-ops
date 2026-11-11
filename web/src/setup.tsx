// Current setup (index + search settings): data hooks, the setup bar, and the last-run panel of a stage.
// The engine describes every option (GET /components), so this file draws choices from that list instead of hard-coding them.
import React, { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  ArrowUpRight, Box, Check, ChevronDown, CircleAlert, Layers3, RefreshCw, RotateCcw, Save, SlidersHorizontal,
  Search, Sparkles, Star, TextSearch, X, Zap, type LucideIcon,
} from 'lucide-react';
import { api, Card, ColorIcon, IconButton, Modal, spring } from './ui';

// ---------- Types (same shapes as engine/app/components.py and api.py) ----------

export type Param = { name: string; label: string; default: string; choices: [string, string][]; help: string; kind: 'choice'; always_shown: boolean };
export type Spec = {
  id: string; stage: string; label: string; description: string; provider: 'local' | 'external'; vendor: string;
  params: Param[]; status: 'ready' | 'planned'; external: boolean; available: boolean; reason: string; max_tokens?: number;
};
export type Catalog = { chunker: Spec[]; embedder: Spec[]; reranker: Spec[]; generator: Spec[]; keyword: Spec[] };
export type StageSetting = { id: string; params: Record<string, string> };
export type IndexInfo = {
  id: number; key: string; chunker: StageSetting; embedder: StageSetting; dims: number; is_base: boolean; created_at: string;
  chunks: number; documents: number; pending: number; label: { chunker: string; embedder: string }; external: boolean;
};
export type Query = { top_k: number; reranker: StageSetting | null; reranker_label?: string | null; generator: StageSetting | null; generator_label?: string | null; keyword: StageSetting | null; keyword_label?: string | null };
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
export type PanelStage = 'chunker' | 'embedder' | 'query' | 'reranker' | 'generator' | 'keyword';

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
    update: (body: { index_id?: number; top_k?: number; reranker?: StageSetting | 'off'; generator?: StageSetting | 'off'; keyword?: StageSetting | 'off' }) => act('/setup', 'PUT', body),
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

export function SetupBar({ s, onBuild, onChange }: { s: SetupApi; onBuild: (r: BuildResponse) => void; onChange: () => void }) {
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
        <button className="primary-button setup-open" onClick={onChange} disabled={!setup}><SlidersHorizontal size={14} />설정 바꾸기</button>
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

// ---------- Stage panel (what a stage did in the last run) ----------

const stageInfo: Record<PanelStage, { title: string; icon: LucideIcon; color: string }> = {
  chunker: { title: 'Chunking', icon: Layers3, color: 'blue' },
  embedder: { title: 'Embedding', icon: Box, color: 'purple' },
  query: { title: 'Search', icon: Search, color: 'peach' },
  reranker: { title: 'Rerank', icon: Zap, color: 'neutral' },
  generator: { title: 'Answer', icon: Sparkles, color: 'neutral' },
  keyword: { title: '키워드 검색', icon: TextSearch, color: 'blue' },
};

// Slides in from the right and shows the last run of one indexing stage. Settings are changed in the setup flow (setupflow.tsx).
export function StagePanel({ title, icon, color, lastRun, close, onChange }: {
  title: string; icon: LucideIcon; color: string; lastRun: React.ReactNode | null; close: () => void; onChange?: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  return <>
    <motion.div className="panel-backdrop" onClick={close} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />
    <motion.aside className="stage-panel" role="dialog" aria-label={`${title} last run`} initial={{ x: '104%' }} animate={{ x: 0 }} exit={{ x: '104%' }} transition={spring}>
      <header className="panel-head">
        <ColorIcon icon={icon} color={color} small />
        <h2>{title}</h2>
        {onChange && <button className="subtle-button panel-change" onClick={onChange}><SlidersHorizontal size={14} />설정 바꾸기</button>}
        <IconButton icon={X} label="Close panel" onClick={close} />
      </header>
      <div className="panel-body">{lastRun ?? <p className="dialog-note">Nothing has run yet.</p>}</div>
    </motion.aside>
  </>;
}

export { stageInfo };
