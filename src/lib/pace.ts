import type { Env } from '../env';
import type { PdfFailure } from './pace-reasons';

export { PDF_REASON, type PdfFailure } from './pace-reasons';

/**
 * Fetching an estimate's quote letter PDF from Dumont's own server.
 *
 * They put an endpoint in front of Pace rather than exposing Pace itself: it resolves the
 * estimate to its current version and newest quote letter, runs the report, and hands back
 * the PDF. So there is no SOAP here, no report key, no ReportService — one GET.
 *
 * The number is the one a REP READS OFF THE QUOTE LETTER (estimatenumber, e.g. 99802), not
 * Pace's internal estimateid. It is text: some have leading zeros, so it must never be
 * parsed as a number and must go up exactly as typed.
 */

const TIMEOUT_MS = 45_000;   // their guidance; the report generates live
const RETRIES = 2;           // on 502/504 and on not getting there at all

export type PdfResult =
  | { ok: true; bytes: ArrayBuffer; bytesLength: number }
  | { ok: false; why: PdfFailure; detail: string; tried: number };

/**
 * One attempt is retried only when retrying could plausibly help: a 502 means Pace itself
 * stumbled, a 504 or a dead socket means the hop failed. A 404 is an answer, not a blip —
 * retrying it just delays telling somebody the number is wrong.
 */
export async function fetchEstimatePdf(env: Env, estimateNumber: string): Promise<PdfResult> {
  const base = (env.PACE_PDF_URL ?? '').replace(/\/$/, '');
  const key = env.PACE_API_KEY ?? '';
  if (!base || !key) {
    return { ok: false, why: 'not_configured', detail: 'PACE_PDF_URL or PACE_API_KEY is unset', tried: 0 };
  }

  // Trimmed but otherwise untouched: leading zeros are significant and it is not a number.
  const num = estimateNumber.trim();
  if (!num) return { ok: false, why: 'bad_number', detail: 'no estimate number on the ticket', tried: 0 };

  const url = `${base}/${encodeURIComponent(num)}`;
  let last = '';

  for (let attempt = 1; attempt <= RETRIES + 1; attempt++) {
    try {
      const r = await fetch(url, {
        headers: { 'x-api-key': key, accept: 'application/pdf' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (r.ok) {
        const bytes = await r.arrayBuffer();
        // A 200 with nothing in it is not a PDF, and attaching an empty file is worse than
        // saying we could not get one.
        if (bytes.byteLength === 0) {
          last = 'empty body';
        } else {
          return { ok: true, bytes, bytesLength: bytes.byteLength };
        }
      } else if (r.status === 400) {
        return { ok: false, why: 'bad_number', detail: await short(r), tried: attempt };
      } else if (r.status === 401 || r.status === 403) {
        return { ok: false, why: 'auth', detail: await short(r), tried: attempt };
      } else if (r.status === 404) {
        // They send a reason in the body; it is the difference between "wrong number" and
        // "right estimate, nobody has made a quote letter yet", which are different errands.
        const body = await r.text();
        const reason = /no_quote_letter/.test(body) ? 'no_quote_letter' : 'estimate_not_found';
        return { ok: false, why: reason, detail: body.slice(0, 200), tried: attempt };
      } else {
        last = `${r.status} ${await short(r)}`;
        if (r.status !== 502 && r.status !== 504) {
          return { ok: false, why: 'upstream', detail: last, tried: attempt };
        }
      }
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }

    // Short, because a campaign send is already waiting on this.
    if (attempt <= RETRIES) await new Promise((r) => setTimeout(r, 1000 * attempt));
  }

  return {
    ok: false,
    why: last.startsWith('5') ? 'upstream' : 'unreachable',
    detail: last || 'no response',
    tried: RETRIES + 1,
  };
}

const short = async (r: Response) => (await r.text().catch(() => '')).slice(0, 200);

/** Where a fetched PDF is kept. Dated, because the report regenerates and they differ. */
export const pdfKey = (orgId: string, estimateNumber: string, at = new Date()) =>
  `org/${orgId}/estimates/${estimateNumber}-${at.toISOString().slice(0, 10)}.pdf`;
