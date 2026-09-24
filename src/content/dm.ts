// Direct message to an existing (1st-degree) connection: profile → Message → type → Send → verify.
// Works with LinkedIn's messaging overlay whether it renders in the page or inside shadow DOM.

import { PAGE_STRUCTURE_ERROR } from '@shared/messages';
import { clickables, deepQueryAll, findClickable, firstLine, isEnabled, isVisible, label, namesMatch, pageKind, sleep, text, waitFor } from './dom';
import { agentClick, setCursorLabel } from './cursor';
import { findTopCard, noteValue, writeNote } from './profile';

export type DmResult = { ok: true; verified: boolean } | { ok: false; error: string; stage: 'structure' | 'identity_mismatch' | 'no_message_button' | 'no_composer' };

const COMPOSER =
  '[contenteditable="true"][role="textbox"], div.msg-form__contenteditable[contenteditable="true"], [contenteditable="true"][aria-label*="message" i], [contenteditable="true"][data-placeholder*="message" i]';

function composers(): HTMLElement[] {
  return deepQueryAll<HTMLElement>(COMPOSER).filter(isVisible);
}

/** The conversation panel that owns a composer (its form, or the nearest block with a Send control). */
function conversationOf(box: HTMLElement): HTMLElement {
  const form = box.closest('form');
  if (form) {
    let node: HTMLElement = form;
    for (let i = 0; i < 6 && node.parentElement; i++) node = node.parentElement; // include the header with the name
    return node;
  }
  let node: HTMLElement = box;
  for (let i = 0; i < 10 && node.parentElement; i++) node = node.parentElement;
  return node;
}

function sendControl(box: HTMLElement): HTMLElement | null {
  for (let node: HTMLElement | null = box.parentElement, i = 0; node && i < 8; node = node.parentElement, i++) {
    const send = findClickable(node, (l, el) => /^Send$/i.test(l) && isEnabled(el)) ?? node.querySelector<HTMLElement>('button[type="submit"]:not([disabled])');
    if (send && isVisible(send)) return send;
  }
  return null;
}

export async function sendDirectMessage(expectedName: string, message: string): Promise<DmResult> {
  if (pageKind() !== 'profile') return { ok: false, stage: 'structure', error: 'Not on a LinkedIn profile page.' };
  const card = await waitFor(findTopCard, 15000, 300);
  if (!card) return { ok: false, stage: 'structure', error: PAGE_STRUCTURE_ERROR };
  if (!namesMatch(expectedName, card.name)) return { ok: false, stage: 'identity_mismatch', error: `Profile could not be identified (page shows "${card.name}").` };

  const messageBtn = clickables(card.actions).find((b) => isVisible(b) && /^Message\b/i.test(label(b)));
  if (!messageBtn) return { ok: false, stage: 'no_message_button', error: 'No Message button on this profile.' };

  const before = new Set(composers());
  await agentClick(messageBtn, 'Message');

  const first = expectedName.split(/\s+/)[0] ?? '';
  const box = await waitFor(() => {
    const all = composers();
    // Prefer the composer in a conversation that shows this person's name; else the newly opened one.
    return (
      all.find((b) => namesMatch(expectedName, text(conversationOf(b))) || (first && text(conversationOf(b)).includes(first))) ??
      all.find((b) => !before.has(b)) ??
      null
    );
  }, 8000);
  if (!box) return { ok: false, stage: 'no_composer', error: 'The message box did not open.' };

  if (noteValue(box).trim()) {
    // Don't overwrite a draft the user is writing in this conversation.
    return { ok: false, stage: 'structure', error: 'This conversation already has an unsent draft — skipped so it isn’t overwritten.' };
  }

  await writeNote(box, message);
  await sleep(300);
  if (noteValue(box).replace(/\s+/g, ' ').trim() !== message.replace(/\s+/g, ' ').trim())
    return { ok: false, stage: 'structure', error: 'The message could not be written into the message box.' };

  const send = await waitFor(() => sendControl(box), 4000);
  if (!send) return { ok: false, stage: 'structure', error: `${PAGE_STRUCTURE_ERROR} (Send button not found — nothing sent.)` };
  await agentClick(send, 'Send');

  // Verify: the composer empties and the text shows up in the thread.
  const snippet = firstLine(message).slice(0, 30);
  const convo = conversationOf(box);
  const verified = !!(await waitFor(() => !noteValue(box).trim() && text(convo).includes(snippet), 8000));
  setCursorLabel(verified ? 'Sent ✓' : 'Sent');
  await sleep(1000);

  // Tidy up: close the conversation bubble if it has a close control.
  const close = [...convo.querySelectorAll<HTMLElement>('button, [role="button"]')].find((b) => /^Close your (?:conversation|draft)/i.test(label(b)));
  close?.click();
  return { ok: true, verified };
}
