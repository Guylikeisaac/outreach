// Turns a raw scraped post into a qualified prospect. Pure — no chrome APIs — so it's unit-tested.

import type { Campaign, Prospect, RawPost } from './types';
import { dateFromActivityId, dateFromRelativeTime } from './linkedin';
import { detectGeography, extractHiringRole, firstNameOf, identifyHiringContact, pickCompany } from './extraction';
import { qualify } from './qualification';

export type BuildResult =
  | { kind: 'prospect'; prospect: Prospect }
  | { kind: 'skip'; reason: 'not_hiring' | 'no_contact'; detail: string };

export function postedDateOf(raw: RawPost, now = new Date()): Date | null {
  return dateFromActivityId(raw.activityId) ?? (raw.relativeTime ? dateFromRelativeTime(raw.relativeTime, now) : null);
}

export function buildProspect(raw: RawPost, campaign: Campaign, now = new Date()): BuildResult {
  const contact = identifyHiringContact(raw);
  const hiringRole = extractHiringRole(raw.postText);
  const posted = postedDateOf(raw, now);

  const qualification = qualify(
    {
      postText: raw.postText,
      headline: contact?.headline ?? '',
      hiringRole,
      postedDate: posted,
      contactSource: contact?.source ?? 'post_author',
      companyAuthored: raw.authorType === 'company',
    },
    campaign,
    now,
  );

  const active = qualification.checks.find((c) => c.key === 'activeHiring');
  if (active?.value !== 'YES') return { kind: 'skip', reason: 'not_hiring', detail: active?.evidence ?? '' };
  if (!contact) return { kind: 'skip', reason: 'no_contact', detail: `Post by ${raw.authorName || 'unknown'} names no identifiable hiring contact` };

  const { company, companyUrl } = pickCompany(raw, contact);
  const geo = detectGeography(raw.postText, contact.headline);
  const ts = now.toISOString();

  return {
    kind: 'prospect',
    prospect: {
      id: crypto.randomUUID(),
      profileUrl: contact.profileUrl,
      profileAliases: [],
      name: contact.name,
      firstName: firstNameOf(contact.name),
      headline: contact.headline,
      company,
      companyUrl,
      hiringRole,
      location: geo.location,
      postUrl: raw.postUrl,
      postText: raw.postText,
      postedDate: posted ? posted.toISOString().slice(0, 10) : '',
      source: 'LinkedIn hiring post',
      contactSource: contact.source,
      qualification,
      // The post only shows degree for the author; "1st" there is a reliable "already connected".
      connectionStatus: contact.source === 'post_author' && raw.authorDegree === '1st' ? 'CONNECTED' : 'UNKNOWN',
      connectionCheckedAt: contact.source === 'post_author' && raw.authorDegree === '1st' ? ts : null,
      outreachStatus: 'NEW',
      message: '',
      campaignId: campaign.id,
      createdAt: ts,
      updatedAt: ts,
    },
  };
}
