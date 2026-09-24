// Prospect qualification. Deterministic, evidence-based, and explainable: every check records the
// text that justified it, and UNKNOWN is used whenever the evidence isn't there.

import type { Campaign, QualificationCheck, QualificationResult, Tri } from './types';
import {
  PERSONA_TO_TARGET,
  classifyPersona,
  detectGeography,
  detectHiringSignals,
  headlineMentionsHiring,
  isIndividualContributorHeadline,
  matchesTargetGeography,
} from './extraction';

export interface QualificationInput {
  postText: string;
  headline: string;
  hiringRole: string;
  postedDate: Date | null;
  contactSource: 'post_author' | 'mentioned_in_post';
  /** True when the post author is a company page (not a person). */
  companyAuthored: boolean;
}

const DAY = 864e5;
const RECENT_DAYS = 14;
const STALE_DAYS = 45;

function mark(v: Tri): string {
  return v === 'YES' ? '✓' : v === 'NO' ? '✗' : '?';
}

export function qualify(
  input: QualificationInput,
  campaign: Pick<Campaign, 'targetRoles' | 'targetLocations'>,
  now = new Date(),
): QualificationResult {
  const signals = detectHiringSignals(input.postText);
  const { persona } = classifyPersona(input.headline);
  const geo = detectGeography(input.postText, input.headline);
  const geoMatch = matchesTargetGeography(geo, campaign.targetLocations);

  // 1. Active hiring
  let activeHiring: Tri = 'NO';
  let hiringEvidence = '';
  if (signals.spam) hiringEvidence = 'Looks like a paid/spam job scheme';
  else if (signals.jobSeeker && !signals.strong.length) hiringEvidence = 'Job-seeker post, not a hiring post';
  else if (signals.strong.length) {
    activeHiring = 'YES';
    hiringEvidence = signals.strong[0];
  } else if (signals.weak.includes('Hiring') && !signals.notHiringContext && (input.hiringRole || signals.weak.length >= 2)) {
    activeHiring = 'YES';
    hiringEvidence = input.hiringRole ? `Hiring: ${input.hiringRole}` : signals.weak.join(', ');
  } else if (signals.notHiringContext) hiringEvidence = 'Discusses hiring/layoffs, not an opening';
  else hiringEvidence = 'No clear hiring statement';

  // 2. India (and campaign geography)
  const india: Tri = geoMatch;
  const indiaEvidence =
    geoMatch === 'NO' && geo.india === 'YES' ? `${geo.evidence} (outside target cities)` : geo.evidence;

  // 3. Involved in hiring
  let involved: Tri = 'UNKNOWN';
  let involvedEvidence = '';
  if (input.contactSource === 'mentioned_in_post') {
    involved = 'YES';
    involvedEvidence = 'Named as hiring contact in the post';
  } else if (persona && ['Recruiter', 'Talent Acquisition', 'HR', 'People Operations'].includes(persona)) {
    involved = 'YES';
    involvedEvidence = 'Works in recruiting / people team';
  } else if (!input.companyAuthored && activeHiring === 'YES' && (signals.strong.length || signals.weak.includes('DM me'))) {
    involved = 'YES';
    involvedEvidence = 'Posted the hiring announcement';
  } else if (headlineMentionsHiring(input.headline)) {
    involved = 'YES';
    involvedEvidence = 'Headline mentions hiring';
  }

  // 4. Decision maker / relevant hiring contact (per campaign target roles)
  let decisionMaker: Tri = 'UNKNOWN';
  let dmEvidence = '';
  if (persona) {
    const targeted = campaign.targetRoles.length === 0 || campaign.targetRoles.includes(PERSONA_TO_TARGET[persona] as never);
    decisionMaker = targeted ? 'YES' : 'NO';
    dmEvidence = targeted ? persona : `${persona} (not a target role)`;
  } else if (input.headline && isIndividualContributorHeadline(input.headline)) {
    decisionMaker = 'NO';
    dmEvidence = 'Individual contributor headline';
  }

  // 5. Role relevance — SyncUp can source for any genuine role; spam is never relevant.
  const roleRelevant: Tri = signals.spam ? 'NO' : input.hiringRole ? 'YES' : 'UNKNOWN';

  // 6. Recency
  let recent: Tri = 'UNKNOWN';
  let recentEvidence = '';
  if (input.postedDate) {
    const days = Math.max(0, Math.floor((now.getTime() - input.postedDate.getTime()) / DAY));
    recent = days <= RECENT_DAYS ? 'YES' : days > STALE_DAYS ? 'NO' : 'UNKNOWN';
    recentEvidence = days === 0 ? 'today' : `${days}d ago`;
  }

  const checks: QualificationCheck[] = [
    { key: 'activeHiring', label: 'Active hiring post', value: activeHiring, evidence: hiringEvidence },
    { key: 'india', label: 'India', value: india, evidence: indiaEvidence },
    { key: 'involvedInHiring', label: 'Involved in hiring', value: involved, evidence: involvedEvidence },
    { key: 'decisionMaker', label: 'Decision maker', value: decisionMaker, evidence: dmEvidence },
    { key: 'roleRelevant', label: 'Role', value: roleRelevant, evidence: input.hiringRole },
    { key: 'recent', label: 'Posted recently', value: recent, evidence: recentEvidence },
  ];

  const disqualified =
    activeHiring !== 'YES' ||
    india === 'NO' ||
    roleRelevant === 'NO' ||
    recent === 'NO' ||
    (decisionMaker === 'NO' && involved !== 'YES');

  let level: QualificationResult['level'] = 'LOW';
  if (!disqualified) {
    const strongCount = [decisionMaker, involved, india].filter((v) => v === 'YES').length;
    if (decisionMaker === 'YES' && involved === 'YES' && india === 'YES') level = 'HIGH';
    else if (strongCount >= 2) level = 'MEDIUM';
  }

  const reasons = checks.map((c) => {
    switch (c.key) {
      case 'activeHiring':
        return `${mark(c.value)} ${c.value === 'YES' ? 'Active hiring' : c.evidence || 'Not an active hiring post'}`;
      case 'india':
        return c.value === 'YES' ? `✓ ${c.evidence || 'India'}` : c.value === 'NO' ? `✗ ${c.evidence || 'Outside India'}` : '? Location not stated';
      case 'involvedInHiring':
        return c.value === 'YES' ? `✓ ${c.evidence}` : '? Hiring involvement unclear';
      case 'decisionMaker':
        return c.value === 'YES' ? `✓ ${c.evidence}` : c.value === 'NO' ? `✗ ${c.evidence}` : '? Seniority unclear';
      case 'roleRelevant':
        return c.value === 'YES' ? `✓ Hiring ${c.evidence}` : c.value === 'NO' ? '✗ Not a genuine role' : '? Role not stated';
      case 'recent':
        return c.value === 'YES' ? `✓ Posted recently (${c.evidence})` : c.value === 'NO' ? `✗ Old post (${c.evidence})` : '? Post date unclear';
    }
  });

  return { level, eligible: level !== 'LOW', persona, checks, reasons };
}
