/**
 * Why a quote letter could not be fetched, in words a rep can act on.
 *
 * Its own file, with no imports, so the browser can take it: pace.ts type-imports Env and
 * that drags in the Workers globals. The alternative was a second copy in the client, and
 * a duplicated list is exactly how the token list drifted and blocked saving.
 */

export type PdfFailure =
  | 'bad_number'        // 400 — not an estimate number Pace recognises
  | 'auth'              // 401 — key missing, wrong, or revoked
  | 'estimate_not_found'
  | 'no_quote_letter'   // the estimate exists but has never had one
  | 'upstream'          // 502 — Pace could not generate it
  | 'unreachable'       // tunnel down, DNS, timeout
  | 'not_configured';   // no URL or key on our side

export const PDF_REASON: Record<PdfFailure, string> = {
  bad_number: 'that estimate number is not one Pace recognises',
  auth: 'Front Desk is not authorised to fetch estimates — the API key needs checking',
  estimate_not_found: 'no estimate with that number',
  no_quote_letter: 'that estimate has no quote letter yet',
  upstream: 'Pace could not produce the PDF',
  unreachable: "could not reach Dumont's server",
  not_configured: 'estimate attachments are not switched on',
};
