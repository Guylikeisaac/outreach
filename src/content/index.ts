// SyncUp content script (www.linkedin.com only). Passive until the background worker asks it to do
// something; every action is scoped, verified, and stops safely when the page isn't recognized.

import type { ContentEvent, ContentRequest, PingResponse, PrepareResponse, ScanResponse } from '@shared/messages';
import { PAGE_STRUCTURE_ERROR } from '@shared/messages';
import { pageKind, sleep, waitFor } from './dom';
import { scanDiagnostics, scanPosts } from './scan';
import { detectConnection, findInviteDialog, findNoteField, findSendButton, noteValue, prepareConnect, profileDiagnostics, verifyPending } from './profile';
import { removeOverlay, showOverlay } from './overlay';

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
      send.click();
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
