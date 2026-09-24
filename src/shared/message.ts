// SyncUp outreach message generation. The template is fixed; the only personalization is a single
// line built from the hiring role that was actually extracted from the prospect's post.

/** Kept at 200 so notes fit free LinkedIn accounts too (Premium allows 300). */
export const LINKEDIN_NOTE_LIMIT = 200;

const BODY = [
  'We’re building SyncUp, India’s own LinkedIn.',
  'Early days, so everything’s free.',
  'If you’re hiring, share a JD and support us while we build for India!',
  'We’ll send pre-screened candidates.',
];

const PLURAL_TAIL = /\b(?:engineers|developers|designers|interns|managers|analysts|scientists|leads|associates|executives|recruiters|marketers|sdes|freshers|trainees|architects|specialists|consultants|writers|testers)$/i;

function article(role: string): string {
  if (PLURAL_TAIL.test(role)) return '';
  const first = role.split(/\s+/)[0];
  if (/^[A-Z]{2,}(?:[-\d]|$)/.test(first)) return /^[AEFHILMNORSX]/.test(first) ? 'an ' : 'a ';
  if (/^(?:uni|use|usu|eu|one)/i.test(first)) return 'a ';
  if (/^(?:hour|honest)/i.test(first)) return 'an ';
  return /^[aeiou]/i.test(first) ? 'an ' : 'a ';
}

/**
 * Default template: a short greeting. Tokens: {first_name} (required) and optional {hiring_line}
 * (the "Saw you're hiring…" line, removed when no role was found in the post).
 */
export const DEFAULT_TEMPLATE = 'Hi {first_name}';

/** The original long SyncUp pitch (≈260 chars — over the 200 limit); kept as a reference/preset. */
export const LEGACY_TEMPLATE = [
  '{first_name}, not selling anything 😄',
  '{hiring_line}',
  ...BODY,
].join('\n');

/** Renders a user template for one prospect. Unknown data is never invented: tokens without data are removed. */
export function renderTemplate(template: string, firstName: string, hiringRole: string, aiLine?: string | null): string {
  const line = aiLine || personalizationLine(hiringRole);
  const fill = (withLine: boolean) =>
    template
      .replace(/\{\s*first[_ ]?name\s*\}/gi, firstName.trim())
      .replace(/^[ \t]*\{\s*hiring[_ ]?line\s*\}[ \t]*\r?\n?/gim, withLine && line ? `${line}\n` : '')
      .replace(/\{\s*hiring[_ ]?line\s*\}/gi, withLine && line ? line : '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  const full = fill(true);
  return full.length <= LINKEDIN_NOTE_LIMIT ? full : fill(false);
}

export function templateIssues(template: string): string[] {
  const issues: string[] = [];
  if (!/\{\s*first[_ ]?name\s*\}/i.test(template)) issues.push('Add {first_name} where the person’s name should go.');
  const unknown = template.match(/\{[^}]*\}/g)?.filter((t) => !/^\{\s*(?:first[_ ]?name|hiring[_ ]?line)\s*\}$/i.test(t)) ?? [];
  if (unknown.length) issues.push(`Unknown placeholder(s): ${unknown.join(', ')}. Use {first_name} or {hiring_line}.`);
  const preview = renderTemplate(template, 'Priyadarshini', '');
  if (preview.length > LINKEDIN_NOTE_LIMIT) issues.push(`Too long: ${preview.length}/${LINKEDIN_NOTE_LIMIT} characters with a long name.`);
  return issues;
}

export function personalizationLine(hiringRole: string): string {
  const role = hiringRole.trim();
  if (!role || role.length > 45) return '';
  return `Saw you're hiring ${article(role)}${role}.`;
}

export function buildMessage(firstName: string, personalization = ''): string {
  const name = firstName.trim();
  const opener = personalization ? `${name}, not selling anything 😄` : `${name}, Not selling anything 😄`;
  const lines = [opener, ...(personalization ? [personalization] : []), ...BODY];
  return lines.join('\n');
}

/** Builds the message, dropping personalization if it would exceed LinkedIn's note limit. */
export function generateMessage(firstName: string, hiringRole: string, aiLine?: string | null): string {
  const line = aiLine || personalizationLine(hiringRole);
  const personalized = buildMessage(firstName, line);
  return personalized.length <= LINKEDIN_NOTE_LIMIT ? personalized : buildMessage(firstName);
}

export interface MessageIssue {
  level: 'error' | 'warn';
  text: string;
}

export function validateMessage(message: string, firstName: string): MessageIssue[] {
  const issues: MessageIssue[] = [];
  if (!message.trim()) issues.push({ level: 'error', text: 'Message is empty.' });
  if (/\[first name\]/i.test(message)) issues.push({ level: 'error', text: 'Replace the [First Name] placeholder.' });
  if (message.length > LINKEDIN_NOTE_LIMIT)
    issues.push({ level: 'error', text: `Keep the message under ${LINKEDIN_NOTE_LIMIT} characters (it is ${message.length}).` });
  if (firstName && !message.includes(firstName)) issues.push({ level: 'warn', text: `Message doesn't address ${firstName} by name.` });
  return issues;
}
