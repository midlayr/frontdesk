/**
 * The tenant's allowlist of websites, shared by everything that checks one.
 *
 * org.widget.allowed_domains gates two public, unauthenticated endpoints — /widget/config
 * for the chat widget and /hooks/form for website quote forms. It is therefore the one piece
 * of install configuration that can make a perfectly correct script tag do nothing at all,
 * and the only evidence is a CORS message in the console of the shop's own website.
 */

/**
 * Hostname only, however it was typed.
 *
 * Someone copying their site address will paste "https://www.dumontprinting.com/quotes",
 * which can never match: the check compares against a hostname. Rather than rejecting it and
 * explaining the distinction, take the hostname out of whatever arrives.
 *
 * Returns null for anything that is not a hostname, so the caller can report it instead of
 * saving a value that will silently never match.
 */
export function hostOnly(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  if (!v) return null;
  if (v === '*') return '*';
  // Refused rather than interpreted. URL() reads what is before an @ as userinfo, so
  // "summer@dumontprinting.com" would otherwise quietly add dumontprinting.com to a
  // security-relevant allowlist on the strength of a guess about what was meant.
  if (v.includes('@')) return null;
  let host: string;
  try {
    host = new URL(v.includes('://') ? v : `https://${v}`).hostname;
  } catch {
    return null;
  }
  // localhost is let through for anyone testing against a local copy of their own site.
  if (host === 'localhost') return host;
  // A hostname, not label soup: at least one dot, every label alphanumeric with inner dashes.
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)
    ? host : null;
}

/** Clean a submitted list: hostnames only, de-duplicated, with the rest reported back. */
export function cleanDomains(raw: string[]): { domains: string[]; rejected: string[] } {
  const domains = [...new Set(raw.map(hostOnly).filter((d): d is string => d !== null))];
  const rejected = raw.filter((d) => d.trim() && hostOnly(d) === null);
  return { domains, rejected };
}
