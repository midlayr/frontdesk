import { Hono } from 'hono';
import { ulid } from 'ulid';
import { z } from 'zod';
import type { Env, Org, Step } from '../env';
import { withOrg, type Sql } from '../db';
import { loopingAsks, simulate } from '../flow-engine';

type Vars = { org: Org; sql: Sql; userId: string };

export const flows = new Hono<{ Bindings: Env; Variables: Vars }>();

const StepSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('ask'),
    id: z.string().min(1).max(40).optional(),
    prompt: z.string().min(1),
    field: z.string().min(1),
    chips: z.string().optional(),
    skippable: z.boolean().optional(),
    // chip label → ask id, or 'ticket'. Not validated against the other steps here: the
    // engine already falls through on a target that no longer exists, and rejecting the
    // save would make deleting a question impossible while anything still pointed at it.
    next: z.record(z.string(), z.string()).optional(),
  }),
  z.object({
    kind: z.literal('rule'),
    words: z.string(),
    handoff: z.string(),
    route: z.string(),
  }),
  z.object({ kind: z.literal('ticket'), text: z.string() }),
]);

/**
 * Give every question an id before it is stored.
 *
 * Branch targets are ids, so a flow without them can only be traversed by position — and
 * then reordering the questions silently reroutes every branch. Doing this server-side means
 * it holds for anything that writes a flow, not only for the builder.
 */
function withIds(steps: Step[]): Step[] {
  const seen = new Set<string>();
  return steps.map((s) => {
    if (s.kind !== 'ask') return s;
    const id = s.id && !seen.has(s.id) ? s.id : ulid();
    seen.add(id);
    return { ...s, id };
  });
}

const FlowBody = z.object({
  name: z.string().min(1).optional(),
  steps: z.array(StepSchema).min(1),
});

/**
 * Run an unsaved draft. The builder posts the steps it currently has on screen plus what the
 * tester has typed, and gets the resulting conversation back. Stateless on purpose — there is
 * no session to leak between tenants, and the preview cannot desync from what you are editing.
 *
 * It calls the same flow-engine as the live ChatSession DO, so the preview is not an
 * approximation of the bot's behaviour: it is the bot's behaviour.
 */
flows.post('/:slug/simulate', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({
    steps: z.array(StepSchema).min(1),
    said: z.array(z.string()).max(50).default([]),
  }).safeParse(body);
  if (!parsed.success) return c.json({ error: 'bad draft', detail: parsed.error.issues }, 400);

  const r = simulate(parsed.data.steps, parsed.data.said);
  return c.json({
    turns: r.next.turns,
    chips: r.chips,
    captured: r.next.captured,
    state: r.next.state,
    handedOff: r.handedOff,
    completed: r.completed,
    // Reported from here rather than recomputed in the builder, so the warning and the
    // behaviour cannot disagree — the same reason the preview runs this engine at all.
    loops: [...loopingAsks(parsed.data.steps)],
  });
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
              ${tx.json(withIds(parsed.data.steps))}, ${userId})
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
