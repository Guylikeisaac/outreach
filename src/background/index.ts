// SyncUp background service worker: routes UI requests, receives content-script events,
// and owns all writes to extension storage.

import type { Campaign } from '@shared/types';
import type { ContentEvent, UiRequest, UiResponse } from '@shared/messages';
import { isLinkedInUrl } from '@shared/linkedin';
import { DEFAULT_TEMPLATE, LEGACY_TEMPLATE, templateIssues } from '@shared/message';
import { get, set, update, withLock } from '@shared/storage';
import { log } from './log';
import { requestStop, setRun, startDiscovery } from './discovery';
import { approveAndConnect, cancelWorkflow, checkConnection, generateFor, onWorkflowEvent, saveMessage, setOutreachStatus } from './outreach';
import { syncNow } from './sync';
import { DEFAULT_DAILY_SEND_LIMIT, MAX_DAILY_SEND_LIMIT } from './autopilot';

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);

// Migrate a saved message that is still the old long pitch (over the 200-char limit) to the new default.
void (async () => {
  const settings = await get('settings');
  if (settings.messageTemplate === LEGACY_TEMPLATE) await update('settings', (s) => ({ ...s, messageTemplate: DEFAULT_TEMPLATE }));
})();

// A worker restart kills any in-flight run; don't leave the UI showing "running" forever.
void (async () => {
  const run = await get('runState');
  if (run.phase === 'running' || run.phase === 'stopping') {
    await setRun({ phase: 'idle', message: 'Discovery was interrupted. Start again to continue.' });
  }
})();

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason !== 'install') return;
  const campaigns = await get('campaigns');
  if (Object.keys(campaigns).length) return;
  const ts = new Date().toISOString();
  const starter: Campaign = {
    id: crypto.randomUUID(),
    name: 'Indian Startup Hiring',
    searchQueries: ['"we are hiring" startup India', '"I am hiring" India', '"we\'re hiring" Bengaluru'],
    targetRoles: ['Founders', 'Co-founders', 'Recruiters', 'Talent Acquisition', 'HR', 'Hiring Managers', 'CTOs'],
    targetLocations: ['India'],
    dailyTarget: 20,
    createdAt: ts,
    updatedAt: ts,
  };
  await set('campaigns', { [starter.id]: starter });
  await set('activeCampaignId', starter.id);
  await update('syncQueue', (q) => void q.campaigns.push(starter.id));
});

// Long-running flows (discovery) keep the side panel connected; its heartbeats keep this worker awake.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'syncup-ui') return;
  port.onMessage.addListener(() => undefined);
});

async function handleUi(req: UiRequest): Promise<UiResponse> {
  switch (req.type) {
    case 'SAVE_CAMPAIGN': {
      const c = req.campaign;
      if (!c.name.trim()) throw new Error('Campaign name is required.');
      const queries = [...new Set(c.searchQueries.map((q) => q.trim()).filter(Boolean))];
      if (!queries.length) throw new Error('Add at least one search query.');
      const ts = new Date().toISOString();
      let saved!: Campaign;
      await withLock(async () => {
        const campaigns = await get('campaigns');
        const existing = c.id ? campaigns[c.id] : undefined;
        saved = {
          id: existing?.id ?? crypto.randomUUID(),
          name: c.name.trim(),
          searchQueries: queries,
          targetRoles: c.targetRoles,
          targetLocations: c.targetLocations.length ? c.targetLocations : ['India'],
          dailyTarget: Math.min(200, Math.max(1, Math.round(c.dailyTarget) || 20)),
          autoSend: c.autoSend !== false,
          dailySendLimit: Math.min(MAX_DAILY_SEND_LIMIT, Math.max(1, Math.round(c.dailySendLimit ?? DEFAULT_DAILY_SEND_LIMIT) || DEFAULT_DAILY_SEND_LIMIT)),
          createdAt: existing?.createdAt ?? ts,
          updatedAt: ts,
        };
        campaigns[saved.id] = saved;
        await set('campaigns', campaigns);
        await set('activeCampaignId', saved.id);
        await update('syncQueue', (q) => {
          if (!q.campaigns.includes(saved.id)) q.campaigns.push(saved.id);
        });
      });
      await log(`Campaign saved: ${saved.name}`, { campaignId: saved.id });
      void syncNow();
      return { ok: true, data: saved };
    }
    case 'DELETE_CAMPAIGN':
      await withLock(async () => {
        const campaigns = await get('campaigns');
        delete campaigns[req.campaignId];
        await set('campaigns', campaigns);
        const active = await get('activeCampaignId');
        if (active === req.campaignId) await set('activeCampaignId', Object.keys(campaigns)[0] ?? null);
      });
      return { ok: true };
    case 'SET_ACTIVE_CAMPAIGN':
      await set('activeCampaignId', req.campaignId);
      return { ok: true };
    case 'START_DISCOVERY':
    case 'SCAN_CURRENT_TAB':
    case 'START_AUTOPILOT': {
      const run = await get('runState');
      if (run.phase === 'running' || run.phase === 'stopping') throw new Error('A run is already in progress.');
      const campaign = (await get('campaigns'))[req.campaignId];
      if (req.type === 'START_AUTOPILOT' && campaign?.autoSend === false) throw new Error('Turn on Autopilot for this campaign first.');
      // Runs in the background; progress is reported through storage.
      void startDiscovery(req.campaignId, req.type === 'START_DISCOVERY' ? 'search' : req.type === 'SCAN_CURRENT_TAB' ? 'current_tab' : 'autopilot');
      return { ok: true };
    }
    case 'STOP_DISCOVERY':
      requestStop();
      await setRun({ phase: 'stopping', message: 'Stopping after the current step…' });
      return { ok: true };
    case 'CHECK_CONNECTION':
      return { ok: true, data: await checkConnection(req.prospectId) };
    case 'GENERATE_MESSAGE':
      return { ok: true, data: await generateFor(req.prospectId) };
    case 'SAVE_MESSAGE':
      await saveMessage(req.prospectId, req.message);
      return { ok: true };
    case 'APPROVE_AND_CONNECT':
      await approveAndConnect(req.prospectId, req.message);
      return { ok: true };
    case 'CANCEL_WORKFLOW':
      await cancelWorkflow();
      return { ok: true };
    case 'SET_OUTREACH_STATUS':
      await setOutreachStatus(req.prospectId, req.status);
      return { ok: true };
    case 'OPEN_URL':
      if (!isLinkedInUrl(req.url)) throw new Error('Only LinkedIn links can be opened.');
      await chrome.tabs.create({ url: req.url, active: true });
      return { ok: true };
    case 'SAVE_SETTINGS': {
      const s = req.settings;
      if (s.supabaseUrl && !/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(s.supabaseUrl.trim()))
        throw new Error('Supabase URL must look like https://<project>.supabase.co');
      if (s.messageTemplate !== undefined) {
        const issues = templateIssues(s.messageTemplate);
        if (issues.length) throw new Error(issues[0]);
      }
      await update('settings', (cur) => ({
        ...cur,
        ...s,
        supabaseUrl: (s.supabaseUrl ?? cur.supabaseUrl).trim().replace(/\/+$/, ''),
        maxPostsPerQuery: Math.min(60, Math.max(5, Number(s.maxPostsPerQuery ?? cur.maxPostsPerQuery) || 25)),
      }));
      return { ok: true };
    }
    case 'SYNC_NOW': {
      // Queue everything so a newly configured backend receives full history.
      const [prospects, campaigns, logs] = await Promise.all([get('prospects'), get('campaigns'), get('logs')]);
      await withLock(() =>
        update('syncQueue', () => ({ prospects: Object.keys(prospects), campaigns: Object.keys(campaigns), logs: logs.map((l) => l.id) })),
      );
      const res = await syncNow();
      return res.ok ? { ok: true } : { ok: false, error: res.error ?? 'Sync failed' };
    }
    case 'CLEAR_ERROR':
      await setRun({ phase: 'idle', lastError: null, diagnostics: null });
      return { ok: true };
  }
}

chrome.runtime.onMessage.addListener((msg: UiRequest | ContentEvent, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;

  // Events from the LinkedIn content script.
  if (sender.tab) {
    if (!isLinkedInUrl(sender.tab.url)) return false;
    if (msg.type === 'WORKFLOW_EVENT') void onWorkflowEvent(msg);
    // SCAN_PROGRESS needs no handling beyond waking the worker.
    return false;
  }

  handleUi(msg as UiRequest)
    .then(sendResponse)
    .catch((e: unknown) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) } satisfies UiResponse));
  return true;
});
