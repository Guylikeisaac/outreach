import { useState } from 'react';
import type { OutreachStatus } from '@shared/types';
import { useStore, useWorkerHeartbeat } from './hooks';
import { ToastProvider } from './components/ui';
import { CampaignPanel } from './components/CampaignPanel';
import { ProspectList } from './components/Prospects';
import { Pipeline } from './components/Pipeline';
import { ActivityLog } from './components/ActivityLog';
import { SettingsPanel } from './components/SettingsPanel';

const TABS = ['discover', 'prospects', 'pipeline', 'activity', 'settings'] as const;
type Tab = (typeof TABS)[number];
const OPEN: OutreachStatus[] = ['NEW', 'REVIEWED', 'APPROVED'];

function Header() {
  return (
    <header className="px-5 pb-4 pt-5">
      <div className="flex items-center gap-2.5">
        <img src="icons/icon48.png" alt="" className="h-7 w-7 rounded-lg" />
        <div className="text-[13px] font-bold tracking-[.28em]">
          SYNCUP <span className="gold-text">OUTREACH</span>
        </div>
      </div>
      <p className="mt-2 text-xs text-muted">Find hiring teams. Start conversations.</p>
    </header>
  );
}

export default function App() {
  useWorkerHeartbeat();
  const [tab, setTab] = useState<Tab>(() => (TABS.includes(location.hash.slice(1) as Tab) ? (location.hash.slice(1) as Tab) : 'discover'));
  const prospects = useStore('prospects');
  const workflow = useStore('workflow');
  const recommended = Object.values(prospects).filter((p) => p.qualification.eligible && OPEN.includes(p.outreachStatus)).length;

  const tabs: [Tab, string, number?][] = [
    ['discover', 'Discover'],
    ['prospects', 'Prospects', recommended],
    ['pipeline', 'Pipeline'],
    ['activity', 'Activity'],
    ['settings', 'Settings'],
  ];

  return (
    <ToastProvider>
      <div className="mx-auto min-h-screen max-w-2xl bg-ink">
        <Header />
        <nav className="sticky top-0 z-30 border-b border-line bg-ink/90 px-2 backdrop-blur">
          <div className="flex overflow-x-auto">
            {tabs.map(([k, label, count]) => (
              <button
                key={k}
                onClick={() => setTab(k)}
                className={`relative whitespace-nowrap px-2 py-3 text-[11.5px] font-medium transition ${tab === k ? 'text-fg' : 'text-muted hover:text-silver'}`}
              >
                {label}
                {!!count && <span className="ml-1.5 rounded-full bg-gold/15 px-1.5 py-px text-[10px] text-gold-2 tabular-nums">{count}</span>}
                {k === 'prospects' && workflow.step === 'awaiting_final_confirmation' && (
                  <span className="animate-pulse-dot absolute right-1 top-2.5 h-1.5 w-1.5 rounded-full bg-gold" />
                )}
                {tab === k && <span className="absolute inset-x-3 -bottom-px h-px bg-gradient-to-r from-gold/0 via-gold to-gold/0" />}
              </button>
            ))}
          </div>
        </nav>
        <main key={tab} className="animate-rise p-4 pb-16">
          {tab === 'discover' && <CampaignPanel />}
          {tab === 'prospects' && <ProspectList />}
          {tab === 'pipeline' && <Pipeline />}
          {tab === 'activity' && <ActivityLog />}
          {tab === 'settings' && <SettingsPanel />}
        </main>
      </div>
    </ToastProvider>
  );
}
