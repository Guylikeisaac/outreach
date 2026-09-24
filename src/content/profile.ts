// Profile-page logic: identify the person, detect connection status, and prepare (never silently
// send) a connection request with a note. Every search is scoped to the profile's top card so we
// never pick up "People also viewed" buttons belonging to someone else.

import type { ConnectionStatus } from '@shared/types';
import type { DetectResponse, PrepareResponse } from '@shared/messages';
import { PAGE_STRUCTURE_ERROR } from '@shared/messages';
import { normalizeProfileUrl } from '@shared/linkedin';
import {
  clickables,
  findClickable,
  firstLine,
  isEnabled,
  isVisible,
  jitter,
  label,
  namesMatch,
  pageKind,
  setNativeValue,
  sleep,
  text,
  waitFor,
} from './dom';

interface TopCard {
  root: HTMLElement;
  name: string;
  headline: string;
}

const ACTION_LABEL = /^(?:Message|Connect|Follow|Following|Pending|More|More actions)$|^Invite .+ to connect$|^Pending\b|^Message\s|^Follow\s|^More actions$/i;

export function findTopCard(): TopCard | null {
  const main = document.querySelector('main');
  const h1 = main?.querySelector('h1');
  if (!main || !h1) return null;
  const name = firstLine(text(h1));
  if (!name) return null;

  let root: HTMLElement | null = h1.closest('section');
  if (!root || !clickables(root).some((b) => ACTION_LABEL.test(label(b)))) {
    // Climb from the name until we reach a block that also contains the profile action buttons.
    root = null;
    let node: HTMLElement | null = h1.parentElement;
    for (let i = 0; node && node !== main && i < 10; i++, node = node.parentElement) {
      if (clickables(node).some((b) => ACTION_LABEL.test(label(b)))) {
        root = node;
        break;
      }
    }
  }
  if (!root || root.querySelector('aside')) return null;
  const headline =
    text(root.querySelector('.text-body-medium')) ||
    (text(root)
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .find((l, i, all) => i > all.indexOf(name) && l.length > 12 && !/^(?:·|\d|he\/|she\/|they\/)/i.test(l)) ??
      '');
  return { root, name, headline: firstLine(headline) };
}

function canonicalUrl(): string {
  const canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href;
  return normalizeProfileUrl(canonical || location.href);
}

// ── Connection status ──────────────────────────────────────────────────────────────────────

interface StatusRead {
  status: ConnectionStatus;
  via: string;
  connectEl?: HTMLElement;
  inMenu?: boolean;
}

function connectLabelMatches(l: string, expectedName: string): boolean {
  const m = l.match(/^Invite (.+) to connect$/i);
  if (m) return namesMatch(expectedName, m[1]);
  return /^Connect$/i.test(l);
}

function menuFor(more: HTMLElement): HTMLElement | null {
  const id = more.getAttribute('aria-controls');
  const byId = id ? document.getElementById(id) : null;
  if (byId && isVisible(byId)) return byId;
  const dropdown = more.closest('.artdeco-dropdown')?.querySelector<HTMLElement>('.artdeco-dropdown__content');
  if (dropdown && isVisible(dropdown)) return dropdown;
  return [...document.querySelectorAll<HTMLElement>('[role="menu"]')].find(isVisible) ?? null;
}

function menuItems(menu: HTMLElement): HTMLElement[] {
  const items = [
    ...menu.querySelectorAll<HTMLElement>('[role="button"], [role="menuitem"], button, .artdeco-dropdown__item'),
  ];
  return items.filter(isVisible);
}

async function openMoreMenu(root: HTMLElement): Promise<{ more: HTMLElement; menu: HTMLElement } | null> {
  const more = findClickable(root, (l) => /^More actions$/i.test(l) || /^More$/i.test(l));
  if (!more) return null;
  more.click();
  const menu = await waitFor(() => menuFor(more), 3000);
  return menu ? { more, menu } : null;
}

async function closeMenu(more: HTMLElement) {
  if (menuFor(more)) more.click();
  await sleep(250);
}

export async function readStatus(
  card: TopCard,
  expectedName: string,
  opts: { keepMenuOpenForConnect?: boolean; useMenu?: boolean } = {},
): Promise<StatusRead> {
  const { keepMenuOpenForConnect = false, useMenu = true } = opts;
  const { root } = card;
  const buttons = clickables(root).filter(isVisible);

  const degree =
    text(root.querySelector('.dist-value')) || (text(root).match(/[·•]\s*(1st|2nd|3rd\+?)\b/)?.[1] ?? '');
  if (degree === '1st') return { status: 'CONNECTED', via: '1st-degree badge' };

  if (buttons.some((b) => /^Pending\b/i.test(label(b)) || /withdraw invitation/i.test(label(b))))
    return { status: 'PENDING', via: 'Pending button' };

  const direct = buttons.find((b) => connectLabelMatches(label(b), expectedName));
  if (direct) return { status: 'CONNECT_AVAILABLE', via: 'Connect button', connectEl: direct };

  const opened = useMenu ? await openMoreMenu(root) : null;
  if (opened) {
    const items = menuItems(opened.menu);
    const labels = items.map(label);
    let result: StatusRead | null = null;
    if (labels.some((l) => /remove (?:your )?connection/i.test(l))) result = { status: 'CONNECTED', via: 'More menu' };
    else if (labels.some((l) => /withdraw|^pending/i.test(l))) result = { status: 'PENDING', via: 'More menu' };
    else {
      const connect = items.find((el) => connectLabelMatches(label(el), expectedName));
      if (connect) result = { status: 'CONNECT_AVAILABLE', via: 'More menu', connectEl: connect, inMenu: true };
    }
    if (!(result?.inMenu && keepMenuOpenForConnect)) await closeMenu(opened.more);
    if (result) return result;
  }

  // We recognized the top card (it has action buttons) but there's no way to connect.
  const recognized = buttons.some((b) => /^(?:Message|Follow|Following)\b/i.test(label(b)));
  return recognized ? { status: 'UNAVAILABLE', via: 'No Connect option' } : { status: 'UNKNOWN', via: 'Unrecognized top card' };
}

async function readyTopCard(): Promise<TopCard | null> {
  return waitFor(() => {
    const card = findTopCard();
    return card && clickables(card.root).some((b) => ACTION_LABEL.test(label(b))) ? card : null;
  }, 15000, 300);
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

// ── Connect with note ──────────────────────────────────────────────────────────────────────

export function findInviteDialog(): HTMLElement | null {
  const dialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"], .artdeco-modal')].filter(isVisible);
  return dialogs.find((d) => /invitation|add a note|send without|note|connect/i.test(text(d))) ?? null;
}

export function findNoteField(dialog: HTMLElement): HTMLTextAreaElement | null {
  return (
    dialog.querySelector<HTMLTextAreaElement>('textarea[name="message"]') ??
    dialog.querySelector<HTMLTextAreaElement>('textarea#custom-message') ??
    [...dialog.querySelectorAll<HTMLTextAreaElement>('textarea')].find(isVisible) ??
    null
  );
}

/** The dialog's send button — never "Send without a note". */
export function findSendButton(dialog: HTMLElement): HTMLElement | null {
  return findClickable(dialog, (l, el) => /^Send(?: invitation| now)?$/i.test(l) && !/without/i.test(l) && isEnabled(el));
}

export async function prepareConnect(expectedName: string, message: string): Promise<PrepareResponse & { dialog?: HTMLElement; field?: HTMLTextAreaElement }> {
  if (pageKind() !== 'profile') return { ok: false, stage: 'structure', error: 'Not on a LinkedIn profile page.' };
  const card = await readyTopCard();
  if (!card) return { ok: false, stage: 'structure', error: PAGE_STRUCTURE_ERROR };
  if (!namesMatch(expectedName, card.name))
    return { ok: false, stage: 'identity_mismatch', error: `Profile could not be identified (page shows "${card.name}").` };

  const read = await readStatus(card, expectedName, { keepMenuOpenForConnect: true });
  if (read.status !== 'CONNECT_AVAILABLE' || !read.connectEl)
    return { ok: false, stage: 'status_changed', status: read.status, error: `Connection status is ${read.status}. Nothing was sent.` };

  await jitter(400, 900);
  read.connectEl.click();

  const dialog = await waitFor(findInviteDialog, 6000);
  if (!dialog) {
    await sleep(1500);
    const after = await readStatus(card, expectedName);
    return {
      ok: false,
      stage: 'no_dialog',
      status: after.status,
      error:
        after.status === 'PENDING'
          ? 'LinkedIn sent the invitation immediately without offering a note.'
          : PAGE_STRUCTURE_ERROR,
    };
  }

  if (dialog.querySelector('input[type="email"]') || /how do you know/i.test(text(dialog)))
    return { ok: false, stage: 'extra_verification', error: 'LinkedIn is asking for extra verification (email / how you know them). Please complete this one manually.' };

  let field = findNoteField(dialog);
  if (!field) {
    const addNote = findClickable(dialog, (l) => /^Add a (?:free )?note$/i.test(l));
    if (!addNote) return { ok: false, stage: 'no_note', error: 'LinkedIn did not offer "Add a note". Please complete this one manually.' };
    await jitter(300, 700);
    addNote.click();
    field = await waitFor(() => {
      const d = findInviteDialog();
      return d ? findNoteField(d) : null;
    }, 5000);
  }
  if (!field)
    return { ok: false, stage: 'no_note', error: 'The note field could not be found (LinkedIn may have hit your note limit). Please complete this one manually.' };

  const max = field.maxLength > 0 ? field.maxLength : null;
  if (max && message.length > max)
    return { ok: false, stage: 'too_long', error: `This account's note limit is ${max} characters; the message is ${message.length}. Shorten it and try again.` };

  setNativeValue(field, message);
  await sleep(200);
  if (field.value !== message) return { ok: false, stage: 'structure', error: 'The message could not be inserted into the note field.' };

  return { ok: true, stage: 'awaiting_confirmation', noteMaxLength: max, dialog: findInviteDialog() ?? dialog, field };
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
