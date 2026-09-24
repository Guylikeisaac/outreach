// Extracts posts from LinkedIn search results / feed pages.
//
// LinkedIn ships different markups (legacy `data-urn` + BEM classes, and a newer obfuscated/SDUI
// markup with neither). So container detection is anchored on what every post visibly has — its
// Like / Comment / Repost action bar — and fields are parsed from visible text lines. Class-based
// selectors are only used as a bonus when present. If nothing matches, the scan fails safely and
// returns a structure summary for debugging.

import type { RawPost } from '@shared/types';
import { firstLine, isVisible, jitter, sleep, text, waitFor } from './dom';

const URN_RE = /urn(?::|%3A)li(?::|%3A)(activity|ugcPost|share)(?::|%3A)(\d{15,})/i;
const AUTHOR_LINK = 'a[href*="/in/"], a[href*="/company/"], a[href*="/school/"], a[href*="/showcase/"]';

// ── Locate post containers ─────────────────────────────────────────────────────────────────

/** Short visible label of a control: aria-label, else its own text. */
function controlLabel(el: Element): string {
  return (el.getAttribute('aria-label') || text(el)).replace(/\s+/g, ' ').trim();
}

const CLICKABLE = 'button, [role="button"], a, [tabindex]';

/**
 * Elements whose own visible text is exactly `word` (e.g. "Like"), whatever their tag — LinkedIn's
 * newer markup renders action-bar controls as plain div/span elements, not <button>s.
 * Returns the nearest clickable ancestor when there is one, else the text's parent element.
 */
function elementsLabelled(words: RegExp, root: Node = document.body): HTMLElement[] {
  const out = new Set<HTMLElement>();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n.nodeValue?.trim();
    if (!t || t.length > 12 || !words.test(t)) continue;
    const parent = n.parentElement;
    if (!parent) continue;
    const control = (parent.closest(CLICKABLE) as HTMLElement | null) ?? parent;
    if (isVisible(control)) out.add(control);
  }
  // Also accept aria-labelled reaction buttons whose visible text isn't "Like".
  if (root instanceof Element || root === document.body) {
    for (const b of (root as Element).querySelectorAll<HTMLElement>('[aria-label]')) {
      const aria = b.getAttribute('aria-label') ?? '';
      if (words.source.includes('Like') && /^(?:React Like|Reaction button state|Like)\b/i.test(aria) && isVisible(b)) out.add(b);
    }
  }
  const arr = [...out];
  return arr.filter((el) => !arr.some((o) => o !== el && o.contains(el)));
}

const LIKE_WORD = /^Like$/;
const OTHER_ACTION_WORD = /^(?:Comment|Repost|Send)$/;

function likeControls(root: Node = document.body): HTMLElement[] {
  return elementsLabelled(LIKE_WORD, root);
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
 * (it grows until it would swallow the neighbouring post), has an author link, and has the other
 * action-bar controls (Comment / Repost / Send).
 */
function byActionBar(): HTMLElement[] {
  const likes = likeControls();
  const others = elementsLabelled(OTHER_ACTION_WORD);
  const out = new Set<HTMLElement>();
  for (const like of likes) {
    let best: HTMLElement | null = null;
    for (let node = like.parentElement, depth = 0; node && node !== document.body && depth < 30; node = node.parentElement, depth++) {
      if (likes.some((l) => l !== like && node!.contains(l))) break;
      best = node;
    }
    if (best && best.querySelector(AUTHOR_LINK) && others.some((o) => best!.contains(o))) out.add(best);
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
  const likeish = likeControls().slice(0, 2);
  const shadowHosts = [...document.querySelectorAll('*')].filter((e) => e.shadowRoot).length;
  const likeTextNodes = (() => {
    let n = 0;
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let t = w.nextNode(); t; t = w.nextNode()) if (t.nodeValue?.trim() === 'Like') n++;
    return n;
  })();
  const out = [
    `url: ${location.pathname}${location.search.slice(0, 80)}`,
    `main: ${!!document.querySelector('main')}, iframes: ${document.querySelectorAll('iframe').length}, shadow hosts: ${shadowHosts}, data-urn: ${document.querySelectorAll('[data-urn]').length}, role=listitem: ${document.querySelectorAll('[role="listitem"]').length}`,
    `buttons: ${document.querySelectorAll('button').length}, "Like" text nodes: ${likeTextNodes}, like controls: ${likeControls().length}, other actions: ${elementsLabelled(OTHER_ACTION_WORD).length}`,
    `/in/ links: ${document.querySelectorAll('a[href*="/in/"]').length}, /company/ links: ${document.querySelectorAll('a[href*="/company/"]').length}, all links: ${document.querySelectorAll('a[href]').length}`,
    `containers found: ${findPostContainers().length}`,
    `sample hrefs: ${[...document.querySelectorAll<HTMLAnchorElement>('main a[href], a[href]')].slice(0, 400).map((a) => a.getAttribute('href') ?? '').filter((h) => /linkedin|^\//.test(h)).map((h) => h.replace(/\?.*$/, '').replace(/(\/(?:in|company)\/)[^/]+/, '$1…')).filter((h, i, all) => all.indexOf(h) === i).slice(0, 12).join(' ')}`,
  ];
  likeish.forEach((b, i) => {
    out.push(`like-ish #${i}: label="${controlLabel(b).slice(0, 60)}"`);
    let n: Element | null = b;
    for (let d = 0; n && d < 14; d++, n = n.parentElement) out.push(`  ${'  '.repeat(Math.min(d, 6))}${describe(n).slice(0, 180)}`);
  });
  return out.join('\n');
}

// ── Scrolling / expansion ──────────────────────────────────────────────────────────────────

/** Clicks the post's own "… more" text expander (never links or action buttons). Returns true if clicked. */
function expandTruncatedText(container: HTMLElement): boolean {
  const likes = likeControls(container);
  for (const el of container.querySelectorAll<HTMLElement>('button, [role="button"], span, div')) {
    const t = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!/^(?:…|\.\.\.)?\s*(?:see |show )?more$/i.test(t)) continue;
    if (el.closest('a[href]') || likes.some((l) => l.contains(el) || el.contains(l))) continue;
    const target = (el.closest('button, [role="button"]') as HTMLElement | null) ?? el;
    if (!isVisible(target)) continue;
    target.click();
    return true;
  }
  return false;
}

function scrollableAncestor(el: HTMLElement): HTMLElement | null {
  for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
    const s = getComputedStyle(n);
    if (/(auto|scroll)/.test(s.overflowY) && n.scrollHeight > n.clientHeight + 20) return n;
  }
  return null;
}

/** Brings the next batch of results in: scroll the last post into view (window or inner scroller), or press "Show more results". */
function loadMore() {
  const posts = findPostContainers();
  const last = posts[posts.length - 1];
  if (last) {
    last.scrollIntoView({ behavior: 'smooth', block: 'end' });
    const scroller = scrollableAncestor(last);
    scroller?.scrollBy({ top: scroller.clientHeight * 0.9, behavior: 'smooth' });
  }
  window.scrollBy({ top: window.innerHeight * 0.9, behavior: 'smooth' });
  const more = [...document.querySelectorAll<HTMLElement>('button, [role="button"]')].find(
    (b) => isVisible(b) && /^(?:Show|See|Load) more results$/i.test((b.textContent ?? '').trim()),
  );
  more?.click();
}

// ── Public scan ────────────────────────────────────────────────────────────────────────────

export async function scanPosts(
  maxPosts: number,
  scroll: boolean,
  onProgress: (found: number) => void,
): Promise<{ posts: RawPost[]; truncated: boolean } | null> {
  // Always start reading from the top of the results.
  window.scrollTo({ top: 0 });
  const appeared = await waitFor(() => findPostContainers().length > 0, 15000, 400);
  if (!appeared) {
    // A genuinely empty result page is valid (LinkedIn shows a visible "No results found" heading);
    // anything else means we couldn't recognise the posts → fail with diagnostics, never silently.
    const emptyState = [...document.querySelectorAll<HTMLElement>('h1, h2, h3, p, span')].some(
      (el) => isVisible(el) && /^No results found\.?$/i.test((el.textContent ?? '').trim()),
    );
    return emptyState ? { posts: [], truncated: false } : null;
  }

  const seen = new Map<string, RawPost>();
  const expanded = new WeakSet<HTMLElement>();
  const collect = async () => {
    for (const c of findPostContainers()) {
      if (!expanded.has(c)) {
        expanded.add(c);
        if (expandTruncatedText(c)) await sleep(250);
      }
      const post = extractPost(c);
      if (!post) continue;
      const key = post.postUrl || `${post.authorUrl}|${post.postText.slice(0, 80)}`;
      // Keep the longest version (text may have been expanded after the first read).
      const prev = seen.get(key);
      if (!prev || post.postText.length > prev.postText.length) seen.set(key, post);
    }
  };

  await collect();
  onProgress(seen.size);
  let stale = 0;
  while (scroll && seen.size < maxPosts && stale < 3) {
    const before = seen.size;
    loadMore();
    await jitter(1800, 3200); // human-paced; lets LinkedIn lazy-load the next batch
    await collect();
    onProgress(seen.size);
    stale = seen.size === before ? stale + 1 : 0;
  }
  // Containers were found but none could be parsed → treat as a structure problem, not "no posts".
  if (seen.size === 0) return null;
  const posts = [...seen.values()].slice(0, maxPosts);
  return { posts, truncated: seen.size > maxPosts };
}
