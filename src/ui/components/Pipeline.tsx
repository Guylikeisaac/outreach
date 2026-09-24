import { useMemo, useState } from 'react';
import { OUTREACH_STATUSES, type OutreachStatus, type Prospect } from '@shared/types';
import { useStore } from '../hooks';
import { Card } from './ui';

/** Position in the pipeline; SKIPPED is off-pipeline. */
const rank = (s: OutreachStatus) => (s === 'SKIPPED' ? -1 : OUTREACH_STATUSES.indexOf(s));
const reached = (list: Prospect[], s: OutreachStatus) => list.filter((p) => rank(p.outreachStatus) >= rank(s)).length;

function Metric({ label, value, sub }: { label: string; value: number | null; sub?: string }) {
  return (
    <div className="rounded-2xl border border-line bg-panel p-3.5">
      <div className="label-caps !text-[9px]">{label}</div>
      <div className="mt-1.5 text-2xl font-semibold tabular-nums">{value === null || value === 0 ? <span className="text-dim">—</span> : value}</div>
      {sub && <div className="mt-0.5 text-[10px] text-dim">{sub}</div>}
    </div>
  );
}

export function Pipeline() {
  const prospects = useStore('prospects');
  const stats = useStore('stats');
  const activeId = useStore('activeCampaignId');
  const campaigns = useStore('campaigns');
  const [scope, setScope] = useState<'campaign' | 'all'>('campaign');

  const m = useMemo(() => {
    const list = Object.values(prospects).filter((p) => scope === 'all' || p.campaignId === activeId);
    const qualified = list.filter((p) => p.qualification.eligible);
    const statsRows = scope === 'all' ? Object.values(stats) : activeId && stats[activeId] ? [stats[activeId]] : [];
    return {
      hiringPosts: statsRows.reduce((a, s) => a + s.hiringPosts, 0),
      scanned: statsRows.reduce((a, s) => a + s.postsScanned, 0),
      found: list.length,
      qualified: qualified.length,
      high: qualified.filter((p) => p.qualification.level === 'HIGH').length,
      reviewed: reached(qualified, 'REVIEWED'),
      approved: reached(qualified, 'APPROVED'),
      submitted: reached(list, 'REQUEST_SUBMITTED'),
      connected: reached(list, 'CONNECTED'),
      replied: reached(list, 'REPLIED'),
      jd: reached(list, 'JD_RECEIVED'),
      candidates: reached(list, 'CANDIDATES_SENT'),
      interview: reached(list, 'INTERVIEW'),
      hired: reached(list, 'HIRED'),
      skipped: list.filter((p) => p.outreachStatus === 'SKIPPED').length,
    };
  }, [prospects, stats, scope, activeId]);

  const funnel: [string, number][] = [
    ['Hiring posts', m.hiringPosts],
    ['Qualified prospects', m.qualified],
    ['Requests sent', m.submitted],
    ['Connected', m.connected],
    ['Replied', m.replied],
    ['JD received', m.jd],
    ['Candidates sent', m.candidates],
    ['Interview', m.interview],
    ['Hired', m.hired],
  ];
  const top = Math.max(1, ...funnel.map(([, v]) => v));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-xs text-muted">{scope === 'campaign' ? campaigns[activeId ?? '']?.name ?? 'No campaign' : 'All campaigns'}</div>
        <div className="flex rounded-lg border border-line bg-panel p-0.5 text-[11px]">
          {(['campaign', 'all'] as const).map((s) => (
            <button key={s} onClick={() => setScope(s)} className={`rounded-md px-2.5 py-1 ${scope === s ? 'bg-panel-3 text-fg' : 'text-muted'}`}>
              {s === 'campaign' ? 'Campaign' : 'All'}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Metric label="Prospects found" value={m.found} sub={m.scanned ? `from ${m.scanned} posts scanned` : undefined} />
        <Metric label="Qualified" value={m.qualified} sub={m.high ? `${m.high} high` : undefined} />
        <Metric label="Reviewed" value={m.reviewed} />
        <Metric label="Approved" value={m.approved} />
        <Metric label="Requests submitted" value={m.submitted} />
        <Metric label="Connected" value={m.connected} />
        <Metric label="Replies" value={m.replied} />
        <Metric label="Skipped" value={m.skipped} sub="connected, pending, or by you" />
      </div>

      <Card className="p-4">
        <div className="label-caps">Conversion</div>
        <div className="mt-3 space-y-2.5">
          {funnel.map(([label, v], i) => {
            const prev = i > 0 ? funnel[i - 1][1] : 0;
            const conv = i > 0 && prev > 0 ? Math.round((v / prev) * 100) : null;
            return (
              <div key={label}>
                <div className="flex items-baseline justify-between text-xs">
                  <span className={v ? 'text-silver' : 'text-dim'}>{label}</span>
                  <span className="tabular-nums">
                    <span className={v ? 'text-fg' : 'text-dim'}>{v || '—'}</span>
                    {conv !== null && <span className="ml-2 text-[10px] text-dim">{conv}%</span>}
                  </span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-panel-3">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-gold/70 to-gold-2 transition-all duration-500"
                    style={{ width: `${(v / top) * 100}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
        <p className="mt-4 text-[11px] leading-relaxed text-dim">
          Stages after “Requests sent” are updated from each prospect’s Status menu as conversations progress toward JD → candidates → hire.
        </p>
      </Card>
    </div>
  );
}
