// SyncUp outreach message generation. The template is fixed; the only personalization is a single
// line built from the hiring role that was actually extracted from the prospect's post.

export const LINKEDIN_NOTE_LIMIT = 300;

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
    issues.push({ level: 'error', text: `LinkedIn notes are limited to ${LINKEDIN_NOTE_LIMIT} characters.` });
  else if (message.length > 200)
    issues.push({ level: 'warn', text: 'Some free LinkedIn accounts cap notes at 200 characters — the page limit is checked before inserting.' });
  if (firstName && !message.includes(firstName)) issues.push({ level: 'warn', text: `Message doesn't address ${firstName} by name.` });
  return issues;
}
