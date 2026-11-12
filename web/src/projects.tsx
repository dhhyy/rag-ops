// 프로젝트: 문서를 묶는 단위. Knowledge 화면의 카드·머리 띠·새 프로젝트 서랍·문서 연결 창, Playground의 범위 고르기.
// 화면 나누기: 카드 격자 = Fluid(폭에 따라 열 수), 머리 띠 = Hybrid(정보는 늘고 줄며 버튼은 고정), 서랍·연결 창 = Fixed 폭.
import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowLeft, ArrowRight, Check, ChevronDown, CircleAlert, FileUp, GitBranch, LoaderCircle, NotebookPen, RefreshCw, X } from 'lucide-react';
import { api, Modal, shortTime, spring } from './ui';
import { Drawer } from './questionset';

export type ProjectRef = { id: number; name: string; origin: boolean };
export type Project = {
  id: number; name: string; kind: 'git' | 'managed'; description: string;
  source: { from?: string; path?: string }; defaults: { env?: string; doc_type?: string; external_ok?: boolean };
  documents: number; origin_documents: number; chunks: number; last_ingested: string | null;
  git: { repo: string; branch: string | null; commit: string | null } | null;
};
export type PullResult = { jobs: { job_id: number; path: string }[]; skipped: { path: string; reason: string }[] };
export type UploadResult = {
  new: { name: string }[]; updated: { name: string; from: string | null }[]; unchanged: { name: string; version: string }[];
  skipped: { name: string; reason: string }[]; jobs: { job_id: number; path: string }[];
};
export type Version = { version: number; content_hash: string; title: string | null; filename: string; size_bytes: number; uploaded_at: string; content?: string };

// ---------- 파일 올리기 (직접 관리 프로젝트) ----------

const MAX_FILE = 512 * 1024;      // 엔진과 같은 한도
const MAX_BODY = 900 * 1024;      // 웹 프록시가 요청 하나를 1MB까지 받아서, 그보다 작게 나눠 보낸다
const MAX_FILES = 50;
const kb = (n: number) => `${Math.max(1, Math.round(n / 1024))}KB`;

// 고른 파일을 읽어 나눠 보내고 결과를 합친다. 너무 큰 파일은 보내지 않고 이유와 함께 뺀다.
export async function uploadFiles(projectId: number, files: File[]): Promise<UploadResult> {
  const out: UploadResult = { new: [], updated: [], unchanged: [], skipped: [], jobs: [] };
  let batch: { name: string; content: string }[] = [];
  let size = 0;
  const send = async () => {
    if (!batch.length) return;
    const r = await api<UploadResult>(`/projects/${projectId}/upload`, { method: 'POST', body: { files: batch } });
    (Object.keys(out) as (keyof UploadResult)[]).forEach(k => (out[k] as unknown[]).push(...r[k]));
    batch = []; size = 0;
  };
  for (const f of files) {
    if (f.size > MAX_FILE) { out.skipped.push({ name: f.name, reason: `${kb(MAX_FILE)}보다 커요 (${kb(f.size)})` }); continue; }
    if (!f.name.toLowerCase().endsWith('.md')) { out.skipped.push({ name: f.name, reason: 'Markdown(.md) 파일만 올릴 수 있어요' }); continue; }
    const content = await f.text();
    const bytes = new Blob([JSON.stringify(content)]).size + f.name.length + 32;
    if (batch.length && (size + bytes > MAX_BODY || batch.length >= MAX_FILES)) await send();
    batch.push({ name: f.name, content }); size += bytes;
  }
  await send();
  return out;
}

export function uploadSummary(r: UploadResult): string {
  const parts = [r.new.length && `새 문서 ${r.new.length}개`, r.updated.length && `새 판 ${r.updated.length}개`,
    r.unchanged.length && `바뀐 것 없음 ${r.unchanged.length}개`, r.skipped.length && `뺀 파일 ${r.skipped.length}개`].filter(Boolean);
  return parts.length ? parts.join(' · ') : '올린 파일이 없어요';
}

// 끌어 놓기 + 눌러서 고르기. 폴더째 끌어 놓으면 브라우저가 파일만 넘기지 않으므로 .md 파일을 골라 달라고 안내한다.
function DropZone({ onFiles, compact = false, disabled = false }: { onFiles: (f: File[]) => void; compact?: boolean; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  return <div className={`pj-drop ${over ? 'is-over' : ''} ${compact ? 'is-compact' : ''}`}
    onDragOver={e => { e.preventDefault(); if (!disabled) setOver(true); }} onDragLeave={() => setOver(false)}
    onDrop={e => { e.preventDefault(); setOver(false); if (!disabled) onFiles([...e.dataTransfer.files]); }}>
    <input ref={input} type="file" multiple accept=".md,text/markdown" hidden onChange={e => { onFiles([...(e.target.files ?? [])]); e.target.value = ''; }} />
    <button type="button" className="pj-drop-btn" disabled={disabled} onClick={() => input.current?.click()}>
      <FileUp size={compact ? 14 : 18} /><b>{compact ? '파일 올리기' : '여기로 끌어 놓거나 눌러서 고르기'}</b></button>
    {!compact && <small>.md 여러 개 · 파일 하나 {kb(MAX_FILE)}까지 · 같은 이름을 다시 올리면 새 판이 돼요</small>}
  </div>;
}

// 직접 관리 문서의 판 목록. 위가 지금 판이다.
export function VersionList({ documentId }: { documentId: number }) {
  const [list, setList] = useState<Version[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api<Version[]>(`/documents/${documentId}/versions`).then(setList).catch(e => setError(message(e))); }, [documentId]);
  if (error) return <p className="source-error">{error}</p>;
  if (!list) return <p className="muted">판을 불러오는 중…</p>;
  return <div className="pj-versions">{list.map((v, i) => <div key={v.version} className={`pj-ver ${i === 0 ? 'is-now' : ''}`}>
    <b>{v.version}판</b>{i === 0 && <span className="sf-now">지금</span>}
    <small>{shortTime(v.uploaded_at)} · {kb(v.size_bytes)} · <code>{v.content_hash.slice(0, 8)}</code></small>
  </div>)}</div>;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function useProjects() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = () => api<Project[]>('/projects').then(p => { setProjects(p); setError(null); }).catch(e => setError(message(e)));
  useEffect(() => { void reload(); }, []);
  return { projects, error, reload };
}

export function KindTag({ project }: { project: Pick<Project, 'kind'> }) {
  return project.kind === 'git'
    ? <span className="pj-tag is-git"><GitBranch size={11} />Git</span>
    : <span className="pj-tag is-own"><NotebookPen size={11} />직접 관리</span>;
}

// ---------- 카드 격자 ----------

export function ProjectCards({ projects, selected, select, onNew }: { projects: Project[]; selected: number | null; select: (id: number | null) => void; onNew: () => void }) {
  return <div className="pj-grid">
    {projects.map((p, i) => <motion.button key={p.id} className={`pj-card ${selected === p.id ? 'is-active' : ''}`} aria-pressed={selected === p.id}
      initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05, duration: 0.3 }}
      onClick={() => select(selected === p.id ? null : p.id)}>
      <span className="pj-tags"><KindTag project={p} />{p.kind === 'git' && <span className="pj-tag">로컬 폴더</span>}
        <AnimatePresence>{selected === p.id && <motion.span className="pj-check" initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }} transition={spring}><Check size={12} /></motion.span>}</AnimatePresence>
      </span>
      <h3>{p.name}</h3>
      <small className="pj-src">{p.git ? `${p.git.repo} · ${p.git.branch ?? '브랜치 없음'} @ ${p.git.commit ?? '커밋 없음'}` : p.kind === 'git' ? '폴더를 읽을 수 없어요' : `업로드 문서${p.last_ingested ? ` · 마지막 ${shortTime(p.last_ingested)}` : ''}`}</small>
      <span className="pj-stats"><span><b>{p.documents}</b><small>문서</small></span><span><b>{p.chunks}</b><small>조각</small></span>
        {p.documents > p.origin_documents && <span><b>{p.documents - p.origin_documents}</b><small>연결</small></span>}</span>
    </motion.button>)}
    <button className="pj-card pj-new" onClick={onNew}><span>+</span>새 프로젝트</button>
  </div>;
}

// ---------- 고른 프로젝트의 머리 띠 ----------

// 넣기 작업은 뒤에서 돈다. 다 끝날 때까지 기다렸다가 목록을 다시 읽어야 판·조각 수가 맞는다.
// 실패한 작업 수를 돌려준다. 너무 오래 걸리면(3분) 기다리기를 멈추고 null.
export async function waitJobs(ids: number[]): Promise<number | null> {
  const until = Date.now() + 180_000;
  let left = ids;
  let failed = 0;
  while (left.length && Date.now() < until) {
    await new Promise(r => setTimeout(r, 1500));
    const rows = await Promise.all(left.map(id => api<{ id: number; status: string }>(`/jobs/${id}`).catch(() => null)));
    failed += rows.filter(j => j?.status === 'failed').length;
    left = left.filter((_, i) => { const st = rows[i]?.status; return st === 'queued' || st === 'running'; });
  }
  return left.length ? null : failed;
}

export function ProjectHead({ project, onPulled, openPipeline }: { project: Project; onPulled: () => void; openPipeline: () => void }) {
  const [pulling, setPulling] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string; detail?: string[] } | null>(null);
  async function upload(files: File[]) {
    if (!files.length) return;
    setPulling(true); setNote(null);
    try {
      const r = await uploadFiles(project.id, files);
      const detail = r.skipped.map(x => `${x.name}: ${x.reason}`);
      const ok = r.jobs.length > 0 || r.unchanged.length > 0;
      setNote({ ok, text: uploadSummary(r) + (r.jobs.length ? ' · 넣는 중' : ''), detail });
      onPulled();
      if (r.jobs.length) {
        const failed = await waitJobs(r.jobs.map(j => j.job_id));
        setNote({ ok: failed === 0, detail, text: uploadSummary(r) + (failed === null ? ' · 아직 넣는 중이에요' : failed ? ` · 넣기 실패 ${failed}개` : ' · 다 넣었어요') });
        onPulled();
      }
    } catch (e) { setNote({ ok: false, text: message(e) }); }
    setPulling(false);
  }
  useEffect(() => setNote(null), [project.id]);
  async function pull() {
    setPulling(true);
    try {
      const r = await api<PullResult>(`/projects/${project.id}/pull`, { method: 'POST' });
      const base = `문서 ${r.jobs.length}개를 다시 확인해요. 바뀐 문서만 다시 넣어요${r.skipped.length ? ` · 뺀 문서 ${r.skipped.length}개` : ''}`;
      setNote({ ok: true, text: base });
      onPulled();
      if (r.jobs.length) {
        const failed = await waitJobs(r.jobs.map(j => j.job_id));
        setNote({ ok: failed === 0, text: base + (failed === null ? ' · 아직 진행 중' : failed ? ` · 실패 ${failed}개` : ' · 끝났어요') });
        onPulled();
      }
    } catch (e) { setNote({ ok: false, text: message(e) }); }
    setPulling(false);
  }
  return <div className="pj-head">
    <div className="pj-head-row">
      <KindTag project={project} />
      <div className="pj-head-info">
        <b>{project.git ? project.git.repo : project.name}</b>
        <small>{project.kind === 'git'
          ? <>브랜치 <code>{project.git?.branch ?? '—'}</code> · 지금 커밋 <code>{project.git?.commit ?? '—'}</code> · 폴더 <code>{project.source.path ?? '—'}</code></>
          : <>문서 {project.origin_documents}개 · 원문은 DB에 저장해요{project.last_ingested ? ` · 마지막으로 넣은 때 ${shortTime(project.last_ingested)}` : ''}{` · 외부 전송 기본 ${project.defaults.external_ok ? '허용' : '불가'}`}</>}
          {project.defaults.env || project.defaults.doc_type ? ` · 기본값 ${[project.defaults.env, project.defaults.doc_type].filter(Boolean).join(' · ')}` : ''}</small>
      </div>
      {project.kind === 'git' && <button className="primary-button" disabled={pulling} onClick={() => void pull()}>
        {pulling ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}다시 받기</button>}
      {project.kind === 'managed' && (pulling ? <span className="primary-button pj-busy"><LoaderCircle size={14} className="spin" />올리는 중</span>
        : <DropZone compact onFiles={f => void upload(f)} />)}
    </div>
    {note && <p className={`pj-note ${note.ok ? 'is-ok' : 'is-error'}`}>{note.ok ? <Check size={13} /> : <CircleAlert size={13} />}<span>{note.text}</span>
      {note.ok && <button className="text-button" onClick={openPipeline}>진행 보기 <ArrowRight size={12} /></button>}
      {note.detail && note.detail.length > 0 && <small className="pj-note-detail">{note.detail.join(' / ')}</small>}</p>}
    {project.kind === 'managed' && <p className="pj-hint">같은 이름의 파일을 다시 올리면 새 판이 돼요. 내용이 같으면 판을 늘리지 않아요. 파일을 머리 띠의 [파일 올리기]에 끌어 놓아도 돼요.</p>}
    {project.kind === 'git' && <p className="pj-hint">Git이 원본이에요. 여기서 파일을 올리거나 고칠 수 없어요. 원본 저장소에서 고치고 [다시 받기]를 누르면 바뀐 문서만 다시 넣어요 (기본 색인 ★).</p>}
  </div>;
}

// ---------- 문서를 다른 프로젝트에 연결 ----------

export function LinkModal({ title, documentId, links, projects, close, saved }: {
  title: string; documentId: number; links: ProjectRef[]; projects: Project[]; close: () => void; saved: (links: ProjectRef[]) => void;
}) {
  const origin = links.find(l => l.origin)?.id;
  const [picked, setPicked] = useState(() => new Set(links.filter(l => !l.origin).map(l => l.id)));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = (id: number) => setPicked(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  async function save() {
    setSaving(true); setError(null);
    try { saved(await api<ProjectRef[]>(`/documents/${documentId}/projects`, { method: 'PUT', body: { project_ids: [...picked] } })); }
    catch (e) { setError(message(e)); setSaving(false); }
  }
  return <Modal title="다른 프로젝트에 연결" close={close}>
    <p className="muted pj-link-sub">「{title}」 · 문서는 한 번만 저장돼요. 연결만 늘어나서 다시 임베딩하지 않아요. 원본이 바뀌면 연결된 곳에도 같이 바뀌어요.</p>
    <div className="pj-checks">{projects.map(p => {
      const isOrigin = p.id === origin, on = isOrigin || picked.has(p.id);
      return <button key={p.id} className={`pj-chk ${on ? 'is-on' : ''}`} role="checkbox" aria-checked={on} disabled={isOrigin} onClick={() => toggle(p.id)}>
        <i>{on && <Check size={11} />}</i><span>{p.name}</span><small>{isOrigin ? '원본 · 뗄 수 없어요' : picked.has(p.id) ? '연결됨' : ''}</small>
      </button>;
    })}</div>
    {error && <p className="source-error"><CircleAlert size={13} />{error}</p>}
    <div className="pj-actions"><button className="qs-btn qs-btn-ghost" onClick={close}>닫기</button>
      <button className="qs-btn qs-btn-dark" disabled={saving} onClick={() => void save()}>{saving ? <LoaderCircle size={13} className="spin" /> : <Check size={13} />}저장</button></div>
  </Modal>;
}

// ---------- 새 프로젝트 서랍 ----------

type Check_ = { ok: true; path: string; repo: string; branch: string | null; commit: string | null; md_count: number } | { ok: false; error: string };
const ALL_STEPS = ['name', 'kind', 'folder', 'files', 'defaults', 'review'] as const;
type Step = typeof ALL_STEPS[number];
const ENVS = ['혼합', '운영', '개발', '샘플'] as const;
const TYPES = ['해설', '설정', '실행 결과', '장애 기록'] as const;
const Q: Record<Step, [string, string]> = {
  name: ['프로젝트 이름을 정해 주세요', 'Playground 범위와 Knowledge 카드에 이 이름이 보여요.'],
  kind: ['문서를 어떻게 관리하나요?', '한 번 정하면 바꿀 수 없어요. 섞어 쓰고 싶으면 프로젝트를 나누고 문서를 연결하세요.'],
  folder: ['어느 git 폴더에서 가져올까요?', '서버가 읽을 수 있는 폴더(INGEST_ROOTS) 안이어야 해요. 다른 프로젝트 폴더와 겹치면 안 돼요.'],
  files: ['처음 넣을 파일을 올려 주세요', '지금 안 올려도 돼요. 나중에 프로젝트 머리 띠에서 올릴 수 있어요.'],
  defaults: ['이 프로젝트 문서의 기본값', '이 프로젝트로 넣는 문서에 붙어요. 검증 상태는 항상 "미확인"으로 들어가요.'],
  review: ['이렇게 만들까요?', '만들면 문서를 기본 색인(★)에 넣기 시작해요. 진행은 Pipelines의 작업 대기열에서 보여요.'],
};

export function NewProjectFlow({ open, onClose, onCreated, taken }: { open: boolean; onClose: () => void; onCreated: (p: Project, r: PullResult) => void; taken: string[] }) {
  const [at, setAt] = useState(0);
  const [dir, setDir] = useState(1);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [path, setPath] = useState('');
  const [check, setCheck] = useState<Check_ | null>(null);
  const [checking, setChecking] = useState(false);
  const [env, setEnv] = useState<string>('혼합');
  const [docType, setDocType] = useState<string>('해설');
  const [kind, setKind] = useState<'git' | 'managed'>('git');
  const [files, setFiles] = useState<File[]>([]);
  const [external, setExternal] = useState(false);
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const seq = useRef(0);
  const STEPS = ALL_STEPS.filter(k => k !== (kind === 'git' ? 'files' : 'folder'));
  const step = STEPS[Math.min(at, STEPS.length - 1)];

  useEffect(() => { if (open) { setAt(0); setName(''); setDesc(''); setPath(''); setCheck(null); setEnv('혼합'); setDocType('해설'); setKind('git'); setFiles([]); setExternal(false); setProblem(null); } }, [open]);
  // 같은 이름 파일은 마지막 것만 남긴다 (엔진도 같은 이름 두 개는 받지 않는다)
  const addFiles = (more: File[]) => setFiles(cur => [...cur.filter(f => !more.some(m => m.name === f.name)), ...more]);
  // 폴더를 적는 동안 잠깐 멈추면 검사한다. 늦게 온 응답이 새 입력을 덮지 않게 순번을 본다.
  useEffect(() => {
    if (!path.trim()) { setCheck(null); setChecking(false); return; }
    const n = ++seq.current;
    setChecking(true);
    const t = setTimeout(() => {
      api<Check_>('/projects/check', { method: 'POST', body: { path: path.trim() } })
        .then(r => { if (n === seq.current) setCheck(r); })
        .catch(e => { if (n === seq.current) setCheck({ ok: false, error: message(e) }); })
        .finally(() => { if (n === seq.current) setChecking(false); });
    }, 400);
    return () => clearTimeout(t);
  }, [path]);

  const nameProblem = !name.trim() ? '이름을 적어 주세요' : taken.some(t => t.toLowerCase() === name.trim().toLowerCase()) ? '같은 이름의 프로젝트가 있어요' : null;
  const canNext = step === 'name' ? !nameProblem : step === 'folder' ? !!check?.ok && !checking : true;
  const go = (i: number) => { setDir(i > at ? 1 : -1); setAt(i); setProblem(null); };
  const dirty = !!(name || path || files.length);
  const close = () => { if (!working && (!dirty || window.confirm('만들던 프로젝트를 버리고 닫을까요?'))) onClose(); };

  async function create() {
    setWorking(true); setProblem(null);
    try {
      const r = await api<{ project: Project } & PullResult>('/projects', { method: 'POST', body: { name: name.trim(), kind, path: kind === 'git' ? path.trim() : '', description: desc, env, doc_type: docType, external_ok: external } });
      if (kind === 'managed' && files.length) {
        // 프로젝트는 이미 만들어졌다. 올리기가 실패해도 만든 프로젝트로 넘어가고, 실패는 안내에 남긴다.
        try {
          const u = await uploadFiles(r.project.id, files);
          onCreated(r.project, { jobs: u.jobs, skipped: u.skipped.map(x => ({ path: x.name, reason: x.reason })) });
        } catch (e) { onCreated(r.project, { jobs: [], skipped: [{ path: '파일 올리기', reason: message(e) }] }); }
      } else onCreated(r.project, r);
    } catch (e) { setProblem(message(e)); }
    setWorking(false);
  }

  return <Drawer open={open} title="새 프로젝트" contentKey={step} dir={dir} onClose={close}>
    <div className="sf-steps" aria-label={`${at + 1} / ${STEPS.length} 단계`}>
      {STEPS.map((k, i) => <button key={k} className={i === at ? 'on' : i < at ? 'past' : ''} aria-label={Q[k][0]} title={Q[k][0]} disabled={i > at} onClick={() => go(i)} />)}
      <span>{at + 1} / {STEPS.length}</span>
    </div>
    <div className="qs-step sf-step">
      <h3>{Q[step][0]}</h3><p className="sf-sub">{Q[step][1]}</p>
      {step === 'name' && <>
        <label className="pj-field"><small>이름</small><input autoFocus maxLength={60} value={name} onChange={e => setName(e.target.value)} placeholder="예: k8s-handbook"
          onKeyDown={e => { if (e.key === 'Enter' && !nameProblem) go(1); }} /></label>
        {name && nameProblem && <p className="sf-dim"><CircleAlert size={11} />{nameProblem}</p>}
        <label className="pj-field"><small>설명 (선택)</small><input maxLength={200} value={desc} onChange={e => setDesc(e.target.value)} placeholder="무슨 문서를 모으는지 한 줄로" /></label>
      </>}
      {step === 'kind' && <div className="sf-opts" role="radiogroup" aria-label="관리 방식">
        <button role="radio" aria-checked={kind === 'git'} className={`sf-opt ${kind === 'git' ? 'is-on' : ''}`} onClick={() => setKind('git')}><span className="sf-radio" /><span className="sf-opt-body">
          <span className="sf-opt-head"><b>Git으로 관리</b><span className="pj-tag is-git"><GitBranch size={11} />Git</span></span>
          <small>원본은 git 저장소예요. 우리는 읽기만 해요. 판 = 커밋이고, 원본에서 고친 뒤 [다시 받기]로 반영해요.</small></span></button>
        <button role="radio" aria-checked={kind === 'managed'} className={`sf-opt ${kind === 'managed' ? 'is-on' : ''}`} onClick={() => setKind('managed')}><span className="sf-radio" /><span className="sf-opt-body">
          <span className="sf-opt-head"><b>직접 관리</b><span className="pj-tag is-own"><NotebookPen size={11} />직접</span></span>
          <small>파일을 올리면 원문을 DB에 저장해요. 판 = 내용이 바뀐 파일을 올릴 때마다 1판, 2판… git이 없어도 돼요.</small>
          <span className="sf-meta">지금은 .md만 · PDF는 다음 단계</span></span></button>
      </div>}
      {step === 'folder' && <>
        <span className="segmented pj-from" role="radiogroup" aria-label="가져올 곳">
          <button role="radio" aria-checked className="is-on"><span>이 컴퓨터의 git 폴더</span></button>
          <button role="radio" aria-checked={false} disabled title="다음 단계에서 만들 수 있어요"><span>GitHub · 준비 중</span></button>
        </span>
        <label className="pj-field"><small>폴더</small><input autoFocus className="mono" spellCheck={false} value={path} onChange={e => setPath(e.target.value)} placeholder="/path/to/docs-repo" /></label>
        {checking ? <p className="sf-impact"><LoaderCircle size={13} className="spin" />폴더를 보는 중…</p>
          : check?.ok ? <p className="sf-impact is-ok"><Check size={13} />git 저장소 {check.repo} · 브랜치 {check.branch ?? '—'} @ {check.commit ?? '커밋 없음'} · .md {check.md_count}개</p>
          : check ? <p className="sf-impact is-warn"><CircleAlert size={13} />{check.error}</p> : null}
      </>}
      {step === 'files' && <>
        <DropZone onFiles={addFiles} />
        {files.length > 0 && <div className="pj-files">{files.map(f => <div key={f.name} className="pj-file">
          <span>{f.name}</span><small>{kb(f.size)}{f.size > MAX_FILE ? ' · 너무 커서 빠져요' : !f.name.toLowerCase().endsWith('.md') ? ' · .md가 아니라 빠져요' : ''}</small>
          <button aria-label={`${f.name} 빼기`} onClick={() => setFiles(cur => cur.filter(x => x !== f))}><X size={13} /></button></div>)}</div>}
      </>}
      {step === 'defaults' && <>
        <Pick label="환경" values={ENVS} value={env} set={setEnv} />
        <Pick label="자료 성격" values={TYPES} value={docType} set={setDocType} />
        {kind === 'managed'
          ? <><Pick label="외부 전송 (OpenAI 등)" values={['불가', '허용']} value={external ? '허용' : '불가'} set={v => setExternal(v === '허용')} />
            <p className="sf-note">기본은 불가예요. 외부 임베딩이나 LLM 답변을 쓰려면 허용해야 해요. 문서마다 Knowledge에서 바꿀 수 있어요.</p></>
          : <p className="sf-note">외부 전송은 폴더로 정해져요. .env의 EXTERNAL_OK_ROOTS 안 문서만 허용, 나머지는 불가예요. 문서마다 Knowledge에서 바꿀 수 있어요.</p>}
      </>}
      {step === 'review' && <div className="sf-diff">
        {(kind === 'git'
          ? [['이름', name.trim()], ['관리 방식', 'Git · 로컬 폴더'], ['폴더', check?.ok ? check.path : path], ['가져올 문서', check?.ok ? `.md ${check.md_count}개` : '—'], ['기본값', `${env} · ${docType}`]]
          : [['이름', name.trim()], ['관리 방식', '직접 관리'], ['올릴 파일', files.length ? `${files.length}개` : '나중에'], ['기본값', `${env} · ${docType} · 외부 ${external ? '허용' : '불가'}`]]).map(([k, v]) =>
          <div key={k} className="sf-drow is-changed"><span className="sf-dk">{k}</span><span className="sf-dv"><b>{v}</b></span><span /></div>)}
      </div>}
    </div>
    <div className="qs-wiz-foot sf-foot">
      {problem && <p className="qs-check error" role="alert"><CircleAlert size={13} />{problem}</p>}
      <div className="sf-nav">
        {at > 0 ? <button className="qs-btn qs-btn-ghost" onClick={() => go(at - 1)}><ArrowLeft size={13} />이전</button> : <span />}
        {step !== 'review'
          ? <button className="qs-btn qs-btn-dark" disabled={!canNext} onClick={() => go(at + 1)}>다음<ArrowRight size={13} /></button>
          : <button className="qs-btn qs-btn-dark" disabled={working} onClick={() => void create()}>{working ? <LoaderCircle size={13} className="spin" /> : <Check size={13} />}프로젝트 만들기</button>}
      </div>
    </div>
  </Drawer>;
}

function Pick({ label, values, value, set }: { label: string; values: readonly string[]; value: string; set: (v: string) => void }) {
  return <div className="sf-seg-row"><small>{label}</small>
    <div className="segmented" role="radiogroup" aria-label={label}>{values.map(v => <button key={v} role="radio" aria-checked={value === v} className={value === v ? 'is-on' : ''} onClick={() => set(v)}><span>{v}</span></button>)}</div>
  </div>;
}

// ---------- Playground 범위 고르기 ----------

const SCOPE_KEY = 'playground-scope';
export function loadScope(): number | null {
  try { const v = localStorage.getItem(SCOPE_KEY); return v ? Number(v) || null : null; } catch { return null; }
}
export function saveScope(id: number | null) {
  try { if (id) localStorage.setItem(SCOPE_KEY, String(id)); else localStorage.removeItem(SCOPE_KEY); } catch { /* storage unavailable */ }
}

export function ScopePicker({ projects, value, onChange, disabled }: { projects: Project[] | null; value: number | null; onChange: (id: number | null) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', off); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', off); document.removeEventListener('keydown', esc); };
  }, [open]);
  const current = projects?.find(p => p.id === value);
  const pick = (id: number | null) => { onChange(id); setOpen(false); };
  return <div className="pj-scope" ref={ref}>
    <button type="button" className="pj-scope-btn" aria-haspopup="listbox" aria-expanded={open} disabled={disabled} onClick={() => setOpen(o => !o)} title="찾을 범위">
      <small>범위</small><b>{current?.name ?? '전체'}</b><ChevronDown size={13} /></button>
    <AnimatePresence>{open && <motion.div className="pj-scope-list" role="listbox" aria-label="찾을 범위"
      initial={{ opacity: 0, y: -4, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -4, scale: 0.98 }} transition={{ duration: 0.16 }}>
      <button type="button" role="option" aria-selected={value === null} className={value === null ? 'is-on' : ''} onClick={() => pick(null)}>
        <span>전체</span><small>모든 프로젝트</small></button>
      {projects && projects.length > 0 && <hr />}
      {projects?.map(p => <button type="button" key={p.id} role="option" aria-selected={value === p.id} className={value === p.id ? 'is-on' : ''} onClick={() => pick(p.id)}>
        <span>{p.name}</span><small>문서 {p.documents}</small><KindTag project={p} /></button>)}
    </motion.div>}</AnimatePresence>
  </div>;
}

