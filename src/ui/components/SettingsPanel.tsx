import { useEffect, useState } from 'react';
import type { Settings } from '@shared/types';
import { get } from '@shared/storage';
import { send, timeLabel, useStore } from '../hooks';
import { Button, Card, Field, inputCls, useAction } from './ui';

export function SettingsPanel() {
  const settings = useStore('settings');
  const lastSyncAt = useStore('lastSyncAt');
  const lastSyncError = useStore('lastSyncError');
  const queue = useStore('syncQueue');
  const [draft, setDraft] = useState<Settings>(settings);
  const { busy, run } = useAction();

  useEffect(() => setDraft(settings), [settings]);
  const patch = (p: Partial<Settings>) => setDraft((d) => ({ ...d, ...p }));
  const pending = queue.prospects.length + queue.campaigns.length + queue.logs.length;

  const exportData = async () => {
    const [campaigns, prospects, logs] = await Promise.all([get('campaigns'), get('prospects'), get('logs')]);
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), campaigns, prospects, logs }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `syncup-outreach-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="space-y-4">
      <Card className="space-y-4 p-4">
        <div>
          <div className="text-sm font-semibold">Backend (Supabase)</div>
          <div className="mt-0.5 text-xs text-dim">Shared prospect history across your team. Run supabase/schema.sql first. Optional — data is always kept locally.</div>
        </div>
        <Field label="Project URL">
          <input className={inputCls} placeholder="https://xyzcompany.supabase.co" value={draft.supabaseUrl} onChange={(e) => patch({ supabaseUrl: e.target.value })} />
        </Field>
        <Field label="Anon / publishable key">
          <input className={inputCls} type="password" value={draft.supabaseAnonKey} onChange={(e) => patch({ supabaseAnonKey: e.target.value })} />
        </Field>
        <div className="flex items-center justify-between text-[11px]">
          <span className={lastSyncError ? 'text-bad' : 'text-dim'}>
            {lastSyncError ? `Sync error: ${lastSyncError}` : lastSyncAt ? `Last synced ${timeLabel(lastSyncAt)} · ${pending} pending` : `${pending} pending`}
          </span>
          <Button size="sm" busy={busy === 'sync'} disabled={!settings.supabaseUrl} onClick={() => run('sync', () => send({ type: 'SYNC_NOW' }), 'Synced')}>
            Sync all
          </Button>
        </div>
      </Card>

      <Card className="space-y-4 p-4">
        <div>
          <div className="text-sm font-semibold">AI personalization</div>
          <div className="mt-0.5 text-xs text-dim">
            Uses Claude to write the “Saw you’re hiring…” line from the post. Output is checked against the post text; if it adds anything not in the post, the
            template line is used instead.
          </div>
        </div>
        <label className="flex items-center gap-2 text-xs text-silver">
          <input type="checkbox" className="accent-[#d4af6a]" checked={draft.useAiPersonalization} onChange={(e) => patch({ useAiPersonalization: e.target.checked })} />
          Enable AI personalization
        </label>
        <Field label="Anthropic API key" hint="Stored only in this browser's extension storage.">
          <input className={inputCls} type="password" placeholder="sk-ant-…" value={draft.anthropicApiKey} onChange={(e) => patch({ anthropicApiKey: e.target.value })} />
        </Field>
      </Card>

      <Card className="space-y-4 p-4">
        <div className="text-sm font-semibold">Discovery</div>
        <Field label="Max posts per search" hint="How far SyncUp scrolls each search (5–60). Scrolling is human-paced.">
          <input
            className={inputCls}
            type="number"
            min={5}
            max={60}
            value={draft.maxPostsPerQuery}
            onChange={(e) => patch({ maxPostsPerQuery: Number(e.target.value) })}
          />
        </Field>
      </Card>

      <div className="flex gap-2">
        <Button variant="primary" className="flex-1" busy={busy === 'save'} onClick={() => run('save', () => send({ type: 'SAVE_SETTINGS', settings: draft }), 'Settings saved')}>
          Save settings
        </Button>
        <Button onClick={exportData}>Export JSON</Button>
      </div>
    </div>
  );
}
