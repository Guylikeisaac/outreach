// Optional Claude-written personalization line. The model only sees the prospect's public hiring
// post; its output is validated so it can't introduce facts that aren't in that post. On any
// failure the deterministic template line is used instead.

import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-opus-5';

const SYSTEM = `You write ONE short opening line for a LinkedIn connection note from SyncUp (a free Indian hiring platform) to someone who posted about hiring.

Rules:
- Output only the line, nothing else. Max 70 characters. Start with "Saw you're hiring".
- Mention only the role(s) stated in the post. Use the post's own wording for the role.
- Never mention funding, investors, company size, growth numbers, candidate numbers, personal details, or anything not written in the post.
- No hashtags, no emojis, no flattery, no questions.
- If the post does not clearly state a role, output exactly: NONE`;

/** Every word in the line (beyond a small allowlist) must appear in the post. */
export function isGrounded(line: string, postText: string): boolean {
  const allowed = new Set([
    "saw", "you're", 'you’re', 'you', 'are', 'hiring', 'a', 'an', 'the', 'for', 'and', 'your', 'team', 'role', 'roles',
    'at', 'in', 'on', 'to', 'of', 'with', 'new', 'open', 'some', 'few', 'multiple', 'folks', 'people',
  ]);
  const post = postText.toLowerCase();
  const words = line.toLowerCase().replace(/[.,!:;()"]/g, ' ').split(/\s+/).filter(Boolean);
  return words.every((w) => allowed.has(w) || post.includes(w) || post.includes(w.replace(/s$/, '')));
}

export async function aiPersonalizationLine(apiKey: string, postText: string, hiringRole: string): Promise<string | null> {
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 1, timeout: 30_000 });
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 1024,
    betas: ['server-side-fallback-2026-07-01'],
    ...({ fallbacks: 'default' } as object),
    output_config: { effort: 'low' },
    system: SYSTEM,
    messages: [
      {
        role: 'user',
        content: `Hiring post:\n"""\n${postText.slice(0, 3000)}\n"""\nRole extracted by our parser (may be empty): ${hiringRole || '(none)'}`,
      },
    ],
  });
  if (response.stop_reason === 'refusal') return null;
  const text = response.content
    .flatMap((b) => (b.type === 'text' ? [b.text] : []))
    .join('')
    .trim()
    .split('\n')[0]
    .trim();
  if (!text || text === 'NONE') return null;
  if (!/^Saw you(?:'|’)re hiring\b/.test(text) || text.length > 80 || /\d/.test(text) && !/\d/.test(postText)) return null;
  if (!isGrounded(text, postText)) return null;
  return /[.!]$/.test(text) ? text : `${text}.`;
}
