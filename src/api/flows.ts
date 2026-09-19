import { Hono } from 'hono';
import { ulid } from 'ulid';
import { z } from 'zod';
import type { Env, Org, Step } from '../env';
import { withOrg, type Sql } from '../db';

type Vars = { org: Org; sql: Sql; userId: string };

export const flows = new Hono<{ Bindings: Env; Variables: Vars }>();

const StepSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('ask'),
    prompt: z.string().min(1),
    field: z.string().min(1),
    chips: z.string().optional(),
    skippable: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('rule'),
    words: z.string(),
    handoff: z.string(),
    route: z.string(),
  }),
  z.object({ kind: z.literal('ticket'), text: z.string() }),
]);

const FlowBody = z.object({
  name: z.string().min(1).optional(),
  steps: z.array(StepSchema).min(1),
});

flows.get('/:slug', async (c) => {
  const org = c.get('org');
  const slug = c.req.param('slug');
  const row = await withOrg(c.get('sql'), org.id, async (tx) => {
    const [f] = await tx`SELECT id, slug, name, steps, settings, version, published_at, updated_at
                           FROM chat_flows WHERE slug = ${slug}`;
    return f ?? null;
  });
  return row ? c.json(row) : c.json({ error: 'not found' }, 404);
});

/** Save a draft. Does not affect the live widget until it is published. */
flows.put('/:slug', async (c) => {
  const org = c.get('org');
  const userId = c.get('userId');
  const slug = c.req.param('slug');

  const parsed = FlowBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'bad flow', detail: parsed.error.issues }, 400);

  const saved = await withOrg(c.get('sql'), org.id, async (tx) => {
    const [row] = await tx<{ id: string; version: number }[]>`
      INSERT INTO chat_flows (id, org_id, slug, name, steps, updated_by)
      VALUES (${ulid()}, ${org.id}, ${slug}, ${parsed.data.name ?? slug},
              ${tx.json(parsed.data.steps)}, ${userId})
      ON CONFLICT (org_id, slug) DO UPDATE
        SET steps = EXCLUDED.steps,
            name = COALESCE(EXCLUDED.name, chat_flows.name),
            updated_by = EXCLUDED.updated_by,
            updated_at = now()
      RETURNING id, version`;
    return row;
  });

  return c.json({ ok: true, ...saved });
});

/**
 * Publish: bump the version and write the flow to KV, which is the only copy the widget
 * ever reads. Postgres stays the editable draft; KV is the served artefact.
 */
flows.post('/:slug/publish', async (c) => {
  const org = c.get('org');
  const slug = c.req.param('slug');

  const published = await withOrg(c.get('sql'), org.id, async (tx) => {
    const [row] = await tx<{ id: string; version: number; steps: Step[] }[]>`
      UPDATE chat_flows SET version = version + 1, published_at = now()
       WHERE slug = ${slug}
       RETURNING id, version, steps`;
    return row ?? null;
  });

  if (!published) return c.json({ error: 'not found' }, 404);

  await c.env.CONFIG.put(
    `flow:${org.id}:${slug}`,
    JSON.stringify({ id: published.id, version: published.version, steps: published.steps }),
  );

  return c.json({ ok: true, version: published.version, key: `flow:${org.id}:${slug}` });
});
