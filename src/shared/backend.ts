// Supabase (PostgREST) sync. Optional: when not configured the extension runs local-only.
// Schema: supabase/schema.sql. The LinkedIn profile URL is the unique key for prospects.

import type { ActivityLog, Campaign, OutreachStatus, Prospect, Settings } from './types';

export function backendConfigured(s: Settings): boolean {
  return Boolean(s.supabaseUrl && s.supabaseAnonKey);
}

function headers(s: Settings, extra: Record<string, string> = {}): HeadersInit {
  return {
    apikey: s.supabaseAnonKey,
    Authorization: `Bearer ${s.supabaseAnonKey}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

function base(s: Settings): string {
  return s.supabaseUrl.replace(/\/+$/, '') + '/rest/v1';
}

async function request(s: Settings, path: string, init: RequestInit): Promise<Response> {
  const res = await fetch(base(s) + path, init);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Supabase ${res.status}: ${body.slice(0, 200)}`);
  }
  return res;
}

export function prospectRow(p: Prospect) {
  return {
    id: p.id,
    linkedin_profile_url: p.profileUrl,
    profile_aliases: p.profileAliases,
    name: p.name,
    headline: p.headline,
    company: p.company,
    company_url: p.companyUrl,
    hiring_role: p.hiringRole,
    location: p.location,
    post_url: p.postUrl,
    post_text: p.postText,
    posted_date: p.postedDate || null,
    qualification: p.qualification.level,
    qualification_reasons: p.qualification.reasons,
    connection_status: p.connectionStatus,
    outreach_status: p.outreachStatus,
    message: p.message,
    campaign_id: p.campaignId,
    created_at: p.createdAt,
    updated_at: p.updatedAt,
  };
}

export function campaignRow(c: Campaign) {
  return {
    id: c.id,
    name: c.name,
    search_queries: c.searchQueries,
    target_roles: c.targetRoles,
    target_locations: c.targetLocations,
    daily_target: c.dailyTarget,
    created_at: c.createdAt,
    updated_at: c.updatedAt,
  };
}

export function logRow(l: ActivityLog) {
  return {
    id: l.id,
    prospect_id: l.prospectId,
    campaign_id: l.campaignId,
    action: l.action,
    metadata: { ...l.metadata, level: l.level },
    created_at: l.createdAt,
  };
}

export async function upsertCampaigns(s: Settings, rows: Campaign[]) {
  if (!rows.length) return;
  await request(s, '/campaigns?on_conflict=id', {
    method: 'POST',
    headers: headers(s, { Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify(rows.map(campaignRow)),
  });
}

export async function upsertProspects(s: Settings, rows: Prospect[]) {
  if (!rows.length) return;
  await request(s, '/prospects?on_conflict=linkedin_profile_url', {
    method: 'POST',
    headers: headers(s, { Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify(rows.map(prospectRow)),
  });
}

export async function insertLogs(s: Settings, rows: ActivityLog[]) {
  if (!rows.length) return;
  await request(s, '/activity_logs?on_conflict=id', {
    method: 'POST',
    headers: headers(s, { Prefer: 'resolution=ignore-duplicates,return=minimal' }),
    body: JSON.stringify(rows.map(logRow)),
  });
}

/**
 * Returns the outreach status for any of the given profile URLs that already exist in the backend
 * (e.g. processed by a teammate), matching the primary URL or any recorded alias.
 */
export async function findExistingProfiles(s: Settings, urls: string[]): Promise<Map<string, OutreachStatus>> {
  const out = new Map<string, OutreachStatus>();
  if (!urls.length) return out;
  const quoted = urls.map((u) => `"${u.replace(/"/g, '')}"`).join(',');
  const filter = `(linkedin_profile_url.in.(${quoted}),profile_aliases.ov.{${quoted}})`;
  const res = await request(
    s,
    `/prospects?select=linkedin_profile_url,profile_aliases,outreach_status&or=${encodeURIComponent(filter)}`,
    { method: 'GET', headers: headers(s) },
  );
  type Row = { linkedin_profile_url: string; profile_aliases: string[] | null; outreach_status: OutreachStatus };
  for (const row of (await res.json()) as Row[]) {
    for (const url of [row.linkedin_profile_url, ...(row.profile_aliases ?? [])]) out.set(url, row.outreach_status);
  }
  return out;
}
