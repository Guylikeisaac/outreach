import { useMemo, useState } from 'react';
import type { ActivityLog as Log } from '@shared/types';
import { timeLabel, useStore } from '../hooks';
import { Card } from './ui';

const dot: Record<Log['level'], string> = {
  info: 'bg-silver/50',
  success: 'bg-ok',
  warn: 'bg-warn',
  error: 'bg-bad',
};

export function ActivityLog() {
  const logs = useStore('logs');
  const prospects = useStore('prospects');
  const run = useStore('runState');
  const [issuesOnly, setIssuesOnly] = useState(false);

  const items = useMemo(() => {
    const list = issuesOnly ? logs.filter((l) => l.level === 'warn' || l.level === 'error') : logs;
    return [...list].reverse().slice(0, 300);
  }, [logs, issuesOnly]);

  let lastDay = '';
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-2 text-xs text-muted">
          <span className={`h-1.5 w-1.5 rounded-full ${run.phase === 'running' ? 'animate-pulse-dot bg-gold' : 'bg-dim'}`} />
          {run.phase === 'running' ? 'Live' : 'Idle'} · {logs.length} events
        </div>
        <label className="flex items-center gap-1.5 text-[11px] text-dim">
          <input type="checkbox" checked={issuesOnly} onChange={(e) => setIssuesOnly(e.target.checked)} className="accent-[#d4af6a]" />
          Issues only
        </label>
      </div>
      <Card className="p-2">
        {items.length === 0 && <div className="p-6 text-center text-xs text-dim">Nothing yet. Every action SyncUp takes will appear here.</div>}
        <ol>
          {items.map((l) => {
            const day = new Date(l.createdAt).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
            const header = day !== lastDay ? day : null;
            lastDay = day;
            const who = l.prospectId ? prospects[l.prospectId]?.name : undefined;
            const showWho = who && !l.action.includes(who);
            return (
              <li key={l.id}>
                {header && <div className="label-caps px-2 pb-1 pt-3 !text-[9px]">{header}</div>}
                <div className="flex gap-3 rounded-xl px-2 py-2 hover:bg-panel-2">
                  <div className="w-14 shrink-0 pt-px text-[11px] tabular-nums text-dim">{timeLabel(l.createdAt)}</div>
                  <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${dot[l.level]}`} />
                  <div className="min-w-0 text-xs leading-relaxed">
                    <div className={l.level === 'error' ? 'text-red-200' : l.level === 'warn' ? 'text-amber-100' : 'text-silver'}>{l.action}</div>
                    {showWho && <div className="text-[11px] text-dim">{who}</div>}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      </Card>
    </div>
  );
}
