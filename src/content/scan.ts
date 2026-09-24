// Extracts posts from LinkedIn search results / feed pages.
//
// LinkedIn ships different markups (legacy `data-urn` + BEM classes, and a newer obfuscated/SDUI
// markup with neither). So container detection is anchored on what every post visibly has — its
// Like / Comment / Repost action bar — and fields are parsed from visible text lines. Class-based
// selectors are only used as a bonus when present. If nothing matches, the scan fails safely and
// returns a structure summary for debugging.

import type { RawPost } from '@shared/types';
import { firstLine, isVisible, jitter, text, waitFor } from './dom';

const URN_RE = /urn(?::|%3A)li(?::|%3A)(activity|ugcPost|share)(?::|%3A)(\d{15,})/i;
const AUTHOR_LINK = 'a[href*="/in/"], a[href*="/company/"], a[href*="/school/"], a[href*="/showcase/"]';

// ── Locate post containers ─────────────────────────────────────────────────────────────────

/** Short visible label of a control: aria-label, else its own text. */
function controlLabel(el: Element): string {
  return (el.getAttribute('aria-label') || text(el)).replace(/\s+/g, ' ').trim();
}

/** The post's "Like" control (a reaction button), in any markup variant. */
function isLikeControl(el: HTMLElement): boolean {
  const own = firstLine(text(el));
  const aria = el.getAttribute('aria-label') ?? '';
  return (
    own === 'Like' ||
    /^React Like\b/i.test(aria) ||
    /^Like\b/.test(aria) ||
    /^Reaction button state/i.test(aria) ||
    /^(?:Like|Celebrate|Support|Love|Insightful|Funny)$/.test(own) && /reaction|react/i.test(aria)
  );
}

function likeControls(root: ParentNode = document): HTMLElement[] {
  const found = [...root.querySelectorAll<HTMLElement>('button, [role="button"]')].filter((b) => isLikeControl(b) && isVisible(b));
  // Nested matches (button > span[role=button]) → keep the outermost.
  return found.filter((el) => !found.some((o) => o !== el && o.contains(el)));
}

/** Other action-bar controls; used to confirm a like control really belongs to a post. */
function hasSiblingActions(node: HTMLElement): boolean {
  return [...node.querySelectorAll<HTMLElement>('button, [role="button"]')].some((b) => /^(?:Comment|Repost|Send)$/i.test(firstLine(text(b))) || /^(?:Comment|Repost|Send in a private message)\b/i.test(b.getAttribute('aria-label') ?? ''));
}

function byUrnAttributes(): HTMLElement[] {
  const els = [
    ...document.querySelectorAll<HTMLElement>(
      '[data-urn*="urn:li:activity:"], [data-id*="urn:li:activity:"], [data-chameleon-result-urn*="urn:li:activity:"], [data-urn*="urn:li:ugcPost:"], [data-urn*="urn:li:share:"]',
    ),
  ];
  return els.filter((el) => !els.some((other) => other !== el && other.contains(el)) && likeControls(el).length <= 1);
}

/**
 * Each post = the largest ancestor of its Like control that contains exactly one Like control
 * (i.e. it grows until it would swallow the neighbouring post), and that has an author link.
 */
function byActionBar(): HTMLElement[] {
  const likes = likeControls();
  const out = new Set<HTMLElement>();
  const main = document.querySelector('main') ?? document.body;
  for (const like of likes) {
    let best: HTMLElement | null = null;
    let node: HTMLElement | null = like.parentElement;
    for (let depth = 0; node && node !== main && node !== document.body && depth < 25; depth++, node = node.parentElement) {
      if (likeControls(node).length > 1) break;
      best = node;
    }
    if (best && best.querySelector(AUTHOR_LINK) && hasSiblingActions(best)) out.add(best);
  }
  const arr = [...out];
  return arr.filter((el) => !arr.some((o) => o !== el && o.contains(el)));
}

export function findPostContainers(): HTMLElement[] {
  const primary = byUrnAttributes();
  return primary.length ? primary : byActionBar();
}

// ── Extract one post ───────────────────────────────────────────────────────────────────────

const ACTOR_SELECTORS = ['.update-components-actor', '.feed-shared-actor'];
const TEXT_SELECTORS = [
  '.update-components-text',
  '.feed-shared-update-v2__description',
  '.feed-shared-inline-show-more-text',
  '.update-components-update-v2__commentary',
];
const HEADER_NOISE = /\b(?:reposted|likes? this|commented on this|celebrates? this|loves? this|supports? this|finds? this|reacted)\b/i;
const DEGREE_RE = /(?:^|[•·\s])(1st|2nd|3rd\+?)(?=\s|$)/;
const TIME_RE = /^(\d+\s*(?:s|m|min|h|hr|d|w|mo|yr|y))(?:\s|•|·|$)/i;
const NOISE_LINE = /^(?:•|·|Follow|Following|\+\s*Follow|Promoted|Verified|Premium|Edited|Visible to anyone.*|View .* profile|Show translation|See translation)$/i;

function findUrn(container: HTMLElement): { kind: string; id: string } | null {
  // Any attribute on the container, its descendants, or its close ancestors may carry the URN.
  const nodes: Element[] = [container, ...container.querySelectorAll('*')];
  let anc = container.parentElement;
  for (let i = 0; anc && i < 4; i++, anc = anc.parentElement) nodes.push(anc);
  for (const n of nodes) {
    for (const attr of n.attributes) {
      if (!attr.value.includes('urn') ) continue;
      const m = attr.value.match(URN_RE);
      if (m) return { kind: m[1].replace(/^ugcpost$/i, 'ugcPost'), id: m[2] };
    }
  }
  return null;
}

function actorLink(container: HTMLElement): { link: HTMLAnchorElement; block: HTMLElement | null } | null {
  for (const sel of ACTOR_SELECTORS) {
    const block = container.querySelector<HTMLElement>(sel);
    const link = block?.querySelector<HTMLAnchorElement>(AUTHOR_LINK);
    if (block && link) return { link, block };
  }
  // Generic: the first author link with a visible name, skipping "X reposted/likes this" headers.
  for (const link of container.querySelectorAll<HTMLAnchorElement>(AUTHOR_LINK)) {
    const name = firstLine(text(link));
    if (!name || name.length < 2) continue;
    const row = text(link.parentElement?.parentElement ?? link);
    if (HEADER_NOISE.test(row) && row.length < 160) continue;
    return { link, block: null };
  }
  return null;
}

function cleanName(raw: string): string {
  return firstLine(raw)
    .replace(DEGREE_RE, ' ')
    .replace(/\s*[•·].*$/, '')
    .replace(/\s*(?:Verified|Premium)(?:\s+(?:Profile|Member))?.*$/i, '')
    .replace(/^View\s+/i, '')
    .replace(/[’']s\s+(?:profile|graphic link)$/i, '')
    .trim();
}

function lines(el: Element): string[] {
  return text(el)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Parses "Name • 3rd+ / Headline / 40m • Edited" from the post's visible lines. */
function parseHeader(container: HTMLElement, link: HTMLAnchorElement, block: HTMLElement | null) {
  const pick = (sel: string) => {
    const el = block?.querySelector(sel);
    return el ? text(el.querySelector('span[aria-hidden="true"]') ?? el) : '';
  };
  let name = cleanName(pick('.update-components-actor__title') || pick('.update-components-actor__name'));
  let headline = firstLine(pick('.update-components-actor__description'));
  let time = pick('.update-components-actor__sub-description');

  const all = lines(container);
  if (!name) {
    // The link's own text is usually the name (possibly followed by degree/headline lines).
    name = cleanName(text(link)) || cleanName(link.getAttribute('aria-label') ?? '');
  }
  const start = Math.max(0, all.findIndex((l) => name && l.startsWith(name)));
  const header = all.slice(start, start + 8);
  const degree = header.join(' ').match(DEGREE_RE)?.[1] ?? '';
  if (!time) time = header.find((l) => TIME_RE.test(l)) ?? '';
  if (!headline) {
    headline =
      header.find(
        (l, i) =>
          i > 0 &&
          !l.startsWith(name) &&
          !TIME_RE.test(l) &&
          !NOISE_LINE.test(l) &&
          !/^\+?\s*Follow(?:ing)?\b/i.test(l) &&
          !/^[•·]?\s*(?:1st|2nd|3rd\+?)$/.test(l) &&
          !/^\d[\d,.]*\s+followers?$/i.test(l) &&
          l.length > 2,
      ) ?? '';
    // Company pages show a follower count instead of a headline.
    if (!headline) headline = header.find((l) => /followers?$/i.test(l)) ?? '';
  }
  return { name, headline, time: time.match(TIME_RE)?.[1] ?? '', degree, headerLineCount: start + 8 };
}

/** Post body: known commentary selectors, else the longest text block outside header and action bar. */
function postBody(container: HTMLElement, link: HTMLAnchorElement): HTMLElement | null {
  for (const sel of TEXT_SELECTORS) {
    const el = container.querySelector<HTMLElement>(sel);
    if (el && (el.textContent ?? '').trim()) return el;
  }
  const likes = likeControls(container);
  let best: HTMLElement | null = null;
  let bestLen = 0;
  for (const el of container.querySelectorAll<HTMLElement>('div, span, p')) {
    if (el.contains(link) || likes.some((l) => el.contains(l)) || el.querySelector('button, [role="button"]:not(a)') && el.querySelectorAll('button').length > 1) continue;
    const len = (el.textContent ?? '').trim().length;
    // Prefer the deepest element among equally long ones (no wrapper noise).
    if (len > bestLen || (len === bestLen && (best as HTMLElement | null)?.contains(el))) {
      best = el;
      bestLen = len;
    }
  }
  return bestLen >= 20 ? best : null;
}

function bodyText(el: HTMLElement | null): string {
  if (!el) return '';
  // textContent includes text hidden by line-clamping; innerText keeps line breaks. Use whichever is longer.
  const inner = text(el);
  const content = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  const raw = content.length > inner.replace(/\s+/g, ' ').length + 20 ? content : inner;
  return raw
    .replace(/(?:…|\.\.\.)\s*(?:see|show)?\s*more\s*$/i, '')
    .replace(/\s*(?:Show|See) translation\s*$/i, '')
    .trim();
}

function extractPost(container: HTMLElement): RawPost | null {
  const actor = actorLink(container);
  if (!actor) return null;
  const { link, block } = actor;
  const header = parseHeader(container, link, block);
  if (!header.name) return null;

  const body = postBody(container, link);
  const postText = bodyText(body);
  if (!postText) return null;

  const href = link.href.split('?')[0];
  const authorType = /\/in\//.test(href) ? 'person' : /\/(?:company|school|showcase)\//.test(href) ? 'company' : 'unknown';

  const mentionedPeople: RawPost['mentionedPeople'] = [];
  const companyLinks: RawPost['companyLinks'] = [];
  for (const a of body?.querySelectorAll<HTMLAnchorElement>('a[href]') ?? []) {
    const name = firstLine(text(a)).replace(/^@/, '');
    if (!name) continue;
    if (/\/in\//.test(a.href)) mentionedPeople.push({ name, url: a.href });
    else if (/\/company\//.test(a.href)) companyLinks.push({ name, url: a.href });
  }

  const urn = findUrn(container);
  const fallbackLink = container.querySelector<HTMLAnchorElement>('a[href*="/feed/update/"], a[href*="/posts/"]');
  return {
    postUrl: urn ? `https://www.linkedin.com/feed/update/urn:li:${urn.kind}:${urn.id}/` : fallbackLink?.href.split('?')[0] ?? '',
    activityId: urn?.kind === 'activity' ? urn.id : '',
    authorName: header.name,
    authorUrl: href,
    authorType,
    authorHeadline: header.headline,
    authorDegree: header.degree,
    relativeTime: header.time,
    postText: postText.slice(0, 5000),
    companyLinks,
    mentionedPeople,
  };
}

// ── Diagnostics ────────────────────────────────────────────────────────────────────────────

/** Compact, content-light description of the page structure, for fixing selectors. */
export function scanDiagnostics(): string {
  const describe = (el: Element) => {
    const attrs = [...el.attributes]
      .filter((a) => a.name !== 'style')
      .map((a) => `${a.name}${a.value && a.value.length < 60 ? `="${a.value}"` : ''}`)
      .join(' ');
    return `<${el.tagName.toLowerCase()} ${attrs}>`;
  };
  const likeish = [...document.querySelectorAll<HTMLElement>('button, [role="button"]')].filter((b) => /\blike\b|react/i.test(controlLabel(b))).slice(0, 3);
  const out = [
    `url: ${location.pathname}${location.search.slice(0, 80)}`,
    `main: ${!!document.querySelector('main')}, data-urn: ${document.querySelectorAll('[data-urn]').length}, data-id: ${document.querySelectorAll('[data-id]').length}, role=article: ${document.querySelectorAll('[role="article"]').length}, role=listitem: ${document.querySelectorAll('[role="listitem"]').length}`,
    `buttons: ${document.querySelectorAll('button').length}, like controls: ${likeControls().length}, /in/ links: ${document.querySelectorAll('a[href*="/in/"]').length}, /company/ links: ${document.querySelectorAll('a[href*="/company/"]').length}`,
    `containers found: ${findPostContainers().length}`,
  ];
  likeish.forEach((b, i) => {
    out.push(`like-ish #${i}: label="${controlLabel(b).slice(0, 60)}"`);
    let n: Element | null = b;
    for (let d = 0; n && d < 14; d++, n = n.parentElement) out.push(`  ${'  '.repeat(Math.min(d, 6))}${describe(n).slice(0, 180)}`);
  });
  return out.join('\n');
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
    const emptyState = /no results found|try removing filters|no matching/i.test(text(document.querySelector('main') ?? document.body));
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
  // Containers were found but none could be parsed → treat as a structure problem, not "no posts".
  if (seen.size === 0) return null;
  const posts = [...seen.values()].slice(0, maxPosts);
  return { posts, truncated: seen.size > maxPosts };
}
