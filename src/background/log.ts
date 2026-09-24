import type { ActivityLog, Prospect } from '@shared/types';
import { MAX_LOGS, get, set, update, withLock } from '@shared/storage';

export async function log(
  action: string,
  opts: { level?: ActivityLog['level']; prospectId?: string | null; campaignId?: string | null; metadata?: Record<string, unknown> } = {},
): Promise<void> {
  const entry: ActivityLog = {
    id: crypto.randomUUID(),
    prospectId: opts.prospectId ?? null,
    campaignId: opts.campaignId ?? null,
    action,
    level: opts.level ?? 'info',
    metadata: opts.metadata ?? {},
    createdAt: new Date().toISOString(),
  };
  await withLock(async () => {
    await update('logs', (logs) => {
      logs.push(entry);
      if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
    });
    await update('syncQueue', (q) => {
      q.logs.push(entry.id);
    });
  });
}

/** Persists a prospect change and queues it for backend sync. Caller must hold the lock. */
export async function saveProspect(p: Prospect): Promise<Prospect> {
  p.updatedAt = new Date().toISOString();
  const prospects = await get('prospects');
  prospects[p.id] = p;
  await set('prospects', prospects);
  const index = await get('profileIndex');
  for (const url of [p.profileUrl, ...p.profileAliases]) if (url) index[url] = p.id;
  await set('profileIndex', index);
  await update('syncQueue', (q) => {
    if (!q.prospects.includes(p.id)) q.prospects.push(p.id);
  });
  return p;
}

export async function patchProspect(id: string, fn: (p: Prospect) => void): Promise<Prospect | null> {
  return withLock(async () => {
    const prospects = await get('prospects');
    const p = prospects[id];
    if (!p) return null;
    fn(p);
    return saveProspect(p);
  });
}
