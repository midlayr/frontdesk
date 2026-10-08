import { Hono } from 'hono';
import { ulid } from 'ulid';
import { z } from 'zod';
import type { Env, Org, PublishedFlow, Step } from '../env';
import { withOrg, type Sql } from '../db';
import { loopingAsks, simulate } from '../flow-engine';
import { presentation, type FlowSettings } from '../lib/flow-settings';

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
    // Same leniency as `next`: a target that no longer exists falls through rather than
    // making the question undeletable.
    otherwise: z.string().optional(),
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
/**
 * Every flow this shop has, and whether each is live.
 *
 * chat_flows has always been keyed UNIQUE (org_id, slug) and the widget has always taken
 * data-flow, so a shop could have had several bots from the start — one on the quotes page,
 * one for reorders, one behind a campaign link. There was simply no way to see or make them.
 *
 * `live` is the published copy in KV, not published_at on the row: KV is what the widget
 * actually reads, so it is the only honest answer to "is this bot running".
 */
flows.get('/', async (c) => {
  const org = c.get('org');
  const rows = await withOrg(c.get('sql'), org.id, (tx) =>
    tx<{ slug: string; name: string; version: number; published_at: string | null;
         updated_at: string; steps: Step[]; settings: unknown }[]>`
      SELECT slug, name, version, published_at, updated_at, steps, settings
        FROM chat_flows WHERE org_id = ${org.id} ORDER BY name`);

  const list = await Promise.all(rows.map(async (r) => ({
    slug: r.slug,
    name: r.name,
    version: r.version,
    questions: r.steps.filter((s) => s.kind === 'ask').length,
    published_at: r.published_at,
    updated_at: r.updated_at,
    live: (await c.env.CONFIG.get(`flow:${org.id}:${r.slug}`)) !== null,
    settings: presentation(r.settings),
  })));

  return c.json({ flows: list, install: installFacts(c.env, org) });
});

/**
 * Everything needed to write the script tag, answered by the server rather than guessed
 * at in the browser.
 *
 * The admin app cannot work this out from location.origin: in development it is served by
 * Vite on :5173 and proxies to the Worker, so a snippet built there would point the shop's
 * own website at a localhost that only exists on one laptop. PUBLIC_ORIGIN is the address
 * the Worker actually answers on, which is the address the tag has to name.
 *
 * `domains` comes along because it is the difference between a snippet that works and one
 * that silently does nothing: /widget/config refuses an Origin that is not on the list, and
 * the failure is a console message on the shop's site that nobody here will ever see.
 */
function installFacts(env: Env, org: Org) {
  const domains = (org.widget as { allowed_domains?: unknown }).allowed_domains;
  return {
    origin: env.PUBLIC_ORIGIN?.replace(/\/$/, '') ?? '',
    org: org.slug,
    domains: Array.isArray(domains) ? domains.filter((d): d is string => typeof d === 'string') : [],
  };
}

const NewFlow = z.object({
  name: z.string().min(1).max(80),
  // Lowercase, dashed: it goes in a data-flow attribute and a KV key, and a space or a
  // capital there is a support ticket six months later.
  slug: z.string().min(1).max(40).regex(/^[a-z0-9][a-z0-9-]*$/,
    'Use lowercase letters, numbers and dashes'),
});

/**
 * A new bot, created as a draft. Never live on creation — a flow nobody has read should not
 * be answering customers because somebody typed a name.
 *
 * It starts with one question and a ticket step rather than empty: an empty flow is not a
 * thing the engine can run, and a blank canvas is a worse starting point than something to
 * edit.
 */
flows.post('/', async (c) => {
  const org = c.get('org');
  const parsed = NewFlow.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message ?? 'name and slug are required' }, 400);
  }
  const { name, slug } = parsed.data;

  const steps: Step[] = withIds([
    { kind: 'ask', prompt: 'Welcome, how may I help you today?', field: 'product', chips: '' },
    { kind: 'ticket', text: 'Thanks — your request is in. We will come back to you shortly.' },
  ]);

  const [row] = await withOrg(c.get('sql'), org.id, (tx) =>
    tx<{ slug: string }[]>`
      INSERT INTO chat_flows (id, org_id, slug, name, steps, updated_by)
      VALUES (${ulid()}, ${org.id}, ${slug}, ${name}, ${tx.json(steps)}, ${c.get('userId')})
      ON CONFLICT (org_id, slug) DO NOTHING
      RETURNING slug`);
  if (!row) return c.json({ error: `this shop already has a flow called "${slug}"` }, 409);

  return c.json({ ok: true, slug, name }, 201);
});

/**
 * Take a bot off the website.
 *
 * Deleting the KV key is the whole act — that is what the widget reads, so the bubble stops
 * appearing within the edge cache's minute. The draft is untouched and published_at is
 * cleared, so pausing loses nothing and publishing again puts back exactly what was there.
 *
 * A visitor already mid-conversation keeps their session: it lives in the Durable Object,
 * not in KV. Cutting somebody off halfway through answering questions would be a strange
 * way to treat the one customer who was engaging with it.
 */
flows.post('/:slug/pause', async (c) => {
  const org = c.get('org');
  const slug = c.req.param('slug');

  const [row] = await withOrg(c.get('sql'), org.id, (tx) =>
    tx<{ slug: string }[]>`
      UPDATE chat_flows SET published_at = NULL
       WHERE org_id = ${org.id} AND slug = ${slug} RETURNING slug`);
  if (!row) return c.json({ error: 'not found' }, 404);

  await c.env.CONFIG.delete(`flow:${org.id}:${slug}`);
  return c.json({ ok: true, live: false });
});

const SettingsBody = z.object({
  // The internal name. Renaming is free: nothing points at it. The address is a different
  // matter and is not editable here — see below.
  name: z.string().min(1).max(80).optional(),
  // Blank is meaningful: it clears the override and falls back to the shop's own wording,
  // which is why these are '' rather than optional-undefined.
  launcher: z.string().max(40).optional(),
  nudge: z.string().max(160).optional(),
});

/**
 * Change what a bot is called and what it says on the website.
 *
 * Separate from PUT /:slug on purpose. That route is the builder's debounced autosave of the
 * step list, firing every half-second while someone types a question; folding a settings
 * form into the same body would have the two racing to overwrite each other's field.
 *
 * The two also differ in when they take effect, and the split makes that honest:
 *
 *   steps     — draft until published. A half-finished question must not be put in front of
 *               a customer because the editor lost focus.
 *   launcher  — live immediately. It is a button label, not conversation logic; there is
 *   nudge       nothing to review, and a Save that visibly does nothing until you find the
 *               Publish button reads as a broken Save.
 *
 * Which is why the KV refresh below splices the new wording into the copy that is already
 * published rather than republishing the row: the draft steps stay in the draft.
 *
 * NOT here: the address (slug). It is in the KV key, in UNIQUE (org_id, slug) and — the one
 * that matters — in the <script> tag already pasted into the shop's website. Renaming it
 * from this panel would take their chat bubble off their site with no hint as to why.
 */
flows.patch('/:slug/settings', async (c) => {
  const org = c.get('org');
  const slug = c.req.param('slug');

  const parsed = SettingsBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message ?? 'bad settings' }, 400);
  }
  const body = parsed.data;

  const saved = await withOrg(c.get('sql'), org.id, async (tx) => {
    const [row] = await tx<{ name: string; settings: unknown }[]>`
      SELECT name, settings FROM chat_flows WHERE org_id = ${org.id} AND slug = ${slug}`;
    if (!row) return null;

    // Read, merge, write — rather than a jsonb || in SQL. Only the keys actually present in
    // the body are touched, so this stays a patch; a '' present in the body deletes its key,
    // because presentation() drops blanks.
    const merged: Record<string, unknown> = { ...presentation(row.settings) };
    for (const k of ['launcher', 'nudge'] as const) {
      if (body[k] === undefined) continue;
      if (body[k]!.trim()) merged[k] = body[k]!.trim(); else delete merged[k];
    }
    const settings = presentation(merged);

    // Decided here rather than with a CASE in SQL: the row is already in hand, and an
    // all-whitespace name should leave the existing one alone rather than blank it.
    const name = body.name?.trim() || row.name;

    const [out] = await tx<{ name: string }[]>`
      UPDATE chat_flows
         SET name = ${name},
             settings = ${tx.json(settings as Record<string, string>)}::jsonb,
             updated_at = now()
       WHERE org_id = ${org.id} AND slug = ${slug}
      RETURNING name`;
    return { name: out.name, settings };
  });

  if (!saved) return c.json({ error: 'not found' }, 404);

  // Wording applies at once, but only to a bot that is already answering customers. Reading
  // the published copy and putting it back keeps the live steps exactly as they were — the
  // draft may well contain a question half-written.
  const key = `flow:${org.id}:${slug}`;
  const live = await c.env.CONFIG.get<PublishedFlow>(key, 'json');
  if (live) await c.env.CONFIG.put(key, JSON.stringify({ ...live, settings: saved.settings }));

  return c.json({ ok: true, ...saved, live: live !== null });
});

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
    const [f] = await tx<{ settings: unknown }[]>`
      SELECT id, slug, name, steps, settings, version, published_at, updated_at
        FROM chat_flows WHERE slug = ${slug}`;
    return f ?? null;
  });
  if (!row) return c.json({ error: 'not found' }, 404);
  return c.json({
    ...row,
    settings: presentation(row.settings),
    install: installFacts(c.env, org),
    // From KV, not published_at: KV is what the widget fetches, so it is the only honest
    // answer to "would the script tag show anything right now".
    live: (await c.env.CONFIG.get(`flow:${org.id}:${slug}`)) !== null,
  });
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
    const [row] = await tx<{ id: string; version: number; steps: Step[]; settings: unknown }[]>`
      UPDATE chat_flows SET version = version + 1, published_at = now()
       WHERE slug = ${slug}
       RETURNING id, version, steps, settings`;
    return row ?? null;
  });

  if (!published) return c.json({ error: 'not found' }, 404);

  // Wording ships with the steps so a first publish starts with the right button label, and
  // so a bot that was paused and brought back does not revert to the shop's default wording.
  await c.env.CONFIG.put(
    `flow:${org.id}:${slug}`,
    JSON.stringify({
      id: published.id,
      version: published.version,
      steps: published.steps,
      settings: presentation(published.settings),
    } satisfies PublishedFlow),
  );

  return c.json({ ok: true, version: published.version, key: `flow:${org.id}:${slug}` });
});
