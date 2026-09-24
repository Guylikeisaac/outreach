// Profile-page logic: identify the person, detect connection status, and connect with a note.
//
// Works on both LinkedIn profile layouts:
//  - legacy: <h1> name inside a top-card <section> with Connect/Message/More buttons
//  - new:    no <h1>; the name comes from the page title ("Sreeja M | LinkedIn") and the top card is
//            located from the profile action buttons (Follow <name> / More / Message / Connect).
// Every search is scoped to the top card so "People also viewed" / post buttons are never used, and
// the More-menu items are identified as the controls that *appear* after opening that menu.

import type { ConnectionStatus } from '@shared/types';
import type { DetectResponse, PrepareResponse } from '@shared/messages';
import { PAGE_STRUCTURE_ERROR } from '@shared/messages';
import { normalizeProfileUrl } from '@shared/linkedin';
import { clickables, findClickable, firstLine, isEnabled, isVisible, jitter, label, namesMatch, pageKind, sleep, text, waitFor } from './dom';
import { agentClick, moveTo, setCursorLabel, typeVisibly } from './cursor';

export interface TopCard {
  root: HTMLElement;
  /** The tight cluster of profile action buttons (Connect / Message / Follow / More). */
  actions: HTMLElement;
  name: string;
  headline: string;
}

/** Controls that only exist inside posts / feeds — a top card never contains these. */
const POST_CONTROL = /^(?:Reaction button state|React Like|Like|Comment|Repost|Open control menu for post)/i;
const MORE_LABEL = /^(?:More|More actions)$/i;

function isProfileAction(l: string, name: string): boolean {
  if (MORE_LABEL.test(l) || /^(?:Message|Connect|Follow|Following|Pending)$/i.test(l)) return true;
  if (/^Invite .+ to connect$/i.test(l) || /^Pending\b/i.test(l)) return true;
  if (name && /^(?:Follow|Unfollow|Message)\s+/i.test(l) && namesMatch(name, l.replace(/^(?:Follow|Unfollow|Message)\s+/i, ''))) return true;
  return false;
}

/** Profile owner's name: <h1> in the legacy layout, otherwise the document title. */
function profileName(): string {
  const h1 = document.querySelector('main h1');
  if (h1 && firstLine(text(h1))) return firstLine(text(h1));
  const m = document.title.match(/^(?:\(\d+\+?\)\s*)?(.+?)\s*\|\s*LinkedIn/i);
  return m ? m[1].trim() : '';
}

export function findTopCard(): TopCard | null {
  const main = document.querySelector('main');
  if (!main) return null;
  const name = profileName();
  if (!name) return null;

  // First profile action button in document order (before any post content).
  const anchor = clickables(main).find((b) => isVisible(b) && isProfileAction(label(b), name));
  if (!anchor) return null;

  // Grow from the action buttons to the largest block that still contains no post controls.
  let root: HTMLElement | null = null;
  for (let node = anchor.parentElement; node && node !== main; node = node.parentElement) {
    if (clickables(node).some((b) => POST_CONTROL.test(label(b)))) break;
    if (node.querySelector('aside')) break;
    root = node;
  }
  if (!root) return null;

  // Action cluster: the ancestor of the first action (within a few levels) holding the most actions.
  let actions: HTMLElement = anchor.parentElement ?? root;
  let bestCount = 0;
  for (let node = anchor.parentElement, i = 0; node && i < 5 && root.contains(node); node = node.parentElement, i++) {
    const count = clickables(node).filter((b) => isVisible(b) && isProfileAction(label(b), name)).length;
    if (count > bestCount) {
      bestCount = count;
      actions = node;
    }
  }

  const nameLine = text(root)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const idx = nameLine.findIndex((l) => namesMatch(name, l));
  const headline =
    text(root.querySelector('.text-body-medium')) ||
    nameLine.find(
      (l, i) => i > idx && idx >= 0 && l.length > 12 && !/^(?:·|•|\d|he\/|she\/|they\/|Contact info|followers|connections)/i.test(l) && !namesMatch(name, l),
    ) ||
    '';
  return { root, actions, name, headline: firstLine(headline) };
}

function canonicalUrl(): string {
  const canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href;
  return normalizeProfileUrl(canonical || location.href);
}

// ── More menu ──────────────────────────────────────────────────────────────────────────────

const MENU_ITEM_SELECTOR = 'button, [role="button"], [role="menuitem"], [role="option"], a, li, [tabindex]';

function visibleMenuItems(): Set<HTMLElement> {
  return new Set([...document.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR)].filter(isVisible));
}

interface OpenMenu {
  more: HTMLElement;
  items: HTMLElement[];
}

/** Opens the top card's More menu; returns only the items that appeared because of it. */
async function openMoreMenu(root: HTMLElement): Promise<OpenMenu | null> {
  const more = findClickable(root, (l) => MORE_LABEL.test(l));
  if (!more) return null;
  const before = visibleMenuItems();
  await agentClick(more, 'More');
  const items = await waitFor(() => {
    const fresh = [...visibleMenuItems()].filter((el) => !before.has(el) && label(el));
    return fresh.length ? fresh : null;
  }, 4000);
  if (!items) return null;
  await sleep(250); // let the whole menu render
  const all = [...visibleMenuItems()].filter((el) => !before.has(el) && label(el));
  // Innermost labelled items only (li > div[role=button] → keep the div).
  return { more, items: all.filter((el) => !all.some((o) => o !== el && el.contains(o) && label(o) === label(el))) };
}

async function closeMenu(menu: OpenMenu) {
  if (menu.items.some((i) => i.isConnected && isVisible(i))) {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
    await sleep(200);
    if (menu.items.some((i) => i.isConnected && isVisible(i))) menu.more.click();
  }
  await sleep(250);
}

// ── Connection status ──────────────────────────────────────────────────────────────────────

interface StatusRead {
  status: ConnectionStatus;
  via: string;
  connectEl?: HTMLElement;
  menu?: OpenMenu;
}

function isConnectLabel(l: string, expectedName: string): boolean {
  const m = l.match(/^Invite (.+) to connect$/i);
  if (m) return namesMatch(expectedName, m[1]);
  return /^Connect$/i.test(l);
}

export async function readStatus(
  card: TopCard,
  expectedName: string,
  opts: { keepMenuOpenForConnect?: boolean; useMenu?: boolean } = {},
): Promise<StatusRead> {
  const { keepMenuOpenForConnect = false, useMenu = true } = opts;
  const { root } = card;
  const buttons = clickables(card.actions).filter(isVisible);

  const degree = text(root.querySelector('.dist-value')) || (text(root).match(/[·•]\s*(1st|2nd|3rd\+?)\b/)?.[1] ?? '');
  if (degree === '1st') return { status: 'CONNECTED', via: '1st-degree badge' };

  if (buttons.some((b) => /^Pending\b/i.test(label(b)) || /withdraw invitation/i.test(label(b)))) return { status: 'PENDING', via: 'Pending button' };

  const direct = buttons.find((b) => isConnectLabel(label(b), expectedName));
  if (direct) return { status: 'CONNECT_AVAILABLE', via: 'Connect button', connectEl: direct };

  const menu = useMenu ? await openMoreMenu(card.actions) : null;
  if (menu) {
    const labels = menu.items.map(label);
    let result: StatusRead | null = null;
    if (labels.some((l) => /remove (?:your )?connection/i.test(l))) result = { status: 'CONNECTED', via: 'More menu' };
    else if (labels.some((l) => /^(?:Pending|Withdraw)\b/i.test(l))) result = { status: 'PENDING', via: 'More menu' };
    else {
      const connect = menu.items.find((el) => isConnectLabel(label(el), expectedName));
      if (connect) result = { status: 'CONNECT_AVAILABLE', via: 'More menu', connectEl: connect, menu };
    }
    if (!(result?.menu && keepMenuOpenForConnect)) await closeMenu(menu);
    if (result) return result;
  }

  const recognized = buttons.some((b) => /^(?:Message|Follow|Following|Unfollow)\b/i.test(label(b)) || MORE_LABEL.test(label(b)));
  return recognized ? { status: 'UNAVAILABLE', via: 'No Connect option (button or More menu)' } : { status: 'UNKNOWN', via: 'Unrecognized top card' };
}

async function readyTopCard(): Promise<TopCard | null> {
  return waitFor(findTopCard, 15000, 300);
}

export async function detectConnection(expectedName: string): Promise<DetectResponse> {
  if (pageKind() !== 'profile') return { ok: false, status: 'UNKNOWN', error: 'Not on a LinkedIn profile page.' };
  const card = await readyTopCard();
  if (!card) return { ok: false, status: 'UNKNOWN', error: PAGE_STRUCTURE_ERROR };
  if (expectedName && !namesMatch(expectedName, card.name))
    return { ok: false, status: 'UNKNOWN', error: `Profile could not be identified (page shows "${card.name}").` };
  const read = await readStatus(card, expectedName);
  return { ok: true, status: read.status, via: read.via, name: card.name, headline: card.headline, canonicalUrl: canonicalUrl() };
}

// ── Invitation dialog ──────────────────────────────────────────────────────────────────────

export type NoteField = HTMLTextAreaElement | HTMLInputElement | HTMLElement;

export function findInviteDialog(): HTMLElement | null {
  const dialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"], .artdeco-modal, dialog[open]')].filter(isVisible);
  return dialogs.find((d) => /invitation|add a note|send without|personali[sz]e|note|connect/i.test(text(d))) ?? null;
}

export function findNoteField(dialog: HTMLElement): NoteField | null {
  return (
    dialog.querySelector<HTMLTextAreaElement>('textarea[name="message"]') ??
    dialog.querySelector<HTMLTextAreaElement>('textarea#custom-message') ??
    [...dialog.querySelectorAll<HTMLTextAreaElement>('textarea')].find(isVisible) ??
    [...dialog.querySelectorAll<HTMLElement>('[contenteditable="true"], [contenteditable=""], [role="textbox"]')].find(isVisible) ??
    null
  );
}

export function noteValue(field: NoteField): string {
  return field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement ? field.value : (field.innerText ?? '').replace(/\n$/, '');
}

function noteMaxLength(field: NoteField, dialog: HTMLElement): number | null {
  if ((field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement) && field.maxLength > 0) return field.maxLength;
  const m = text(dialog).match(/\b\d+\s*\/\s*(\d{3})\b/); // "0/300" counter
  return m ? Number(m[1]) : null;
}

/** Types the note so LinkedIn's own state sees it (works for textarea and rich-text fields). */
async function writeNote(field: NoteField, message: string) {
  await moveTo(field);
  setCursorLabel('Writing note');
  field.focus();
  if (field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement) {
    const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setValue = (v: string) => {
      Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(field, v);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    };
    await typeVisibly(message, setValue); // visible, human-paced typing
    setValue(message);
    field.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }
  // contenteditable: clear, then insert as real edits in visible chunks.
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(field);
  sel?.removeAllRanges();
  sel?.addRange(range);
  document.execCommand('delete', false);
  let typed = '';
  await typeVisibly(message, (soFar) => {
    document.execCommand('insertText', false, soFar.slice(typed.length));
    typed = soFar;
  });
  await sleep(100);
  if (noteValue(field).trim() !== message.trim()) {
    field.textContent = message;
    field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: message }));
  }
}

/** The dialog's send button — never "Send without a note". */
export function findSendButton(dialog: HTMLElement): HTMLElement | null {
  return findClickable(dialog, (l, el) => /^Send(?: invitation| now| request)?$/i.test(l) && !/without/i.test(l) && isEnabled(el));
}

export type PrepareResult = PrepareResponse & { dialog?: HTMLElement; field?: NoteField };

/** Opens Connect (directly or via More), adds a note and writes the message. Does not send. */
export async function prepareConnect(expectedName: string, message: string): Promise<PrepareResult> {
  if (pageKind() !== 'profile') return { ok: false, stage: 'structure', error: 'Not on a LinkedIn profile page.' };
  const card = await readyTopCard();
  if (!card) return { ok: false, stage: 'structure', error: PAGE_STRUCTURE_ERROR };
  if (!namesMatch(expectedName, card.name))
    return { ok: false, stage: 'identity_mismatch', error: `Profile could not be identified (page shows "${card.name}").` };

  const read = await readStatus(card, expectedName, { keepMenuOpenForConnect: true });
  if (read.status !== 'CONNECT_AVAILABLE' || !read.connectEl)
    return { ok: false, stage: 'status_changed', status: read.status, error: `Connection status is ${read.status}. Nothing was sent.` };

  await jitter(500, 1100);
  await agentClick(read.connectEl, 'Connect');

  const dialog = await waitFor(findInviteDialog, 7000);
  if (!dialog) {
    await sleep(1500);
    const again = findTopCard();
    const after = again ? await readStatus(again, expectedName, { useMenu: false }) : null;
    return {
      ok: false,
      stage: 'no_dialog',
      status: after?.status,
      error: after?.status === 'PENDING' ? 'LinkedIn sent the invitation immediately without offering a note.' : PAGE_STRUCTURE_ERROR,
    };
  }

  if (dialog.querySelector('input[type="email"]') || /how do you know/i.test(text(dialog)))
    return { ok: false, stage: 'extra_verification', error: 'LinkedIn asked for extra verification (email / how you know them). Skipped.' };

  let field = findNoteField(dialog);
  if (!field) {
    const addNote = findClickable(dialog, (l) => /^Add a (?:free )?note$/i.test(l));
    if (!addNote) return { ok: false, stage: 'no_note', error: 'LinkedIn did not offer "Add a note".' };
    await jitter(400, 900);
    await agentClick(addNote, 'Add a note');
    field = await waitFor(() => {
      const d = findInviteDialog();
      return d ? findNoteField(d) : null;
    }, 6000);
  }
  if (!field) return { ok: false, stage: 'no_note', error: 'Note field not found (LinkedIn may have hit your monthly note limit).' };

  const live = findInviteDialog() ?? dialog;
  const max = noteMaxLength(field, live);
  if (max && message.length > max)
    return { ok: false, stage: 'too_long', error: `This account's note limit is ${max} characters; the message is ${message.length}.` };

  await jitter(300, 700);
  await writeNote(field, message);
  await sleep(300);
  if (noteValue(field).trim() !== message.trim()) return { ok: false, stage: 'structure', error: 'The message could not be written into the note field.' };

  return { ok: true, stage: 'awaiting_confirmation', noteMaxLength: max, dialog: live, field };
}

/** After a submission, confirm LinkedIn now shows the invitation as pending. */
export async function verifyPending(expectedName: string): Promise<boolean> {
  for (let i = 0; i < 8; i++) {
    await sleep(1000);
    const card = findTopCard();
    if (!card) continue;
    const read = await readStatus(card, expectedName, { useMenu: i === 7 });
    if (read.status === 'PENDING') return true;
  }
  return false;
}

/** Compact description of the profile page structure, for fixing selectors. */
export function profileDiagnostics(): string {
  const main = document.querySelector('main');
  const card = findTopCard();
  const scope = card?.root ?? main ?? document.body;
  const controls = clickables(scope)
    .filter(isVisible)
    .map((b) => label(b).slice(0, 50))
    .filter(Boolean)
    .slice(0, 25);
  const dialogs = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], .artdeco-modal, dialog[open]')].filter(isVisible);
  return [
    `url: ${location.pathname}`,
    `title name: "${profileName()}", h1 in main: ${main?.querySelectorAll('h1').length ?? 0}`,
    `top card: ${card ? `found (<${card.root.tagName.toLowerCase()}>, ${clickables(card.root).length} controls)` : 'NOT found'}`,
    `controls: ${controls.join(' | ')}`,
    `visible dialogs: ${dialogs.length}${dialogs.length ? ` → ${dialogs.map((d) => clickables(d).map(label).filter(Boolean).slice(0, 8).join(' | ')).join(' || ')}` : ''}`,
    `dialog fields: ${dialogs.map((d) => `${d.querySelectorAll('textarea').length} textarea, ${d.querySelectorAll('[contenteditable]').length} editable`).join('; ')}`,
  ].join('\n');
}
