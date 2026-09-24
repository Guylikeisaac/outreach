import { useMemo, useState } from 'react';
import { OUTREACH_STATUSES, type OutreachStatus, type Prospect } from '@shared/types';
import { send, relativeDay, useStore } from '../hooks';
import { Badge, Button, Card, ConnectionBadge, CopyDiagnostics, OutreachBadge, QualificationBadge, useAction } from './ui';
import { ReviewSheet } from './ReviewSheet';

const OPEN: OutreachStatus[] = ['NEW', 'REVIEWED', 'APPROVED'];
const LEVEL_RANK = { HIGH: 0, MEDIUM: 1, LOW: 2 } as const;

type Filter = 'recommended' | 'in_progress' | 'all' | 'not_recommended';

function reasonTone(r: string) {
  return r.startsWith('✓') ? 'text-ok/90' : r.startsWith('✗') ? 'text-bad/90' : 'text-dim';
}

export function WorkflowBanner() {
  const wf = useStore('workflow');
  const prospects = useStore('prospects');
  if (wf.step === 'idle') return null;
  const p = wf.prospectId ? prospects[wf.prospectId] : undefined;
  const active = ['checking_connection', 'opening_profile', 'submitting'].includes(wf.step);
  const waiting = wf.step === 'awaiting_final_confirmation';
  return (
    <div
      className={`animate-rise flex items-start gap-3 rounded-2xl border p-3.5 text-xs ${
        waiting ? 'border-gold/40 bg-gold/5' : wf.step === 'stopped' ? 'border-warn/30 bg-warn/5' : 'border-line-2 bg-panel'
      }`}
    >
      <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${active ? 'animate-pulse-dot bg-gold' : waiting ? 'bg-gold' : wf.step === 'done' ? 'bg-ok' : 'bg-warn'}`} />
      <div className="min-w-0 flex-1">
        <div className="font-semibold text-fg">
          {waiting ? 'Waiting for your confirmation on LinkedIn' : wf.step === 'done' ? 'Done' : wf.step === 'stopped' ? 'Stopped' : 'Working…'}
          {p ? ` · ${p.name}` : ''}
        </div>
        <div className="mt-0.5 text-muted">{wf.detail}</div>
        {wf.diagnostics && (
          <div className="mt-1.5 -ml-3">
            <CopyDiagnostics text={wf.diagnostics} />
          </div>
        )}
      </div>
      {!active && (
        <button className="text-dim hover:text-silver" onClick={() => send({ type: 'CANCEL_WORKFLOW' })} aria-label="Dismiss">
          ✕
        </button>
      )}
    </div>
  );
}

function ProspectCard({ p, onReview }: { p: Prospect; onReview: (p: Prospect) => void }) {
  const { busy, run } = useAction();
  const [expanded, setExpanded] = useState(false);
  const open = OPEN.includes(p.outreachStatus);
  const title = p.headline;

  const primary = () => {
    if (!p.qualification.eligible) return <div className="text-[11px] text-dim">Did not pass qualification — outreach disabled.</div>;
    if (!open) return null;
    switch (p.connectionStatus) {
      case 'CONNECTED':
        return <div className="text-[11px] text-muted">Already connected — no request needed.</div>;
      case 'PENDING':
        return <div className="text-[11px] text-muted">Connection already pending.</div>;
      case 'CONNECT_AVAILABLE':
        return (
          <Button
            variant="primary"
            className="w-full"
            busy={busy === 'gen'}
            onClick={async () => {
              if (p.message) return onReview(p);
              const msg = await run('gen', () => send<string>({ type: 'GENERATE_MESSAGE', prospectId: p.id }));
              if (msg) onReview({ ...p, message: msg });
            }}
          >
            {p.message ? 'REVIEW MESSAGE' : 'GENERATE MESSAGE'}
          </Button>
        );
      default:
        return (
          <div className="space-y-1.5">
            {p.connectionStatus === 'UNAVAILABLE' && <div className="text-[11px] text-muted">Connect unavailable on this profile.</div>}
            <Button className="w-full" busy={busy === 'check'} onClick={() => run('check', () => send({ type: 'CHECK_CONNECTION', prospectId: p.id }))}>
              {p.connectionStatus === 'UNKNOWN' && p.connectionCheckedAt ? 'RETRY CONNECTION CHECK' : 'CHECK CONNECTION'}
            </Button>
            {p.connectionStatus === 'UNKNOWN' && p.connectionCheckedAt && (
              <div className="text-[11px] text-warn/80">Could not determine connection status last time.</div>
            )}
          </div>
        );
    }
  };

  return (
    <Card className="animate-rise p-4 transition hover:border-line-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-[15px] font-semibold">{p.name}</div>
          {title && <div className="mt-0.5 line-clamp-2 text-xs text-muted">{title}</div>}
        </div>
        <QualificationBadge level={p.qualification.level} />
      </div>

      <dl className="mt-3 grid grid-cols-[72px_1fr] gap-x-2 gap-y-1 text-xs">
        <dt className="text-dim">Hiring</dt>
        <dd className="text-silver">{p.hiringRole || <span className="text-dim">Not stated</span>}</dd>
        {p.company && (
          <>
            <dt className="text-dim">Company</dt>
            <dd className="text-silver">{p.company}</dd>
          </>
        )}
        <dt className="text-dim">Location</dt>
        <dd className="text-silver">{p.location || <span className="text-dim">Not stated</span>}</dd>
        <dt className="text-dim">Posted</dt>
        <dd className="text-silver">{p.postedDate ? relativeDay(p.postedDate) : <span className="text-dim">Unknown</span>}</dd>
      </dl>

      <ul className="mt-3 space-y-0.5 text-xs">
        {(expanded ? p.qualification.reasons : p.qualification.reasons.filter((r) => !r.startsWith('?')).slice(0, 4)).map((r) => (
          <li key={r} className={reasonTone(r)}>
            {r}
          </li>
        ))}
      </ul>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <ConnectionBadge status={p.connectionStatus} />
        <OutreachBadge status={p.outreachStatus} />
        {p.contactSource === 'mentioned_in_post' && <Badge>Named in post</Badge>}
      </div>

      {expanded && (
        <div className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap rounded-xl border border-line bg-panel-2 p-3 text-[11px] leading-relaxed text-muted">
          {p.postText}
        </div>
      )}

      <div className="mt-2 flex items-center justify-between text-[11px] text-dim">
        <span>Source: {p.source}</span>
        <button className="hover:text-silver" onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Less' : 'Details'}
        </button>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <Button size="sm" disabled={!p.postUrl} onClick={() => send({ type: 'OPEN_URL', url: p.postUrl })}>
          VIEW POST
        </Button>
        <Button size="sm" onClick={() => send({ type: 'OPEN_URL', url: p.profileUrl })}>
          VIEW PROFILE
        </Button>
      </div>
      <div className="mt-2">{primary()}</div>

      <div className="mt-3 flex items-center justify-between gap-2 border-t border-line pt-3">
        <label className="flex items-center gap-2 text-[11px] text-dim">
          Status
          <select
            className="rounded-lg border border-line-2 bg-panel-2 px-2 py-1 text-[11px] text-silver outline-none"
            value={p.outreachStatus}
            onChange={(e) => run('status', () => send({ type: 'SET_OUTREACH_STATUS', prospectId: p.id, status: e.target.value as OutreachStatus }))}
          >
            {OUTREACH_STATUSES.map((s) => (
              <option key={s} value={s} disabled={s === 'APPROVED' && p.outreachStatus !== 'APPROVED'}>
                {s.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        </label>
        {open && (
          <Button size="sm" variant="ghost" onClick={() => run('skip', () => send({ type: 'SET_OUTREACH_STATUS', prospectId: p.id, status: 'SKIPPED' }))}>
            Skip
          </Button>
        )}
      </div>
    </Card>
  );
}

export function ProspectList() {
  const prospects = useStore('prospects');
  const activeId = useStore('activeCampaignId');
  const [filter, setFilter] = useState<Filter>('recommended');
  const [onlyCampaign, setOnlyCampaign] = useState(true);
  const [reviewing, setReviewing] = useState<string | null>(null);

  const list = useMemo(() => {
    const all = Object.values(prospects).filter((p) => !onlyCampaign || p.campaignId === activeId);
    const f = all.filter((p) => {
      switch (filter) {
        case 'recommended':
          return p.qualification.eligible && OPEN.includes(p.outreachStatus);
        case 'in_progress':
          return !OPEN.includes(p.outreachStatus) && p.outreachStatus !== 'SKIPPED';
        case 'not_recommended':
          return !p.qualification.eligible || p.outreachStatus === 'SKIPPED';
        default:
          return true;
      }
    });
    return f.sort((a, b) => LEVEL_RANK[a.qualification.level] - LEVEL_RANK[b.qualification.level] || b.createdAt.localeCompare(a.createdAt));
  }, [prospects, filter, onlyCampaign, activeId]);

  const tabs: [Filter, string][] = [
    ['recommended', 'Recommended'],
    ['in_progress', 'In pipeline'],
    ['not_recommended', 'Skipped / low'],
    ['all', 'All'],
  ];
  const reviewProspect = reviewing ? prospects[reviewing] : undefined;

  return (
    <div className="space-y-3">
      <WorkflowBanner />
      <div className="flex gap-1 overflow-x-auto rounded-xl border border-line bg-panel p-1">
        {tabs.map(([k, l]) => (
          <button
            key={k}
            onClick={() => setFilter(k)}
            className={`flex-1 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-[11px] font-medium transition ${filter === k ? 'bg-panel-3 text-fg' : 'text-muted hover:text-silver'}`}
          >
            {l}
          </button>
        ))}
      </div>
      <label className="flex items-center gap-2 px-1 text-[11px] text-dim">
        <input type="checkbox" checked={onlyCampaign} onChange={(e) => setOnlyCampaign(e.target.checked)} className="accent-[#d4af6a]" />
        Active campaign only · {list.length} shown
      </label>

      {list.length === 0 ? (
        <Card className="p-8 text-center">
          <div className="text-sm text-silver">No prospects here yet.</div>
          <div className="mt-1 text-xs text-dim">Start discovery from the Discover tab to find hiring posts.</div>
        </Card>
      ) : (
        list.map((p) => <ProspectCard key={p.id} p={p} onReview={(x) => setReviewing(x.id)} />)
      )}

      {reviewProspect && <ReviewSheet prospect={reviewProspect} onClose={() => setReviewing(null)} />}
    </div>
  );
}
