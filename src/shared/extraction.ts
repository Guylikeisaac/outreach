// Pure text analysis for LinkedIn hiring posts. Everything here only *reads* what is present in
// the post/headline — nothing is guessed. When a value can't be extracted confidently, return ''.

import type { Persona, RawPost } from './types';
import { normalizeCompanyUrl, normalizeProfileUrl } from './linkedin';

const APOS = "['’]";

// ── Hiring signals ──────────────────────────────────────────────────────────────────────────

/** First-person hiring statements — strong evidence the author's team is actively hiring. */
const STRONG_SIGNALS: [string, RegExp][] = [
  ["We're hiring", new RegExp(`\\bwe${APOS}?re\\s+hiring\\b`, 'i')],
  ['We are hiring', /\bwe\s+are\s+(?:actively\s+)?hiring\b/i],
  ["I'm hiring", new RegExp(`\\bi${APOS}?m\\s+hiring\\b|\\bi\\s+am\\s+hiring\\b`, 'i')],
  ['My/our team is hiring', /\b(?:my|our)\s+team\s+is\s+(?:now\s+)?hiring\b/i],
  ['Join our team', /\bjoin\s+(?:our|my)\s+(?:team|squad|crew)\b/i],
  ['Hiring now', /\bhiring\s+now\b|\bnow\s+hiring\b/i],
  ['Open roles', /\bopen\s+(?:roles?|positions?|requisitions?)\b/i],
  ["We're looking for", new RegExp(`\\bwe${APOS}?re\\s+looking\\s+for\\b|\\bwe\\s+are\\s+looking\\s+for\\b`, 'i')],
  ['Team expansion', /\b(?:team\s+expansion|expanding\s+(?:our|the|my)\s+team|growing\s+(?:our|the|my)\s+team)\b/i],
];

/** Weaker signals — count only when combined with other evidence. */
const WEAK_SIGNALS: [string, RegExp][] = [
  ['Hiring', /(?:^|[\s#])hiring\b/i],
  ['Looking for', /\blooking\s+for\b/i],
  ['Careers', /\bcareers?\s+(?:page|at)\b/i],
  ['Open positions', /\bopenings?\b|\bvacanc(?:y|ies)\b/i],
  ['Apply / send CV', /\b(?:apply|send|share|drop|dm)\b[^.\n]{0,40}\b(?:cv|resume|résumé|profile|jd)\b|\bapply\s+(?:here|now|via|at|through)\b|\blink\s+(?:to\s+apply|in\s+comments?)\b/i],
  ['DM me', /\bdm\s+me\b|\breach\s+out\s+to\s+me\b|\bsend\s+me\s+(?:a\s+)?(?:dm|message)\b/i],
];

/** Posts by job seekers or about the job market, not by someone hiring. */
const JOB_SEEKER = [
  /#?open\s*to\s*work\b/i,
  new RegExp(`\\bi${APOS}?m\\s+(?:actively\\s+)?(?:looking|seeking)\\s+for\\s+(?:a\\s+)?(?:new\\s+)?(?:job|role|position|opportunit)`, 'i'),
  /\bi\s+am\s+(?:actively\s+)?(?:looking|seeking)\s+(?:for\s+)?(?:a\s+)?(?:new\s+)?(?:job|role|position|opportunit)/i,
  /\b(?:seeking|looking\s+for)\s+(?:new\s+)?(?:job\s+)?opportunities\b/i,
  /\bhire\s+me\b/i,
  /\b(?:i\s+was|i\s+got|recently)\s+laid\s+off\b/i,
  /\bimmediate\s+joiner\b[^.\n]{0,30}\bmyself\b/i,
];

const NOT_HIRING_CONTEXT = [/\bhiring\s+(?:freeze|trends?|market|process\s+is\s+broken|is\s+broken)\b/i, /\blayoffs?\b/i];

const SPAM = [
  /\bregistration\s+fee\b/i,
  /\bpay\s+(?:a\s+)?(?:fee|deposit)\b/i,
  /\bno\s+investment\b/i,
  /\bearn\s+(?:₹|rs\.?|inr)?\s*\d[\d,]*\s*(?:per|\/)\s*(?:day|week)\b/i,
  /\bwork\s+from\s+home\s+and\s+earn\b/i,
  /\bpart[-\s]?time\s+job\s+for\s+students\b.*\bearn\b/i,
];

export interface HiringSignals {
  strong: string[];
  weak: string[];
  jobSeeker: boolean;
  notHiringContext: boolean;
  spam: boolean;
}

export function detectHiringSignals(text: string): HiringSignals {
  return {
    strong: STRONG_SIGNALS.filter(([, re]) => re.test(text)).map(([l]) => l),
    weak: WEAK_SIGNALS.filter(([, re]) => re.test(text)).map(([l]) => l),
    jobSeeker: JOB_SEEKER.some((re) => re.test(text)),
    notHiringContext: NOT_HIRING_CONTEXT.some((re) => re.test(text)),
    spam: SPAM.some((re) => re.test(text)),
  };
}

// ── Role extraction ────────────────────────────────────────────────────────────────────────

const ROLE_NOUN =
  /\b(?:engineers?|developers?|programmers?|architects?|designers?|managers?|leads?|heads?|directors?|analysts?|scientists?|interns?|internships?|associates?|executives?|specialists?|consultants?|recruiters?|marketers?|sde\s*-?\s*(?:i{1,3}|[1-3])?|sdes|sres?|devops|qa|testers?|writers?|editors?|accountants?|officers?|coordinators?|representatives?|administrators?|strategists?|researchers?|generalists?|trainees?|freshers?|vp|cto|cfo|coo|cmo|founding\s+\w+|mts|members?\s+of\s+technical\s+staff|bdes?|bdrs?|sdrs?|account\s+executives?|product\s+owners?)\b/i;

const ROLE_PATTERNS: RegExp[] = [
  new RegExp(`\\b(?:we${APOS}?re|we\\s+are|i${APOS}?m|i\\s+am|team\\s+is|is|are|currently|actively)\\s+hiring\\s+(?:for\\s+)?(?:(?:an?|the|multiple|several|\\d+)\\s+)?(?<role>[^.!?\\n:;#()|•]{3,70})`, 'i'),
  /\bhiring\s*(?:for|:|-|–)\s*(?:(?:an?|the)\s+)?(?<role>[^.!?\n;#()|•]{3,70})/i,
  new RegExp(`\\b(?:we${APOS}?re|we\\s+are|i${APOS}?m|i\\s+am)\\s+looking\\s+for\\s+(?:(?:an?|the)\\s+)?(?:(?:talented|passionate|experienced|driven|skilled|strong|great)\\s+)*(?<role>[^.!?\\n:;#()|•]{3,70})`, 'i'),
  /\b(?:role|position|opening|job\s+title|designation)\s*[:\-–]\s*(?<role>[^\n|•]{3,70})/i,
  /\bopen\s+(?:roles?|positions?)\s*[:\-–]\s*(?<role>[^\n|•]{3,70})/i,
  /\bhiring\s+(?:an?\s+)?(?<role>[^.!?\n:;#()|•]{3,70})/i,
];

const ROLE_STOP =
  /\s+(?:in|at|to\s+join|to\s+help|who|with|for\s+(?:our|a|an|the|my)|based|located|from|and\s+(?:we|you|if)|if|remote|onsite|on-site|hybrid|immediately|asap|urgently|\bexp\b|experience|\d+\s*(?:\+|-)?\s*(?:yrs?|years?))\b|\s+[-–—]\s+|[,/]/i;

function cleanRole(raw: string): string {
  let role = raw.split(ROLE_STOP)[0] ?? '';
  role = role
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
    .replace(/^(?:an?|the|our|my|multiple|several|\d+)\s+/i, '')
    .replace(/[\s"'“”‘’*_]+$/g, '')
    .replace(/^[\s"'“”‘’*_]+/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+(?:roles?|positions?|openings?|profiles?)$/i, '')
    .trim();
  const words = role.split(' ');
  if (words.length > 7 || words.length === 0) return '';
  if (!ROLE_NOUN.test(role)) return '';
  // Reject roles that are clearly not job titles ("looking for opportunities", "managers who…")
  if (/\b(?:opportunit|job|role|position|someone|people|candidates|talent)\b/i.test(role)) return '';
  // Title-case fully-lowercase roles; keep original casing otherwise (preserves "SDE", "iOS").
  if (role === role.toLowerCase()) role = role.replace(/\b[a-z]/g, (c) => c.toUpperCase());
  return role;
}

/** Returns the hiring role stated in the post, or '' when none is stated clearly. */
export function extractHiringRole(text: string): string {
  const flat = text.replace(/\r/g, '');
  for (const re of ROLE_PATTERNS) {
    const all = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    for (const m of flat.matchAll(all)) {
      const role = cleanRole(m.groups?.role ?? '');
      if (role) return role;
    }
  }
  return '';
}

// ── Geography ──────────────────────────────────────────────────────────────────────────────

const INDIA_PLACES: [string, RegExp][] = [
  ['Bengaluru', /\b(?:bengaluru|bangalore|blr)\b/i],
  ['Mumbai', /\b(?:mumbai|bombay|navi\s+mumbai|thane)\b/i],
  ['Delhi NCR', /\b(?:delhi(?:\s*ncr)?|new\s+delhi|ncr)\b/i],
  ['Gurugram', /\b(?:gurugram|gurgaon)\b/i],
  ['Noida', /\bnoida\b/i],
  ['Hyderabad', /\b(?:hyderabad|secunderabad)\b/i],
  ['Pune', /\bpune\b/i],
  ['Chennai', /\b(?:chennai|madras)\b/i],
  ['Kolkata', /\b(?:kolkata|calcutta)\b/i],
  ['Ahmedabad', /\bahmedabad\b/i],
  ['Jaipur', /\bjaipur\b/i],
  ['Kochi', /\b(?:kochi|cochin)\b/i],
  ['Chandigarh', /\bchandigarh\b/i],
  ['Indore', /\bindore\b/i],
  ['Coimbatore', /\bcoimbatore\b/i],
];
const INDIA_GENERIC = /\b(?:india|indian|pan[-\s]?india|bharat)\b|₹|\b\d+(?:\.\d+)?\s*(?:-\s*\d+(?:\.\d+)?\s*)?lpa\b|\binr\b/i;
const FOREIGN =
  /\b(?:usa|u\.s\.|united\s+states|us[-\s]based|san\s+francisco|bay\s+area|new\s+york|nyc|seattle|austin|london|united\s+kingdom|\buk\b|europe|berlin|amsterdam|dubai|uae|abu\s+dhabi|singapore|canada|toronto|australia|sydney|germany|paris|riyadh|saudi)\b/i;

/** Cities that belong to the "Delhi NCR" target. */
const NCR = new Set(['Delhi NCR', 'Gurugram', 'Noida']);

export interface GeoResult {
  india: 'YES' | 'NO' | 'UNKNOWN';
  places: string[]; // canonical Indian place names found
  evidence: string;
  location: string; // display value, '' when nothing found
}

export function detectGeography(...texts: string[]): GeoResult {
  const text = texts.filter(Boolean).join('\n');
  const places = INDIA_PLACES.filter(([, re]) => re.test(text)).map(([name]) => name);
  const generic = INDIA_GENERIC.test(text);
  const remote = /\bremote\b/i.test(text);
  if (places.length || generic) {
    const loc = places.length ? places.join(', ') : 'India';
    return {
      india: 'YES',
      places,
      evidence: places.length ? places.join(', ') : 'India',
      location: remote && !places.length ? 'Remote (India)' : loc,
    };
  }
  const foreign = text.match(FOREIGN);
  if (foreign) return { india: 'NO', places: [], evidence: foreign[0], location: '' };
  return { india: 'UNKNOWN', places: [], evidence: '', location: '' };
}

/** Does the detected geography match the campaign's target locations? */
export function matchesTargetGeography(geo: GeoResult, targets: string[]): 'YES' | 'NO' | 'UNKNOWN' {
  if (geo.india !== 'YES') return geo.india;
  if (targets.length === 0 || targets.includes('India')) return 'YES';
  if (!geo.places.length) return 'UNKNOWN'; // "India" only — city not stated
  const hit = geo.places.some((p) => targets.includes(p) || (NCR.has(p) && targets.some((t) => NCR.has(t))));
  return hit ? 'YES' : 'NO';
}

// ── Persona / headline ─────────────────────────────────────────────────────────────────────

const PERSONA_RULES: [Persona, RegExp][] = [
  ['Co-founder', /\bco[-\s]?founder\b/i],
  ['Founder', /\bfounder\b|\bceo\b|\bchief\s+executive\b|\bmanaging\s+director\b/i],
  ['Talent Acquisition', /\btalent\s+(?:acquisition|partner|lead|sourcing)\b|\bta\s+(?:lead|manager|partner|specialist|head)\b/i],
  ['Recruiter', /\brecruit(?:er|ing|ment)\b|\bhead\s*hunter\b|\bsourcer\b|\bstaffing\b/i],
  ['People Operations', /\bpeople\s+(?:operations|ops|partner|&\s*culture|and\s+culture|team|function)\b|\bhead\s+of\s+people\b|\bchief\s+people\b/i],
  ['HR', /\bhr\b|\bhuman\s+resources?\b|\bhrbp\b/i],
  ['CTO', /\bcto\b|\bchief\s+technology\b|\bchief\s+technical\b/i],
  ['Engineering Leader', /\b(?:vp|vice\s+president|head|director)\s+(?:of\s+)?engineering\b|\bengineering\s+(?:manager|lead|leader|director|head)\b|\bhead\s+of\s+(?:tech|technology)\b|\btech(?:nical)?\s+lead\b/i],
  ['Product Leader', /\b(?:vp|vice\s+president|head|director)\s+(?:of\s+)?product\b|\bcpo\b|\bchief\s+product\b|\bgroup\s+product\s+manager\b|\bproduct\s+(?:lead|head|director)\b/i],
  ['Hiring Manager', /\bhiring\s+manager\b|\bhead\s+of\b|\bdirector\b|\bvp\b|\bvice\s+president\b|\bgeneral\s+manager\b|\bpartner\b/i],
];

export const PERSONA_TO_TARGET: Record<Persona, string> = {
  Founder: 'Founders',
  'Co-founder': 'Co-founders',
  Recruiter: 'Recruiters',
  'Talent Acquisition': 'Talent Acquisition',
  HR: 'HR',
  'People Operations': 'People Operations',
  'Hiring Manager': 'Hiring Managers',
  CTO: 'CTOs',
  'Engineering Leader': 'Engineering Leaders',
  'Product Leader': 'Product Leaders',
};

export function classifyPersona(headline: string): { persona: Persona | null; evidence: string } {
  // Only the "current role" part of a headline — ignore "Ex-Founder", "Former CTO".
  const cleaned = headline.replace(/\b(?:ex|former|previously|prev)[-\s:]+[\w\s-]{0,25}?(?=[|,@•]|$)/gi, ' ');
  for (const [persona, re] of PERSONA_RULES) {
    const m = cleaned.match(re);
    if (m) return { persona, evidence: m[0] };
  }
  return { persona: null, evidence: '' };
}

/** Headlines that clearly describe an individual contributor / student / job seeker. */
export function isIndividualContributorHeadline(headline: string): boolean {
  return /\b(?:student|intern|fresher|aspiring|seeking|open\s+to\s+work|software\s+(?:engineer|developer)|developer|analyst|designer|associate|executive|trainee)\b/i.test(headline);
}

export function headlineMentionsHiring(headline: string): boolean {
  return /#?\bhiring\b|\bwe'?re\s+hiring\b/i.test(headline);
}

/** "Founder @ Example AI", "CEO at Example", "Co-founder, Example | ex-Google" */
export function extractCompanyFromHeadline(headline: string): string {
  const m =
    headline.match(/(?:@|\bat\s)\s*([A-Z0-9][\w&.'\- ]{1,40}?)(?=\s*(?:[|,•(]|\s-\s|\s–\s|$))/) ??
    headline.match(/\b(?:founder|co-?founder|ceo|cto|recruiter|hr)\s*[,\-–]\s*([A-Z0-9][\w&.'\- ]{1,40}?)(?=\s*(?:[|•(]|$))/i);
  if (!m) return '';
  const company = m[1].trim().replace(/[.\s]+$/, '');
  if (!company || /^(?:the|a|an)$/i.test(company)) return '';
  return company;
}

export function firstNameOf(fullName: string): string {
  let name = fullName
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
    .split(/[,(|]/)[0]
    .trim();
  name = name.replace(/^(?:dr|mr|mrs|ms|er|ca|adv|prof|capt)\.?\s+/i, '');
  const first = name.split(/\s+/).find((t) => /\p{L}{2,}/u.test(t)) ?? '';
  const clean = first.replace(/[^\p{L}'-]/gu, '');
  if (!clean) return '';
  return clean === clean.toUpperCase() ? clean[0] + clean.slice(1).toLowerCase() : clean;
}

// ── Contact identification ─────────────────────────────────────────────────────────────────

export interface HiringContact {
  name: string;
  profileUrl: string;
  headline: string;
  source: 'post_author' | 'mentioned_in_post';
}

const CONTACT_PHRASE =
  /\b(?:reach\s+out\s+to|contact|connect\s+with|dm|message|ping|write\s+to|send\s+(?:your\s+)?(?:cv|resume|profile)s?\s+to|share\s+(?:your\s+)?(?:cv|resume|profile)s?\s+(?:with|to)|get\s+in\s+touch\s+with|refer(?:rals)?\s+to)\b/gi;

/**
 * Finds a person *explicitly* named in the post as the hiring contact
 * ("reach out to @Priya Nair"). Returns null unless exactly one such person is found.
 */
export function findExplicitContact(post: RawPost): { name: string; url: string } | null {
  const text = post.postText;
  const hits = new Map<string, { name: string; url: string }>();
  for (const phrase of text.matchAll(CONTACT_PHRASE)) {
    const window = text.slice(phrase.index ?? 0, (phrase.index ?? 0) + phrase[0].length + 60).toLowerCase();
    for (const person of post.mentionedPeople) {
      const url = normalizeProfileUrl(person.url);
      if (url && person.name && window.includes(person.name.toLowerCase())) hits.set(url, { name: person.name, url });
    }
  }
  return hits.size === 1 ? [...hits.values()][0] : null;
}

export function identifyHiringContact(post: RawPost): HiringContact | null {
  const explicit = findExplicitContact(post);
  const authorUrl = normalizeProfileUrl(post.authorUrl);
  if (explicit && explicit.url !== authorUrl) {
    return { name: explicit.name, profileUrl: explicit.url, headline: '', source: 'mentioned_in_post' };
  }
  if (post.authorType === 'person' && authorUrl && post.authorName) {
    return { name: post.authorName, profileUrl: authorUrl, headline: post.authorHeadline, source: 'post_author' };
  }
  // Company-page post with no explicitly named contact: do not guess an employee.
  return null;
}

export function pickCompany(post: RawPost, contact: HiringContact): { company: string; companyUrl: string } {
  if (post.authorType === 'company' && post.authorName) {
    return { company: post.authorName, companyUrl: normalizeCompanyUrl(post.authorUrl) };
  }
  const fromHeadline = extractCompanyFromHeadline(contact.headline);
  if (fromHeadline) {
    const link = post.companyLinks.find((c) => c.name.toLowerCase() === fromHeadline.toLowerCase());
    return { company: fromHeadline, companyUrl: link ? normalizeCompanyUrl(link.url) : '' };
  }
  if (post.companyLinks.length === 1) {
    return { company: post.companyLinks[0].name, companyUrl: normalizeCompanyUrl(post.companyLinks[0].url) };
  }
  return { company: '', companyUrl: '' };
}
