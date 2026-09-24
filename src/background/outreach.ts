// Per-prospect workflow: connection check → message generation → approval → assisted connect.
// Each step re-validates state so nothing is sent to connected, pending, duplicate, or unqualified people.

import type { ConnectionStatus, OutreachStatus, Prospect, WorkflowState } from '@shared/types';
import { OUTREACH_STATUSES } from '@shared/types';
import type { ContentEvent, DetectResponse, PrepareResponse } from '@shared/messages';
import { PAGE_STRUCTURE_ERROR } from '@shared/messages';
import { generateMessage, validateMessage } from '@shared/message';
import { qualify } from '@shared/qualification';
import { normalizeProfileUrl } from '@shared/linkedin';
import { get, set, update, withLock } from '@shared/storage';
import { log, patchProspect, saveProspect } from './log';
import { openInWorkTab, sendToTab } from './tabs';
import { aiPersonalizationLine } from './ai';
import { syncNow } from './sync';

const OUTREACH_OPEN: OutreachStatus[] = ['NEW', 'REVIEWED', 'APPROVED'];

async function setWorkflow(patch: Partial<WorkflowState>) {
  await withLock(() => update('workflow', (w) => ({ ...w, ...patch, updatedAt: new Date().toISOString() })));
}

async function mustGet(prospectId: string): Promise<Prospect> {
  const p = (await get('prospects'))[prospectId];
  if (!p) throw new Error('Prospect not found.');
  return p;
}

const STATUS_TEXT: Record<ConnectionStatus, string> = {
  CONNECTED: 'Already connected',
  PENDING: 'Connection already pending',
  CONNECT_AVAILABLE: 'Connect available',
  UNAVAILABLE: 'Connect unavailable',
  UNKNOWN: 'Could not determine connection status',
};

async function applyConnectionStatus(p: Prospect, status: ConnectionStatus) {
  await patchProspect(p.id, (x) => {
    x.connectionStatus = status;
    x.connectionCheckedAt = new Date().toISOString();
    if ((status === 'CONNECTED' || status === 'PENDING') && OUTREACH_OPEN.includes(x.outreachStatus)) x.outreachStatus = 'SKIPPED';
  });
}

// ── Connection status ──────────────────────────────────────────────────────────────────────

export async function checkConnection(prospectId: string): Promise<ConnectionStatus> {
  const p = await mustGet(prospectId);
  await setWorkflow({ prospectId, step: 'checking_connection', detail: `Opening ${p.name}'s profile…` });
  await log(`Checking connection status for ${p.name}`, { prospectId, campaignId: p.campaignId });

  let res: DetectResponse;
  try {
    const tabId = await openInWorkTab(p.profileUrl);
    res = await sendToTab<DetectResponse>(tabId, { type: 'DETECT_CONNECTION', expectedName: p.name });
  } catch (e) {
    res = { ok: false, status: 'UNKNOWN', error: e instanceof Error ? e.message : String(e) };
  }

  if (!res?.ok) {
    const error = res?.error ?? PAGE_STRUCTURE_ERROR;
    const identity = /could not be identified/i.test(error);
    await patchProspect(prospectId, (x) => {
      x.connectionStatus = 'UNKNOWN';
      x.connectionCheckedAt = new Date().toISOString();
      if (identity && OUTREACH_OPEN.includes(x.outreachStatus)) x.outreachStatus = 'SKIPPED';
    });
    await log(identity ? `${error} Prospect skipped.` : `${STATUS_TEXT.UNKNOWN}: ${error}`, { level: 'warn', prospectId, campaignId: p.campaignId });
    await setWorkflow({ step: 'stopped', detail: error });
    return 'UNKNOWN';
  }

  // Canonical profile URL: dedupe against people we already know under another URL.
  const canonical = normalizeProfileUrl(res.canonicalUrl);
  if (canonical && canonical !== p.profileUrl) {
    const merged = await withLock(async () => {
      const index = await get('profileIndex');
      const otherId = index[canonical];
      if (otherId && otherId !== p.id) {
        const prospects = await get('prospects');
        delete prospects[p.id];
        await set('prospects', prospects);
        for (const url of [p.profileUrl, ...p.profileAliases]) index[url] = otherId;
        await set('profileIndex', index);
        return prospects[otherId];
      }
      const fresh = (await get('prospects'))[p.id];
      if (fresh && !fresh.profileAliases.includes(canonical)) fresh.profileAliases.push(canonical);
      if (fresh) await saveProspect(fresh);
      return null;
    });
    if (merged) {
      await log(`${p.name} is already tracked as a prospect — duplicate removed`, { level: 'warn', prospectId: merged.id, campaignId: p.campaignId });
      await setWorkflow({ prospectId: merged.id, step: 'done', detail: 'Duplicate merged into existing prospect.' });
      return merged.connectionStatus;
    }
  }

  // Fill in the headline from the profile when we didn't have one (e.g. contact named in a post),
  // then re-qualify with that real data.
  if (!p.headline && res.headline) {
    const campaign = (await get('campaigns'))[p.campaignId];
    await patchProspect(prospectId, (x) => {
      x.headline = res.headline;
      if (campaign) {
        const prev = x.qualification.level;
        x.qualification = qualify(
          {
            postText: x.postText,
            headline: x.headline,
            hiringRole: x.hiringRole,
            postedDate: x.postedDate ? new Date(x.postedDate) : null,
            contactSource: x.contactSource,
            companyAuthored: false,
          },
          campaign,
        );
        if (prev !== x.qualification.level) void log(`Re-qualified ${x.name}: ${prev} → ${x.qualification.level}`, { prospectId });
      }
    });
  }

  await applyConnectionStatus(p, res.status);
  await log(`${p.name}: ${STATUS_TEXT[res.status]}`, {
    level: res.status === 'CONNECT_AVAILABLE' ? 'success' : 'info',
    prospectId,
    campaignId: p.campaignId,
    metadata: { via: res.via },
  });
  await setWorkflow({ step: 'done', detail: STATUS_TEXT[res.status] });
  void syncNow();
  return res.status;
}

// ── Message ────────────────────────────────────────────────────────────────────────────────

function assertCanReachOut(p: Prospect) {
  if (!p.qualification.eligible) throw new Error('This prospect did not pass qualification — outreach is disabled.');
  if (!OUTREACH_OPEN.includes(p.outreachStatus)) throw new Error(`Outreach already ${p.outreachStatus.toLowerCase().replace('_', ' ')}.`);
  if (p.connectionStatus !== 'CONNECT_AVAILABLE') throw new Error(`${STATUS_TEXT[p.connectionStatus]}. Check connection status first.`);
}

export async function generateFor(prospectId: string): Promise<string> {
  const p = await mustGet(prospectId);
  assertCanReachOut(p);
  const settings = await get('settings');
  let aiLine: string | null = null;
  if (settings.useAiPersonalization && settings.anthropicApiKey) {
    try {
      aiLine = await aiPersonalizationLine(settings.anthropicApiKey, p.postText, p.hiringRole);
    } catch (e) {
      await log(`AI personalization unavailable, used template (${e instanceof Error ? e.message : e})`, { level: 'warn', prospectId });
    }
  }
  const message = generateMessage(p.firstName || '[First Name]', p.hiringRole, aiLine);
  await patchProspect(prospectId, (x) => {
    x.message = message;
    if (x.outreachStatus === 'NEW') x.outreachStatus = 'REVIEWED';
  });
  await log(`Message generated${aiLine ? ' (AI-personalized)' : ''}`, { prospectId, campaignId: p.campaignId });
  return message;
}

export async function saveMessage(prospectId: string, message: string) {
  await patchProspect(prospectId, (x) => {
    x.message = message;
  });
}

// ── Approval + assisted connect ────────────────────────────────────────────────────────────

export async function approveAndConnect(prospectId: string, message: string) {
  const workflow = await get('workflow');
  if (['opening_profile', 'awaiting_final_confirmation', 'submitting'].includes(workflow.step) && workflow.prospectId !== prospectId)
    throw new Error('Finish or cancel the open connection workflow first.');

  const p = await mustGet(prospectId);
  assertCanReachOut(p);
  const errors = validateMessage(message, p.firstName).filter((i) => i.level === 'error');
  if (errors.length) throw new Error(errors[0].text);

  await patchProspect(prospectId, (x) => {
    x.message = message;
    x.outreachStatus = 'APPROVED';
  });
  await log('User approved outreach', { level: 'success', prospectId, campaignId: p.campaignId });
  await setWorkflow({ prospectId, step: 'opening_profile', detail: `Opening ${p.name}'s profile…` });

  let res: PrepareResponse;
  try {
    const tabId = await openInWorkTab(p.profileUrl);
    await log('Connection workflow opened', { prospectId, campaignId: p.campaignId });
    res = await sendToTab<PrepareResponse>(tabId, { type: 'PREPARE_CONNECT', prospectId, expectedName: p.name, message });
  } catch (e) {
    res = { ok: false, stage: 'structure', error: e instanceof Error ? e.message : String(e) };
  }

  if (res?.ok) {
    await log('Message inserted — waiting for your final confirmation in LinkedIn', { prospectId, campaignId: p.campaignId });
    await setWorkflow({ step: 'awaiting_final_confirmation', detail: 'Confirm or cancel in the SyncUp panel on the LinkedIn page.' });
    return;
  }

  const failure = res ?? { ok: false, stage: 'structure', error: PAGE_STRUCTURE_ERROR };
  switch (failure.stage) {
    case 'status_changed':
      if (failure.status) await applyConnectionStatus(p, failure.status);
      break;
    case 'identity_mismatch':
      await patchProspect(prospectId, (x) => {
        x.outreachStatus = 'SKIPPED';
      });
      break;
    case 'no_dialog':
      if (failure.status === 'PENDING') {
        await patchProspect(prospectId, (x) => {
          x.connectionStatus = 'PENDING';
          x.outreachStatus = 'REQUEST_SUBMITTED';
        });
      }
      break;
  }
  const manual = ['no_note', 'extra_verification', 'structure', 'no_dialog'].includes(failure.stage) && failure.status !== 'PENDING';
  await log(`Connection workflow stopped: ${failure.error}`, { level: manual ? 'warn' : 'error', prospectId, campaignId: p.campaignId });
  await setWorkflow({
    step: manual ? 'awaiting_final_confirmation' : 'stopped',
    detail: manual ? `${failure.error} A SyncUp panel on the LinkedIn page lets you copy the message and record the result.` : failure.error,
  });
  void syncNow();
}

export async function onWorkflowEvent(ev: Extract<ContentEvent, { type: 'WORKFLOW_EVENT' }>) {
  const p = (await get('prospects'))[ev.prospectId];
  if (!p) return;
  if (ev.event === 'submitted' && ev.verified) {
    await patchProspect(p.id, (x) => {
      x.outreachStatus = 'REQUEST_SUBMITTED';
      x.connectionStatus = 'PENDING';
      x.connectionCheckedAt = new Date().toISOString();
      if (ev.finalMessage) x.message = ev.finalMessage;
    });
    await log(`Connection request submitted to ${p.name}`, { level: 'success', prospectId: p.id, campaignId: p.campaignId, metadata: { detail: ev.detail } });
    await setWorkflow({ step: 'done', detail: 'Request submitted and verified as pending.' });
  } else if (ev.event === 'submitted') {
    await log(`${ev.detail} Use “Mark request submitted” if it was sent.`, { level: 'warn', prospectId: p.id, campaignId: p.campaignId });
    await setWorkflow({ step: 'stopped', detail: ev.detail });
  } else {
    await log(ev.event === 'cancelled' ? `Outreach to ${p.name} cancelled — nothing sent` : `Connection workflow failed: ${ev.detail}`, {
      level: ev.event === 'cancelled' ? 'info' : 'error',
      prospectId: p.id,
      campaignId: p.campaignId,
    });
    await setWorkflow({ step: 'stopped', detail: ev.detail });
  }
  void syncNow();
}

export async function setOutreachStatus(prospectId: string, status: OutreachStatus) {
  if (!OUTREACH_STATUSES.includes(status)) throw new Error('Unknown status.');
  const p = await mustGet(prospectId);
  if (status === 'APPROVED') throw new Error('Approve outreach from the message review screen.');
  await patchProspect(prospectId, (x) => {
    x.outreachStatus = status;
    if (status === 'REQUEST_SUBMITTED') x.connectionStatus = 'PENDING';
    if (status === 'CONNECTED' || status === 'REPLIED') x.connectionStatus = 'CONNECTED';
  });
  await log(`${p.name}: status set to ${status.replace(/_/g, ' ')}`, { prospectId, campaignId: p.campaignId });
  void syncNow();
}

export async function cancelWorkflow() {
  await setWorkflow({ step: 'idle', prospectId: null, detail: '' });
}
