// Pushes queued local changes to Supabase. Local storage stays the source of truth for the UI;
// the backend is the shared, durable history (and cross-device duplicate check).

import { backendConfigured, insertLogs, upsertCampaigns, upsertProspects } from '@shared/backend';
import { get, set, update, withLock } from '@shared/storage';

let syncing = false;

export async function syncNow(): Promise<{ ok: boolean; error?: string }> {
  const settings = await get('settings');
  if (!backendConfigured(settings)) return { ok: true };
  if (syncing) return { ok: true };
  syncing = true;
  try {
    const queue = await get('syncQueue');
    if (!queue.prospects.length && !queue.campaigns.length && !queue.logs.length) return { ok: true };
    const [campaigns, prospects, logs] = await Promise.all([get('campaigns'), get('prospects'), get('logs')]);

    // Campaigns first (prospects/logs reference them), then prospects, then logs.
    const campaignRows = queue.campaigns.map((id) => campaigns[id]).filter(Boolean);
    const referenced = new Set([...queue.prospects.map((id) => prospects[id]?.campaignId)].filter(Boolean) as string[]);
    for (const id of referenced) if (campaigns[id] && !campaignRows.includes(campaigns[id])) campaignRows.push(campaigns[id]);
    await upsertCampaigns(settings, campaignRows);
    await upsertProspects(settings, queue.prospects.map((id) => prospects[id]).filter(Boolean));
    const logIds = new Set(queue.logs);
    // Logs may reference prospects/campaigns removed locally; keep the log, drop the link.
    await insertLogs(
      settings,
      logs
        .filter((l) => logIds.has(l.id))
        .map((l) => ({
          ...l,
          prospectId: l.prospectId && prospects[l.prospectId] ? l.prospectId : null,
          campaignId: l.campaignId && campaigns[l.campaignId] ? l.campaignId : null,
        })),
    );

    await withLock(() =>
      update('syncQueue', (q) => {
        q.campaigns = q.campaigns.filter((id) => !queue.campaigns.includes(id));
        q.prospects = q.prospects.filter((id) => !queue.prospects.includes(id));
        q.logs = q.logs.filter((id) => !logIds.has(id));
      }),
    );
    await set('lastSyncAt', new Date().toISOString());
    await set('lastSyncError', null);
    return { ok: true };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await set('lastSyncError', error);
    return { ok: false, error };
  } finally {
    syncing = false;
  }
}
