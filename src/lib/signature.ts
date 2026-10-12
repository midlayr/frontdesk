/**
 * A rep's sign-off, built from the records rather than typed out.
 *
 * Four lines, always in the same order:
 *
 *   Name
 *   Title
 *   Company
 *   Phone | Email
 *
 * Only the title and the phone are stored per person. The name and email are already on
 * their user record and the company is the shop's — asking somebody to retype those into a
 * free-text box is how you end up with seven signatures that disagree about the company's
 * name, and one that still says a rep who left.
 *
 * A line with nothing in it is dropped rather than left blank, and the last line collapses
 * to whichever of phone and email exists.
 */

export interface SignatureFields {
  title?: string;
  phone?: string;
}

export interface SignatureWho {
  name: string;
  email: string;
}

/** Only the two keys, trimmed, blanks dropped — the same gate used on the way in and out. */
export function signatureFields(raw: unknown): SignatureFields {
  const src = (raw ?? {}) as Record<string, unknown>;
  const out: SignatureFields = {};
  for (const k of ['title', 'phone'] as const) {
    const v = src[k];
    if (typeof v === 'string' && v.trim()) out[k] = v.trim();
  }
  return out;
}

export function renderSignature(who: SignatureWho, company: string, f: SignatureFields): string {
  const contact = [f.phone, who.email].filter((v) => v && v.trim()).join(' | ');
  return [who.name, f.title, company, contact]
    .map((l) => (l ?? '').trim())
    .filter(Boolean)
    .join('\n');
}
