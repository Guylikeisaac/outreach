// Visible "agent cursor": a drawn pointer that glides to each element before SyncUp clicks it,
// with a click ripple, so the user can watch every step (Chrome extensions can't move the real
// mouse pointer). Also provides human-paced typing for the note field.

import { sleep } from './dom';

const HOST_ID = 'syncup-agent-cursor';
let host: HTMLDivElement | null = null;
let pointer: HTMLDivElement | null = null;
let badge: HTMLDivElement | null = null;
let pos = { x: window.innerWidth - 80, y: 120 };

function ensureCursor() {
  if (host?.isConnected && pointer) return;
  host = document.createElement('div');
  host.id = HOST_ID;
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      .ptr { position: fixed; left: 0; top: 0; z-index: 2147483647; pointer-events: none;
        transition: transform .75s cubic-bezier(.22,.8,.3,1); will-change: transform; }
      .ptr svg { width: 26px; height: 26px; filter: drop-shadow(0 3px 6px rgba(0,0,0,.45)); }
      .tag { position: absolute; left: 20px; top: 22px; white-space: nowrap; font: 600 11px/1 -apple-system, "Inter", sans-serif;
        letter-spacing: .06em; color: #0b0b0c; background: linear-gradient(180deg,#ecd39e,#d4af6a); padding: 5px 8px; border-radius: 999px;
        box-shadow: 0 4px 14px rgba(0,0,0,.35); }
      .ripple { position: fixed; z-index: 2147483646; pointer-events: none; width: 14px; height: 14px; margin: -7px 0 0 -7px;
        border-radius: 50%; border: 2px solid #d4af6a; animation: rip .55s ease-out forwards; }
      @keyframes rip { from { transform: scale(.4); opacity: 1; } to { transform: scale(3.2); opacity: 0; } }
    </style>
    <div class="ptr">
      <svg viewBox="0 0 24 24"><path d="M3 2l7.5 19 2.4-7.7L21 11 3 2z" fill="#0b0b0c" stroke="#ecd39e" stroke-width="1.6" stroke-linejoin="round"/></svg>
      <div class="tag">SyncUp</div>
    </div>`;
  pointer = root.querySelector('.ptr');
  badge = root.querySelector('.tag');
  (host as unknown as { __root: ShadowRoot }).__root = root;
  document.documentElement.appendChild(host);
  pointer!.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
}

export function setCursorLabel(label: string) {
  ensureCursor();
  if (badge) badge.textContent = label ? `SyncUp · ${label}` : 'SyncUp';
}

export function hideCursor() {
  host?.remove();
  host = null;
  pointer = null;
}

function ripple(x: number, y: number) {
  const root = (host as unknown as { __root?: ShadowRoot })?.__root;
  if (!root) return;
  const r = document.createElement('div');
  r.className = 'ripple';
  r.style.left = `${x}px`;
  r.style.top = `${y}px`;
  root.appendChild(r);
  setTimeout(() => r.remove(), 600);
}

/** Glides the agent cursor to the element's centre. */
export async function moveTo(el: Element) {
  ensureCursor();
  el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
  await sleep(350);
  const r = el.getBoundingClientRect();
  pos = { x: r.left + Math.min(r.width / 2, r.width - 6), y: r.top + r.height / 2 };
  pointer!.style.transform = `translate(${pos.x - 3}px, ${pos.y - 2}px)`;
  await sleep(780);
}

/** Moves the cursor to the element, shows a click ripple, then clicks it. */
export async function agentClick(el: HTMLElement, label = '') {
  if (label) setCursorLabel(label);
  await moveTo(el);
  ripple(pos.x, pos.y);
  await sleep(160);
  el.click();
  await sleep(250);
}

/** Types text in visible chunks; `write` receives the text so far and must apply it to the field. */
export async function typeVisibly(full: string, write: (soFar: string) => void | Promise<void>) {
  const chars = [...full]; // keep emoji intact
  const step = Math.max(2, Math.ceil(chars.length / 90)); // ~90 steps, ~2–3 s total
  for (let i = step; i < chars.length + step; i += step) {
    await write(chars.slice(0, Math.min(i, chars.length)).join(''));
    await sleep(18 + Math.random() * 22);
  }
}
