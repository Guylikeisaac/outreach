import { describe, expect, it } from 'vitest';
import type { Campaign, RawPost } from '../src/shared/types';
import {
  classifyPersona,
  detectGeography,
  extractCompanyFromHeadline,
  extractHiringRole,
  firstNameOf,
  identifyHiringContact,
} from '../src/shared/extraction';
import { qualify } from '../src/shared/qualification';
import { DEFAULT_TEMPLATE, LEGACY_TEMPLATE, LINKEDIN_NOTE_LIMIT, personalizationLine, renderTemplate, templateIssues, validateMessage } from '../src/shared/message';
import { buildProspect } from '../src/shared/pipeline';
import { dateFromActivityId, dateFromRelativeTime, normalizeProfileUrl } from '../src/shared/linkedin';

const NOW = new Date('2026-09-24T10:00:00Z');

const campaign: Campaign = {
  id: 'c1',
  name: 'Indian Startup Hiring',
  searchQueries: ['startup hiring India'],
  targetRoles: ['Founders', 'Co-founders', 'Recruiters', 'Talent Acquisition', 'HR', 'Hiring Managers', 'CTOs'],
  targetLocations: ['India'],
  dailyTarget: 20,
  createdAt: '',
  updatedAt: '',
};

function post(over: Partial<RawPost>): RawPost {
  return {
    postUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:7000000000000000000/',
    activityId: '',
    authorName: 'Rahul Sharma',
    authorUrl: 'https://www.linkedin.com/in/rahul-sharma-123?miniProfileUrn=abc',
    authorType: 'person',
    authorHeadline: 'Founder @ Example AI | Ex-Flipkart',
    authorDegree: '2nd',
    relativeTime: '2d',
    postText: "We're hiring a Senior Backend Engineer in Bengaluru! DM me or apply via the link.",
    companyLinks: [],
    mentionedPeople: [],
    ...over,
  };
}

describe('role extraction', () => {
  it.each([
    ["We're hiring a Senior Backend Engineer in Bengaluru!", 'Senior Backend Engineer'],
    ['We are hiring for SDE-2 roles at Acme', 'SDE-2'],
    ['Hiring: Product Designer (Remote, India)', 'Product Designer'],
    ["I'm hiring founding engineers to join our team", 'Founding Engineers'],
    ['We are looking for a talented Frontend Developer with 3+ years experience', 'Frontend Developer'],
    ['Role: Data Scientist\nLocation: Pune', 'Data Scientist'],
    ['Open to work! Looking for new opportunities', ''],
    ['Hiring is broken and here is why', ''],
    ['We are hiring! Join our team.', ''],
  ])('%s → %s', (text, role) => {
    expect(extractHiringRole(text)).toBe(role);
  });
});

describe('persona', () => {
  it.each([
    ['Co-Founder & CTO at Stackly', 'Co-founder'],
    ['Founder @ Example AI', 'Founder'],
    ['Senior Technical Recruiter | Hiring for SaaS', 'Recruiter'],
    ['Talent Acquisition Lead at Zeta', 'Talent Acquisition'],
    ['HR Manager, Acme Pvt Ltd', 'HR'],
    ['VP Engineering @ Fintech', 'Engineering Leader'],
    ['Ex-Founder | Software Engineer at Google', null],
    ['Software Engineer at Infosys', null],
  ])('%s → %s', (headline, persona) => {
    expect(classifyPersona(headline).persona).toBe(persona);
  });
});

describe('geography', () => {
  it('detects Indian cities and generic India', () => {
    expect(detectGeography('Location: Bangalore / Gurgaon').places).toEqual(['Bengaluru', 'Gurugram']);
    expect(detectGeography('CTC 12-18 LPA').india).toBe('YES');
    expect(detectGeography('Remote role for our London office').india).toBe('NO');
    expect(detectGeography('We are hiring engineers').india).toBe('UNKNOWN');
  });
});

describe('helpers', () => {
  it('first names', () => {
    expect(firstNameOf('Rahul Sharma')).toBe('Rahul');
    expect(firstNameOf('Dr. Priya Nair, PhD')).toBe('Priya');
    expect(firstNameOf('ANKIT GUPTA 🚀')).toBe('Ankit');
  });
  it('company from headline', () => {
    expect(extractCompanyFromHeadline('Founder @ Example AI | Ex-Flipkart')).toBe('Example AI');
    expect(extractCompanyFromHeadline('Recruiter at Zeta Suite')).toBe('Zeta Suite');
    expect(extractCompanyFromHeadline('Building cool things')).toBe('');
  });
  it('profile URLs', () => {
    expect(normalizeProfileUrl('https://www.linkedin.com/in/Rahul-Sharma-123/?trk=x')).toBe('https://www.linkedin.com/in/rahul-sharma-123/');
    expect(normalizeProfileUrl('https://in.linkedin.com/in/rahul/')).toBe('https://www.linkedin.com/in/rahul/');
    expect(normalizeProfileUrl('https://www.linkedin.com/company/acme/')).toBe('');
  });
  it('dates', () => {
    // 7200000000000000000 >> 22 ≈ 2024-05
    expect(dateFromActivityId('7200000000000000000')?.getUTCFullYear()).toBe(2024);
    expect(dateFromRelativeTime('3d •', NOW)?.toISOString().slice(0, 10)).toBe('2026-09-21');
  });
});

describe('qualification', () => {
  it('founder hiring in Bengaluru → HIGH', () => {
    const r = buildProspect(post({}), campaign, NOW);
    expect(r.kind).toBe('prospect');
    if (r.kind !== 'prospect') return;
    const p = r.prospect;
    expect(p.qualification.level).toBe('HIGH');
    expect(p.hiringRole).toBe('Senior Backend Engineer');
    expect(p.company).toBe('Example AI');
    expect(p.location).toBe('Bengaluru');
    expect(p.profileUrl).toBe('https://www.linkedin.com/in/rahul-sharma-123/');
    expect(p.qualification.reasons).toContain('✓ Founder');
  });

  it('job seeker post is not a prospect', () => {
    const r = buildProspect(post({ postText: 'I am looking for a new role as a backend engineer. #OpenToWork. Hiring managers, please DM!' }), campaign, NOW);
    expect(r.kind).toBe('skip');
  });

  it('software engineer sharing a hiring post without India → LOW', () => {
    const q = qualify(
      { postText: 'My company is hiring a Data Engineer, link in comments', headline: 'Software Engineer at X', hiringRole: 'Data Engineer', postedDate: NOW, contactSource: 'post_author', companyAuthored: false },
      campaign,
      NOW,
    );
    expect(q.level).toBe('LOW');
    expect(q.eligible).toBe(false);
  });

  it('non-India hiring is excluded', () => {
    const r = buildProspect(post({ postText: "We're hiring a Backend Engineer in London, UK." }), campaign, NOW);
    expect(r.kind === 'prospect' && r.prospect.qualification.level).toBe('LOW');
  });

  it('city targeting', () => {
    const blr = { ...campaign, targetLocations: ['Bengaluru' as const] };
    const r = buildProspect(post({ postText: "We're hiring a Backend Engineer in Pune." }), blr, NOW);
    expect(r.kind === 'prospect' && r.prospect.qualification.level).toBe('LOW');
  });

  it('company page post without named contact is skipped (no random employees)', () => {
    const r = buildProspect(post({ authorType: 'company', authorName: 'Acme', authorUrl: 'https://www.linkedin.com/company/acme/', authorHeadline: '12,000 followers' }), campaign, NOW);
    expect(r).toMatchObject({ kind: 'skip', reason: 'no_contact' });
  });

  it('company post that names a hiring contact uses that person', () => {
    const raw = post({
      authorType: 'company',
      authorName: 'Acme',
      authorUrl: 'https://www.linkedin.com/company/acme/',
      postText: "We're hiring a Product Manager in Mumbai! Reach out to Priya Nair with your resume.",
      mentionedPeople: [{ name: 'Priya Nair', url: 'https://www.linkedin.com/in/priyanair/' }],
    });
    expect(identifyHiringContact(raw)?.profileUrl).toBe('https://www.linkedin.com/in/priyanair/');
    const r = buildProspect(raw, campaign, NOW);
    expect(r.kind === 'prospect' && r.prospect.qualification.level).toBe('MEDIUM');
    expect(r.kind === 'prospect' && r.prospect.company).toBe('Acme');
  });

  it('1st-degree author is marked connected', () => {
    const r = buildProspect(post({ authorDegree: '1st' }), campaign, NOW);
    expect(r.kind === 'prospect' && r.prospect.connectionStatus).toBe('CONNECTED');
  });

  it('old posts are not recommended', () => {
    const r = buildProspect(post({ relativeTime: '3mo' }), campaign, NOW);
    expect(r.kind === 'prospect' && r.prospect.qualification.level).toBe('LOW');
  });
});

describe('message', () => {
  it('default is a short greeting with the first name', () => {
    expect(DEFAULT_TEMPLATE).toBe('Hi {first_name}');
    expect(renderTemplate(DEFAULT_TEMPLATE, 'Pravin', 'Backend Engineer')).toBe('Hi Pravin');
    expect(templateIssues(DEFAULT_TEMPLATE)).toEqual([]);
  });
  it('personalization line uses only the extracted role, with correct articles', () => {
    expect(personalizationLine('Senior Backend Engineer')).toBe("Saw you're hiring a Senior Backend Engineer.");
    expect(personalizationLine('SDE-2')).toBe("Saw you're hiring an SDE-2.");
    expect(personalizationLine('Backend Engineers')).toBe("Saw you're hiring Backend Engineers.");
    expect(personalizationLine('UX Designer')).toBe("Saw you're hiring a UX Designer.");
    expect(personalizationLine('')).toBe('');
  });
  it('enforces the 200-character limit', () => {
    expect(LINKEDIN_NOTE_LIMIT).toBe(200);
    expect(validateMessage('x'.repeat(201), 'x').some((i) => i.level === 'error')).toBe(true);
    expect(validateMessage('[First Name], hi', '').some((i) => i.level === 'error')).toBe(true);
    expect(templateIssues(LEGACY_TEMPLATE).some((i) => /Too long/.test(i))).toBe(true);
  });
  it('drops the hiring line rather than exceed the limit', () => {
    const t = `{first_name}, ${'x'.repeat(170)}\n{hiring_line}`;
    expect(renderTemplate(t, 'Rahul', 'Senior Backend Engineer')).not.toContain('Saw you');
  });
});

describe('message template', () => {
  it('custom template replaces the name', () => {
    const t = 'Hi {first_name}, this is Shruti from SyncUp 👋\n{hiring_line}\nWould love to connect!';
    expect(renderTemplate(t, 'Sreeja', '')).toBe('Hi Sreeja, this is Shruti from SyncUp 👋\nWould love to connect!');
    expect(renderTemplate(t, 'Sreeja', 'Data Analyst')).toContain("Saw you're hiring a Data Analyst.");
  });
  it('flags missing name token and unknown tokens', () => {
    expect(templateIssues('Hi Shruti, hello')).toHaveLength(1);
    expect(templateIssues('Hi {first_name} {company}')[0]).toMatch(/Unknown/);
  });
});
