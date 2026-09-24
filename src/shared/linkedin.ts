// LinkedIn URL helpers. Pure functions — safe to use anywhere.

export const LINKEDIN_ORIGIN = 'https://www.linkedin.com';

export function isLinkedInUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === 'www.linkedin.com';
  } catch {
    return false;
  }
}

/**
 * Normalizes a profile URL to `https://www.linkedin.com/in/<slug>/`.
 * Returns '' when the URL is not a member profile.
 */
export function normalizeProfileUrl(url: string): string {
  if (!url) return '';
  try {
    const u = new URL(url, LINKEDIN_ORIGIN);
    if (!/(^|\.)linkedin\.com$/.test(u.hostname)) return '';
    const m = u.pathname.match(/^\/in\/([^/?#]+)/i);
    if (!m) return '';
    const slug = decodeURIComponent(m[1]).trim();
    if (!slug) return '';
    // Vanity slugs are case-insensitive; URN-style ids (ACoAA…) are case-sensitive.
    const normalizedSlug = /^ACo[A-Za-z0-9_-]{10,}$/.test(slug) ? slug : slug.toLowerCase();
    return `${LINKEDIN_ORIGIN}/in/${encodeURIComponent(normalizedSlug)}/`;
  } catch {
    return '';
  }
}

export function isUrnStyleProfileUrl(url: string): boolean {
  return /\/in\/ACo[A-Za-z0-9_-]{10,}\/?$/.test(url);
}

export function normalizeCompanyUrl(url: string): string {
  try {
    const u = new URL(url, LINKEDIN_ORIGIN);
    const m = u.pathname.match(/^\/(company|school|showcase)\/([^/?#]+)/i);
    return m ? `${LINKEDIN_ORIGIN}/${m[1].toLowerCase()}/${m[2].toLowerCase()}/` : '';
  } catch {
    return '';
  }
}

export function postUrlFromActivityId(activityId: string): string {
  return activityId ? `${LINKEDIN_ORIGIN}/feed/update/urn:li:activity:${activityId}/` : '';
}

/** LinkedIn activity ids embed a millisecond timestamp in their top 41 bits. */
export function dateFromActivityId(activityId: string): Date | null {
  if (!/^\d{16,20}$/.test(activityId)) return null;
  try {
    const ms = Number(BigInt(activityId) >> 22n);
    const d = new Date(ms);
    const year = d.getUTCFullYear();
    return year >= 2010 && year <= 2100 ? d : null;
  } catch {
    return null;
  }
}

/** Parses LinkedIn relative times like "3h", "2d •", "1w", "5mo". */
export function dateFromRelativeTime(text: string, now = new Date()): Date | null {
  const m = text.trim().match(/^(\d+)\s*(s|m|min|h|hr|d|w|mo|yr|y)\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const mult: Record<string, number> = {
    s: 1e3, m: 6e4, min: 6e4, h: 36e5, hr: 36e5, d: 864e5, w: 6048e5, mo: 2592e6, yr: 31536e6, y: 31536e6,
  };
  return new Date(now.getTime() - n * mult[unit]);
}

export function buildContentSearchUrl(query: string): string {
  const params = new URLSearchParams({
    keywords: query,
    datePosted: '"past-week"',
    sortBy: '"date_posted"',
    origin: 'FACETED_SEARCH',
  });
  return `${LINKEDIN_ORIGIN}/search/results/content/?${params.toString()}`;
}
