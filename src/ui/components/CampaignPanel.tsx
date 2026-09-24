import { useEffect, useMemo, useState } from 'react';
import { TARGET_LOCATIONS, TARGET_ROLES, type Campaign, type TargetLocation, type TargetRole } from '@shared/types';
import { PAGE_STRUCTURE_ERROR } from '@shared/messages';
import { send, useStore } from '../hooks';
import { Button, Card, Field, Spinner, inputCls, useAction } from './ui';

const SUGGESTED_QUERIES = [
  'startup hiring Bengaluru',
  'we are hiring India startup',
  'founder hiring India',
  'hiring software engineer India',
];

type Draft = Omit<Campaign, 'id' | 'createdAt' | 'updatedAt'> & { id?: string };

const blank = (): Draft => ({
  name: 'Indian Startup Hiring',
  searchQueries: ['startup hiring India'],
  targetRoles: ['Founders', 'Co-founders', 'Recruiters', 'Talent Acquisition', 'HR', 'Hiring Managers', 'CTOs'],
  targetLocations: ['India'],
  dailyTarget: 20,
});

function Chip({ on, children, onClick }: { on: boolean; children: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={`rounded-full border px-3 py-1.5 text-[11px] font-medium transition ${
        on ? 'border-gold/50 bg-gold/10 text-gold-2' : 'border-line-2 bg-panel-2 text-muted hover:text-silver'
      }`}
    >
      {on ? '✓ ' : ''}
      {children}
    </button>
  );
}

export function CampaignPanel() {
  const campaigns = useStore('campaigns');
  const activeId = useStore('activeCampaignId');
  const run = useStore('runState');
  const prospects = useStore('prospects');
  const { busy, run: act } = useAction();

  const active = activeId ? campaigns[activeId] : undefined;
  const [draft, setDraft] = useState<Draft>(blank);
  const [newQuery, setNewQuery] = useState('');
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (active && !dirty) setDraft({ ...active });
  }, [active?.id, active?.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const patch = (p: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...p }));
    setDirty(true);
  };
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const addQuery = (q: string) => {
    const v = q.trim();
    if (v && !draft.searchQueries.includes(v)) patch({ searchQueries: [...draft.searchQueries, v] });
    setNewQuery('');
  };

  const today = new Date().toLocaleDateString('en-CA');
  const qualifiedToday = useMemo(
    () =>
      Object.values(prospects).filter(
        (p) => p.campaignId === activeId && p.qualification.eligible && new Date(p.createdAt).toLocaleDateString('en-CA') === today,
      ).length,
    [prospects, activeId, today],
  );

  const running = run.phase === 'running' || run.phase === 'stopping';

  const save = async () => {
    const saved = await act('save', () => send<Campaign>({ type: 'SAVE_CAMPAIGN', campaign: draft }), 'Campaign saved');
    if (saved) setDirty(false);
    return saved;
  };

  const start = async (mode: 'search' | 'tab') => {
    let id = draft.id;
    if (dirty || !id) {
      const saved = await save();
      if (!saved) return;
      id = saved.id;
    }
    await act(mode, () => send({ type: mode === 'search' ? 'START_DISCOVERY' : 'SCAN_CURRENT_TAB', campaignId: id! }));
  };

  const target = Math.max(1, draft.dailyTarget || 1);
  const pct = Math.min(100, Math.round((qualifiedToday / target) * 100));

  return (
    <div className="space-y-4">
      {/* Run status */}
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between px-4 pt-4">
          <div>
            <div className="label-caps">Today</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums">
              {qualifiedToday}
              <span className="text-base text-dim"> / {draft.dailyTarget} qualified</span>
            </div>
          </div>
          <div className="text-right text-[11px] text-muted">
            {running ? (
              <span className="inline-flex items-center gap-1.5 text-gold-2">
                <span className="animate-pulse-dot h-1.5 w-1.5 rounded-full bg-gold" /> {run.phase === 'stopping' ? 'Stopping' : 'Discovering'}
              </span>
            ) : (
              <span>{run.message || 'Ready'}</span>
            )}
            {running && (
              <div className="mt-0.5 tabular-nums">
                {run.scanned} scanned · {run.added} new
              </div>
            )}
          </div>
        </div>
        <div className="mx-4 mt-3 h-1 overflow-hidden rounded-full bg-panel-3">
          <div className="h-full rounded-full bg-gradient-to-r from-gold to-gold-2 transition-all duration-500" style={{ width: `${pct}%` }} />
        </div>
        {running && run.message && <div className="px-4 pt-3 text-xs text-silver">{run.message}</div>}
        {run.phase === 'error' && run.lastError && (
          <div className="mx-4 mt-3 rounded-xl border border-bad/30 bg-bad/5 p-3 text-xs text-red-200">
            <div className="font-semibold">Stopped safely</div>
            <div className="mt-1 text-red-200/80">{run.lastError}</div>
            {run.lastError === PAGE_STRUCTURE_ERROR && (
              <div className="mt-1 text-red-200/60">Nothing was clicked after the page stopped matching. You can retry.</div>
            )}
            <div className="mt-2 flex gap-2">
              <Button size="sm" variant="secondary" onClick={() => start('search')} busy={busy === 'search'}>
                Retry
              </Button>
              <Button size="sm" variant="ghost" onClick={() => send({ type: 'CLEAR_ERROR' })}>
                Dismiss
              </Button>
            </div>
          </div>
        )}
        <div className="grid grid-cols-[1fr_auto] gap-2 p-4">
          {running ? (
            <Button variant="danger" size="lg" onClick={() => act('stop', () => send({ type: 'STOP_DISCOVERY' }))} disabled={run.phase === 'stopping'}>
              {run.phase === 'stopping' ? <Spinner /> : null} STOP
            </Button>
          ) : (
            <Button variant="primary" size="lg" onClick={() => start('search')} busy={busy === 'search' || busy === 'save'}>
              START DISCOVERY
            </Button>
          )}
          <Button
            variant="secondary"
            size="lg"
            className="!px-3 !text-[10px] !tracking-[.1em]"
            title="Scan the LinkedIn search/feed page open in the current tab"
            onClick={() => start('tab')}
            disabled={running}
            busy={busy === 'tab'}
          >
            SCAN TAB
          </Button>
        </div>
      </Card>

      {/* Campaign form */}
      <Card className="space-y-5 p-4">
        <div className="flex items-center gap-2">
          <select
            className={`${inputCls} !py-2 font-medium`}
            value={activeId ?? ''}
            onChange={(e) => {
              if (e.target.value === '__new') {
                setDraft({ ...blank(), name: '' });
                setDirty(true);
                return;
              }
              setDirty(false);
              void send({ type: 'SET_ACTIVE_CAMPAIGN', campaignId: e.target.value });
            }}
            disabled={running}
            aria-label="Campaign"
          >
            {Object.values(campaigns).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
            <option value="__new">+ New campaign</option>
          </select>
        </div>

        <Field label="Campaign name">
          <input className={inputCls} value={draft.name} placeholder="Indian Startup Hiring" onChange={(e) => patch({ name: e.target.value })} />
        </Field>

        <Field label="Search queries" hint="Each query runs as a LinkedIn post search, newest first, past week.">
          <div className="space-y-2">
            {draft.searchQueries.map((q) => (
              <div key={q} className="flex items-center gap-2 rounded-xl border border-line-2 bg-panel-2 py-1.5 pl-3 pr-1.5 text-sm">
                <span className="flex-1 truncate">{q}</span>
                <button
                  type="button"
                  className="rounded-lg px-2 py-1 text-xs text-dim hover:bg-panel-3 hover:text-bad"
                  onClick={() => patch({ searchQueries: draft.searchQueries.filter((x) => x !== q) })}
                  aria-label={`Remove ${q}`}
                >
                  ✕
                </button>
              </div>
            ))}
            <div className="flex gap-2">
              <input
                className={inputCls}
                placeholder="Add a search, e.g. hiring Pune startup"
                value={newQuery}
                onChange={(e) => setNewQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addQuery(newQuery))}
              />
              <Button onClick={() => addQuery(newQuery)} disabled={!newQuery.trim()}>
                Add
              </Button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {SUGGESTED_QUERIES.filter((q) => !draft.searchQueries.includes(q)).map((q) => (
                <button key={q} type="button" onClick={() => addQuery(q)} className="rounded-full border border-dashed border-line-2 px-2.5 py-1 text-[11px] text-muted hover:border-gold/40 hover:text-gold-2">
                  + {q}
                </button>
              ))}
            </div>
          </div>
        </Field>

        <Field label="Target people">
          <div className="flex flex-wrap gap-1.5">
            {TARGET_ROLES.map((r) => (
              <Chip key={r} on={draft.targetRoles.includes(r)} onClick={() => patch({ targetRoles: toggle<TargetRole>(draft.targetRoles, r) })}>
                {r}
              </Chip>
            ))}
          </div>
        </Field>

        <Field label="Target geography" hint={draft.targetLocations.includes('India') ? 'Any Indian location qualifies.' : 'Only posts naming these cities qualify.'}>
          <div className="flex flex-wrap gap-1.5">
            {TARGET_LOCATIONS.map((l) => (
              <Chip key={l} on={draft.targetLocations.includes(l)} onClick={() => patch({ targetLocations: toggle<TargetLocation>(draft.targetLocations, l) })}>
                {l}
              </Chip>
            ))}
          </div>
        </Field>

        <Field label="Daily prospect target" hint="Discovery pauses once this many qualified prospects are found today. Nothing is sent automatically.">
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={5}
              max={100}
              step={5}
              value={draft.dailyTarget}
              onChange={(e) => patch({ dailyTarget: Number(e.target.value) })}
              className="flex-1 accent-[#d4af6a]"
            />
            <span className="w-24 text-right text-sm tabular-nums text-silver">{draft.dailyTarget} / day</span>
          </div>
        </Field>

        <div className="flex items-center justify-between gap-2 border-t border-line pt-4">
          {draft.id && Object.keys(campaigns).length > 1 ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => act('delete', () => send({ type: 'DELETE_CAMPAIGN', campaignId: draft.id! }), 'Campaign deleted').then(() => setDirty(false))}
              disabled={running}
            >
              Delete
            </Button>
          ) : (
            <span />
          )}
          <Button onClick={save} busy={busy === 'save'} disabled={!dirty || running}>
            {dirty ? 'Save campaign' : 'Saved'}
          </Button>
        </div>
      </Card>
    </div>
  );
}
