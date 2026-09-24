// Extracts posts from LinkedIn search results / feed pages. Uses several independent strategies so a
// single class-name change doesn't break discovery; if none of them find posts, the scan fails safely.

import type { RawPost } from '@shared/types';
import { firstLine, jitter, text, waitFor } from './dom';

const URN_RE = /urn:li:(activity|ugcPost|share):(\d{10,})/;

// ── Locate post containers ─────────────────────────────────────────────────────────────────

function byUrnAttributes(): HTMLElement[] {
  const els = [
    ...document.querySelectorAll<HTMLElement>(
      '[data-urn*="urn:li:activity:"], [data-id*="urn:li:activity:"], [data-chameleon-result-urn*="urn:li:activity:"], [data-urn*="urn:li:ugcPost:"], [data-urn*="urn:li:share:"]',
    ),
  ];
  // Keep outermost containers only.
  return els.filter((el) => !els.some((other) => other !== el && other.contains(el)));
}

/** Fallback: climb from each post's social "Like" control to the nearest block holding an author link. */
function bySocialActions(): HTMLElement[] {
  const likes = [...document.querySelectorAll<HTMLElement>('button[aria-label], button')].filter((b) => {
    const l = (b.getAttribute('aria-label') ?? '').trim();
    return /^React Like\b/i.test(l) || /^Like\b/.test(l) || (!l && text(b) === 'Like');
  });
  const out = new Set<HTMLElement>();
  for (const like of likes) {
    let node: HTMLElement | null = like.parentElement;
    for (let depth = 0; node && depth < 14; depth++, node = node.parentElement) {
      const hasAuthor = node.querySelector('a[href*="/in/"], a[href*="/company/"]');
      if (hasAuthor && text(node).length > 80) {
        out.add(node);
        break;
      }
    }
  }
  const arr = [...out];
  return arr.filter((el) => !arr.some((o) => o !== el && o.contains(el)));
}

export function findPostContainers(): HTMLElement[] {
  const primary = byUrnAttributes();
  return primary.length ? primary : bySocialActions();
}

// ── Extract one post ───────────────────────────────────────────────────────────────────────

const ACTOR_SELECTORS = ['.update-components-actor', '.feed-shared-actor', '[data-view-name="feed-actor"]'];
const TEXT_SELECTORS = [
  '.update-components-text',
  '.feed-shared-update-v2__description',
  '.feed-shared-inline-show-more-text',
  '.update-components-update-v2__commentary',
  '[data-view-name="feed-commentary"]',
];
const HEADER_NOISE = /\b(?:reposted|likes? this|commented|celebrates?|loves? this|supports? this|finds? this|insightful|funny|follows?)\b/i;

function findUrn(container: HTMLElement): { kind: string; id: string } | null {
  const attrs = ['data-urn', 'data-id', 'data-chameleon-result-urn'];
  const nodes = [container, ...container.querySelectorAll<HTMLElement>('[data-urn], [data-id], [data-chameleon-result-urn]')];
  for (const n of nodes) {
    for (const a of attrs) {
      const m = n.getAttribute(a)?.match(URN_RE);
      if (m) return { kind: m[1], id: m[2] };
    }
  }
  for (const a of container.querySelectorAll<HTMLAnchorElement>('a[href*="urn:li:"]')) {
    const m = decodeURIComponent(a.href).match(URN_RE);
    if (m) return { kind: m[1], id: m[2] };
  }
  return null;
}

function findActor(container: HTMLElement): { block: HTMLElement | null; link: HTMLAnchorElement | null } {
  for (const sel of ACTOR_SELECTORS) {
    const block = container.querySelector<HTMLElement>(sel);
    const link = block?.querySelector<HTMLAnchorElement>('a[href*="/in/"], a[href*="/company/"]');
    if (block && link) return { block, link };
  }
  // Generic: first profile/company link that isn't part of a "X reposted this" header.
  const links = [...container.querySelectorAll<HTMLAnchorElement>('a[href*="/in/"], a[href*="/company/"]')];
  for (const link of links) {
    const lineText = text(link.closest('div, span') ?? link);
    if (HEADER_NOISE.test(lineText) && lineText.length < 120) continue;
    if (!firstLine(text(link))) continue;
    return { block: link.parentElement as HTMLElement, link };
  }
  return { block: null, link: null };
}

const DEGREE_RE = /(?:^|[•·\s])(1st|2nd|3rd\+?)(?:\s|$)/;
const TIME_RE = /^(\d+\s*(?:s|m|min|h|hr|d|w|mo|yr|y))\b/i;

function cleanName(raw: string): string {
  return firstLine(raw)
    .replace(/\s*[•·]\s*(?:1st|2nd|3rd\+?|Following|Follow).*$/i, '')
    .replace(/\b(?:View|View:)\s.*$/, '')
    .replace(/\s*(?:Verified|Premium)(?:\s+Profile)?\s*$/i, '')
    .trim();
}

function actorDetails(block: HTMLElement | null, link: HTMLAnchorElement) {
  const q = (sel: string) => (block ? text(block.querySelector(sel)?.querySelector('span[aria-hidden="true"]') ?? block.querySelector(sel)) : '');
  let name = q('.update-components-actor__title') || q('.update-components-actor__name') || q('.feed-shared-actor__name');
  let headline = q('.update-components-actor__description') || q('.feed-shared-actor__description');
  let time = q('.update-components-actor__sub-description') || q('.feed-shared-actor__sub-description');
  const lines = text(block ?? link)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (!name) name = cleanName(text(link)) || cleanName(lines[0] ?? '');
  name = cleanName(name);
  if (!headline) {
    headline =
      lines.find((l, i) => i > 0 && l !== name && !DEGREE_RE.test(` ${l} `) && !TIME_RE.test(l) && !/^(?:•|Follow|Following|Promoted)$/i.test(l) && l.length > 3) ?? '';
  }
  if (!time) time = lines.find((l) => TIME_RE.test(l)) ?? '';
  const degree = (text(block ?? link).match(DEGREE_RE)?.[1] ?? '').replace(/\+$/, '+');
  return { name, headline: firstLine(headline), time: time.match(TIME_RE)?.[1] ?? '', degree };
}

function postBody(container: HTMLElement, actorBlock: HTMLElement | null): HTMLElement | null {
  for (const sel of TEXT_SELECTORS) {
    const el = container.querySelector<HTMLElement>(sel);
    if (el && text(el).length > 0) return el;
  }
  // Fallback: the largest dir="ltr" text block that isn't inside the actor block.
  const candidates = [...container.querySelectorAll<HTMLElement>('[dir="ltr"], span.break-words')].filter(
    (el) => !actorBlock?.contains(el),
  );
  return candidates.sort((a, b) => text(b).length - text(a).length)[0] ?? null;
}

function extractPost(container: HTMLElement): RawPost | null {
  const { block, link } = findActor(container);
  if (!link) return null;
  const urn = findUrn(container);
  const body = postBody(container, block);
  const postText = text(body).replace(/…\s*(?:see|show)\s+more\s*$/i, '').trim();
  if (!postText) return null;

  const details = actorDetails(block, link);
  const href = link.href;
  const authorType = /\/in\//.test(href) ? 'person' : /\/company\//.test(href) ? 'company' : 'unknown';

  const mentionedPeople: RawPost['mentionedPeople'] = [];
  const companyLinks: RawPost['companyLinks'] = [];
  for (const a of body?.querySelectorAll<HTMLAnchorElement>('a[href]') ?? []) {
    const name = firstLine(text(a)).replace(/^@/, '');
    if (!name) continue;
    if (/\/in\//.test(a.href)) mentionedPeople.push({ name, url: a.href });
    else if (/\/company\//.test(a.href)) companyLinks.push({ name, url: a.href });
  }

  const postPath = urn ? `/feed/update/urn:li:${urn.kind}:${urn.id}/` : '';
  const fallbackLink = container.querySelector<HTMLAnchorElement>('a[href*="/feed/update/"], a[href*="/posts/"]');
  return {
    postUrl: postPath ? `https://www.linkedin.com${postPath}` : fallbackLink?.href.split('?')[0] ?? '',
    activityId: urn?.kind === 'activity' ? urn.id : '',
    authorName: details.name,
    authorUrl: href.split('?')[0],
    authorType,
    authorHeadline: details.headline,
    authorDegree: details.degree,
    relativeTime: details.time,
    postText: postText.slice(0, 5000),
    companyLinks,
    mentionedPeople,
  };
}

// ── Public scan ────────────────────────────────────────────────────────────────────────────

export async function scanPosts(
  maxPosts: number,
  scroll: boolean,
  onProgress: (found: number) => void,
): Promise<{ posts: RawPost[]; truncated: boolean } | null> {
  const appeared = await waitFor(() => findPostContainers().length > 0, 15000, 400);
  if (!appeared) {
    // An empty result page is valid; an unrecognizable page is not.
    const emptyState = /no results found|try removing filters|no matching/i.test(text(document.querySelector('main')));
    return emptyState ? { posts: [], truncated: false } : null;
  }

  const seen = new Map<string, RawPost>();
  const collect = () => {
    for (const c of findPostContainers()) {
      const post = extractPost(c);
      if (!post) continue;
      const key = post.postUrl || `${post.authorUrl}|${post.postText.slice(0, 80)}`;
      if (!seen.has(key)) seen.set(key, post);
    }
  };

  collect();
  onProgress(seen.size);
  let stale = 0;
  while (scroll && seen.size < maxPosts && stale < 3) {
    const before = seen.size;
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
    await jitter(1800, 3200); // human-paced; lets LinkedIn lazy-load the next batch
    collect();
    onProgress(seen.size);
    stale = seen.size === before ? stale + 1 : 0;
  }
  const posts = [...seen.values()].slice(0, maxPosts);
  return { posts, truncated: seen.size > maxPosts };
}
