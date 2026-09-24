// Autopilot: sends connection requests with the campaign's note automatically, one prospect at a
// time, for qualified prospects only. Enabled per campaign by the user. Guardrails:
//  - daily send cap per campaign, randomized 60–150 s gaps between sends
//  - skips connected / pending / unavailable / already-contacted / unqualified people
//  - verifies each send shows "Pending" on LinkedIn
//  - stops the whole run on sign-in walls, security checks, note limits, or repeated page-structure failures

import type { Campaign, Prospect } from '@shared/types';
import type { AutoConnectResponse, AutoMessageResponse } from '@shared/messages';
import { DEFAULT_TEMPLATE, renderTemplate, validateMessage } from '@shared/message';
import { get } from '@shared/storage';
import { log, patchProspect } from './log';
import { checkConnection, generateFor } from './outreach';
import { openInWorkTab, sendToTab } from './tabs';
import { syncNow } from './sync';

export const DEFAULT_DAILY_SEND_LIMIT = 15;
export const MAX_DAILY_SEND_LIMIT = 40;

const OPEN = ['NEW', 'REVIEWED', 'APPROVED'];
const localDay = (iso: string) => new Date(iso).toLocaleDateString('en-CA');

export function sendLimit(c: Campaign): number {
  return Math.min(MAX_DAILY_SEND_LIMIT, Math.max(1, c.dailySendLimit ?? DEFAULT_DAILY_SEND_LIMIT));
}

export async function sentToday(campaignId: string): Promise<number> {
  const today = localDay(new Date().toISOString());
  return Object.values(await get('prospects')).filter(
    (p) =>
      p.campaignId === campaignId &&
      ((p.requestSentAt && localDay(p.requestSentAt) === today) || (p.messageSentAt && localDay(p.messageSentAt) === today)),
  ).length;
}

/** Existing connections that should get a direct message instead of a connection request. */
function needsDirectMessage(p: Prospect): boolean {
  return p.connectionStatus === 'CONNECTED' && !p.messageSentAt && !p.skippedByUser && !p.dmUnavailable && (OPEN.includes(p.outreachStatus) || p.outreachStatus === 'SKIPPED');
}

function needsConnectionRequest(p: Prospect): boolean {
  return OPEN.includes(p.outreachStatus) && !p.skippedByUser && !['CONNECTED', 'PENDING', 'UNAVAILABLE'].includes(p.connectionStatus);
}

/** Qualified prospects in discovery order (top of the first search first), like the Prospects list. */
function queueFor(prospects: Record<string, Prospect>, campaignId: string): Prospect[] {
  return Object.values(prospects)
    .filter((p) => p.campaignId === campaignId && p.qualification.eligible && (needsConnectionRequest(p) || needsDirectMessage(p)))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

class StopRun extends Error {}

/** Sends the campaign message as a direct message to an existing connection. */
async function sendDm(p: Prospect, campaign: Campaign): Promise<'sent' | 'failed' | 'structure'> {
  const settings = await get('settings');
  const message = renderTemplate(settings.messageTemplate || DEFAULT_TEMPLATE, p.firstName || '', p.hiringRole);
  const errors = validateMessage(message, p.firstName).filter((x) => x.level === 'error');
  if (!p.firstName || errors.length) {
    await log(`Autopilot skipped messaging ${p.name}: ${errors[0]?.text ?? 'first name unknown'}`, { level: 'warn', prospectId: p.id, campaignId: campaign.id });
    return 'failed';
  }
  let res: AutoMessageResponse;
  try {
    const tabId = await openInWorkTab(p.profileUrl);
    res = await sendToTab<AutoMessageResponse>(tabId, { type: 'AUTO_MESSAGE', expectedName: p.name, message });
  } catch (e) {
    res = { ok: false, stage: 'structure', error: e instanceof Error ? e.message : String(e) };
  }
  if (res?.ok) {
    const ts = new Date().toISOString();
    await patchProspect(p.id, (x) => {
      x.outreachStatus = 'MESSAGE_SENT';
      x.messageSentAt = ts; // recorded even if unverified, so it is never sent twice
      x.message = message;
    });
    await log(res.verified ? `Message sent to ${p.name} (already connected)` : `Message sent to ${p.name}, but it couldn't be confirmed in the thread — check it`, {
      level: res.verified ? 'success' : 'warn',
      prospectId: p.id,
      campaignId: campaign.id,
    });
    void syncNow();
    return 'sent';
  }
  const fail = res ?? { ok: false as const, stage: 'structure' as const, error: 'No response from the LinkedIn page.' };
  await log(`Autopilot: couldn't message ${p.name} — ${fail.error}`, {
    level: 'warn',
    prospectId: p.id,
    campaignId: campaign.id,
    metadata: 'diagnostics' in fail && fail.diagnostics ? { diagnostics: fail.diagnostics } : {},
  });
  if (fail.stage === 'identity_mismatch' || fail.stage === 'no_message_button') {
    await patchProspect(p.id, (x) => {
      x.dmUnavailable = true;
      x.outreachStatus = 'SKIPPED';
    });
  }
  return fail.stage === 'structure' || fail.stage === 'no_composer' ? 'structure' : 'failed';
}

/**
 * Runs the Autopilot queue for a campaign. `shouldStop` is polled between every step so the
 * user's STOP takes effect quickly; `status` reports progress to the dashboard.
 */
export async function runAutopilot(
  campaign: Campaign,
  shouldStop: () => boolean,
  status: (message: string) => Promise<void>,
  opts: { quiet?: boolean } = {},
): Promise<void> {
  const limit = sendLimit(campaign);
  let sent = await sentToday(campaign.id);
  if (sent >= limit) {
    if (!opts.quiet) await log(`Autopilot: daily send limit reached (${sent}/${limit})`, { level: 'success', campaignId: campaign.id });
    return;
  }
  const queue = queueFor(await get('prospects'), campaign.id);
  if (!queue.length) {
    if (!opts.quiet) await log('Autopilot: no qualified prospects waiting for outreach', { campaignId: campaign.id });
    return;
  }
  await log(`Autopilot started — ${queue.length} qualified prospect(s) queued, ${limit - sent} send(s) left today`, { campaignId: campaign.id });

  let structureFailures = 0;
  const wait = async (ms: number) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (shouldStop()) throw new StopRun('Stopped by you');
      await new Promise((r) => setTimeout(r, 1000));
    }
  };
  const pause = async () => {
    const gap = 60_000 + Math.random() * 90_000;
    await status(`Autopilot · next profile in ${Math.round(gap / 1000)}s (${sent}/${limit} sent today)`);
    await wait(gap);
  };

  try {
    for (const [i, queued] of queue.entries()) {
      if (shouldStop()) throw new StopRun('Stopped by you');
      if (sent >= limit) {
        await log(`Autopilot: daily send limit reached (${sent}/${limit})`, { level: 'success', campaignId: campaign.id });
        break;
      }
      const p = (await get('prospects'))[queued.id];
      if (!p || !p.qualification.eligible || !(needsConnectionRequest(p) || needsDirectMessage(p))) continue;
      await status(`Autopilot · ${p.name} (${sent}/${limit} sent today)`);

      // 1. Fresh connection status from the profile (Connect button or More → Connect).
      const connection = await checkConnection(p.id);
      if (shouldStop()) throw new StopRun('Stopped by you');
      if (connection === 'UNKNOWN') {
        const wf = await get('workflow');
        if (/signed out|security check|checkpoint/i.test(wf.detail)) throw new StopRun(wf.detail);
        if (/structure changed/i.test(wf.detail) && ++structureFailures >= 2) throw new StopRun(`${wf.detail} (twice in a row)`);
        continue;
      }

      // Already connected → send the message as a direct message instead.
      if (connection === 'CONNECTED') {
        const fresh = (await get('prospects'))[p.id];
        if (!fresh || !needsDirectMessage(fresh)) continue;
        const outcome = await sendDm(fresh, campaign);
        if (outcome === 'sent') {
          sent++;
          structureFailures = 0;
        } else if (outcome === 'structure' && ++structureFailures >= 2) throw new StopRun('Messaging page not recognised twice in a row.');
        if (i < queue.length - 1 && sent < limit) await pause();
        continue;
      }
      if (connection !== 'CONNECT_AVAILABLE') continue; // pending / unavailable → already handled & logged

      // 2. Message from the campaign template.
      let message: string;
      try {
        message = await generateFor(p.id);
      } catch (e) {
        await log(`Autopilot skipped ${p.name}: ${e instanceof Error ? e.message : e}`, { level: 'warn', prospectId: p.id, campaignId: campaign.id });
        continue;
      }
      const errors = validateMessage(message, p.firstName).filter((x) => x.level === 'error');
      if (errors.length) {
        await log(`Autopilot skipped ${p.name}: ${errors[0].text}`, { level: 'warn', prospectId: p.id, campaignId: campaign.id });
        continue;
      }
      await patchProspect(p.id, (x) => {
        x.outreachStatus = 'APPROVED';
      });
      await log('Autopilot approved outreach (campaign setting)', { prospectId: p.id, campaignId: campaign.id });

      // 3. Connect → Add a note → write → Send → verify pending.
      let res: AutoConnectResponse;
      try {
        const tabId = await openInWorkTab(p.profileUrl);
        res = await sendToTab<AutoConnectResponse>(tabId, { type: 'AUTO_CONNECT', expectedName: p.name, message });
      } catch (e) {
        res = { ok: false, stage: 'structure', error: e instanceof Error ? e.message : String(e) };
      }

      if (res?.ok) {
        structureFailures = 0;
        sent++;
        const ts = new Date().toISOString();
        await patchProspect(p.id, (x) => {
          // Recorded as submitted even when unverified, so it is never sent twice.
          x.outreachStatus = 'REQUEST_SUBMITTED';
          x.connectionStatus = 'PENDING';
          x.connectionCheckedAt = ts;
          x.requestSentAt = ts;
          x.message = res.ok ? res.sentMessage || message : message;
        });
        await log(
          res.verified ? `Connection request sent to ${p.name} with note` : `Send clicked for ${p.name}, but "Pending" could not be verified — check their profile`,
          { level: res.verified ? 'success' : 'warn', prospectId: p.id, campaignId: campaign.id },
        );
        void syncNow();
      } else {
        const fail = res ?? { ok: false as const, stage: 'structure' as const, error: 'No response from the LinkedIn page.' };
        await log(`Autopilot: ${p.name} — ${fail.error}`, {
          level: 'warn',
          prospectId: p.id,
          campaignId: campaign.id,
          metadata: fail.diagnostics ? { diagnostics: fail.diagnostics } : {},
        });
        switch (fail.stage) {
          case 'status_changed':
            await patchProspect(p.id, (x) => {
              if (fail.status) x.connectionStatus = fail.status;
              if (fail.status === 'CONNECTED' || fail.status === 'PENDING') x.outreachStatus = 'SKIPPED';
            });
            break;
          case 'identity_mismatch':
          case 'extra_verification':
            await patchProspect(p.id, (x) => {
              x.outreachStatus = 'SKIPPED';
            });
            break;
          case 'no_dialog':
            if (fail.status === 'PENDING') {
              sent++;
              await patchProspect(p.id, (x) => {
                x.outreachStatus = 'REQUEST_SUBMITTED';
                x.connectionStatus = 'PENDING';
                x.requestSentAt = new Date().toISOString();
              });
            } else if (++structureFailures >= 2) throw new StopRun(`${fail.error} (twice in a row)`);
            break;
          case 'no_note':
            // Usually LinkedIn's monthly custom-note limit: every following send would fail the same way.
            throw new StopRun(`${fail.error} Autopilot paused so requests aren't sent without your note.`);
          case 'too_long':
            throw new StopRun(`${fail.error} Shorten the message template in Settings.`);
          default:
            if (/signed out|security check/i.test(fail.error)) throw new StopRun(fail.error);
            if (++structureFailures >= 2) throw new StopRun(`${fail.error} (twice in a row)`);
        }
        if (fail.stage !== 'no_dialog' || fail.status !== 'PENDING') {
          // Revert the approval so the prospect can be retried or handled manually.
          await patchProspect(p.id, (x) => {
            if (x.outreachStatus === 'APPROVED') x.outreachStatus = 'REVIEWED';
          });
        }
      }

      // 4. Human-paced gap before the next profile.
      if (i < queue.length - 1 && sent < limit) await pause();
    }
    await log(`Autopilot finished — ${sent}/${limit} sent today`, { level: 'success', campaignId: campaign.id });
  } catch (e) {
    if (e instanceof StopRun) {
      await log(`Autopilot stopped: ${e.message}`, { level: e.message === 'Stopped by you' ? 'warn' : 'error', campaignId: campaign.id });
      if (e.message !== 'Stopped by you') throw new Error(e.message);
      return;
    }
    throw e;
  }
}
