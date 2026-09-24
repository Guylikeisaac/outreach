// SyncUp content script (www.linkedin.com only). Passive until the background worker asks it to do
// something; every action is scoped, verified, and stops safely when the page isn't recognized.

import type { AutoConnectResponse, ContentEvent, ContentRequest, PingResponse, PrepareResponse, ScanResponse } from '@shared/messages';
import { PAGE_STRUCTURE_ERROR } from '@shared/messages';
import { jitter, pageKind, sleep, waitFor } from './dom';
import { scanDiagnostics, scanPosts } from './scan';
import { detectConnection, findInviteDialog, findNoteField, findSendButton, noteValue, prepareConnect, profileDiagnostics, verifyPending } from './profile';
import { removeOverlay, showOverlay } from './overlay';
import { agentClick, hideCursor, setCursorLabel } from './cursor';
import { sendDirectMessage } from './dm';

declare global {
  interface Window {
    __syncupContentLoaded?: boolean;
  }
}

function emit(event: ContentEvent) {
  chrome.runtime.sendMessage(event).catch(() => undefined);
}

let workflowActive = false;

async function handlePrepare(req: Extract<ContentRequest, { type: 'PREPARE_CONNECT' }>): Promise<PrepareResponse> {
  if (workflowActive) return { ok: false, stage: 'structure', error: 'A connection workflow is already open on this page.' };
  const res = await prepareConnect(req.expectedName, req.message);

  if (!res.ok) {
    // Stages where the user can still finish by hand get the manual-completion panel.
    if (['no_note', 'extra_verification', 'structure', 'no_dialog'].includes(res.stage) && res.status !== 'PENDING') {
      const panel = showOverlay({
        mode: 'manual',
        name: req.expectedName,
        getMessage: () => req.message,
        maxLength: null,
        info: res.error,
        onDone: async () => {
          panel.setInfo('Checking LinkedIn for a pending invitation…');
          const verified = await verifyPending(req.expectedName);
          panel.remove();
          emit({ type: 'WORKFLOW_EVENT', prospectId: req.prospectId, event: 'submitted', verified, detail: verified ? 'Sent manually by user; pending invitation verified.' : 'User reported sending manually; pending status not detected.' });
        },
        onCancel: () => {
          panel.remove();
          emit({ type: 'WORKFLOW_EVENT', prospectId: req.prospectId, event: 'cancelled', verified: false, detail: 'User cancelled manual completion.' });
        },
      });
    }
    const diagnostics = res.stage === 'structure' || res.stage === 'no_dialog' ? profileDiagnostics() : undefined;
    return { ok: res.ok, stage: res.stage, status: res.status, error: res.error, diagnostics } as PrepareResponse;
  }

  workflowActive = true;
  const field = res.field!;
  let finished = false;

  const finish = (event: Extract<ContentEvent, { type: 'WORKFLOW_EVENT' }>) => {
    if (finished) return;
    finished = true;
    workflowActive = false;
    observer.disconnect();
    field.removeEventListener('input', onInput);
    panel.remove();
    emit(event);
  };

  const onInput = () => panel.refresh();
  field.addEventListener('input', onInput);

  const panel = showOverlay({
    mode: 'confirm',
    name: req.expectedName,
    getMessage: () => (field.isConnected ? noteValue(field) : ''),
    maxLength: res.noteMaxLength,
    onSend: async () => {
      const dialog = findInviteDialog();
      const liveField = dialog ? findNoteField(dialog) : null;
      const send = dialog ? findSendButton(dialog) : null;
      if (!dialog || !liveField || !noteValue(liveField).trim() || !send) {
        panel.setInfo(`${PAGE_STRUCTURE_ERROR} Please click Send in LinkedIn yourself, or cancel.`);
        return;
      }
      const finalMessage = noteValue(liveField);
      panel.setInfo('Submitting…');
      observer.disconnect(); // we handle completion ourselves from here
      await agentClick(send, 'Send');
      await waitFor(() => !findInviteDialog(), 8000);
      const verified = await verifyPending(req.expectedName);
      finish({
        type: 'WORKFLOW_EVENT',
        prospectId: req.prospectId,
        event: 'submitted',
        verified,
        finalMessage,
        detail: verified ? 'Request submitted; LinkedIn shows it as pending.' : 'Send clicked, but pending status could not be verified.',
      });
    },
    onCancel: () => {
      const dialog = findInviteDialog();
      // Dismissing LinkedIn's dialog is safe; it never sends anything.
      dialog?.querySelector<HTMLElement>('button[aria-label="Dismiss"], button[aria-label="Close"]')?.click();
      finish({ type: 'WORKFLOW_EVENT', prospectId: req.prospectId, event: 'cancelled', verified: false, detail: 'User cancelled at final confirmation.' });
    },
  });

  // If the user sends or closes via LinkedIn's own dialog buttons, record what actually happened.
  const lastMessage = { value: noteValue(field) };
  const observer = new MutationObserver(async () => {
    if (field.isConnected) lastMessage.value = noteValue(field);
    if (findInviteDialog() || finished) return;
    observer.disconnect();
    await sleep(800);
    const verified = await verifyPending(req.expectedName);
    finish(
      verified
        ? { type: 'WORKFLOW_EVENT', prospectId: req.prospectId, event: 'submitted', verified: true, finalMessage: lastMessage.value, detail: 'Sent via LinkedIn’s Send button; pending invitation verified.' }
        : { type: 'WORKFLOW_EVENT', prospectId: req.prospectId, event: 'cancelled', verified: false, detail: 'LinkedIn dialog closed without sending.' },
    );
  });
  observer.observe(document.body, { childList: true, subtree: true });

  return { ok: true, stage: 'awaiting_confirmation', noteMaxLength: res.noteMaxLength };
}

/** Closes LinkedIn's invite dialog without sending (Dismiss / Close / Escape). */
function closeInviteDialog() {
  const dialog = findInviteDialog();
  if (!dialog) return;
  const close = dialog.querySelector<HTMLElement>('button[aria-label="Dismiss"], button[aria-label="Close"], button[aria-label*="Dismiss"]');
  if (close) close.click();
  else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
}

/**
 * Autopilot send (the user enabled Autopilot for the campaign): the same verified steps as the
 * assisted flow — Connect (or More → Connect) → Add a note → write message — then LinkedIn's Send.
 * Anything unexpected closes the dialog without sending.
 */
async function handleAutoConnect(req: Extract<ContentRequest, { type: 'AUTO_CONNECT' }>): Promise<AutoConnectResponse> {
  if (workflowActive) return { ok: false, stage: 'structure', error: 'A connection workflow is already open on this page.' };
  workflowActive = true;
  try {
    const res = await prepareConnect(req.expectedName, req.message);
    if (!res.ok) {
      const diagnostics = res.stage === 'structure' || res.stage === 'no_dialog' ? profileDiagnostics() : undefined;
      closeInviteDialog();
      return { ok: false, stage: res.stage, status: res.status, error: res.error, diagnostics };
    }
    await jitter(900, 1800);
    const dialog = findInviteDialog();
    const field = dialog ? findNoteField(dialog) : null;
    const send = dialog ? findSendButton(dialog) : null;
    const sentMessage = field ? noteValue(field) : '';
    if (!dialog || !field || sentMessage.trim() !== req.message.trim() || !send) {
      closeInviteDialog();
      return { ok: false, stage: 'structure', error: `${PAGE_STRUCTURE_ERROR} (Send button or note not found — nothing sent.)`, diagnostics: profileDiagnostics() };
    }
    await agentClick(send, 'Send');
    await waitFor(() => !findInviteDialog(), 8000);
    const verified = await verifyPending(req.expectedName);
    setCursorLabel(verified ? 'Sent ✓' : 'Sent');
    await sleep(1200);
    return { ok: true, verified, sentMessage };
  } finally {
    workflowActive = false;
    hideCursor();
  }
}

async function handle(req: ContentRequest): Promise<unknown> {
  const kind = pageKind();
  if (req.type === 'PING') return { ok: true, url: location.href, page: kind } satisfies PingResponse;
  if (kind === 'auth') return { ok: false, error: 'You are signed out of LinkedIn. Please sign in, then retry.', status: 'UNKNOWN', stage: 'structure' };
  if (kind === 'checkpoint')
    return { ok: false, error: 'LinkedIn is showing a security check. Please complete it yourself, then retry.', status: 'UNKNOWN', stage: 'structure' };

  switch (req.type) {
    case 'SCAN_POSTS': {
      const result = await scanPosts(req.maxPosts, req.scroll, (found) => emit({ type: 'SCAN_PROGRESS', found }));
      return (result ? { ok: true, ...result } : { ok: false, error: PAGE_STRUCTURE_ERROR, diagnostics: scanDiagnostics() }) satisfies ScanResponse;
    }
    case 'DETECT_CONNECTION': {
      const res = await detectConnection(req.expectedName);
      return res.ok ? res : { ...res, diagnostics: profileDiagnostics() };
    }
    case 'PREPARE_CONNECT':
      return handlePrepare(req);
    case 'AUTO_CONNECT':
      return handleAutoConnect(req);
    case 'AUTO_MESSAGE': {
      if (workflowActive) return { ok: false, stage: 'structure', error: 'A workflow is already open on this page.' };
      workflowActive = true;
      try {
        const res = await sendDirectMessage(req.expectedName, req.message);
        return res.ok ? res : { ...res, diagnostics: res.stage === 'structure' || res.stage === 'no_composer' ? profileDiagnostics() : undefined };
      } finally {
        workflowActive = false;
        hideCursor();
      }
    }
  }
}

if (!window.__syncupContentLoaded) {
  window.__syncupContentLoaded = true;
  chrome.runtime.onMessage.addListener((req: ContentRequest, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false;
    handle(req)
      .then(sendResponse)
      .catch((e: unknown) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e), status: 'UNKNOWN', stage: 'structure' }));
    return true; // async response
  });
  window.addEventListener('pagehide', removeOverlay);
}
