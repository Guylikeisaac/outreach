// Discovery run: search LinkedIn for each campaign query, scan hiring posts, qualify, dedupe, store.

import type { Campaign, RawPost, RunState } from '@shared/types';
import type { ScanResponse } from '@shared/messages';
import { buildContentSearchUrl } from '@shared/linkedin';
import { backendConfigured, findExistingProfiles } from '@shared/backend';
import { buildProspect } from '@shared/pipeline';
import { get, update, withLock } from '@shared/storage';
import { log, saveProspect } from './log';
import { activeLinkedInTab, openInWorkTab, sendToTab, useTabAsWorkTab, waitForContentScript } from './tabs';
import { syncNow } from './sync';
import { runAutopilot, sentToday } from './autopilot';

let stopRequested = false;
let targetReached = false;

export async function setRun(patch: Partial<RunState>) {
  await withLock(() => update('runState', (r) => ({ ...r, ...patch, updatedAt: new Date().toISOString() })));
}

export function requestStop() {
  stopRequested = true;
}

const localDay = (iso: string) => new Date(iso).toLocaleDateString('en-CA');

async function qualifiedToday(campaign: Campaign): Promise<number> {
  const prospects = await get('prospects');
  const today = localDay(new Date().toISOString());
  return Object.values(prospects).filter(
    (p) => p.campaignId === campaign.id && p.qualification.eligible && localDay(p.createdAt) === today,
  ).length;
}

class SafeStop extends Error {
  constructor(message: string, readonly diagnostics: string | null = null) {
    super(message);
  }
}

export async function startDiscovery(campaignId: string, mode: 'search' | 'current_tab' | 'autopilot') {
  const run = await get('runState');
  if (run.phase === 'running' || run.phase === 'stopping') throw new Error('A run is already in progress.');
  const campaign = (await get('campaigns'))[campaignId];
  if (!campaign) throw new Error('Campaign not found.');
  if (mode === 'search' && !campaign.searchQueries.length) throw new Error('Add at least one search query.');
  if (mode === 'autopilot' && campaign.autoSend === false) throw new Error('Turn on Autopilot for this campaign first.');

  stopRequested = false;
  targetReached = false;
  await setRun({
    phase: 'running',
    campaignId,
    currentQuery: '',
    scanned: 0,
    added: 0,
    lastError: null,
    diagnostics: null,
    message: mode === 'autopilot' ? 'Starting Autopilot…' : 'Starting discovery…',
  });
  if (mode !== 'autopilot')
    await log(mode === 'search' ? `Discovery started — ${campaign.searchQueries.length} search(es)` : 'Scanning current LinkedIn page', {
      campaignId,
      metadata: { queries: campaign.searchQueries },
    });

  try {
    const queries = mode === 'search' ? campaign.searchQueries : mode === 'current_tab' ? ['current page'] : [];
    for (const query of queries) {
      if (stopRequested || targetReached) break;
      const have = await qualifiedToday(campaign);
      if (have >= campaign.dailyTarget) {
        await log(`Daily target reached (${have}/${campaign.dailyTarget} qualified today)`, { level: 'success', campaignId });
        break;
      }

      let tabId: number;
      if (mode === 'search') {
        await setRun({ currentQuery: query, message: `Searching “${query}”` });
        await log(`Searching LinkedIn: “${query}”`, { campaignId });
        tabId = await openInWorkTab(buildContentSearchUrl(query));
      } else {
        const tab = await activeLinkedInTab();
        if (!tab?.id) throw new SafeStop('Open a LinkedIn search results or feed page in the active tab first.');
        tabId = tab.id;
        await useTabAsWorkTab(tabId);
        await waitForContentScript(tabId);
      }

      const { maxPostsPerQuery } = await get('settings');
      await setRun({ message: 'Reading posts…' });
      const res = await sendToTab<ScanResponse>(tabId, { type: 'SCAN_POSTS', maxPosts: maxPostsPerQuery, scroll: true });
      if (!res?.ok) throw new SafeStop(res?.error ?? 'No response from the LinkedIn page.', res?.diagnostics ?? null);
      await processPosts(res.posts, campaign);
      // Autopilot: message the people just found right away, instead of after every search.
      if (!stopRequested && campaign.autoSend !== false) {
        const fresh = (await get('campaigns'))[campaignId] ?? campaign;
        await runAutopilot(fresh, () => stopRequested, (message) => setRun({ message }), { quiet: true });
      }
      if (stopRequested || targetReached) break;
      await new Promise((r) => setTimeout(r, 2500 + Math.random() * 2500)); // human-paced between searches
    }
    const r = await get('runState');
    if (mode !== 'autopilot')
      await log(stopRequested ? 'Discovery stopped by user' : `Discovery finished — ${r.added} new prospect(s)`, {
        level: stopRequested ? 'warn' : 'success',
        campaignId,
      });

    // Autopilot (enabled per campaign by the user): send connection requests with the note.
    if (!stopRequested && campaign.autoSend !== false) {
      const fresh = (await get('campaigns'))[campaignId] ?? campaign;
      await runAutopilot(fresh, () => stopRequested, (message) => setRun({ message }));
    }

    const sent = await sentToday(campaignId);
    await setRun({
      phase: 'idle',
      message: stopRequested ? 'Stopped by you' : campaign.autoSend !== false ? `Done — ${r.added} new, ${sent} sent today` : `Done — ${r.added} new prospect(s)`,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const diagnostics = e instanceof SafeStop ? e.diagnostics : null;
    await setRun({ phase: 'error', lastError: msg, diagnostics, message: 'Stopped safely' });
    await log(`Run stopped: ${msg}`,{ level: 'error', campaignId, metadata: diagnostics ? { diagnostics } : {} });
  } finally {
    stopRequested = false;
    void syncNow();
  }
}

async function processPosts(posts: RawPost[], campaign: Campaign) {
  const built = posts.map((raw) => ({ raw, result: buildProspect(raw, campaign) }));
  const counts = { scanned: posts.length, notHiring: 0, noContact: 0, duplicates: 0, added: 0 };

  // Cross-device duplicate check (teammates' history). Failure here falls back to local-only.
  const settings = await get('settings');
  let remote = new Map<string, string>();
  const candidateUrls = built.flatMap((b) => (b.result.kind === 'prospect' ? [b.result.prospect.profileUrl] : []));
  if (backendConfigured(settings) && candidateUrls.length) {
    try {
      remote = await findExistingProfiles(settings, candidateUrls);
    } catch (e) {
      await log(`Backend duplicate check unavailable — using local history only (${e instanceof Error ? e.message : e})`, {
        level: 'warn',
        campaignId: campaign.id,
      });
    }
  }

  for (const { raw, result } of built) {
    if (stopRequested || targetReached) break;
    if (result.kind === 'skip') {
      if (result.reason === 'not_hiring') counts.notHiring++;
      else {
        counts.noContact++;
        await log(`Skipped hiring post: ${result.detail}`, { campaignId: campaign.id, metadata: { postUrl: raw.postUrl } });
      }
      continue;
    }
    const p = result.prospect;

    const outcome = await withLock(async () => {
      const index = await get('profileIndex');
      if (index[p.profileUrl]) return 'duplicate' as const;
      if (remote.has(p.profileUrl)) return 'remote' as const;
      if (p.connectionStatus === 'CONNECTED') p.outreachStatus = 'SKIPPED';
      await saveProspect(p);
      return 'added' as const;
    });

    if (outcome !== 'added') {
      counts.duplicates++;
      if (outcome === 'remote')
        await log(`${p.name} already in SyncUp history (${remote.get(p.profileUrl)}) — skipped`, { campaignId: campaign.id });
      continue;
    }
    counts.added++;
    await log('Found hiring post', { prospectId: p.id, campaignId: campaign.id, metadata: { postUrl: p.postUrl } });
    await log(`Identified ${p.name}${p.headline ? ` — ${p.headline}` : ''}`, { prospectId: p.id, campaignId: campaign.id });
    await log(`Qualification: ${p.qualification.level}`, {
      prospectId: p.id,
      campaignId: campaign.id,
      level: p.qualification.eligible ? 'success' : 'info',
      metadata: { reasons: p.qualification.reasons },
    });
    if (p.connectionStatus === 'CONNECTED')
      await log(`${p.name}: already connected (1st degree) — skipped`, { prospectId: p.id, campaignId: campaign.id });

    if (p.qualification.eligible && (await qualifiedToday(campaign)) >= campaign.dailyTarget) {
      targetReached = true;
      await log(`Daily target of ${campaign.dailyTarget} qualified prospects reached`, { level: 'success', campaignId: campaign.id });
    }
  }

  const run = await get('runState');
  await setRun({ scanned: run.scanned + counts.scanned, added: run.added + counts.added });
  await withLock(() =>
    update('stats', (stats) => {
      const cur = stats[campaign.id] ?? { postsScanned: 0, hiringPosts: 0 };
      cur.postsScanned += counts.scanned;
      cur.hiringPosts += counts.scanned - counts.notHiring;
      stats[campaign.id] = cur;
    }),
  );
  await log(
    `Scanned ${counts.scanned} posts: ${counts.added} new, ${counts.duplicates} already known, ${counts.notHiring} not hiring, ${counts.noContact} without a clear contact`,
    { campaignId: campaign.id, metadata: counts },
  );
}
