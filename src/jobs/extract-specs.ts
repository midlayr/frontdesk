import { ulid } from 'ulid';
import { z } from 'zod';
import type { Env } from '../env';
import { withOrg, type Sql } from '../db';
import { runJson } from '../lib/ai-json';

// Workers AI retires models on a schedule — the scaffold's llama-3.1-8b-instruct was
// deprecated 2026-05-30 and returned AiError 5028 in production. Keep it overridable from
// wrangler.toml [vars] so swapping models is a config change, not a deploy of new code.
const DEFAULT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

// Mirrors the spec columns on leads. Everything is nullable: a first text rarely has it all,
// and a guessed value is worse than a gap the rep can see.
const Spec = z.object({
  description: z.string().nullable(),
  summary: z.string().nullable(),
  product: z.string().nullable(),
  qty: z.number().int().positive().nullable(),
  size: z.string().nullable(),
  stock: z.string().nullable(),
  color: z.string().nullable(),
  finish: z.string().nullable(),
  rush: z.boolean().nullable(),
  notes: z.string().nullable(),
  confidence: z.record(z.string(), z.number().min(0).max(1)).default({}),
});
type Spec = z.infer<typeof Spec>;

const SPECIFIED: (keyof Spec)[] = ['product', 'qty', 'size', 'stock', 'color', 'finish'];

const JSON_SCHEMA = {
  type: 'object',
  properties: {
    // Deliberately not "product plus quantity": the shop's own job jacket leads with a
    // short human name for the work ("Wedding Menu & Placards"), sometimes broader than the
    // product and sometimes, in their words, as generic as "Business Cards".
    // What the rep reads first. The ticket shows the spec as fields and the chat as a
    // transcript; neither tells you in a sentence what this person wants.
    summary: { type: ['string', 'null'], description: 'two or three sentences a rep can read before picking up the phone: what they want, anything unusual, and what is still unknown. Plain prose, the customer\'s own terms, no bullet points and no preamble.' },
    description: { type: ['string', 'null'], description: 'a short name for the job as a person would say it, 2-5 words, title case, e.g. "Wedding Menus & Placards", "Trail Map Posters", "Business Cards". No quantities, no sizes.' },
    product: { type: ['string', 'null'], description: 'what is being printed, e.g. business cards, banner, flyers' },
    qty: { type: ['integer', 'null'] },
    size: { type: ['string', 'null'], description: 'trim or finished size as written, e.g. 3.5x2, 24x36' },
    stock: { type: ['string', 'null'], description: 'paper or substrate, e.g. 16pt matte, 100lb gloss text' },
    color: { type: ['string', 'null'], description: 'e.g. 4/4, full color, 1 color black' },
    finish: { type: ['string', 'null'], description: 'e.g. soft touch lamination, spot UV, foil' },
    rush: { type: ['boolean', 'null'] },
    notes: { type: ['string', 'null'], description: 'anything else the rep needs' },
    confidence: { type: 'object', additionalProperties: { type: 'number' } },
  },
  required: ['summary', 'description', 'product', 'qty', 'size', 'stock', 'color', 'finish', 'rush', 'notes', 'confidence'],
} as const;

const SYSTEM = [
  'You read inbound print-shop enquiries and pull out the job specification.',
  'Use null for anything the customer did not actually state. Never invent a value.',
  // Without this the model writes its reasoning into the field values ("16pt heavy stock
  // (implied, not explicitly stated for business cards...)") and blows the token budget
  // mid-JSON, so nothing parses.
  'Every value must be a short literal phrase in the customer\'s own words — at most a few',
  'words. Never explain, qualify or hedge inside a value: uncertainty belongs in confidence',
  'as a number, and nowhere else.',
  'confidence maps each field you filled to 0..1. notes is for anything that does not fit a',
  'field, one short sentence at most.',
  'summary is the exception to the short-phrase rule: two or three plain sentences for the',
  'rep, covering what they want, anything unusual, and what is still unknown. Say what is',
  'missing rather than guessing at it.',
].join(' ');

/** Models fence their JSON or prepend prose often enough to be worth handling. */
function parseLoose(raw: unknown): unknown {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const text = (fenced ? fenced[1] : raw).trim();
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

/**
 * Runs the model and returns a validated spec, or null if it gave us nothing usable.
 *
 * Structured output is model-dependent on Workers AI, so a model that rejects
 * response_format gets a second pass with the schema described in the prompt instead.
 */
async function extract(env: Env, transcript: string): Promise<Spec | null> {
  let raw: Record<string, unknown> | null;
  try {
    raw = await runJson(env, SYSTEM, transcript, JSON_SCHEMA);
  } catch (err) {
    console.warn('extract_specs: model call failed', err);
    return null;
  }
  if (!raw) return null;
  const parsed = Spec.safeParse(raw);
  // Partial beats nothing: a model that got qty right and invented a shape for confidence
  // should still fill qty, so the strict parse falls back to a lenient one.
  if (parsed.success) return parsed.data;
  const loose = Spec.partial().safeParse(raw);
  if (!loose.success) {
    console.warn('extract_specs: unusable shape', parsed.error.issues[0]?.message);
    return null;
  }
  return { confidence: {}, ...loose.data } as Spec;
}

/**
 * extract_specs: read the lead's inbound messages, fill the spec columns, and record what
 * is still missing so the queue can show "needs info" and the rep knows what to ask.
 */
export async function extractSpecs(env: Env, sql: Sql, orgId: string, leadId: string): Promise<void> {
  const { transcript, locked } = await withOrg(sql, orgId, async (tx) => {
    const rows = await tx<{ body: string | null }[]>`
      SELECT body FROM messages
       WHERE lead_id = ${leadId} AND direction = 'in' AND body IS NOT NULL
       ORDER BY sent_at`;
    const [lead] = await tx<{ locked: string[] | null }[]>`
      SELECT ARRAY(SELECT jsonb_array_elements_text(COALESCE(spec->'locked_fields','[]'::jsonb)))
             AS locked
        FROM leads WHERE id = ${leadId}`;
    /*
     * The bot's questions, not just the answers.
     *
     * A chat transcript of inbound messages reads "Yes / Business Cards / 250 / One side" —
     * every answer stripped of what it answered. The model cannot summarise that, and a rep
     * reading it learns nothing either. captured holds the labelled version, so it goes in
     * front of the transcript.
     */
    const [cap] = await tx<{ captured: Record<string, string> | null }[]>`
      SELECT spec->'captured' AS captured FROM leads WHERE id = ${leadId}`;
    const answers = Object.entries(cap?.captured ?? {})
      .filter(([, v]) => typeof v === 'string' && v.trim())
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n');

    return {
      transcript: [answers, rows.map((r) => r.body).filter(Boolean).join('\n')]
        .filter((p) => p.trim()).join('\n\n'),
      locked: new Set(lead?.locked ?? []),
    };
  });

  if (!transcript.trim()) return;

  const spec = await extract(env, transcript);
  if (!spec) {
    console.warn(`extract_specs: model returned nothing usable for lead ${leadId}`);
    return;
  }

  const missing = SPECIFIED.filter((f) => spec[f] === null || spec[f] === undefined);


  // The model may revise its own earlier reading — "actually make that 1000" has to land —
  // but a field a rep edited is off limits. COALESCE alone could only ever fill blanks,
  // which meant a correction in a follow-up message was silently ignored.
  const val = <T,>(field: keyof Spec, v: T): T | null => (locked.has(field) ? null : v);

  await withOrg(sql, orgId, async (tx) => {
    await tx`
      UPDATE leads SET
        -- Only ever fills a blank. A rep's description is the shop's own language for the
        -- job and a later message must not quietly reword it — unlike the spec fields,
        -- where "actually make that 1000" genuinely should overwrite.
        description    = COALESCE(description, ${spec.description}),
        product        = COALESCE(${val('product', spec.product)}, product),
        qty            = COALESCE(${val('qty', spec.qty)}, qty),
        size           = COALESCE(${val('size', spec.size)}, size),
        stock          = COALESCE(${val('stock', spec.stock)}, stock),
        color          = COALESCE(${val('color', spec.color)}, color),
        finish         = COALESCE(${val('finish', spec.finish)}, finish),
        rush           = COALESCE(${val('rush', spec.rush)}, rush),
        spec           = spec || ${tx.json({
                           ...(spec.notes ? { notes: spec.notes } : {}),
                           // Rewritten each run: a later message can change what the job
                           // is, and a summary that describes the first half of a
                           // conversation is worse than none.
                           ...(spec.summary ? { summary: spec.summary } : {}),
                         })},
        confidence     = confidence || ${tx.json(spec.confidence)},
        -- passed as jsonb and rebuilt server-side: with fetch_types:false postgres.js
        -- cannot infer the text[] type for a JS array parameter.
        missing_fields = ARRAY(SELECT jsonb_array_elements_text(${tx.json(missing)}::jsonb)),
        -- don't walk a lead backwards once a rep has replied or quoted it
        status         = CASE WHEN status = 'new' AND ${missing.length} > 0
                              THEN 'needs_info'::lead_status ELSE status END
      WHERE id = ${leadId} AND org_id = ${orgId}`;

    await tx`INSERT INTO activity (id, org_id, lead_id, actor, kind, detail)
             VALUES (${ulid()}, ${orgId}, ${leadId}, 'system', 'specs_extracted',
                     ${tx.json({ missing, confidence: spec.confidence })})`;
  });
}
