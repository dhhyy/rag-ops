import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AnimatePresence, motion, MotionConfig, useReducedMotion } from 'motion/react';
import {
  ArrowDown, ArrowRight, ArrowUpRight, Bell, BookOpen, Box, Check, CheckCheck,
  ChevronDown, ChevronRight, Clock3, Database, FileText, Folder,
  GitBranch, Home, Layers3, Maximize2, MessageSquare, Pause, Play,
  Plus, Search, Settings2, ShieldCheck, SkipBack, SkipForward, SlidersHorizontal,
  Sparkles, Terminal, Trash2, X, Zap, ChartNoAxesCombined,
  type LucideIcon,
} from 'lucide-react';
import './styles.css';

type Page = 'home' | 'knowledge' | 'pipeline' | 'playground' | 'evaluations' | 'runs' | 'conversations' | 'settings';
type Collection = { id: number; name: string; documents: number; color: string };
type Chat = { id: number; title: string; prompt: string };
type Run = { id: number; title: string; status: string; time: string };
type PreviewSettings = { name: string; endpoint: string };
type DialogState = { type: 'create' | 'search' | 'node' | 'run' | 'notifications'; value?: string } | null;
const pages: { id: Page; label: string; icon: LucideIcon }[] = [
  { id: 'home', label: 'Home', icon: Home },
  { id: 'knowledge', label: 'Knowledge base', icon: Database },
  { id: 'pipeline', label: 'RAG pipeline', icon: GitBranch },
  { id: 'playground', label: 'Playground', icon: MessageSquare },
  { id: 'evaluations', label: 'Evaluations', icon: ChartNoAxesCombined },
  { id: 'runs', label: 'Run history', icon: Clock3 },
  { id: 'conversations', label: 'Conversations', icon: BookOpen },
];
const stages = [
  { name: 'Documents', detail: 'Knowledge source', icon: FileText, color: 'lime' },
  { name: 'Chunking', detail: '512 tokens · 64 overlap', icon: Layers3, color: 'blue' },
  { name: 'Embedding', detail: 'Local embedding model', icon: Box, color: 'purple' },
  { name: 'Retrieval', detail: 'Top 5 · similarity', icon: Search, color: 'peach' },
  { name: 'Generation', detail: 'Local language model', icon: Sparkles, color: 'lilac' },
];
const spring = { type: 'spring' as const, stiffness: 360, damping: 30 };

function IconButton({ icon: Icon, label, onClick, className = '', disabled = false }: { icon: LucideIcon; label: string; onClick?: () => void; className?: string; disabled?: boolean }) {
  return <button className={`icon-button ${className}`} aria-label={label} title={label} onClick={onClick} disabled={disabled}><Icon size={18} strokeWidth={1.7} /></button>;
}
function ColorIcon({ icon: Icon, color = 'lilac', small = false }: { icon: LucideIcon; color?: string; small?: boolean }) {
  return <span className={`color-icon ${color} ${small ? 'small' : ''}`}><Icon size={small ? 15 : 19} strokeWidth={1.6} /></span>;
}
function Toggle({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }) {
  return <button role="switch" aria-checked={checked} aria-label={label} onClick={onChange} className={`switch ${checked ? 'checked' : ''}`}><motion.span animate={{ x: checked ? 17 : 0 }} transition={spring} /></button>;
}
function Card({ children, className = '', delay = 0 }: { children: React.ReactNode; className?: string; delay?: number }) {
  const reduced = useReducedMotion();
  return <motion.section className={`card ${className}`} initial={{ opacity: 0, y: reduced ? 0 : 22, filter: reduced ? 'none' : 'blur(7px)' }} animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }} transition={{ duration: reduced ? 0.1 : 0.65, delay: reduced ? 0 : delay, ease: [0.22, 1, 0.36, 1] }}>{children}</motion.section>;
}
function Heading({ title, subtitle, children }: { title: string; subtitle?: string; children?: React.ReactNode }) {
  return <div className="page-heading"><div><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div><div className="heading-actions">{children}</div></div>;
}
function Modal({ children, title, close }: { children: React.ReactNode; title: string; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); ref.current?.querySelector<HTMLInputElement>('input')?.focus(); }, []);
  return <dialog ref={ref} className="dialog" onCancel={close} onClick={e => { if (e.target === e.currentTarget) close(); }} aria-labelledby="dialog-title"><motion.div className="dialog-inner" initial={{ opacity: 0, y: 16, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={spring}><div className="dialog-heading"><h2 id="dialog-title">{title}</h2><IconButton icon={X} label="Close dialog" onClick={close} /></div>{children}</motion.div></dialog>;
}
function App() {
  const [page, setPage] = useState<Page>('home');
  const [settings, setSettings] = useState<PreviewSettings>({ name: 'Local workspace', endpoint: 'http://localhost:11434' });
  const [dialog, setDialog] = useState<DialogState>(null);
  const [toast, setToast] = useState('');
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [enabled, setEnabled] = useState([true, true, false, true]);
  const [collections, setCollections] = useState<Collection[]>([
    { id: 1, name: 'Sample documents', documents: 12, color: 'lime' },
    { id: 2, name: 'Research notes', documents: 8, color: 'blue' },
    { id: 3, name: 'Product knowledge', documents: 4, color: 'purple' },
  ]);
  const [chats, setChats] = useState<Chat[]>([]);
  const [selectedChat, setSelectedChat] = useState<Chat | null>(null);
  const [runs, setRuns] = useState<Run[]>([{ id: 1, title: 'Retrieval pipeline', status: 'Completed', time: 'Sample run' }, { id: 2, title: 'Baseline evaluation', status: 'Completed', time: 'Sample run' }, { id: 3, title: 'Document indexing', status: 'Completed', time: 'Sample run' }]);
  const [runStep, setRunStep] = useState(-1);
  const [runState, setRunState] = useState<'idle' | 'running' | 'paused' | 'complete'>('idle');
  const [score, setScore] = useState(86);
  const [evaluating, setEvaluating] = useState(false);
  const reduced = useReducedMotion();
  const notify = (message: string) => setToast(message);
  function navigate(next: Page) { setPage(next); setDialog(null); setWorkspaceOpen(false); window.scrollTo({ top: 0, behavior: 'instant' }); }
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 3400); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => {
    function handler(e: KeyboardEvent) { if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); setDialog({ type: 'search' }); } if (e.key === 'Escape') setWorkspaceOpen(false); }
    window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler);
  }, []);
  useEffect(() => {
    if (runState !== 'running') return;
    const timer = setTimeout(() => {
      if (runStep < 4) setRunStep(s => s + 1);
      else { setRunState('complete'); setRuns(r => [{ id: Date.now(), title: 'Retrieval pipeline', status: 'Completed', time: 'Just now · demo' }, ...r]); notify('Sample run complete'); }
    }, 850);
    return () => clearTimeout(timer);
  }, [runState, runStep]);
  useEffect(() => {
    if (!evaluating) return;
    const timer = setTimeout(() => { setScore(92); setEvaluating(false); setRuns(r => [{ id: Date.now(), title: 'Baseline evaluation', status: 'Completed', time: 'Just now · demo' }, ...r]); notify('Sample evaluation complete'); }, 1700);
    return () => clearTimeout(timer);
  }, [evaluating]);
  function run() {
    if (runState === 'running') setRunState('paused');
    else { if (runState !== 'paused') setRunStep(0); setRunState('running'); }
  }
  function evaluate() { setScore(0); setEvaluating(true); }
  function flip(index: number) { setEnabled(e => e.map((v, i) => i === index ? !v : v)); }
  function send(prompt: string) {
    const chat = { id: Date.now(), title: prompt, prompt };
    setChats(c => [chat, ...c]); setSelectedChat(chat);
  }

  return <MotionConfig reducedMotion="user" transition={spring}><div className="desktop-stage"><div className="app-shell">
    <aside className="sidebar" aria-label="Main navigation">
      <button className="brand" aria-label="Local RAG home" onClick={() => navigate('home')}><span className="brand-mark">{Array.from({ length: 16 }, (_, i) => <i key={i} />)}</span></button>
      <nav className="rail-nav">{pages.map(({ id, label, icon: Icon }) => <button key={id} className={`nav-button ${page === id ? 'active' : ''}`} aria-label={label} aria-current={page === id ? 'page' : undefined} onClick={() => navigate(id)}>{page === id && <motion.span className="nav-active" layoutId="active-nav" transition={spring} />}<Icon size={19} strokeWidth={1.7} /><span className="nav-tooltip">{label}</span></button>)}</nav>
      <div className="rail-bottom"><button className={`nav-button ${page === 'settings' ? 'active' : ''}`} aria-label="Settings" onClick={() => navigate('settings')}><Settings2 size={19} /><span className="nav-tooltip">Settings</span></button><button className="nav-button notification-button" aria-label="Notifications" onClick={() => setDialog({ type: 'notifications' })}><Bell size={18} /><i /><span className="nav-tooltip">Notifications</span></button><button className="avatar" aria-label="Local profile" onClick={() => navigate('settings')}>L</button></div>
    </aside>
    <div className="main-shell">
      <header className="topbar">
        <div className="workspace-container"><button className="workspace-button" aria-expanded={workspaceOpen} onClick={() => setWorkspaceOpen(!workspaceOpen)}>My workspace <ChevronDown size={14} /></button><AnimatePresence>{workspaceOpen && <motion.div className="workspace-menu" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}><span className="overline">WORKSPACE</span><button onClick={() => setWorkspaceOpen(false)}><span className="local-dot" />Local workspace <Check size={14} /></button><small>UI preview · Sample data</small></motion.div>}</AnimatePresence></div>
        <nav className="top-nav" aria-label="Workspace sections">{([{ id: 'knowledge', label: 'Knowledge' }, { id: 'pipeline', label: 'Pipelines' }, { id: 'evaluations', label: 'Evaluations' }, { id: 'playground', label: 'Playground' }] as { id: Page; label: string }[]).map(item => <button key={item.id} className={page === item.id ? 'selected' : ''} onClick={() => navigate(item.id)}>{item.label}</button>)}</nav>
        <div className="top-actions"><IconButton icon={Plus} label="Create knowledge base" onClick={() => setDialog({ type: 'create' })} /><IconButton icon={Search} label="Search workspace" onClick={() => setDialog({ type: 'search' })} /><IconButton icon={MessageSquare} label="Open conversations" onClick={() => navigate('conversations')} /><IconButton icon={Maximize2} label="Toggle full screen" onClick={() => { if (document.fullscreenElement) void document.exitFullscreen(); else void document.documentElement.requestFullscreen().catch(() => notify('Use your browser’s full-screen control')); }} /></div>
      </header>
      <main className="content" id="main-content"><AnimatePresence mode="wait"><motion.div key={page} className={`page page-${page}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, y: reduced ? 0 : -8, filter: reduced ? 'none' : 'blur(5px)' }} transition={{ duration: 0.2 }}>
        {page === 'home' && <>
          <div className="status-row">
            <Status icon={ShieldCheck} color="peach" title="Local workspace" subtitle="Private by design" delay={0.02} />
            <Status icon={Database} color="lime" title="Knowledge" subtitle={`${collections.length} collections`} delay={0.07} />
            <Status icon={Box} color="blue" title="Local models" subtitle="Not connected" badge="Demo" delay={0.12} />
            <Status icon={ChartNoAxesCombined} color="lilac" title={`${score}%`} subtitle="Sample quality" badge="Sample" delay={0.17} />
          </div>
          <div className="section-heading"><h1>Favorites</h1><button className="text-button" onClick={() => navigate('pipeline')}>View pipeline <ArrowUpRight size={14} /></button></div>
          <div className="quick-grid">{[{ name: 'Retrieval', icon: Search }, { name: 'Reranking', icon: Layers3 }, { name: 'Streaming', icon: Zap }, { name: 'Citations', icon: FileText }].map(({ name, icon: Icon }, i) => <Card key={name} className={`quick-card ${enabled[i] ? 'is-on' : ''}`} delay={0.14 + i * 0.06}><Icon size={19} strokeWidth={1.6} /><Toggle checked={enabled[i]} onChange={() => flip(i)} label={name} /><span>{name}</span></Card>)}</div>
          <div className="widget-grid">
            <Card className="score-card" delay={0.3}><div className="card-heading"><ColorIcon icon={ChartNoAxesCombined} color="peach" /><div><h2>Evaluation</h2><small>Sample quality</small></div><IconButton icon={ArrowUpRight} label="Open evaluations" onClick={() => navigate('evaluations')} /></div><Gauge score={score} evaluating={evaluating} /><div className="gauge-legend"><span><i />Faithfulness</span><strong>{score}%</strong></div><div className="widget-controls"><IconButton icon={Clock3} label="Evaluation history" onClick={() => navigate('runs')} /><button className="round-play" aria-label="Preview evaluation" disabled={evaluating} onClick={evaluate}>{evaluating ? <span className="spinner" /> : <Play size={15} fill="currentColor" />}</button><IconButton icon={SlidersHorizontal} label="Evaluation settings" onClick={() => navigate('evaluations')} /></div></Card>
            <Card className="runner-card" delay={0.37}><div className="card-heading"><ColorIcon icon={GitBranch} color="purple" /><div><h2>Retrieval pipeline</h2><small>{runState === 'running' ? stages[Math.max(0, runStep)].name : runState === 'complete' ? 'Sample complete' : runState === 'paused' ? 'Paused' : 'Ready to preview'}</small></div><span className={`status-dot ${runState === 'running' ? 'pulsing' : ''}`} /></div><div className="pipeline-track">{stages.slice(0, 4).map((s, i) => <React.Fragment key={s.name}><motion.button aria-label={`Inspect ${s.name}`} className={`mini-node ${runStep >= i ? 'lit' : ''}`} onClick={() => setDialog({ type: 'node', value: s.name })} animate={{ y: runState === 'running' && runStep === i && !reduced ? [0, -6, 0] : 0 }} transition={{ duration: 0.6 }}><s.icon size={21} strokeWidth={1.5} /></motion.button>{i < 3 && <div className={`track-link ${runStep > i ? 'passed' : ''}`} />}</React.Fragment>)}</div><div className="runner-description"><span>Documents → Answer</span><span className="tag">Demo</span></div><div className="progress-row"><span>{runStep < 0 ? '0' : Math.min(runStep + 1, 5)} / 5</span><div className="progress-track"><motion.span animate={{ width: `${runStep < 0 ? 0 : (runStep + 1) * 20}%` }} transition={{ duration: 0.7 }} /></div><span>stages</span></div><div className="widget-controls"><IconButton icon={SkipBack} label="Reset pipeline preview" onClick={() => { setRunStep(-1); setRunState('idle'); }} /><button className="round-play" aria-label={runState === 'running' ? 'Pause pipeline preview' : 'Play pipeline preview'} onClick={run}>{runState === 'running' ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}</button><IconButton icon={SkipForward} label="Open pipeline" onClick={() => navigate('pipeline')} /></div></Card>
            <Card className="retrieval-card" delay={0.44}><div className="card-heading"><div><h2>Knowledge space</h2><small>{collections.reduce((a, c) => a + c.documents, 0)} sample documents</small></div><span className="glass-tag">Preview</span></div><KnowledgeArt /><div className="retrieval-footer"><span>Explore your documents</span><button className="glass-button" aria-label="Explore knowledge base" onClick={() => navigate('knowledge')}><ArrowUpRight size={19} /></button></div></Card>
          </div>
          <div className="bottom-grid">
            <Card delay={0.5}><div className="card-heading"><h2>Knowledge bases</h2><IconButton icon={ArrowUpRight} label="View all knowledge bases" onClick={() => navigate('knowledge')} /></div><div className="collection-mini-list">{collections.slice(0, 2).map(c => <button key={c.id} onClick={() => navigate('knowledge')}><ColorIcon icon={Folder} color={c.color} small /><span>{c.name}</span><small>{c.documents} docs</small><ChevronRight size={14} /></button>)}</div></Card>
            <Card delay={0.56}><div className="card-heading"><ColorIcon icon={Clock3} color="neutral" small /><div><h2>Recent activity</h2><small>Sample runs</small></div><IconButton icon={ArrowUpRight} label="View all runs" onClick={() => navigate('runs')} /></div><div className="activity-mini"><span className="activity-line" /><CheckCheck size={16} /><div>{runs[0].title}<small>{runs[0].time}</small></div><span className="tiny-success">Completed</span></div></Card>
            <Card className="playground-promo" delay={0.62}><div className="promo-orbit" /><span className="overline">PLAYGROUND</span><h2>Test your<br />retrieval.</h2><button onClick={() => { setSelectedChat(null); navigate('playground'); }}>Start a conversation <ArrowUpRight size={17} /></button></Card>
          </div>
          <div className="page-footer"><span><span className="local-dot" /> Local workspace</span><span>UI preview · Sample data</span></div>
        </>}
        {page === 'knowledge' && <Knowledge collections={collections} create={() => setDialog({ type: 'create' })} inspect={name => setDialog({ type: 'node', value: name })} />}
        {page === 'pipeline' && <Pipeline enabled={enabled} flip={flip} run={run} running={runState === 'running'} runStep={runStep} inspect={name => setDialog({ type: 'node', value: name })} />}
        {page === 'playground' && <Playground chat={selectedChat} send={send} reset={() => setSelectedChat(null)} />}
        {page === 'evaluations' && <Evaluations score={score} evaluating={evaluating} evaluate={evaluate} />}
        {page === 'runs' && <Runs runs={runs} inspect={title => setDialog({ type: 'run', value: title })} />}
        {page === 'conversations' && <Conversations chats={chats} open={chat => { setSelectedChat(chat); navigate('playground'); }} create={() => { setSelectedChat(null); navigate('playground'); }} remove={id => setChats(c => c.filter(chat => chat.id !== id))} />}
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

function Status({ icon, color, title, subtitle, badge, delay }: { icon: LucideIcon; color: string; title: string; subtitle: string; badge?: string; delay: number }) {
  return <Card className="status-chip" delay={delay}><ColorIcon icon={icon} color={color} /><div><strong>{title}</strong><small>{subtitle}</small></div>{badge && <span className={`status-badge ${badge === 'Sample' ? 'green' : ''}`}>{badge}</span>}</Card>;
}
function Gauge({ score, evaluating }: { score: number; evaluating: boolean }) {
  const reduced = useReducedMotion();
  return <div className="gauge"><svg viewBox="0 0 250 155" aria-hidden="true"><defs><linearGradient id="score-gradient" x1="0" y1="1" x2="1" y2="0"><stop stopColor="#89aafa" /><stop offset=".55" stopColor="#a68bf0" /><stop offset="1" stopColor="#d4acf1" /></linearGradient></defs><path className="gauge-track" d="M 31 126 A 94 94 0 0 1 219 126" /><motion.path className="gauge-value" d="M 31 126 A 94 94 0 0 1 219 126" initial={{ pathLength: 0 }} animate={{ pathLength: score / 100 }} transition={{ duration: reduced ? 0 : 1.5, delay: 0.2, ease: [0.22, 1, 0.36, 1] }} /></svg><div className="gauge-number"><AnimatePresence mode="wait"><motion.strong key={score} initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>{score}<span>%</span></motion.strong></AnimatePresence><small>{evaluating ? 'Evaluating sample' : 'Overall score'}</small></div><span className="gauge-min">0</span><span className="gauge-max">100</span></div>;
}
function KnowledgeArt() {
  return <div className="knowledge-art" aria-hidden="true"><div className="art-halo" /><svg className="art-lines" viewBox="0 0 400 240"><path d="M75 65L200 120L310 55M200 120L94 195M200 120L320 182M75 65L310 55L320 182L94 195Z" /></svg><div className="art-tile tile-one"><FileText /></div><div className="art-tile tile-two"><Layers3 /></div><div className="art-tile tile-three"><Database /></div><div className="art-tile tile-four"><FileText /></div><div className="art-core"><span /><Box size={40} strokeWidth={1} /></div><i className="art-speck speck-one" /><i className="art-speck speck-two" /></div>;
}
function Knowledge({ collections, create, inspect }: { collections: Collection[]; create: () => void; inspect: (name: string) => void }) {
  const [filter, setFilter] = useState('');
  const shown = collections.filter(c => c.name.toLowerCase().includes(filter.toLowerCase()));
  return <><Heading title="Knowledge base"><button className="primary-button" onClick={create}><Plus size={16} />New collection</button></Heading><div className="section-heading"><h2>Collections</h2><span className="muted">{collections.length} total</span></div><div className="collections-grid">{collections.map((c, i) => <Card key={c.id} delay={i * 0.07} className="collection-card"><button onClick={() => inspect(c.name)}><ColorIcon icon={Folder} color={c.color} /><ArrowUpRight className="collection-arrow" size={17} /><div><h3>{c.name}</h3><small>{c.documents} sample documents</small></div></button></Card>)}</div><div className="section-heading document-heading"><h2>Documents</h2><label className="search-field"><Search size={16} /><input aria-label="Filter collections" placeholder="Search collections" value={filter} onChange={e => setFilter(e.target.value)} /></label></div><Card className="table-card" delay={0.2}><table><thead><tr><th>Name</th><th>Collection</th><th>Type</th><th>Status</th><th /></tr></thead><tbody>{shown.map((c, i) => <tr key={c.id}><td><span className="file-label"><FileText size={17} />{c.documents ? `Sample document ${String(i + 1).padStart(2, '0')}` : 'No documents yet'}</span></td><td>{c.name}</td><td>{c.documents ? 'Markdown' : '—'}</td><td><span className={`pill ${c.documents ? 'lime' : 'neutral'}`}>{c.documents ? 'Sample' : 'Empty'}</span></td><td><IconButton icon={ArrowUpRight} label={`Inspect ${c.name}`} onClick={() => inspect(c.name)} /></td></tr>)}</tbody></table>{!shown.length && <div className="empty-state compact"><Search size={24} /><p>No collections match “{filter}”.</p></div>}</Card><p className="footnote">Sample library · Document ingestion will be connected in a later version.</p></>;
}
function Pipeline({ enabled, flip, run, running, runStep, inspect }: { enabled: boolean[]; flip: (i: number) => void; run: () => void; running: boolean; runStep: number; inspect: (name: string) => void }) {
  return <><Heading title="RAG pipeline" subtitle="Your local retrieval flow"><span className="tag">Sample pipeline</span><button className="primary-button" onClick={run}>{running ? <Pause size={15} /> : <Play size={15} />}{running ? 'Pause preview' : 'Preview run'}</button></Heading><Card className="pipeline-canvas"><div className="canvas-toolbar"><span><span className="local-dot" />Retrieval pipeline</span><span>5 stages</span></div><div className="flow-nodes">{stages.map((s, i) => <React.Fragment key={s.name}><motion.button className={`flow-node ${runStep === i ? 'current' : ''} ${runStep > i ? 'done' : ''}`} onClick={() => inspect(s.name)} animate={{ scale: runStep === i && running ? 1.04 : 1 }}><ColorIcon icon={s.icon} color={s.color} /><h3>{s.name}</h3><small>{s.detail}</small><span className="node-port left" /><span className="node-port right" />{runStep > i && <Check size={13} className="node-check" />}</motion.button>{i < 4 && <div className={`flow-connector ${runStep > i ? 'passed' : ''}`}><ArrowRight size={14} /></div>}</React.Fragment>)}</div><div className="canvas-footer"><span><GitBranch size={14} />Sequential RAG</span><span>Click a stage to inspect</span></div></Card><div className="section-heading"><h2>Pipeline options</h2><span className="tag">Preview settings</span></div><div className="quick-grid">{['Retrieval', 'Reranking', 'Streaming', 'Citations'].map((name, i) => <Card className="option-card" key={name} delay={0.15 + i * 0.06}><span>{name}</span><Toggle checked={enabled[i]} onChange={() => flip(i)} label={name} /></Card>)}</div><Card className="pipeline-note" delay={0.3}><ColorIcon icon={Terminal} color="neutral" /><div><h3>Ready for your local stack</h3><p>Choose your models and sources when you connect the backend.</p></div><span className="tag">UI preview</span></Card></>;
}
function Playground({ chat, send, reset }: { chat: Chat | null; send: (text: string) => void; reset: () => void }) {
  const [input, setInput] = useState('');
  return <><Heading title="Playground"><button className="subtle-button" onClick={reset}><Plus size={16} />New conversation</button></Heading><Card className="chat-panel"><div className="chat-toolbar"><span><ColorIcon icon={GitBranch} color="purple" small />Retrieval pipeline <ChevronDown size={13} /></span><span className="tag">Demo mode</span></div><div className="chat-body">{chat ? <><motion.div className="chat-message user-message" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>{chat.prompt}</motion.div><motion.div className="chat-answer" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.4 }}><ColorIcon icon={Sparkles} color="lilac" /><div><h3>Local RAG</h3><p>This is a preview conversation. Once a local model and knowledge base are connected, your answer and source citations will appear here.</p><span className="tag">Sample response · No model connected</span></div></motion.div></> : <div className="chat-empty"><div className="empty-orb"><Sparkles size={31} strokeWidth={1.2} /></div><h2>Ask your knowledge.</h2><p>A space to try your retrieval pipeline.</p><div className="suggestion-row">{['Summarize my documents', 'Find related concepts'].map(t => <button key={t} onClick={() => setInput(t)}>{t}<ArrowUpRight size={14} /></button>)}</div></div>}</div><form className="composer" onSubmit={e => { e.preventDefault(); if (input.trim()) { send(input.trim()); setInput(''); } }}><input aria-label="Your message" value={input} onChange={e => setInput(e.target.value)} placeholder="Ask a question about your documents…" maxLength={2000} /><button className="send-button" disabled={!input.trim()} aria-label="Send message"><ArrowUp size={19} /></button></form><div className="composer-caption">Local workspace · Preview responses only</div></Card></>;
}
function ArrowUp({ size }: { size: number }) { return <ArrowDown size={size} style={{ transform: 'rotate(180deg)' }} />; }
function Evaluations({ score, evaluating, evaluate }: { score: number; evaluating: boolean; evaluate: () => void }) {
  const [metrics, setMetrics] = useState([true, true, true]);
  return <><Heading title="Evaluations" subtitle="A closer look at answer quality"><span className="tag">Sample results</span><button className="primary-button" disabled={evaluating} onClick={evaluate}>{evaluating ? <span className="spinner" /> : <Play size={15} />}{evaluating ? 'Evaluating…' : 'Preview evaluation'}</button></Heading><div className="evaluation-grid"><Card className="evaluation-overview"><div className="card-heading"><ColorIcon icon={ChartNoAxesCombined} color="peach" /><h2>Overall quality</h2></div><Gauge score={score} evaluating={evaluating} /><span className="centered-note">Baseline evaluation · Sample</span></Card><Card className="metrics-card" delay={0.1}><div className="card-heading"><h2>Evaluation metrics</h2><SlidersHorizontal size={17} /></div>{['Faithfulness', 'Answer relevancy', 'Context precision'].map((name, i) => <div className="metric-row" key={name}><div className="metric-label"><span>{name}</span><strong>{score ? [score, 91, 88][i] : '—'}{score ? '%' : ''}</strong><Toggle checked={metrics[i]} onChange={() => setMetrics(m => m.map((v, j) => i === j ? !v : v))} label={name} /></div><div className="metric-track"><motion.span className={['purple', 'blue', 'lime'][i]} initial={{ width: 0 }} animate={{ width: metrics[i] ? `${[score, score ? 91 : 0, score ? 88 : 0][i]}%` : '0%' }} transition={{ duration: 1.2, delay: i * 0.12 }} /></div></div>)}</Card></div><div className="section-heading"><h2>Evaluation sets</h2><span className="muted">1 sample set</span></div><Card className="dataset-card" delay={0.2}><ColorIcon icon={Layers3} color="blue" /><div><h3>Baseline questions</h3><small>20 sample questions · 3 metrics</small></div><span className="pill lime">Ready</span><button className="subtle-button" disabled={evaluating} onClick={evaluate}>Preview <ArrowRight size={15} /></button></Card></>;
}
function Runs({ runs, inspect }: { runs: Run[]; inspect: (title: string) => void }) {
  const [query, setQuery] = useState('');
  const filtered = runs.filter(r => r.title.toLowerCase().includes(query.toLowerCase()));
  return <><Heading title="Run history" /><div className="table-toolbar"><label className="search-field"><Search size={16} /><input aria-label="Search runs" placeholder="Search runs" value={query} onChange={e => setQuery(e.target.value)} /></label><span className="tag">Sample activity</span></div><Card className="table-card"><table><thead><tr><th>When</th><th>Pipeline / task</th><th>Source</th><th>Status</th><th /></tr></thead><tbody>{filtered.map((r, i) => <tr key={r.id}><td>{r.time}</td><td><span className="file-label">{i % 2 ? <ChartNoAxesCombined size={16} /> : <GitBranch size={16} />}{r.title}</span></td><td>Preview</td><td><span className="pill lime">{r.status}</span></td><td><IconButton icon={ArrowUpRight} label={`View ${r.title} run ${r.id}`} onClick={() => inspect(r.title)} /></td></tr>)}</tbody></table>{!filtered.length && <div className="empty-state compact"><p>No matching runs.</p></div>}</Card><div className="table-footer"><span>{filtered.length} {filtered.length === 1 ? 'run' : 'runs'}</span><span>All activity is from this UI preview</span></div></>;
}
function Conversations({ chats, open, create, remove }: { chats: Chat[]; open: (chat: Chat) => void; create: () => void; remove: (id: number) => void }) {
  const [query, setQuery] = useState('');
  const shown = chats.filter(c => c.title.toLowerCase().includes(query.toLowerCase()));
  return <><Heading title="Conversations"><button className="primary-button" onClick={create}><Plus size={16} />New conversation</button></Heading>{chats.length ? <><div className="table-toolbar"><label className="search-field"><Search size={16} /><input aria-label="Search conversations" placeholder="Search conversations" value={query} onChange={e => setQuery(e.target.value)} /></label><span className="muted">This session</span></div><div className="conversation-list">{shown.map((chat, i) => <Card key={chat.id} delay={i * 0.04}><button className="conversation-open" onClick={() => open(chat)}><ColorIcon icon={MessageSquare} color="lilac" /><div><h3>{chat.title}</h3><small>Retrieval pipeline · Preview conversation</small></div><ArrowUpRight size={17} /></button><IconButton icon={Trash2} label={`Delete conversation ${chat.title}`} onClick={() => remove(chat.id)} /></Card>)}{!shown.length && <p className="muted">No matching conversations.</p>}</div></> : <Card className="empty-state"><div className="empty-orb"><MessageSquare size={29} strokeWidth={1.3} /></div><h2>Your conversations, together.</h2><p>Conversations from the playground will appear here.</p><button className="subtle-button" onClick={create}>Open playground <ArrowRight size={16} /></button></Card>}</>;
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
