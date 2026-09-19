import { ulid } from 'ulid';
import { z } from 'zod';
import type { Env } from '../env';
import { withOrg, type Sql } from '../db';

const MODEL = '@cf/meta/llama-3.1-8b-instruct';

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
  'confidence maps each field you did fill to 0..1 for how sure you are.',
].join(' ');

/** Runs the model and returns a validated spec, or null if it gave us nothing usable. */
async function extract(env: Env, transcript: string): Promise<Spec | null> {
  const res = (await env.AI.run(MODEL as never, {
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: transcript },
    ],
    response_format: { type: 'json_schema', json_schema: JSON_SCHEMA },
    max_tokens: 512,
  } as never)) as { response?: unknown };

  const raw = res?.response;
  const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const parsed = Spec.safeParse(obj);
  return parsed.success ? parsed.data : null;
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
