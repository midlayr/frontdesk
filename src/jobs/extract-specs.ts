import { ulid } from 'ulid';
import { z } from 'zod';
import type { Env } from '../env';
import { withOrg, type Sql } from '../db';

// Workers AI retires models on a schedule — the scaffold's llama-3.1-8b-instruct was
// deprecated 2026-05-30 and returned AiError 5028 in production. Keep it overridable from
// wrangler.toml [vars] so swapping models is a config change, not a deploy of new code.
const DEFAULT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

// Mirrors the spec columns on leads. Everything is nullable: a first text rarely has it all,
// and a guessed value is worse than a gap the rep can see.
const Spec = z.object({
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
  required: ['product', 'qty', 'size', 'stock', 'color', 'finish', 'rush', 'notes', 'confidence'],
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
  const model = (env.AI_MODEL || DEFAULT_MODEL) as never;

  const call = async (structured: boolean) => {
    const body: Record<string, unknown> = {
      messages: [
        {
          role: 'system',
          content: structured
            ? SYSTEM
            : `${SYSTEM} Reply with JSON only, matching this schema: ${JSON.stringify(JSON_SCHEMA)}`,
        },
        { role: 'user', content: transcript },
      ],
      max_tokens: 1500,
    };
    if (structured) body.response_format = { type: 'json_schema', json_schema: JSON_SCHEMA };
    return (await env.AI.run(model, body as never)) as { response?: unknown };
  };

  let res: { response?: unknown };
  try {
    res = await call(true);
  } catch (err) {
    console.warn('extract_specs: structured output rejected, retrying as plain JSON', err);
    res = await call(false);
  }

  const parsed = Spec.safeParse(parseLoose(res?.response));
  if (!parsed.success) {
    console.warn('extract_specs: response did not match schema', JSON.stringify(res?.response)?.slice(0, 400));
    return null;
  }
  return parsed.data;
}

/**
 * extract_specs: read the lead's inbound messages, fill the spec columns, and record what
 * is still missing so the queue can show "needs info" and the rep knows what to ask.
 */
export async function extractSpecs(env: Env, sql: Sql, orgId: string, leadId: string): Promise<void> {
  const transcript = await withOrg(sql, orgId, async (tx) => {
    const rows = await tx<{ body: string | null }[]>`
      SELECT body FROM messages
       WHERE lead_id = ${leadId} AND direction = 'in' AND body IS NOT NULL
       ORDER BY sent_at`;
    return rows.map((r) => r.body).filter(Boolean).join('\n');
  });

  if (!transcript.trim()) return;

  const spec = await extract(env, transcript);
  if (!spec) {
    console.warn(`extract_specs: model returned nothing usable for lead ${leadId}`);
    return;
  }

  const missing = SPECIFIED.filter((f) => spec[f] === null || spec[f] === undefined);

  await withOrg(sql, orgId, async (tx) => {
    await tx`
      UPDATE leads SET
        product        = COALESCE(${spec.product}, product),
        qty            = COALESCE(${spec.qty}, qty),
        size           = COALESCE(${spec.size}, size),
        stock          = COALESCE(${spec.stock}, stock),
        color          = COALESCE(${spec.color}, color),
        finish         = COALESCE(${spec.finish}, finish),
        rush           = COALESCE(${spec.rush}, rush),
        spec           = spec || ${tx.json(spec.notes ? { notes: spec.notes } : {})},
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
