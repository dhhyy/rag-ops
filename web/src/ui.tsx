// Shared building blocks used by every page (main.tsx, setup.tsx, evaluations.tsx).
import React, { useEffect, useRef, useState } from 'react';
import { animate, motion, useMotionValue, useReducedMotion, useTransform } from 'motion/react';
import { X, type LucideIcon } from 'lucide-react';

export const RAG_API = '/api/rag';
export const spring = { type: 'spring' as const, stiffness: 360, damping: 30 };
export const ease = [0.22, 1, 0.36, 1] as const;
export const shortTime = (iso: string) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
export const pct = (v: number | null | undefined) => v == null ? '—' : `${Math.round(v * 100)}%`;

export async function readError(res: Response): Promise<string> {
  try {
    const body = await res.json();
    if (typeof body.detail === 'string') return body.detail;
    if (Array.isArray(body.detail)) return body.detail.map((d: { msg: string }) => d.msg).join(' · ');
  } catch { /* fall through */ }
  return res.status === 502 ? 'Engine is not reachable. Start the engine API first.' : `Request failed (${res.status})`;
}

// JSON request to the engine. Throws the engine's own error message so screens can show it as is.
export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(`${RAG_API}${path}`, {
    method: init?.method ?? 'GET',
    headers: init?.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (!res.ok) throw new Error(await readError(res));
  return res.json();
}

export function IconButton({ icon: Icon, label, onClick, className = '', disabled = false }: { icon: LucideIcon; label: string; onClick?: () => void; className?: string; disabled?: boolean }) {
  return <button className={`icon-button ${className}`} aria-label={label} title={label} onClick={onClick} disabled={disabled}><Icon size={18} strokeWidth={1.7} /></button>;
}
export function ColorIcon({ icon: Icon, color = 'lilac', small = false }: { icon: LucideIcon; color?: string; small?: boolean }) {
  return <span className={`color-icon ${color} ${small ? 'small' : ''}`}><Icon size={small ? 15 : 19} strokeWidth={1.6} /></span>;
}
export function Toggle({ checked, onChange, label, disabled = false }: { checked: boolean; onChange: () => void; label: string; disabled?: boolean }) {
  return <button role="switch" aria-checked={checked} aria-label={label} onClick={onChange} disabled={disabled} className={`switch ${checked ? 'checked' : ''}`}><motion.span animate={{ x: checked ? 17 : 0 }} transition={spring} /></button>;
}
export function Card({ children, className = '', delay = 0 }: { children: React.ReactNode; className?: string; delay?: number }) {
  const reduced = useReducedMotion();
  return <motion.section className={`card ${className}`} initial={{ opacity: 0, y: reduced ? 0 : 22, filter: reduced ? 'none' : 'blur(7px)' }} animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }} transition={{ duration: reduced ? 0.1 : 0.65, delay: reduced ? 0 : delay, ease }}>{children}</motion.section>;
}
export function Heading({ title, subtitle, children }: { title: string; subtitle?: string; children?: React.ReactNode }) {
  return <div className="page-heading"><div><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div><div className="heading-actions">{children}</div></div>;
}
export function Modal({ children, title, close }: { children: React.ReactNode; title: string; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  // With no input to type into, focus the dialog itself so the close button doesn't open with a focus ring.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.showModal();
    const input = el.querySelector<HTMLInputElement>('input');
    if (input) input.focus(); else el.focus();
  }, []);
  return <dialog ref={ref} tabIndex={-1} className="dialog" onCancel={close} onClick={e => { if (e.target === e.currentTarget) close(); }} aria-labelledby="dialog-title"><motion.div className="dialog-inner" initial={{ opacity: 0, y: 16, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={spring}><div className="dialog-heading"><h2 id="dialog-title">{title}</h2><IconButton icon={X} label="Close dialog" onClick={close} /></div>{children}</motion.div></dialog>;
}
export function DetailRows({ rows }: { rows: [string, React.ReactNode][] }) {
  return <dl className="detail-rows">{rows.map(([k, v], i) => <motion.div key={k} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.04, duration: 0.3 }}>
    <dt>{k}</dt><dd>{v ?? '—'}</dd>
  </motion.div>)}</dl>;
}
export function CountUp({ value }: { value: number }) {
  const count = useMotionValue(0);
  const text = useTransform(count, v => Math.round(v).toLocaleString());
  useEffect(() => {
    const controls = animate(count, value, { duration: 1.1, ease });
    return () => controls.stop();
  }, [value]);
  return <motion.span>{text}</motion.span>;
}
export function MetricCard({ icon, color, label, value, note, delay }: { icon: LucideIcon; color: string; label: string; value: React.ReactNode; note: string; delay: number }) {
  return <Card className="queue-card" delay={delay}><ColorIcon icon={icon} color={color} small /><div><small>{label}</small><strong>{value}</strong><em title={note}>{note}</em></div></Card>;
}

// Follows an element's size. The embedding map needs real pixels to keep the x and y scale equal.
export function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}
