// Small design-system primitives for the SyncUp dashboard.

import { createContext, useCallback, useContext, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import type { ConnectionStatus, OutreachStatus, Qualification } from '@shared/types';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

export function Button({
  variant = 'secondary',
  size = 'md',
  busy,
  className = '',
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'lg'; busy?: boolean }) {
  const base =
    'inline-flex items-center justify-center gap-2 rounded-xl font-semibold tracking-wide transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/60 active:scale-[.985]';
  const sizes = { sm: 'h-8 px-3 text-[11px]', md: 'h-10 px-4 text-xs', lg: 'h-12 px-5 text-sm tracking-[.14em]' };
  const variants: Record<Variant, string> = {
    primary:
      'bg-gradient-to-b from-gold-2 to-gold text-ink shadow-[0_8px_24px_-12px_rgba(212,175,106,.6)] hover:brightness-105',
    secondary: 'bg-panel-3 text-fg border border-line-2 hover:border-silver/30 hover:bg-[#222228]',
    ghost: 'text-silver hover:text-fg hover:bg-panel-3',
    danger: 'bg-bad/10 text-bad border border-bad/30 hover:bg-bad/15',
  };
  return (
    <button className={`${base} ${sizes[size]} ${variants[variant]} ${className}`} disabled={busy || rest.disabled} {...rest}>
      {busy && <Spinner />}
      {children}
    </button>
  );
}

export function Spinner({ className = '' }: { className?: string }) {
  return <span className={`inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent ${className}`} />;
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-2xl border border-line bg-panel ${className}`}>{children}</div>;
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="label-caps">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-dim">{hint}</span>}
    </label>
  );
}

export const inputCls =
  'w-full rounded-xl border border-line-2 bg-panel-2 px-3 py-2.5 text-sm text-fg placeholder:text-dim outline-none transition focus:border-gold/60 focus:ring-2 focus:ring-gold/15';

type Tone = 'gold' | 'ok' | 'warn' | 'bad' | 'neutral' | 'info';
const toneCls: Record<Tone, string> = {
  gold: 'bg-gold/12 text-gold-2 border-gold/30',
  ok: 'bg-ok/10 text-ok border-ok/25',
  warn: 'bg-warn/10 text-warn border-warn/25',
  bad: 'bg-bad/10 text-bad border-bad/25',
  info: 'bg-sky-400/10 text-sky-300 border-sky-400/25',
  neutral: 'bg-panel-3 text-silver border-line-2',
};

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[.12em] ${toneCls[tone]}`}>
      {children}
    </span>
  );
}

export function QualificationBadge({ level }: { level: Qualification }) {
  return <Badge tone={level === 'HIGH' ? 'gold' : level === 'MEDIUM' ? 'info' : 'neutral'}>{level}</Badge>;
}

export const CONNECTION_LABEL: Record<ConnectionStatus, string> = {
  CONNECTED: 'Already connected',
  PENDING: 'Connection pending',
  CONNECT_AVAILABLE: 'Connect available',
  UNAVAILABLE: 'Connect unavailable',
  UNKNOWN: 'Not checked',
};

export function ConnectionBadge({ status }: { status: ConnectionStatus }) {
  const tone: Record<ConnectionStatus, Tone> = {
    CONNECTED: 'neutral',
    PENDING: 'warn',
    CONNECT_AVAILABLE: 'ok',
    UNAVAILABLE: 'bad',
    UNKNOWN: 'neutral',
  };
  return <Badge tone={tone[status]}>{CONNECTION_LABEL[status]}</Badge>;
}

export function OutreachBadge({ status }: { status: OutreachStatus }) {
  const tone: Tone =
    status === 'SKIPPED' ? 'neutral' : status === 'NEW' ? 'info' : ['REVIEWED', 'APPROVED'].includes(status) ? 'warn' : 'ok';
  return <Badge tone={tone}>{status.replace(/_/g, ' ')}</Badge>;
}

// ── Toasts ─────────────────────────────────────────────────────────────────────────────────

interface Toast {
  id: number;
  text: string;
  tone: 'ok' | 'bad' | 'info';
}
const ToastCtx = createContext<(text: string, tone?: Toast['tone']) => void>(() => undefined);
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: Toast['tone'] = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5200);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed inset-x-3 bottom-3 z-50 flex flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`animate-rise pointer-events-auto rounded-xl border px-3.5 py-2.5 text-xs shadow-2xl backdrop-blur ${
              t.tone === 'bad' ? 'border-bad/30 bg-[#1d1011]/95 text-red-200' : t.tone === 'ok' ? 'border-ok/25 bg-[#0e1a12]/95 text-green-200' : 'border-line-2 bg-panel-2/95 text-silver'
            }`}
          >
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/** Wraps an async action with busy state + error toast. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(
    async <T,>(key: string, fn: () => Promise<T>, success?: string): Promise<T | undefined> => {
      setBusy(key);
      try {
        const r = await fn();
        if (success) toast(success, 'ok');
        return r;
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e), 'bad');
        return undefined;
      } finally {
        setBusy(null);
      }
    },
    [toast],
  );
  return { busy, run };
}

/** Copies a page-structure summary so selector breakages can be reported and fixed. */
export function CopyDiagnostics({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      title="Copies a short summary of the LinkedIn page structure (no post content) for fixing selectors"
      onClick={async () => {
        await navigator.clipboard.writeText(`SyncUp diagnostics v${chrome.runtime.getManifest?.().version ?? ''}\n${text}`);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
    >
      {copied ? 'Copied' : 'Copy diagnostics'}
    </Button>
  );
}
