// chrome.storage.local repository. The background worker is the only writer of prospects, logs and
// run state (all writes go through `withLock`), the UI reads and subscribes to changes.

import type { ActivityLog, Campaign, Prospect, RunState, Settings, WorkflowState } from './types';
import { normalizeProfileUrl } from './linkedin';

export interface StoreShape {
  campaigns: Record<string, Campaign>;
  activeCampaignId: string | null;
  prospects: Record<string, Prospect>;
  /** normalized profile URL → prospect id (includes aliases). */
  profileIndex: Record<string, string>;
  logs: ActivityLog[];
  settings: Settings;
  runState: RunState;
  workflow: WorkflowState;
  /** Items waiting to be pushed to the backend. */
  syncQueue: { prospects: string[]; campaigns: string[]; logs: string[] };
  lastSyncAt: string | null;
  lastSyncError: string | null;
  /** Cumulative discovery counters per campaign id. */
  stats: Record<string, { postsScanned: number; hiringPosts: number }>;
}

export type StoreKey = keyof StoreShape;

const now = () => new Date().toISOString();

export const DEFAULTS: StoreShape = {
  campaigns: {},
  activeCampaignId: null,
  prospects: {},
  profileIndex: {},
  logs: [],
  settings: {
    supabaseUrl: '',
    supabaseAnonKey: '',
    anthropicApiKey: '',
    useAiPersonalization: false,
    maxPostsPerQuery: 25,
  },
  runState: {
    phase: 'idle',
    campaignId: null,
    currentQuery: '',
    scanned: 0,
    added: 0,
    message: '',
    lastError: null,
    updatedAt: now(),
  },
  workflow: { prospectId: null, step: 'idle', detail: '', updatedAt: now() },
  syncQueue: { prospects: [], campaigns: [], logs: [] },
  lastSyncAt: null,
  lastSyncError: null,
  stats: {},
};

export const MAX_LOGS = 800;

export async function get<K extends StoreKey>(key: K): Promise<StoreShape[K]> {
  const res = await chrome.storage.local.get(key);
  const value = res[key] as StoreShape[K] | undefined;
  if (value === undefined) return structuredClone(DEFAULTS[key]);
  if (key === 'settings') return { ...DEFAULTS.settings, ...(value as Settings) } as StoreShape[K];
  return value;
}

export async function set<K extends StoreKey>(key: K, value: StoreShape[K]): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
}

export async function update<K extends StoreKey>(key: K, fn: (v: StoreShape[K]) => StoreShape[K] | void): Promise<StoreShape[K]> {
  const current = await get(key);
  const next = (fn(current) ?? current) as StoreShape[K];
  await set(key, next);
  return next;
}

// Serializes read-modify-write sequences within the background worker.
let chain: Promise<unknown> = Promise.resolve();
export function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

/** Looks up an existing prospect by any known URL for that person. */
export async function findProspectByUrl(url: string): Promise<Prospect | null> {
  const key = normalizeProfileUrl(url);
  if (!key) return null;
  const [index, prospects] = await Promise.all([get('profileIndex'), get('prospects')]);
  const id = index[key];
  return id ? prospects[id] ?? null : null;
}
