import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AnimatePresence, motion, MotionConfig, useReducedMotion } from 'motion/react';
import {
  ArrowLeftRight, Receipt, ArrowRight, ArrowUpRight, Bell, BookOpen, Box, Check, CheckCheck,
  ChevronDown, CircleAlert, Clock3, Database, FileText, Folder, LoaderCircle,
  GitBranch, Home, Layers3, Maximize2, MessageSquare, Play,
  Plus, Search, Settings2, ShieldCheck, SlidersHorizontal, TextSearch,
  Sparkles, Zap, ChartNoAxesCombined, Link2,
  type LucideIcon,
} from 'lucide-react';
import './styles.css';
import { api, Card, ColorIcon, CountUp, DetailRows, ease, Heading, IconButton, Modal, RAG_API, readError, shortTime, spring, Toggle } from './ui';
import { Evaluations } from './evaluations';
import { Compare } from './compare';
import { Playground, type DocTarget } from './playground';
import { UsagePage } from './usage';
import { Home as HomePage } from './home';
import { SetupBar, StagePanel, useCatalog, useSetup, type BuildResponse, type IndexInfo, type PanelStage } from './setup';
import { SetupFlow, stepOf } from './setupflow';
import { LinkModal, NewProjectFlow, ProjectCards, ProjectHead, useProjects, VersionList, waitJobs, type ProjectRef } from './projects';

type Page = 'home' | 'knowledge' | 'pipeline' | 'playground' | 'compare' | 'evaluations' | 'runs' | 'usage' | 'settings';
type Collection = { id: number; name: string; documents: number; color: string };
type PreviewSettings = { name: string; endpoint: string };
type DialogState = { type: 'create' | 'search' | 'node' | 'run' | 'notifications'; value?: string } | null;
const pages: { id: Page; label: string; icon: LucideIcon }[] = [
  { id: 'home', label: 'Home', icon: Home },
  { id: 'knowledge', label: 'Knowledge base', icon: Database },
  { id: 'pipeline', label: 'RAG pipeline', icon: GitBranch },
  { id: 'playground', label: 'Playground', icon: MessageSquare },
  { id: 'compare', label: '비교', icon: ArrowLeftRight },
  { id: 'evaluations', label: 'Evaluations', icon: ChartNoAxesCombined },
  { id: 'runs', label: 'Run history', icon: Clock3 },
  { id: 'usage', label: '사용 기록', icon: Receipt },
];
const stages = [
  { name: 'Documents', detail: 'Knowledge source', icon: FileText, color: 'lime' },
  { name: 'Chunking', detail: '512 tokens · 64 overlap', icon: Layers3, color: 'blue' },
  { name: 'Embedding', detail: 'Local embedding model', icon: Box, color: 'purple' },
  { name: 'Retrieval', detail: 'Top 5 · similarity', icon: Search, color: 'peach' },
  { name: 'Generation', detail: 'Local language model', icon: Sparkles, color: 'lilac' },
];

function App() {
  const [page, setPage] = useState<Page>('home');
  const [knowledgeView, setKnowledgeView] = useState<'all' | 'blocked'>('all');
  const [docTarget, setDocTarget] = useState<DocTarget | null>(null);   // Playground에서 연 조각
  const [askFromHome, setAskFromHome] = useState<string | null>(null);   // Home에서 넣은 질문 → Playground가 바로 보냄
  const [callIngest, setCallIngest] = useState(false);   // [문서 넣기]로 왔으면 Pipeline의 경로 입력칸을 바로 연다
  const [callSetup, setCallSetup] = useState(false);   // 다른 화면의 [설정 바꾸기]로 왔으면 Pipeline에서 설정 서랍을 바로 연다
  const [settings, setSettings] = useState<PreviewSettings>({ name: 'Local workspace', endpoint: 'http://localhost:11434' });
  const [dialog, setDialog] = useState<DialogState>(null);
  const [toast, setToast] = useState('');
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [enabled, setEnabled] = useState([true, true, false, true]);
  const [, setCollections] = useState<Collection[]>([
    { id: 1, name: 'Sample documents', documents: 12, color: 'lime' },
    { id: 2, name: 'Research notes', documents: 8, color: 'blue' },
    { id: 3, name: 'Product knowledge', documents: 4, color: 'purple' },
  ]);
  const reduced = useReducedMotion();
  const notify = (message: string) => setToast(message);
  function navigate(next: Page) { if (next === 'knowledge') setKnowledgeView('all'); setPage(next); setDialog(null); setWorkspaceOpen(false); window.scrollTo({ top: 0, behavior: 'instant' }); }
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 3400); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => {
    function handler(e: KeyboardEvent) { if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); setDialog({ type: 'search' }); } if (e.key === 'Escape') setWorkspaceOpen(false); }
    window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler);
  }, []);
  const openIngest = () => { navigate('pipeline'); setCallIngest(true); };
  const openSetup = () => { navigate('pipeline'); setCallSetup(true); };
  function flip(index: number) { setEnabled(e => e.map((v, i) => i === index ? !v : v)); }

  return <MotionConfig reducedMotion="user" transition={spring}><div className="desktop-stage"><div className="app-shell">
    <aside className="sidebar" aria-label="Main navigation">
      <button className="brand" aria-label="rag-ops home" onClick={() => navigate('home')}><span className="brand-mark">{Array.from({ length: 16 }, (_, i) => <i key={i} />)}</span></button>
      <nav className="rail-nav">{pages.map(({ id, label, icon: Icon }) => <button key={id} className={`nav-button ${page === id ? 'active' : ''}`} aria-label={label} aria-current={page === id ? 'page' : undefined} onClick={() => navigate(id)}>{page === id && <motion.span className="nav-active" layoutId="active-nav" transition={spring} />}<Icon size={19} strokeWidth={1.7} /><span className="nav-tooltip">{label}</span></button>)}</nav>
      <div className="rail-bottom"><button className={`nav-button ${page === 'settings' ? 'active' : ''}`} aria-label="Settings" onClick={() => navigate('settings')}><Settings2 size={19} /><span className="nav-tooltip">Settings</span></button><button className="nav-button notification-button" aria-label="Notifications" onClick={() => setDialog({ type: 'notifications' })}><Bell size={18} /><i /><span className="nav-tooltip">Notifications</span></button><button className="avatar" aria-label="Local profile" onClick={() => navigate('settings')}>L</button></div>
    </aside>
    <div className="main-shell">
      <header className="topbar">
        <div className="workspace-container"><button className="workspace-button" aria-expanded={workspaceOpen} onClick={() => setWorkspaceOpen(!workspaceOpen)}>My workspace <ChevronDown size={14} /></button><AnimatePresence>{workspaceOpen && <motion.div className="workspace-menu" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}><span className="overline">WORKSPACE</span><button onClick={() => setWorkspaceOpen(false)}><span className="local-dot" />Local workspace <Check size={14} /></button><small>UI preview · Sample data</small></motion.div>}</AnimatePresence></div>
        <nav className="top-nav" aria-label="Workspace sections">{([{ id: 'knowledge', label: 'Knowledge' }, { id: 'pipeline', label: 'Pipelines' }, { id: 'compare', label: '비교' }, { id: 'evaluations', label: 'Evaluations' }, { id: 'playground', label: 'Playground' }] as { id: Page; label: string }[]).map(item => <button key={item.id} className={page === item.id ? 'selected' : ''} onClick={() => navigate(item.id)}>{item.label}</button>)}</nav>
        <div className="top-actions"><IconButton icon={Plus} label="Create knowledge base" onClick={() => setDialog({ type: 'create' })} /><IconButton icon={Search} label="Search workspace" onClick={() => setDialog({ type: 'search' })} /><IconButton icon={Maximize2} label="Toggle full screen" onClick={() => { if (document.fullscreenElement) void document.exitFullscreen(); else void document.documentElement.requestFullscreen().catch(() => notify('Use your browser’s full-screen control')); }} /></div>
      </header>
      <main className="content" id="main-content"><AnimatePresence mode="wait"><motion.div key={page} className={`page page-${page}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, y: reduced ? 0 : -8, filter: reduced ? 'none' : 'blur(5px)' }} transition={{ duration: 0.2 }}>
        {page === 'home' && <HomePage openPipeline={() => navigate('pipeline')} openSetup={openSetup} openEvaluations={() => navigate('evaluations')} openUsage={() => navigate('usage')}
          openKnowledge={() => navigate('knowledge')} openPlayground={q => { setAskFromHome(q ?? null); navigate('playground'); }} />}
        {page === 'knowledge' && <Knowledge view={knowledgeView} target={docTarget} clearTarget={() => setDocTarget(null)} openPipeline={openIngest} />}
        {page === 'pipeline' && <Pipeline enabled={enabled} flip={flip} callIngest={callIngest} consumeIngest={() => setCallIngest(false)} callSetup={callSetup} consumeSetup={() => setCallSetup(false)} openKnowledge={() => { navigate('knowledge'); setKnowledgeView('blocked'); }} openProjects={() => navigate('knowledge')} />}
        {page === 'playground' && <Playground initialQuestion={askFromHome} consume={() => setAskFromHome(null)} openPipeline={openSetup} openKnowledge={t => { navigate('knowledge'); setDocTarget(t); }} />}
        {page === 'compare' && <Compare />}
        {page === 'evaluations' && <Evaluations openPipeline={openSetup} openCompare={() => navigate('compare')} />}
        {page === 'runs' && <Runs openPipeline={openIngest} />}
        {page === 'usage' && <UsagePage openPlayground={() => navigate('playground')} />}
        {page === 'settings' && <Settings settings={settings} save={setSettings} notify={notify} />}
      </motion.div></AnimatePresence></main>
    </div>
  </div></div>
  <AnimatePresence>{toast && <motion.div role="status" className="toast" initial={{ opacity: 0, y: 24, scale: 0.95 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 12 }}><Check size={16} />{toast}</motion.div>}</AnimatePresence>
  {dialog?.type === 'create' && <CreateModal close={() => setDialog(null)} create={name => { setCollections(c => [...c, { id: Date.now(), name, documents: 0, color: 'peach' }]); setDialog(null); navigate('knowledge'); notify('Knowledge base added to this preview'); }} />}
  {dialog?.type === 'search' && <SearchModal close={() => setDialog(null)} navigate={navigate} />}
  {dialog?.type === 'node' && <NodeModal name={dialog.value!} close={() => setDialog(null)} notify={notify} />}
  {dialog?.type === 'run' && <Modal title={dialog.value!} close={() => setDialog(null)}><p className="muted">Sample run details</p><div className="run-detail">{stages.map((s, i) => <div key={s.name}><ColorIcon icon={s.icon} color={s.color} small /><span>{s.name}</span><small>{[42, 124, 288, 76, 840][i]} ms</small><Check size={15} /></div>)}</div><p className="dialog-note">Illustrative values. No model was executed.</p></Modal>}
  {dialog?.type === 'notifications' && <Modal title="Notifications" close={() => setDialog(null)}><div className="empty-state compact"><ColorIcon icon={Bell} color="lilac" /><h3>You're all caught up</h3><p>Workspace updates will appear here.</p></div></Modal>}
  </MotionConfig>;
}

type StoredDocument = {
  id: number; source_kind: 'git' | 'managed'; source_repo: string; source_path: string; source_commit: string; title: string;
  env: string | null; doc_type: string | null; verification: string; checked_at: string | null;
  external_ok: boolean; ingested_at: string; chunks: number; projects: ProjectRef[];
};
const verificationTone: Record<string, string> = { '확인': 'lime', '추정': 'blue', '미확인': 'neutral', '폐기': 'peach' };

// Every document stored in the DB (GET /documents). Reloads each time the page opens.
function useDocuments() {
  const [docs, setDocs] = useState<StoredDocument[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = () => fetch(`${RAG_API}/documents`).then(async r => (r.ok ? r.json() : Promise.reject(await readError(r))))
    .then(setDocs).catch(e => setError(String(e)));
  useEffect(() => { void reload(); }, []);
  const setLinks = (id: number, links: ProjectRef[]) => setDocs(list => list?.map(d => (d.id === id ? { ...d, projects: links } : d)) ?? null);
  // Allow or block sending one document to external APIs. Shows the new value at once and puts it back if the engine refuses.
  async function setExternal(id: number, value: boolean): Promise<string | null> {
    setDocs(list => list?.map(d => (d.id === id ? { ...d, external_ok: value } : d)) ?? null);
    try { await api(`/documents/${id}`, { method: 'PATCH', body: { external_ok: value } }); return null; }
    catch (e) {
      setDocs(list => list?.map(d => (d.id === id ? { ...d, external_ok: !value } : d)) ?? null);
      return e instanceof Error ? e.message : String(e);
    }
  }
  return { docs, error, setExternal, setLinks, reload };
}

function DocumentModal({ doc, target, close }: { doc: StoredDocument; target?: DocTarget | null; close: () => void }) {
  const { chunks, error } = useChunks(doc.id, target?.indexId);
  return <Modal title={doc.title} close={close}>
    <DetailRows rows={[
      ['Source', /\.pdf$/i.test(doc.source_path)
        ? <>{`${doc.source_repo}/${doc.source_path}`}<a className="detail-link" href={`${RAG_API}/documents/${doc.id}/original`} target="_blank" rel="noreferrer">원본 PDF 열기</a>
            <em className="detail-hint">PDF는 pypdf로 뽑은 글을 쪽마다 한 조각으로 넣었어요 (p.1, p.2…). 표·그림 속 글자는 빠질 수 있어요</em></>
        : `${doc.source_repo}/${doc.source_path}`],
      ['Projects', doc.projects.length ? doc.projects.map(p => `${p.name}${p.origin ? ' (원본)' : ''}`).join(', ') : '—'],
      doc.source_kind === 'managed'
        ? ['판', <>{doc.source_commit.replace(/^v/, '')}판<em className="detail-hint">직접 관리 문서예요. 같은 이름으로 다시 올리면 새 판이 돼요</em></>]
        : ['Commit', <>{doc.source_commit}{doc.source_commit.endsWith('-dirty') && <em className="detail-hint">-dirty: the file had uncommitted edits</em>}</>],
      ['Environment', doc.env ?? '—'],
      ['Document type', doc.doc_type ?? '—'],
      ['Verification', `${doc.verification}${doc.checked_at ? ` · checked ${doc.checked_at}` : ''}`],
      ['External LLM', doc.external_ok ? 'Allowed' : 'Not allowed'],
      ['Ingested', shortTime(doc.ingested_at)],
    ]} />
    {doc.source_kind === 'managed' && <><p className="muted document-chunks-heading">판 기록</p><VersionList documentId={doc.id} /></>}
    <p className="muted document-chunks-heading">{chunks ? `${chunks.length} chunks${target ? ` · Playground에서 본 조각 #${String(target.chunkIndex).padStart(2, '0')}을 강조했어요 (색인 #${target.indexId ?? '기본'})` : ''}` : error ?? 'Loading chunks…'}</p>
    {chunks && <ChunkList chunks={chunks} highlight={target?.chunkIndex} />}
  </Modal>;
}

// Knowledge base: the documents the engine has stored, grouped by project.
// 프로젝트 카드를 누르면 그 프로젝트(원본 + 연결)의 문서만 보이고, 머리 띠에서 [다시 받기]를 할 수 있다.
// view 'blocked': opened from a stage panel to allow documents for an external model, so start on the blocked ones.
function Knowledge({ view, target, clearTarget, openPipeline }: { view: 'all' | 'blocked'; target: DocTarget | null; clearTarget: () => void; openPipeline: () => void }) {
  const { docs, error, setExternal, setLinks, reload } = useDocuments();
  const { projects, error: projectError, reload: reloadProjects } = useProjects();
  const [filter, setFilter] = useState('');
  const [pid, setPid] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [linking, setLinking] = useState<StoredDocument | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const [open, setOpen] = useState<StoredDocument | null>(null);
  const [onlyBlocked, setOnlyBlocked] = useState(view === 'blocked');
  const [toggleError, setToggleError] = useState<string | null>(null);
  // Playground에서 넘어왔으면 그 문서를 바로 연다
  useEffect(() => {
    if (!docs || !target) return;
    const doc = docs.find(d => d.id === target.documentId);
    if (doc) setOpen(doc); else clearTarget();
  }, [docs, target]);   // eslint-disable-line react-hooks/exhaustive-deps
  const blockedCount = docs?.filter(d => !d.external_ok).length ?? 0;
  const project = projects?.find(p => p.id === pid) ?? null;
  const query = filter.trim().toLowerCase();
  const shown = (docs ?? []).filter(d => (!pid || d.projects.some(p => p.id === pid)) && (!onlyBlocked || !d.external_ok)
    && (!query || d.title.toLowerCase().includes(query) || d.source_path.toLowerCase().includes(query)));
  const totalChunks = docs?.reduce((n, d) => n + d.chunks, 0) ?? 0;

  return <>
    <Heading title="Knowledge base" subtitle={docs ? `${docs.length} documents · ${totalChunks.toLocaleString()} chunks stored` : 'Documents stored by the engine'}>
      <button className="primary-button" onClick={openPipeline} title="Pipelines 화면의 경로 입력칸으로 가요">문서 넣기<ArrowRight size={15} /></button>
    </Heading>

    <div className="section-heading"><h2>Projects</h2><span className="muted">{projects ? `${projects.length} total` : ''}</span></div>
    {projects ? <ProjectCards projects={projects} selected={pid} select={setPid} onNew={() => setCreating(true)} />
    : <Card className="knowledge-empty"><div className="empty-state compact"><ColorIcon icon={Database} color="neutral" /><h3>{projectError || error ? 'Engine is not reachable' : 'Loading…'}</h3><p>{projectError ?? error ?? ''}</p></div></Card>}
    <AnimatePresence initial={false}>{created && <motion.p className="pj-note is-ok pj-created" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>
      <Check size={13} /><span>{created}</span><button className="text-button" onClick={openPipeline}>진행 보기 <ArrowRight size={12} /></button><button className="text-button" onClick={() => setCreated(null)}>닫기</button></motion.p>}</AnimatePresence>
    <AnimatePresence initial={false} mode="wait">{project && <motion.div key={project.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.2 }}>
      <ProjectHead project={project} openPipeline={openPipeline} onPulled={() => { void reloadProjects(); void reload(); }} />
    </motion.div>}</AnimatePresence>

    <div className="section-heading document-heading">
      <h2>Documents{project && <span className="muted"> · {project.name}</span>}</h2>
      <div className="document-tools">
        <button className={`eval-filter ${onlyBlocked ? 'is-active' : ''}`} aria-pressed={onlyBlocked} onClick={() => setOnlyBlocked(v => !v)}>External not allowed {blockedCount}</button>
        <label className="search-field"><Search size={16} /><input aria-label="Filter documents" placeholder="Search title or path" value={filter} onChange={e => setFilter(e.target.value)} /></label>
      </div>
    </div>
    <AnimatePresence initial={false}>{onlyBlocked && <motion.p className="knowledge-hint" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>
      An external model (for example OpenAI embeddings) receives the text of every chunk. Allow only documents you are fine sending outside — company material stays off.
    </motion.p>}</AnimatePresence>
    {toggleError && <p className="source-error queue-problems">{toggleError}</p>}
    <Card className="table-card documents-table" delay={0.2}>
      <table>
        <thead><tr><th>Title</th><th>Environment</th><th>Type</th><th>Verification</th><th title="May this document be sent to external APIs?">External</th><th title="원본 프로젝트와 연결한 프로젝트">Projects</th><th>Chunks</th><th>Ingested</th><th /></tr></thead>
        <tbody>{shown.map((d, i) => <motion.tr key={d.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i, 14) * 0.03, duration: 0.3 }} onClick={() => setOpen(d)}>
          <td><span className="file-label"><FileText size={17} /><span className="doc-name"><b>{d.title}</b><small>{d.source_repo}/{d.source_path}</small></span></span></td>
          <td>{d.env ?? '—'}</td>
          <td>{d.doc_type ?? '—'}</td>
          <td><span className={`pill ${verificationTone[d.verification] ?? 'neutral'}`}>{d.verification}</span></td>
          <td onClick={e => e.stopPropagation()}><span className="external-cell"><Toggle checked={d.external_ok} label={`Allow sending ${d.title} to external APIs`} onChange={async () => setToggleError(await setExternal(d.id, !d.external_ok))} /><small>{d.external_ok ? 'Allowed' : 'Off'}</small></span></td>
          <td onClick={e => e.stopPropagation()}><span className="pj-cell">{d.projects.map(p => <span key={p.id} className={`pj-tag ${p.origin ? '' : 'is-link'}`} title={p.origin ? '원본 프로젝트' : '연결한 프로젝트'}>{p.origin ? '' : '+ '}{p.name}</span>)}
            {projects && projects.length > 1 && <IconButton icon={Link2} label={`${d.title}을 다른 프로젝트에 연결`} className="pj-link-btn" onClick={() => setLinking(d)} />}</span></td>
          <td className="num">{d.chunks}</td>
          <td className="num">{shortTime(d.ingested_at)}</td>
          <td><IconButton icon={ArrowUpRight} label={`Open ${d.title}`} onClick={() => setOpen(d)} /></td>
        </motion.tr>)}</tbody>
      </table>
      {docs && !shown.length && <div className="empty-state compact"><Search size={24} /><p>{!docs.length ? 'No documents stored yet.' : onlyBlocked && !blockedCount ? 'Every document is allowed for external APIs.' : `No documents match “${filter}”.`}</p></div>}
    </Card>
    <p className="footnote">Stored in PostgreSQL · 문서는 한 번만 저장하고, 프로젝트에는 연결만 늘려요 (원본 하나 + 사람이 붙인 연결).</p>

    {linking && projects && <LinkModal title={linking.title} documentId={linking.id} links={linking.projects} projects={projects} close={() => setLinking(null)}
      saved={links => { setLinks(linking.id, links); setLinking(null); void reloadProjects(); }} />}
    <NewProjectFlow open={creating} taken={projects?.map(p => p.name) ?? []} onClose={() => setCreating(false)}
      onCreated={(p, r) => {
        setCreating(false); setPid(p.id); void reloadProjects();
        const skipped = r.skipped.length ? ` · 뺀 문서 ${r.skipped.length}개` : '';
        setCreated(`프로젝트 ${p.name}을 만들었어요 · 문서 ${r.jobs.length}개를 넣는 중${skipped}`);
        // 넣기가 끝나면 목록을 다시 읽어 문서·조각 수를 맞춘다
        if (r.jobs.length) void waitJobs(r.jobs.map(j => j.job_id)).then(failed => {
          setCreated(`프로젝트 ${p.name}을 만들었어요 · 문서 ${r.jobs.length}개 ${failed === null ? '아직 넣는 중' : failed ? `중 ${failed}개 실패` : '다 넣었어요'}${skipped}`);
          void reloadProjects(); void reload();
        });
      }} />
    {open && <DocumentModal doc={open} target={target?.documentId === open.id ? target : null} close={() => { setOpen(null); clearTarget(); }} />}
  </>;
}
// ---------- Live ingest pipeline (engine API: /api/rag) ----------

type JobStatus = 'queued' | 'running' | 'done' | 'failed';
type JobResult = {
  status: 'inserted' | 'replaced' | 'skipped' | 'evaluated'; document_id: number; chunks: number | null;
  tokens: { min: number; max: number; total: number } | null;
  source_repo: string; source_path: string; source_commit: string; title: string;
  index_id?: number;  // build jobs: the index they filled (ingest jobs fill the base index)
  eval_run_id?: number; summary?: { 'recall@1': number | null };  // eval jobs
};
type Job = {
  id: number; path: string; params: Record<string, unknown> | null; status: JobStatus; stage: string | null; stage_index: number | null;
  progress_done: number | null; progress_total: number | null; error: string | null; result: JobResult | null;
  created_at: string; started_at: string | null; finished_at: string | null;
};
type Chunk = { chunk_index: number; heading_path: string; token_count: number; content: string; embed_text: string };
type Moment = { key: string; label: string; detail?: string; tone: 'run' | 'done' | 'fail'; at: number };
type NodeState = 'idle' | 'waiting' | 'current' | 'done' | 'skipped' | 'failed' | 'planned';
// settings: which stage panel the card opens. live: the card is in use even though it is not an ingest stage.
type StageNode = { name: string; detail: string; icon: LucideIcon; color: string; stage?: string; note?: string; settings?: PanelStage; live?: boolean };
type GroupId = 'indexing' | 'retrieval' | 'generation';
type Group = { id: GroupId; title: string; icon: LucideIcon; color: string; nodes: StageNode[] };

const LAST_PATH_KEY = 'rag-ops:last-ingest-path';
const ENV_OPTIONS = ['혼합', '운영', '개발', '샘플'];
const DOC_TYPE_OPTIONS = ['해설', '설정', '실행 결과', '장애 기록'];
const jobKind = (j: Job) => String(j.params?.kind ?? 'ingest') as 'ingest' | 'build' | 'eval' | 'drafts';

// The whole RAG flow in three groups. Indexing cards are engine stages; cards with settings open the stage panel.
const groups: Group[] = [
  { id: 'indexing', title: 'Indexing', icon: Layers3, color: 'lime', nodes: [
    { name: 'Source', detail: 'Front matter · git', icon: FileText, color: 'lime', stage: '확인', note: 'Reads the file, its front matter and the git commit it came from.' },
    { name: 'Dedupe', detail: 'sha256 compare', icon: CheckCheck, color: 'lime', stage: '중복 확인', note: 'Compares the content hash with the stored copy of the same path.' },
    { name: 'Chunking', detail: '## / ### headings', icon: Layers3, color: 'blue', stage: '청킹', settings: 'chunker', note: 'Splits the body into chunks. Each chunk keeps its heading path.' },
    { name: 'Tokens', detail: 'Model tokenizer', icon: SlidersHorizontal, color: 'blue', stage: '토큰 검사', settings: 'embedder', note: "Counts tokens with the embedding model's tokenizer. A chunk over the model's limit stops the run." },
    { name: 'Embedding', detail: 'Index model', icon: Box, color: 'purple', stage: '임베딩', settings: 'embedder', note: "Turns every chunk into a vector with the index's embedding model." },
    { name: 'Storage', detail: 'PostgreSQL · pgvector', icon: Database, color: 'peach', stage: '저장', note: 'Writes the chunks of one document into its index in one transaction.' },
  ] },
  { id: 'retrieval', title: 'Retrieval', icon: Search, color: 'blue', nodes: [
    { name: 'Query', detail: 'Embed the question', icon: MessageSquare, color: 'blue', settings: 'query', live: true },
    { name: 'Vector search', detail: 'pgvector · cosine', icon: Search, color: 'blue', settings: 'query', live: true },
    { name: '키워드 검색', detail: 'BM25 · Kiwi 형태소', icon: TextSearch, color: 'blue', settings: 'keyword', live: true },
    { name: 'Rerank', detail: 'Reorder candidates', icon: Zap, color: 'blue', settings: 'reranker', live: true },
  ] },
  { id: 'generation', title: 'Generation', icon: Sparkles, color: 'purple', nodes: [
    { name: 'Context', detail: 'Pick the evidence', icon: BookOpen, color: 'neutral' },
    { name: 'Answer', detail: 'LLM writes the answer with citations', icon: Sparkles, color: 'neutral', settings: 'generator' },
    { name: 'Citations', detail: 'Sources · status', icon: ShieldCheck, color: 'neutral' },
  ] },
];
const indexing = groups[0].nodes;

const stageLabels: Record<string, string> = {
  '확인': 'Checking source', '중복 확인': 'Comparing with stored copy', '청킹': 'Splitting by headings',
  '토큰 검사': 'Counting tokens', '임베딩': 'Embedding chunks', '저장': 'Saving to pgvector', '평가': 'Evaluating',
};
const resultTone: Record<JobResult['status'], { label: string; color: string; note: string }> = {
  inserted: { label: 'Inserted', color: 'lime', note: 'No stored copy of this path yet, so it was saved as a new document.' },
  replaced: { label: 'Replaced', color: 'blue', note: 'The content hash changed, so the old chunks were replaced.' },
  skipped: { label: 'Unchanged', color: 'neutral', note: 'Same hash as the stored copy, so nothing was re-chunked or re-embedded.' },
  evaluated: { label: 'Evaluated', color: 'lilac', note: 'The evaluation set was run against the setup.' },
};

// 0-based index of the stage the job is on (or stopped at).
const currentIndex = (job: Job) => Math.max(0, job.stage_index ? job.stage_index - 1 : indexing.findIndex(n => n.stage === job.stage));

function nodeState(job: Job | null, index: number): NodeState {
  if (!job) return 'idle';
  if (job.status === 'queued') return 'waiting';
  if (job.status === 'done') return job.result?.status === 'skipped' && index > 1 ? 'skipped' : 'done';
  const current = currentIndex(job);
  if (index < current) return 'done';
  if (index === current) return job.status === 'failed' ? 'failed' : 'current';
  return 'waiting';
}

// Share of the six stages finished, counting embedding batches inside stage 5.
function indexingProgress(job: Job | null) {
  if (!job || job.status === 'queued') return 0;
  if (job.status === 'done') return 1;
  const current = currentIndex(job);
  const part = indexing[current]?.stage === '임베딩' && job.progress_total ? (job.progress_done ?? 0) / job.progress_total : 0;
  return (current + part) / indexing.length;
}

function stageSub(job: Job | null, index: number, state: NodeState) {
  const node = indexing[index];
  const r = job?.result;
  if (state === 'current') return stageLabels[node.stage!];
  if (state === 'failed') return 'Stopped here';
  if (state === 'skipped') return 'Skipped · unchanged';
  if (state === 'done' && r) return [
    `@${r.source_commit.slice(0, 7)}${r.source_commit.endsWith('-dirty') ? ' · dirty' : ''}`,
    resultTone[r.status].label,
    `${r.chunks} chunks`,
    r.tokens ? `Max ${r.tokens.max} tokens` : node.detail,
    `${r.chunks} vectors`,
    `Document #${r.document_id}`,
  ][index];
  return node.detail;
}


const isActive = (j: Job) => j.status === 'queued' || j.status === 'running';

// Starts ingest jobs (one file or a whole folder) and follows them.
// Jobs from one request share created_at, so a reload can rebuild the same queue from GET /jobs.
function useIngestQueue() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [moments, setMoments] = useState<Moment[]>([]);
  const [offline, setOffline] = useState(false);
  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;
  const pinned = useRef(false);  // true once the user picks a finished or waiting job to look at
  const stream = useRef<EventSource | null>(null);
  const job = jobs.find(j => j.id === selectedId) ?? null;
  const active = jobs.some(isActive);
  const idsKey = jobs.map(j => j.id).join(',');

  function record(next: Job) {
    const tone: Moment['tone'] = next.status === 'failed' ? 'fail' : next.status === 'done' ? 'done' : 'run';
    const key = next.status === 'done' || next.status === 'failed' ? next.status : next.stage ?? next.status;
    const label = next.status === 'done' ? (next.result ? `${resultTone[next.result.status].label} · finished` : 'Finished')
      : next.status === 'failed' ? `Stopped at ${stageLabels[next.stage ?? ''] ?? 'start'}`
      : next.stage ? stageLabels[next.stage] ?? next.stage : 'Waiting in queue';
    const detail = next.status === 'failed' ? next.error ?? undefined
      : next.progress_total ? `${next.progress_done ?? 0} / ${next.progress_total} chunks` : undefined;
    setMoments(list => {
      const last = list[list.length - 1];
      if (last?.key === key) return [...list.slice(0, -1), { ...last, detail, tone }];
      // A new stage arrived, so every earlier running stage is now finished.
      // A finished embedding step reads "33 chunks embedded" instead of the last polled count.
      const settled = list.map(m => (m.tone !== 'run' ? m : {
        ...m, tone: 'done' as const,
        detail: m.detail?.replace(/^\d+ \/ (\d+) chunks$/, '$1 chunks embedded'),
      }));
      return [...settled, { key, label, detail, tone, at: Date.now() }];
    });
  }

  const upsert = (next: Job) => setJobs(list => list.map(j => (j.id === next.id ? next : j)));

  // Shows the job the user picked, else the one running now, else the next waiting one, else the last one.
  function autoPick(list: Job[]) {
    if (pinned.current) return;
    const pick = list.find(j => j.status === 'running') ?? list.find(j => j.status === 'queued') ?? list[list.length - 1];
    if (pick) setSelectedId(pick.id);
  }

  function follow(id: number) {
    stream.current?.close();
    const source = new EventSource(`${RAG_API}/jobs/${id}/events`);
    stream.current = source;
    const onEvent = (event: MessageEvent) => {
      const next = JSON.parse(event.data) as Job;
      upsert(next);
      record(next);
      if (next.status === 'done' || next.status === 'failed') source.close();
    };
    for (const type of ['progress', 'done', 'failed']) source.addEventListener(type, onEvent as EventListener);
    source.onerror = () => {
      // The connection dropped before the job finished: read the stored state, then reconnect if it is still running.
      source.close();
      fetch(`${RAG_API}/jobs/${id}`).then(r => (r.ok ? r.json() : null)).then((latest: Job | null) => {
        if (!latest) return;
        upsert(latest);
        if (isActive(latest) && stream.current === source) setTimeout(() => follow(id), 1500);
      }).catch(() => setOffline(true));
    };
  }

  async function readQueue(): Promise<Job[]> {
    const r = await fetch(`${RAG_API}/jobs?limit=200&kind=ingest,build`);
    if (!r.ok) throw new Error(String(r.status));
    return r.json();
  }

  // On first load, rebuild the latest request's queue.
  useEffect(() => {
    readQueue().then(all => {
      const latest = all[0];
      if (!latest) return;
      const list = all.filter(j => j.created_at === latest.created_at).sort((a, b) => a.id - b.id);
      setJobs(list);
      autoPick(list);
    }).catch(() => setOffline(true));
    return () => stream.current?.close();
  }, []);

  // Whenever another job is shown, start its activity log over and stream it if it is still going.
  useEffect(() => {
    stream.current?.close();
    stream.current = null;
    setMoments([]);
    const current = jobsRef.current.find(j => j.id === selectedId);
    if (!current) return;
    record(current);
    if (isActive(current)) follow(current.id);
  }, [selectedId]);

  // While anything is waiting or running, refresh the whole queue once a second.
  useEffect(() => {
    if (!active) return;
    const ids = idsKey.split(',').map(Number);
    const timer = setInterval(() => {
      readQueue().then(all => {
        const list = all.filter(j => ids.includes(j.id)).sort((a, b) => a.id - b.id);
        if (!list.length) return;
        setJobs(list);
        autoPick(list);
      }).catch(() => setOffline(true));
    }, 1000);
    return () => clearInterval(timer);
  }, [active, idsKey]);

  // Picking the job that is running now means "follow along"; picking any other one keeps it on screen.
  function select(id: number) {
    const picked = jobs.find(j => j.id === id);
    pinned.current = !(picked && picked.status === 'running');
    setSelectedId(id);
  }

  async function start(body: { path: string; env: string; doc_type: string }): Promise<{ error: string | null; note: string | null }> {
    try {
      const res = await fetch(`${RAG_API}/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) return { error: await readError(res), note: null };
      const data: { jobs: { job_id: number; path: string }[]; skipped: { path: string; reason: string }[] } = await res.json();
      setOffline(false);
      const note = data.skipped.length ? `${data.skipped.length} skipped · ${data.skipped[0].path.split('/').pop()}: ${data.skipped[0].reason}` : null;
      if (!data.jobs.length) return { error: note ?? 'Nothing to ingest', note: null };
      const created = new Date().toISOString();
      const list: Job[] = data.jobs.map(j => ({ id: j.job_id, path: j.path, params: body, status: 'queued', stage: null, stage_index: null, progress_done: null, progress_total: null, error: null, result: null, created_at: created, started_at: null, finished_at: null }));
      pinned.current = false;
      setJobs(list);
      setSelectedId(list[0].id);
      return { error: null, note };
    } catch {
      setOffline(true);
      return { error: 'Engine is not reachable. Start the engine API first.', note: null };
    }
  }

  // Shows jobs that were started somewhere else (index build or refresh from the setup panel).
  function adopt(created: { job_id: number; path: string }[], params: Record<string, unknown>) {
    const at = new Date().toISOString();
    const list: Job[] = created.map(j => ({ id: j.job_id, path: j.path, params, status: 'queued', stage: null, stage_index: null, progress_done: null, progress_total: null, error: null, result: null, created_at: at, started_at: null, finished_at: null }));
    if (!list.length) return;
    pinned.current = false;
    setJobs(list);
    setSelectedId(list[0].id);
  }

  return { jobs, job, select, moments, offline, start, adopt };
}

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

// Chunks of one document in one index (the base index when indexId is not given).
function useChunks(documentId: number | null, indexId?: number) {
  const [chunks, setChunks] = useState<Chunk[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (documentId === null) return;
    setChunks(null);
    fetch(`${RAG_API}/documents/${documentId}/chunks${indexId ? `?index_id=${indexId}` : ''}`).then(async r => (r.ok ? r.json() : Promise.reject(await readError(r))))
      .then(setChunks).catch(e => setError(String(e)));
  }, [documentId, indexId]);
  return { chunks, error };
}


function elapsed(job: Job | null, now: number) {
  if (!job?.started_at) return null;
  const end = job.finished_at ? Date.parse(job.finished_at) : now;
  return Math.max(0, (end - Date.parse(job.started_at)) / 1000);
}

// chip: what this stage is set to now (e.g. "bge-m3 · Local"). Cards with a chip open their settings.
function StageCard({ node, state, sub, progress, chip, onOpen }: { node: StageNode; state: NodeState; sub: string; progress?: number | null; chip?: { text: string; external?: boolean } | null; onOpen?: () => void }) {
  const isCurrent = state === 'current';
  return <motion.button
    className={`flow-node ingest-node is-${state} ${chip ? 'has-chip' : ''}`}
    onClick={onOpen}
    disabled={!onOpen}
    aria-label={onOpen ? `${node.name}: ${node.settings ? 'settings and details' : 'details'}` : node.name}
    animate={state === 'failed' ? { x: [0, -6, 6, -4, 4, 0], scale: 1 } : { x: 0, scale: isCurrent ? 1.04 : 1 }}
    transition={state === 'failed' ? { duration: 0.5 } : spring}
  >
    <span className="node-icon-wrap">
      {isCurrent && <motion.span className="node-halo" initial={{ scale: 1, opacity: 0.55 }} animate={{ scale: 1.9, opacity: 0 }} transition={{ duration: 1.6, repeat: Infinity, ease: 'easeOut' }} />}
      <motion.span animate={isCurrent ? { y: [0, -2, 0] } : { y: 0 }} transition={isCurrent ? { duration: 1.4, repeat: Infinity, ease: 'easeInOut' } : spring} style={{ display: 'inline-grid' }}>
        <ColorIcon icon={state === 'failed' ? CircleAlert : node.icon} color={state === 'failed' ? 'peach' : node.color} />
      </motion.span>
    </span>
    <h3>{node.name}</h3>
    <AnimatePresence mode="wait" initial={false}>
      <motion.small key={sub} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.25 }}>{sub}</motion.small>
    </AnimatePresence>
    {chip && <span className={`node-chip ${chip.external ? 'is-external' : ''}`} title={chip.text}>{chip.text}</span>}
    {progress != null && <div className="node-progress" aria-label={`${node.name} ${progress}%`}>
      <motion.span initial={{ width: 0 }} animate={{ width: `${progress}%` }} transition={{ duration: 0.7, ease }} />
    </div>}
    <span className="node-port left" /><span className="node-port right" />
    <AnimatePresence>{state === 'done' && <motion.span className="node-check" initial={{ scale: 0, rotate: -40 }} animate={{ scale: 1, rotate: 0 }} exit={{ scale: 0 }} transition={{ type: 'spring', stiffness: 520, damping: 18 }}><Check size={13} /></motion.span>}</AnimatePresence>
    {state === 'planned' && <span className="node-soon">Soon</span>}
  </motion.button>;
}

function StageConnector({ from, to }: { from: NodeState; to: NodeState }) {
  const filled = from === 'done' && (to === 'done' || to === 'current' || to === 'failed');
  const flowing = from === 'done' && to === 'current';
  return <div className={`flow-connector ingest-connector ${filled ? 'passed' : ''} ${to === 'planned' ? 'is-planned' : ''}`}>
    <motion.span className="connector-fill" initial={false} animate={{ scaleX: filled ? 1 : 0 }} transition={{ duration: 0.6, ease }} />
    {flowing && <motion.span className="connector-comet" initial={{ left: '0%', opacity: 0 }} animate={{ left: ['0%', '100%'], opacity: [0, 1, 0] }} transition={{ duration: 1.1, repeat: Infinity, ease: 'easeInOut' }} />}
    <ArrowRight size={14} />
  </div>;
}

// One collapsible group. The header stays visible when closed, so the run can still be followed from its meter.
function GroupCard({ group, open, toggle, summary, badge, meter, delay, children }: {
  group: Group; open: boolean; toggle: () => void; summary: string; badge: React.ReactNode;
  meter?: { value: number; tone: string }; delay: number; children: React.ReactNode;
}) {
  const planned = group.nodes.every(n => !n.stage && !n.live);
  return <Card className={`pipeline-canvas group-card ${open ? 'is-open' : ''} ${planned ? 'is-planned' : ''}`} delay={delay}>
    <button className="group-head" onClick={toggle} aria-expanded={open}>
      <ColorIcon icon={group.icon} color={planned ? 'neutral' : group.color} small />
      <span className="group-title">
        <h2>{group.title}</h2>
        <AnimatePresence mode="wait" initial={false}>
          <motion.small key={summary} initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -3 }} transition={{ duration: 0.2 }}>{summary}</motion.small>
        </AnimatePresence>
      </span>
      {meter && <span className={`group-meter is-${meter.tone}`}><motion.span initial={false} animate={{ width: `${Math.round(meter.value * 100)}%` }} transition={{ duration: 0.7, ease }} /></span>}
      {badge}
      <motion.span className="group-chevron" animate={{ rotate: open ? 180 : 0 }} transition={spring}><ChevronDown size={16} /></motion.span>
    </button>
    <AnimatePresence initial={false}>
      {open && <motion.div key="body" className="group-body" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.45, ease }}>
        {children}
      </motion.div>}
    </AnimatePresence>
  </Card>;
}

function ChunkList({ chunks, highlight }: { chunks: Chunk[]; highlight?: number }) {
  // 강조할 조각이 있으면 그 조각까지 스크롤한다
  const target = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = target.current;
    const list = el?.parentElement;
    // 목록과 창(모달)을 함께 움직여 그 조각이 화면 가운데 오게 한다
    if (el && list) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [chunks, highlight]);
  return <div className="chunk-list">{chunks.map((c, i) => <motion.article ref={c.chunk_index === highlight ? target : undefined} className={`chunk-item ${c.chunk_index === highlight ? 'is-target' : ''}`} key={c.chunk_index} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i, 12) * 0.035, duration: 0.35 }}>
    <header><span>#{String(c.chunk_index).padStart(2, '0')}</span><span>{c.token_count} tokens</span></header>
    <h4>{c.heading_path.split(' > ').slice(1).join(' › ') || c.heading_path}</h4>
    <p>{c.content.replace(/^#{2,3}\s.*\n+/, '')}</p>
  </motion.article>)}</div>;
}

function ChunkModal({ documentId, indexId, close }: { documentId: number; indexId?: number; close: () => void }) {
  const { chunks, error } = useChunks(documentId, indexId);
  return <Modal title={`Chunks · document #${documentId}`} close={close}>
    <p className="muted">{chunks ? `${chunks.length} chunks${indexId ? ` in index #${indexId}` : ''}` : error ?? 'Loading…'}</p>
    {chunks && <ChunkList chunks={chunks} />}
  </Modal>;
}


// What one indexing stage did in the latest run (the "Last run" tab of the stage panel).
// index: the index the job filled, for its model, size and token limit.
function StageRun({ index, job, info, maxTokens }: { index: number; job: Job; info?: IndexInfo; maxTokens?: number }) {
  const node = indexing[index];
  const state = nodeState(job, index);
  const r = job.result;
  const { chunks, error } = useChunks(r && index >= 2 && index <= 4 ? r.document_id : null, r?.index_id);
  const params = job.params ?? {};
  const waiting = <p className="dialog-note">{error ?? 'Loading…'}</p>;
  const pending = <p className="dialog-note">Details appear once the run finishes.</p>;
  const limit = maxTokens ?? Math.max(1, ...(chunks ?? []).map(c => c.token_count));

  let body: React.ReactNode = null;
  if (index === 0) body = <DetailRows rows={[
    ['Job', jobKind(job) === 'build' ? `Index build #${String(params.index_id ?? '?')}` : 'Ingest'],
    ['File', job.path],
    ['Repository', r?.source_repo],
    ['Path in repo', r?.source_path],
    ['Commit', r && <>{r.source_commit}{r.source_commit.endsWith('-dirty') && <em className="detail-hint">-dirty: the file had uncommitted edits</em>}</>],
    ['Title', r?.title],
    ...(jobKind(job) === 'ingest' ? [
      ['Environment', String(params.env ?? '—')],
      ['Document type', String(params.doc_type ?? '—')],
      ['Verification', String(params.verification ?? '미확인')],
    ] as [string, React.ReactNode][] : []),
  ]} />;
  else if (!r) body = pending;
  else if (index === 1) body = <div className="verdict">
    <span className={`pill ${resultTone[r.status].color}`}>{resultTone[r.status].label}</span>
    <p>{resultTone[r.status].note}</p>
    <small>Document #{r.document_id}</small>
  </div>;
  else if (index === 2) body = chunks ? <><p className="muted">{chunks.length} chunks · {info?.label.chunker ?? 'stored index'}</p><ChunkList chunks={chunks} /></> : waiting;
  else if (index === 3) body = chunks ? <>
    <div className="result-stats">
      <div><strong>{Math.min(...chunks.map(c => c.token_count))}</strong><small>Min</small></div>
      <div><strong>{Math.max(...chunks.map(c => c.token_count))}</strong><small>Max</small></div>
      <div><strong>{chunks.reduce((s, c) => s + c.token_count, 0).toLocaleString()}</strong><small>Total</small></div>
    </div>
    <div className="token-bars">{chunks.map((c, i) => <div className="token-row" key={c.chunk_index}>
      <span>#{String(c.chunk_index).padStart(2, '0')}</span>
      <span className="token-track"><motion.span initial={{ width: 0 }} animate={{ width: `${Math.min(100, (c.token_count / limit) * 100)}%` }} transition={{ delay: Math.min(i, 30) * 0.02, duration: 0.6, ease }} /></span>
      <span>{c.token_count}</span>
    </div>)}</div>
    <p className="dialog-note">{maxTokens ? `Bars are scaled to the ${maxTokens.toLocaleString()}-token limit of ${info?.label.embedder ?? 'the model'}.` : 'Bars are scaled to the longest chunk.'}</p>
  </> : waiting;
  else if (index === 4) body = chunks ? <>
    <div className="result-stats">
      <div><strong><CountUp value={chunks.length} /></strong><small>Vectors</small></div>
      <div><strong>{info?.dims ?? '—'}</strong><small>Dimensions</small></div>
      <div><strong>{info ? (info.external ? 'External' : 'Local') : '—'}</strong><small>{info?.label.embedder ?? 'Model'}</small></div>
    </div>
    <p className="muted">What gets embedded{info?.chunker.params.prefix === 'none' ? ' — the section text only.' : ' — the heading path is put in front of the chunk text.'}</p>
    {chunks[0] && <article className="chunk-item embed-preview"><header><span>#{String(chunks[0].chunk_index).padStart(2, '0')}</span><span>{chunks[0].token_count} tokens</span></header><p>{chunks[0].embed_text}</p></article>}
  </> : waiting;
  else body = <DetailRows rows={[
    ['Document', `#${r.document_id}`],
    ['Index', info ? `#${info.id} · ${info.label.chunker} × ${info.label.embedder}${info.is_base ? ' ★' : ''}` : r.index_id ? `#${r.index_id}` : 'Base index'],
    ['Result', resultTone[r.status].label],
    ['Chunks stored', r.chunks ?? 'unchanged'],
    ['Finished', job.finished_at ? new Date(job.finished_at).toLocaleString() : null],
    ['Tables', 'documents · chunks (pgvector)'],
  ]} />;

  return <>
    <div className="node-summary"><ColorIcon icon={state === 'failed' ? CircleAlert : node.icon} color={state === 'failed' ? 'peach' : node.color} /><div><h3>{stageLabels[node.stage!]}</h3><small>{node.note}</small></div></div>
    <p className="run-of">Job #{job.id} · {fileName(job.path)}</p>
    {state === 'failed' && <p className="result-error">{job.error}</p>}
    {state === 'skipped' && <p className="dialog-note">This stage did not run because the document is unchanged. Showing the stored copy.</p>}
    {body}
  </>;
}

// One chip per document in the latest request. The chip being shown is highlighted; the running one fills as it goes.
function QueueStrip({ jobs, selected, select }: { jobs: Job[]; selected: number | null; select: (id: number) => void }) {
  return <div className="queue-strip" role="list" aria-label="Ingest queue">
    {jobs.map((j, i) => {
      const tone = j.status === 'done' ? (j.result?.status === 'skipped' ? 'unchanged' : 'done') : j.status;
      const Icon = j.status === 'done' ? Check : j.status === 'failed' ? CircleAlert : j.status === 'running' ? LoaderCircle : Clock3;
      return <motion.button key={j.id} role="listitem" layout className={`queue-chip is-${tone} ${j.id === selected ? 'is-selected' : ''}`}
        onClick={() => select(j.id)} title={j.path}
        initial={{ opacity: 0, y: 6, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ ...spring, delay: Math.min(i, 20) * 0.03 }}>
        <Icon size={12} className={j.status === 'running' ? 'spin' : ''} />
        <span>{j.path.split('/').pop()?.replace(/\.(md|pdf)$/i, '')}</span>
        {j.status === 'running' && <motion.i className="queue-fill" initial={false} animate={{ width: `${Math.round(indexingProgress(j) * 100)}%` }} transition={{ duration: 0.6, ease }} />}
      </motion.button>;
    })}
  </div>;
}

function Pipeline({ enabled, flip, callIngest, consumeIngest, callSetup, consumeSetup, openKnowledge, openProjects }: {
  enabled: boolean[]; flip: (i: number) => void; callIngest: boolean; consumeIngest: () => void; callSetup: boolean; consumeSetup: () => void; openKnowledge: () => void; openProjects: () => void;
}) {
  const { jobs, job, select, moments, offline, start, adopt } = useIngestQueue();
  const s = useSetup();
  const { catalog } = useCatalog();
  const [path, setPath] = useState(() => { try { return localStorage.getItem(LAST_PATH_KEY) ?? ''; } catch { return ''; } });
  const [env, setEnv] = useState(ENV_OPTIONS[0]);
  const [docType, setDocType] = useState(DOC_TYPE_OPTIONS[0]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // 적은 경로가 어느 프로젝트로 들어가는지. 어느 프로젝트 폴더에도 없으면 넣을 수 없다 (엔진도 같은 규칙으로 거절한다).
  const [owner, setOwner] = useState<{ path: string; project: { id: number; name: string } | null } | null>(null);
  useEffect(() => {
    const p = path.trim();
    if (!p) { setOwner(null); return; }
    let live = true;
    const t = setTimeout(() => {
      api<{ project: { id: number; name: string } | null }>(`/projects/match?path=${encodeURIComponent(p)}`)
        .then(r => { if (live) setOwner({ path: p, project: r.project }); }).catch(() => { if (live) setOwner(null); });
    }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [path]);
  const ownerKnown = owner?.path === path.trim();
  const [chunksOf, setChunksOf] = useState<{ doc: number; index?: number } | null>(null);
  const [panel, setPanel] = useState<{ group: GroupId; node: number } | null>(null);
  // 설정 서랍: 열려 있으면 시작할 단계 번호, 닫혀 있으면 null. 다른 화면의 [설정 바꾸기]로 왔으면 첫 단계부터 연다.
  const [flow, setFlow] = useState<number | null>(null);
  const lastFlow = useRef(0);
  if (flow !== null) lastFlow.current = flow;
  useEffect(() => { if (callSetup) { consumeSetup(); setFlow(0); } }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  // 다른 화면의 [문서 넣기]로 왔으면 경로 입력칸에 커서를 두고 잠깐 빛나게 한다 (화면 전환이 끝난 뒤).
  const sourceInput = useRef<HTMLInputElement>(null);
  const [called, setCalled] = useState(false);
  // 화면이 처음 열릴 때 한 번만 본다. (callIngest를 지우면 값이 바뀌지만, 그때 타이머를 지우면 안 되므로 의존성에 넣지 않는다.)
  useEffect(() => {
    if (!callIngest) return;
    consumeIngest();
    const t1 = setTimeout(() => { sourceInput.current?.focus(); setCalled(true); }, 250);
    const t2 = setTimeout(() => setCalled(false), 2000);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  const [open, setOpen] = useState<Record<GroupId, boolean>>({ indexing: true, retrieval: true, generation: false });
  const queueActive = jobs.some(isActive);
  const busy = submitting || queueActive;
  const building = jobs.some(j => jobKind(j) === 'build');
  const jobBusy = !!job && isActive(job);
  const now = useNow(job?.status === 'running' || job?.status === 'queued');
  const seconds = elapsed(job, now);
  const firstAt = moments[0]?.at ?? 0;
  const status = job?.status;
  const states = indexing.map((_, i) => nodeState(job, i));

  // A run that starts while Indexing is folded opens it again.
  useEffect(() => { if (busy) setOpen(o => (o.indexing ? o : { ...o, indexing: true })); }, [busy]);
  // When the queue goes quiet, read the setup again: a finished build may have switched it, and an ingest leaves other indexes behind.
  const wasActive = useRef(false);
  useEffect(() => { if (wasActive.current && !queueActive) void s.reload(); wasActive.current = queueActive; }, [queueActive]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!path.trim() || busy) return;
    setSubmitting(true);
    setError(null);
    setNote(null);
    try { localStorage.setItem(LAST_PATH_KEY, path.trim()); } catch { /* storage unavailable */ }
    const outcome = await start({ path: path.trim(), env, doc_type: docType });
    setError(outcome.error);
    setNote(outcome.note);
    setSubmitting(false);
  }

  // A build or refresh started from the setup bar or a stage panel: follow its jobs in the same queue.
  function followBuild(r: BuildResponse) {
    setPanel(null);
    setFlow(null);
    setError(null);
    if (!r.jobs.length) { setNote(r.applied ? 'Applied. The index already had every document.' : 'Nothing to refresh. The index is up to date.'); return; }
    const index = s.indexes.find(i => i.id === r.index_id);
    setNote(`Building index #${r.index_id}${index ? ` (${index.label.embedder})` : ''}: ${r.jobs.length} document${r.jobs.length === 1 ? '' : 's'}. It becomes the current setup when every document is done.`);
    adopt(r.jobs, { kind: 'build', index_id: r.index_id });
  }

  // The index the shown job filled: its model, size and token limit explain the "Last run" tab.
  const base = s.indexes.find(i => i.is_base);
  const jobIndexId = job?.result?.index_id ?? (job && jobKind(job) === 'build' ? Number(job.params?.index_id) : base?.id);
  const jobInfo = s.indexes.find(i => i.id === jobIndexId);
  const limitOf = (info?: IndexInfo) => catalog?.embedder.find(e => e.id === info?.embedder.id)?.max_tokens;
  const cur = s.setup?.index;

  function chipFor(n: StageNode): { text: string; external?: boolean } | null {
    if (!cur || !s.setup) return null;
    if (n.settings === 'chunker') return { text: cur.label.chunker };
    if (n.settings === 'embedder') return n.name === 'Tokens'
      ? { text: `≤ ${limitOf(cur)?.toLocaleString() ?? '?'} · ${cur.label.embedder}` }
      : { text: `${cur.label.embedder} · ${cur.dims}d`, external: cur.external };
    if (n.settings === 'reranker') return { text: s.setup.query.reranker_label ?? 'Off' };
    if (n.settings === 'keyword') return { text: s.setup.query.keyword_label ?? '꺼짐' };
    if (n.settings === 'generator') return { text: s.setup.query.generator_label ?? 'Off', external: !!catalog?.generator.find(g => g.id === s.setup?.query.generator?.id)?.external };
    if (n.settings === 'query') return n.name === 'Query' ? { text: cur.label.embedder, external: cur.external } : { text: `top-k ${s.setup.query.top_k}` };
    if (n.settings) return { text: 'Not set' };
    return null;
  }

  const time = seconds !== null ? ` · ${seconds.toFixed(1)}s` : '';
  const finished = jobs.filter(j => !isActive(j)).length;
  const failedCount = jobs.filter(j => j.status === 'failed').length;
  const queuePrefix = (building ? `Index #${String(jobs[0].params?.index_id ?? '?')} · ` : '') + (jobs.length > 1 ? `${finished} / ${jobs.length} documents · ` : '');
  const jobSummary = !job ? 'Not run yet · document → chunks → vectors'
    : status === 'done' && job.result ? `Job #${job.id} · ${job.result.chunks ?? 'no new'} chunks${time}`
    : status === 'failed' ? `Job #${job.id} · stopped at ${indexing[currentIndex(job)].name}`
    : `Job #${job.id} · ${job.stage ? stageLabels[job.stage] : 'Waiting in queue'}${time}`;
  const indexingSummary = queuePrefix + jobSummary;
  const queueProgress = jobs.length ? jobs.reduce((sum, j) => sum + indexingProgress(j), 0) / jobs.length : 0;
  const queueTone = busy ? 'running' : failedCount ? 'failed' : 'done';
  const indexingBadge = jobs.length > 1 ? (busy ? <span className="pill lilac">Running</span>
      : failedCount ? <span className="pill peach">{failedCount} failed</span>
      : <span className="pill lime">All done</span>)
    : status === 'done' && job?.result ? <span className={`pill ${resultTone[job.result.status].color}`}>{resultTone[job.result.status].label}</span>
    : status === 'failed' ? <span className="pill peach">Failed</span>
    : busy ? <span className="pill lilac">Running</span>
    : <span className="tag">Live</span>;
  const embedIndex = indexing.findIndex(n => n.stage === '임베딩');
  const embedPct = states[embedIndex] === 'done' ? 100
    : states[embedIndex] === 'current' && job?.progress_total ? Math.round(((job.progress_done ?? 0) / job.progress_total) * 100)
    : states[embedIndex] === 'current' ? 0 : null;
  const target = panel ? groups.find(g => g.id === panel.group)!.nodes[panel.node] : null;

  return <>
    <Heading title="RAG pipeline" subtitle="Pick what each stage uses, ingest documents and follow every stage live">
      <span className="tag">{offline ? 'Engine offline' : 'Local engine'}</span>
    </Heading>

    <SetupBar s={s} onBuild={followBuild} onChange={() => setFlow(0)} />

    <Card className={`source-card ${called ? 'is-called' : ''}`}>
      <form className="source-form" onSubmit={submit}>
        <ColorIcon icon={FileText} color="lime" small />
        <input ref={sourceInput} className="source-input" aria-label="Document or folder path" placeholder="/path/to/docs-repo — a folder or one .md file" value={path} onChange={e => setPath(e.target.value)} spellCheck={false} />
        <select className="chip-select" aria-label="Environment" value={env} onChange={e => setEnv(e.target.value)}>{ENV_OPTIONS.map(o => <option key={o}>{o}</option>)}</select>
        <select className="chip-select" aria-label="Document type" value={docType} onChange={e => setDocType(e.target.value)}>{DOC_TYPE_OPTIONS.map(o => <option key={o}>{o}</option>)}</select>
        <button className="primary-button" disabled={busy || !path.trim() || (ownerKnown && !owner?.project)}>
          {busy ? <LoaderCircle size={15} className="spin" /> : <Play size={15} />}{busy ? (building ? 'Building…' : 'Ingesting…') : 'Run ingest'}
        </button>
      </form>
      <AnimatePresence initial={false}>{ownerKnown && <motion.p key={owner!.project ? 'in' : 'out'} className={`pj-owner ${owner!.project ? '' : 'is-out'}`} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>
        {owner!.project ? <><ArrowRight size={12} />프로젝트 <b>{owner!.project.name}</b>에 넣어요</>
          : <><CircleAlert size={12} />어느 프로젝트 폴더에도 없어요. 프로젝트를 먼저 만들어 주세요 <button type="button" className="text-button" onClick={openProjects}>Knowledge 열기 <ArrowUpRight size={11} /></button></>}
      </motion.p>}</AnimatePresence>
      <AnimatePresence>{note && !error && <motion.p className="source-note" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>{note}</motion.p>}</AnimatePresence>
      <AnimatePresence>{error && <motion.p className="source-error" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>{error}</motion.p>}</AnimatePresence>
    </Card>

    <div className="stage-groups">
      {groups.map((g, gi) => {
        const live = g.id === 'indexing';
        const toggle = () => setOpen(o => ({ ...o, [g.id]: !o[g.id] }));
        return <GroupCard key={g.id} group={g} open={open[g.id]} toggle={toggle} delay={0.05 + gi * 0.06}
          summary={live ? indexingSummary : g.id === 'retrieval' && s.setup ? `Question → ${s.setup.query.reranker ? `${s.setup.query.reranker.params.candidates} candidates → rerank → ` : ''}top ${s.setup.query.top_k} chunks from index #${s.setup.index.id}${s.setup.query.reranker ? '' : ' · rerank off'}` : g.nodes.map(n => n.name).join(' → ')}
          badge={live ? indexingBadge : g.id === 'retrieval' ? <span className="tag">Used by Evaluations</span> : <span className="tag">Soon</span>}
          meter={live ? { value: queueProgress, tone: queueTone } : undefined}>
          {live ? <>
            {jobs.length > 1 && <QueueStrip jobs={jobs} selected={job?.id ?? null} select={select} />}
            <div className="flow-nodes">{indexing.map((n, i) => <React.Fragment key={n.name}>
              <StageCard node={n} state={states[i]} sub={stageSub(job, i, states[i])} progress={i === embedIndex ? embedPct : null} chip={chipFor(n)}
                onOpen={job && ['done', 'skipped', 'failed'].includes(states[i]) ? () => setPanel({ group: 'indexing', node: i })
                  : n.settings ? () => setFlow(stepOf(n.settings!)) : undefined} />
              {i < indexing.length - 1 && <StageConnector from={states[i]} to={states[i + 1]} />}
            </React.Fragment>)}</div>
            <div className="canvas-footer">
              <span><GitBranch size={14} />{job?.result ? `${job.result.source_repo}/${job.result.source_path}` : job?.path.split('/').slice(-2).join('/') ?? 'No document yet'}{jobInfo && job ? ` · index #${jobInfo.id}${jobInfo.is_base ? ' ★' : ''}` : ''}</span>
              <span>지난 실행이 있으면 카드를 눌러 그 단계 결과를 봐요 · 설정은 [설정 바꾸기]</span>
            </div>
          </> : <>
            <div className="flow-nodes">{g.nodes.map((n, i) => <React.Fragment key={n.name}>
              <StageCard node={n} state={n.live ? 'idle' : 'planned'} sub={n.detail} chip={chipFor(n)} onOpen={n.settings ? () => setFlow(stepOf(n.settings!)) : undefined} />
              {i < g.nodes.length - 1 && <StageConnector from={n.live ? 'done' : 'planned'} to={g.nodes[i + 1].live ? 'idle' : 'planned'} />}
            </React.Fragment>)}</div>
            <div className="canvas-footer"><span><GitBranch size={14} />{g.id === 'retrieval' ? 'Search runs in Evaluations today' : 'Planned'}</span><span>{g.id === 'retrieval' ? 'Changes apply right away' : 'Not connected to the engine yet'}</span></div>
          </>}
        </GroupCard>;
      })}
    </div>

    <div className="live-grid">
      <Card className="timeline-card" delay={0.08}>
        <div className="section-heading"><h2>Activity</h2><span className="tag">Live stream</span></div>
        {moments.length ? <ol className="timeline">
          <AnimatePresence initial={false}>{moments.map(m => <motion.li key={m.key} layout initial={{ opacity: 0, x: -10, filter: 'blur(4px)' }} animate={{ opacity: 1, x: 0, filter: 'blur(0px)' }} transition={{ duration: 0.35 }}>
            <span className={`dot ${m.tone}`} />
            <span>{m.label}{m.detail && <em>{m.detail}</em>}</span>
            <small>+{((m.at - firstAt) / 1000).toFixed(1)}s</small>
          </motion.li>)}</AnimatePresence>
        </ol> : <div className="empty-state compact"><ColorIcon icon={Clock3} color="neutral" /><h3>Nothing running</h3><p>Run an ingest to watch each stage arrive.</p></div>}
      </Card>

      <Card className="result-card" delay={0.14}>
        <div className="section-heading"><h2>Result</h2>
          {status === 'done' && job?.result && <span className={`pill ${resultTone[job.result.status].color}`}>{resultTone[job.result.status].label}</span>}
          {status === 'failed' && <span className="pill peach">Failed</span>}
          {jobBusy && <span className="pill lilac">{job?.status === 'queued' ? 'Waiting' : 'Running'}</span>}
        </div>
        <AnimatePresence mode="wait">
          {status === 'done' && job?.result ? <motion.div key="done" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <h3 className="result-title">{job.result.title}</h3>
            <div className="result-stats">
              <div><strong>{job.result.chunks !== null ? <CountUp value={job.result.chunks} /> : '—'}</strong><small>Chunks</small></div>
              <div><strong>{job.result.tokens ? <CountUp value={job.result.tokens.max} /> : '—'}</strong><small>Max tokens</small></div>
              <div><strong>{seconds !== null ? `${seconds.toFixed(1)}s` : '—'}</strong><small>Elapsed</small></div>
            </div>
            <p className="result-source">{job.result.source_repo}/{job.result.source_path}<br />@ {job.result.source_commit.slice(0, 12)}{jobInfo ? <><br />index #{jobInfo.id} · {jobInfo.label.embedder}</> : null}</p>
            <button className="subtle-button result-action" onClick={() => setChunksOf({ doc: job.result!.document_id, index: job.result!.index_id })}>View chunks <ArrowUpRight size={14} /></button>
          </motion.div>
          : status === 'failed' ? <motion.div key="failed" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <h3 className="result-title">Stopped at {indexing[currentIndex(job!)].name}</h3>
            <p className="result-error">{job!.error}</p>
          </motion.div>
          : jobBusy ? <motion.div key="busy" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <h3 className="result-title">{job?.stage ? stageLabels[job.stage] : 'Waiting in queue'}</h3>
            <div className="progress-row result-progress"><span className="progress-track"><motion.span animate={{ width: `${((job?.stage_index ?? 0) / 6) * 100}%` }} transition={{ duration: 0.6, ease }} /></span><span>{job?.stage_index ?? 0} / 6</span></div>
          </motion.div>
          : <motion.div key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            <p className="result-source">The latest result appears here — chunk count, token size and the source commit.</p>
          </motion.div>}
        </AnimatePresence>
      </Card>
    </div>

    <div className="section-heading pipeline-options-heading"><h2>Pipeline options</h2><span className="tag">Preview settings</span></div>
    <div className="quick-grid">{['Retrieval', 'Reranking', 'Streaming', 'Citations'].map((name, i) => <Card className="option-card" key={name} delay={0.15 + i * 0.06}><span>{name}</span><Toggle checked={enabled[i]} onChange={() => flip(i)} label={name} /></Card>)}</div>

    {chunksOf !== null && <ChunkModal documentId={chunksOf.doc} indexId={chunksOf.index} close={() => setChunksOf(null)} />}
    <AnimatePresence>{target && panel && <StagePanel key={`${panel.group}-${panel.node}`} title={target.name} icon={target.icon} color={target.color}
      lastRun={panel.group === 'indexing' && job && job.status !== 'queued' ? <StageRun index={panel.node} job={job} info={jobInfo} maxTokens={limitOf(jobInfo)} /> : null}
      close={() => setPanel(null)} onChange={target.settings ? () => { setPanel(null); setFlow(stepOf(target.settings!)); } : undefined} />}</AnimatePresence>
    <SetupFlow open={flow !== null} start={flow ?? lastFlow.current} s={s} catalog={catalog} busy={queueActive}
      onClose={() => setFlow(null)} onBuild={followBuild} openKnowledge={openKnowledge} />
  </>;
}

type QueueStatus = {
  online: boolean; workers: { name: string; active_job_ids: number[] }[]; redis_waiting: number | null;
  jobs: Record<JobStatus, number>; problems: string[];
};
const jobTone: Record<JobStatus, { label: string; color: string }> = {
  queued: { label: 'Waiting', color: 'neutral' }, running: { label: 'Running', color: 'lilac' },
  done: { label: 'Done', color: 'lime' }, failed: { label: 'Failed', color: 'peach' },
};
const fileName = (path: string) => path.split('/').pop() ?? path;
const kindLabel = (j: Job) => jobKind(j) === 'build' ? `Index #${String(j.params?.index_id ?? '?')}` : jobKind(j) === 'eval' ? 'Evaluation' : jobKind(j) === 'drafts' ? 'Question drafts' : 'Ingest';
// What a finished or stopped job came to, in one short phrase.
function jobOutcome(j: Job) {
  if (j.result?.status === 'evaluated') return `R@1 ${j.result.summary?.['recall@1'] != null ? Math.round(j.result.summary['recall@1'] * 100) + '%' : '—'} · run #${j.result.eval_run_id}`;
  // 질문 초안 작업은 결과 모양이 달라서(status 없이 made·cost_usd) 따로 적는다.
  if (jobKind(j) === 'drafts' && j.result) { const d = j.result as unknown as { made?: number; cost_usd?: number }; return `${d.made ?? 0} drafts · $${(d.cost_usd ?? 0).toFixed(4)}`; }
  if (j.result) return resultTone[j.result.status]?.label ?? 'Done';
  if (j.status === 'failed') return `Stopped at ${j.stage ? stageLabels[j.stage] ?? j.stage : 'start'}`;
  if (j.stage) return j.progress_total && jobKind(j) === 'eval' ? `${stageLabels[j.stage]} ${j.progress_done ?? 0} / ${j.progress_total}` : stageLabels[j.stage] ?? j.stage;
  return '—';
}
function duration(job: Job) {
  if (!job.started_at || !job.finished_at) return '—';
  return `${((Date.parse(job.finished_at) - Date.parse(job.started_at)) / 1000).toFixed(1)}s`;
}

// Worker and queue state (GET /queue every 3s) plus the job history (GET /jobs, faster while something is moving).
function useRunHistory() {
  const [queue, setQueue] = useState<QueueStatus | null>(null);
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const moving = !!jobs?.some(isActive) || !!queue?.jobs.queued || !!queue?.jobs.running;
  useEffect(() => {
    let alive = true;
    const readQueue = () => fetch(`${RAG_API}/queue`).then(async r => (r.ok ? r.json() : Promise.reject(await readError(r))))
      .then(q => { if (alive) { setQueue(q); setError(null); } }).catch(e => alive && setError(String(e)));
    readQueue();
    const timer = setInterval(readQueue, 3000);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  useEffect(() => {
    let alive = true;
    const readJobs = () => fetch(`${RAG_API}/jobs?limit=100`).then(r => (r.ok ? r.json() : Promise.reject()))
      .then(list => alive && setJobs(list)).catch(() => undefined);
    readJobs();
    const timer = setInterval(readJobs, moving ? 1000 : 5000);
    return () => { alive = false; clearInterval(timer); };
  }, [moving]);
  return { queue, jobs, error };
}

function JobModal({ job, close }: { job: Job; close: () => void }) {
  const r = job.result;
  return <Modal title={`Job #${job.id}`} close={close}>
    <div className="node-summary"><ColorIcon icon={job.status === 'failed' ? CircleAlert : jobKind(job) === 'eval' ? ChartNoAxesCombined : FileText} color={job.status === 'failed' ? 'peach' : jobKind(job) === 'eval' ? 'lilac' : 'lime'} /><div><h3>{r?.title ?? fileName(job.path)}</h3><small>{job.path}</small></div></div>
    {job.error && <p className="result-error">{job.error}</p>}
    <DetailRows rows={[
      ['Kind', kindLabel(job)],
      ['Status', jobTone[job.status].label],
      ['Result', jobOutcome(job)],
      ...(jobKind(job) === 'eval' ? [] : [
        ['Last stage', job.stage ? `${job.stage_index ?? '?'} / 6 · ${stageLabels[job.stage] ?? job.stage}` : '—'],
        ['Chunks', r?.chunks ?? '—'],
        ['Document', r ? `#${r.document_id}` : '—'],
      ] as [string, React.ReactNode][]),
      ['Queued', shortTime(job.created_at)],
      ['Took', duration(job)],
      ...(jobKind(job) === 'ingest' ? [
        ['Environment', String(job.params?.env ?? '—')],
        ['Document type', String(job.params?.doc_type ?? '—')],
      ] as [string, React.ReactNode][] : []),
    ]} />
  </Modal>;
}

// Run history: the Celery worker, what is waiting in Redis, and every ingest job the engine recorded.
function Runs({ openPipeline }: { openPipeline: () => void }) {
  const { queue, jobs, error } = useRunHistory();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<Job | null>(null);
  const q = query.trim().toLowerCase();
  const shown = (jobs ?? []).filter(j => !q || j.path.toLowerCase().includes(q) || String(j.id) === q || jobTone[j.status].label.toLowerCase() === q);
  const runningId = queue?.workers.flatMap(w => w.active_job_ids)[0];
  const runningJob = jobs?.find(j => j.id === runningId);
  const waiting = queue ? queue.jobs.queued : 0;
  const offline = !!error && !queue;

  return <>
    <Heading title="Run history" subtitle="Ingest, index build and evaluation jobs, and the Celery worker that runs them">
      <button className="subtle-button" onClick={openPipeline} title="Pipelines 화면의 경로 입력칸으로 가요">문서 넣기<ArrowRight size={15} /></button>
    </Heading>

    <div className="queue-cards">
      <Card className="queue-card" delay={0}>
        <span className={`worker-dot ${queue?.online ? 'is-online' : ''}`}>{queue?.online && <motion.i initial={{ scale: 1, opacity: 0.5 }} animate={{ scale: 2.4, opacity: 0 }} transition={{ duration: 1.8, repeat: Infinity, ease: 'easeOut' }} />}</span>
        <div><small>Worker</small><strong>{offline ? 'Engine offline' : !queue ? 'Checking…' : queue.online ? 'Online' : 'Offline'}</strong><em>{queue?.workers[0]?.name ?? (queue ? 'No worker answered' : '—')}</em></div>
      </Card>
      <Card className="queue-card" delay={0.05}>
        <ColorIcon icon={runningJob ? LoaderCircle : Check} color={runningJob ? 'purple' : 'neutral'} small />
        <div><small>Processing</small>
          <AnimatePresence mode="wait" initial={false}><motion.strong key={runningJob?.id ?? 'idle'} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }}>{runningJob ? fileName(runningJob.path) : 'Idle'}</motion.strong></AnimatePresence>
          <em>{runningJob ? `Job #${runningJob.id} · ${kindLabel(runningJob)} · ${runningJob.stage ? stageLabels[runningJob.stage] ?? runningJob.stage : 'starting'}` : 'Nothing running'}</em></div>
      </Card>
      <Card className="queue-card" delay={0.1}>
        <ColorIcon icon={Clock3} color={waiting ? 'blue' : 'neutral'} small />
        <div><small>Waiting</small><strong><CountUp value={waiting} /></strong><em>{queue?.redis_waiting != null ? `${queue.redis_waiting} message${queue.redis_waiting === 1 ? '' : 's'} in Redis` : 'Redis not reachable'}</em></div>
      </Card>
      <Card className="queue-card" delay={0.15}>
        <ColorIcon icon={CheckCheck} color="lime" small />
        <div><small>History</small><strong><CountUp value={queue?.jobs.done ?? 0} /> done</strong><em>{queue?.jobs.failed ?? 0} failed</em></div>
      </Card>
    </div>
    {queue?.problems.length ? <p className="source-error queue-problems">{queue.problems.join(' · ')}</p> : null}

    <div className="table-toolbar"><label className="search-field"><Search size={16} /><input aria-label="Search jobs" placeholder="Search file, job # or status" value={query} onChange={e => setQuery(e.target.value)} /></label><span className="tag">Latest 100 jobs</span></div>
    <Card className="table-card documents-table" delay={0.2}>
      <table>
        <thead><tr><th>#</th><th>Job</th><th>Status</th><th>Result</th><th>Chunks</th><th>Took</th><th>Queued</th><th /></tr></thead>
        <tbody>{shown.map((j, i) => <motion.tr key={j.id} layout initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i, 14) * 0.02, duration: 0.3 }} onClick={() => setOpen(j)}>
          <td className="num">{j.id}</td>
          <td><span className="file-label">{j.status === 'running' ? <LoaderCircle size={16} className="spin" /> : jobKind(j) === 'eval' ? <ChartNoAxesCombined size={16} /> : <FileText size={16} />}<span className="doc-name"><b>{j.result?.title ?? fileName(j.path)}</b><small>{kindLabel(j)} · {j.result?.source_repo ? `${j.result.source_repo}/${j.result.source_path}` : j.path}</small></span></span></td>
          <td><span className={`pill ${jobTone[j.status].color}`}>{jobTone[j.status].label}</span></td>
          <td>{jobOutcome(j)}</td>
          <td className="num">{j.result?.chunks ?? '—'}</td>
          <td className="num">{duration(j)}</td>
          <td className="num">{shortTime(j.created_at)}</td>
          <td><IconButton icon={ArrowUpRight} label={`Open job ${j.id}`} onClick={() => setOpen(j)} /></td>
        </motion.tr>)}</tbody>
      </table>
      {jobs && !shown.length && <div className="empty-state compact"><p>{jobs.length ? 'No matching jobs.' : 'No jobs yet.'}</p></div>}
      {!jobs && <div className="empty-state compact"><p>{offline ? error : 'Loading…'}</p></div>}
    </Card>
    <div className="table-footer"><span>{shown.length} {shown.length === 1 ? 'job' : 'jobs'}</span><span>Recorded in ingest_jobs · run by Celery</span></div>

    {open && <JobModal job={jobs?.find(j => j.id === open.id) ?? open} close={() => setOpen(null)} />}
  </>;
}
function Settings({ settings, save, notify }: { settings: PreviewSettings; save: (settings: PreviewSettings) => void; notify: (message: string) => void }) {
  const [name, setName] = useState(settings.name);
  const [endpoint, setEndpoint] = useState(settings.endpoint);
  return <><Heading title="Settings" /><div className="settings-grid"><Card><div className="profile-header"><div className="profile-avatar">L</div><div><h2>Local workspace</h2><span className="tag">Personal</span></div></div><form onSubmit={e => { e.preventDefault(); save({ name: name.trim(), endpoint }); notify('Preview settings saved for this session'); }}><label className="form-label">Workspace name<input value={name} required maxLength={50} onChange={e => setName(e.target.value)} /></label><label className="form-label">Model endpoint<input type="url" value={endpoint} required onChange={e => setEndpoint(e.target.value)} /></label><p className="dialog-note">Configuration preview. Model connections are not active yet.</p><button className="primary-button">Save preview settings</button></form></Card><div className="settings-stack"><Card><ColorIcon icon={ShieldCheck} color="blue" /><h3>Local by default</h3><p>Preview data stays in this browser session.</p></Card><Card><ColorIcon icon={Box} color="peach" /><h3>Model connection</h3><p>Not connected</p><span className="tag">UI preview</span></Card></div></div></>;
}
function CreateModal({ close, create }: { close: () => void; create: (name: string) => void }) {
  const [name, setName] = useState('');
  return <Modal title="New knowledge base" close={close}><form onSubmit={e => { e.preventDefault(); if (name.trim()) create(name.trim()); }}><label className="form-label">Collection name<input autoFocus placeholder="e.g. Project documents" value={name} onChange={e => setName(e.target.value)} maxLength={60} required /></label><p className="dialog-note">Create an empty collection in this preview. Documents can be connected later.</p><div className="dialog-actions"><button type="button" className="subtle-button" onClick={close}>Cancel</button><button className="primary-button" disabled={!name.trim()}>Create collection <Plus size={15} /></button></div></form></Modal>;
}
function SearchModal({ close, navigate }: { close: () => void; navigate: (page: Page) => void }) {
  const [query, setQuery] = useState('');
  const matches = pages.filter(p => p.label.toLowerCase().includes(query.toLowerCase()));
  return <Modal title="Search workspace" close={close}><label className="search-field modal-search"><Search size={17} /><input autoFocus value={query} onChange={e => setQuery(e.target.value)} placeholder="Find a page…" aria-label="Find a page" /><kbd>⌘ K</kbd></label><div className="search-results">{matches.map(({ id, label, icon: Icon }) => <button key={id} onClick={() => navigate(id)}><Icon size={18} /><span>{label}</span><ArrowUpRight size={15} /></button>)}{!matches.length && <p className="muted">No pages found.</p>}</div></Modal>;
}
function NodeModal({ name, close, notify }: { name: string; close: () => void; notify: (message: string) => void }) {
  const stage = stages.find(s => s.name === name);
  return <Modal title={name} close={close}><div className="node-summary"><ColorIcon icon={stage?.icon || Folder} color={stage?.color || 'lime'} /><div><h3>{stage ? 'Pipeline stage' : 'Knowledge collection'}</h3><small>{stage?.detail || 'Sample collection details'}</small></div></div><label className="form-label">{stage ? 'Configuration' : 'Collection name'}<input defaultValue={stage?.detail || name} aria-label="Preview configuration" /></label><p className="dialog-note">Preview only. Changes here do not configure a model or process documents.</p><div className="dialog-actions"><button className="primary-button" onClick={() => { notify('Configuration preview closed'); close(); }}>Done <Check size={15} /></button></div></Modal>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
