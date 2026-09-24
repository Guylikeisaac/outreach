// DOM helpers for LinkedIn. No coordinate clicking — elements are located by role, aria-label,
// link target, or exact visible text, and clicked via element.click().

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const jitter = (min: number, max: number) => sleep(min + Math.random() * (max - min));

export function text(el: Element | null | undefined): string {
  if (!el) return '';
  return ((el as HTMLElement).innerText ?? el.textContent ?? '').replace(/ /g, ' ').trim();
}

export function firstLine(s: string): string {
  return s.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
}

export function label(el: Element): string {
  return (el.getAttribute('aria-label') || text(el)).replace(/\s+/g, ' ').trim();
}

export function isVisible(el: Element): boolean {
  const h = el as HTMLElement;
  if (!h.isConnected) return false;
  const style = getComputedStyle(h);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  const r = h.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

export function isEnabled(el: Element): boolean {
  return !(el as HTMLButtonElement).disabled && el.getAttribute('aria-disabled') !== 'true';
}

/** Polls until `fn` returns a truthy value or the timeout elapses. */
export async function waitFor<T>(fn: () => T | null | undefined | false, timeoutMs = 8000, interval = 200): Promise<T | null> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const v = fn();
      if (v) return v;
    } catch {
      /* keep polling */
    }
    await sleep(interval);
  }
  return null;
}

export function clickables(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('button, [role="button"], a[role="button"], [role="menuitem"]')];
}

export function findClickable(root: ParentNode, match: (label: string, el: HTMLElement) => boolean): HTMLElement | null {
  return clickables(root).find((el) => isVisible(el) && match(label(el), el)) ?? null;
}

/** Sets a value on a framework-controlled textarea/input so the page's own state sees it. */
export function setNativeValue(el: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  el.focus();
  setter ? setter.call(el, value) : (el.value = value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

export function normalizeName(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Loose identity check: first and last name tokens of the expected name appear in the page name. */
export function namesMatch(expected: string, actual: string): boolean {
  const e = normalizeName(expected).split(' ').filter((t) => t.length > 1);
  const a = normalizeName(actual);
  if (!e.length || !a) return false;
  const first = e[0];
  const last = e.length > 1 ? e[e.length - 1] : '';
  return a.includes(first) && (!last || a.includes(last));
}

export type PageKind = 'search' | 'feed' | 'profile' | 'post' | 'auth' | 'checkpoint' | 'other';

export function pageKind(): PageKind {
  const p = location.pathname;
  if (/^\/(?:login|authwall|signup|uas\/login)/.test(p)) return 'auth';
  if (/^\/checkpoint\//.test(p) || document.querySelector('iframe[src*="captcha"], #captcha-internal')) return 'checkpoint';
  if (p.startsWith('/search/results/')) return 'search';
  if (p.startsWith('/feed/update/') || p.startsWith('/posts/')) return 'post';
  if (p.startsWith('/feed')) return 'feed';
  if (p.startsWith('/in/')) return 'profile';
  return 'other';
}
