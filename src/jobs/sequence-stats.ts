import { ulid } from 'ulid';
import type { Env } from '../env';
import { withOrg, type Sql, type Tx } from '../db';

/**
 * Campaign performance, rolled up.
 *
 * One aggregation, used by the nightly job and by the Performance tab when no rollup exists
 * yet. Two implementations of "how is this campaign doing" would eventually disagree, and
 * the number a shop reads off the screen is the one they would quote to decide whether the
 * campaign is worth keeping.
 *
 * Attribution is deliberately narrow: a lead counts as won by the campaign only if it
 * reached 'won' within 30 days of a drip actually going out to it. A campaign cannot claim
 * a job that was already closing.
 */

export const SPANS = ['30d', '90d', 'all'] as const;
export type Span = (typeof SPANS)[number];

const DAYS: Record<Span, number | null> = { '30d': 30, '90d': 90, all: null };

export interface Row {
  step_id: string | null; span: Span;
  enrolled: number; sent: number; opened: number; clicked: number;
  replied: number; won: number; revenue: number;
}

/** Compute one span for one sequence. Nothing is written; the caller decides. */
export async function compute(tx: Tx, sequenceId: string, span: Span): Promise<Row[]> {
  const days = DAYS[span];
  // A null interval means "everything", so the comparison is written to be always-true
  // rather than branching the query into two nearly-identical strings.
  const since = days === null ? null : `${days} days`;

  const [totals] = await tx<{ enrolled: number; replied: number; won: number; revenue: string }[]>`
    SELECT
      count(*)::int AS enrolled,
      count(*) FILTER (WHERE e.state = 'replied')::int AS replied,
      count(*) FILTER (WHERE l.won_at IS NOT NULL
                         AND e.last_sent_at IS NOT NULL
                         AND l.won_at <= e.last_sent_at + interval '30 days')::int AS won,
      COALESCE(sum(l.quote_amount) FILTER (WHERE l.won_at IS NOT NULL
                         AND e.last_sent_at IS NOT NULL
                         AND l.won_at <= e.last_sent_at + interval '30 days'), 0)::text AS revenue
      FROM enrollments e JOIN leads l ON l.id = e.lead_id
     WHERE e.sequence_id = ${sequenceId}
       AND (${since}::interval IS NULL OR e.created_at > now() - ${since}::interval)`;

  const perStep = await tx<{
    step_id: string; sent: number; opened: number; clicked: number; replied: number;
  }[]>`
    SELECT m.step_id,
           count(*)::int AS sent,
           count(*) FILTER (WHERE m.opened_at IS NOT NULL)::int AS opened,
           count(*) FILTER (WHERE m.clicked_at IS NOT NULL)::int AS clicked,
           count(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM messages r
              WHERE r.lead_id = m.lead_id AND r.direction = 'in' AND r.sent_at > m.sent_at
           ))::int AS replied
      FROM messages m
      JOIN enrollments e ON e.id = m.enrollment_id
     WHERE e.sequence_id = ${sequenceId} AND m.step_id IS NOT NULL
       AND (${since}::interval IS NULL OR m.sent_at > now() - ${since}::interval)
     GROUP BY m.step_id`;

  const sent = perStep.reduce((a, s) => a + s.sent, 0);
  const rows: Row[] = [{
    step_id: null, span,
    enrolled: totals?.enrolled ?? 0, sent,
    opened: perStep.reduce((a, s) => a + s.opened, 0),
    clicked: perStep.reduce((a, s) => a + s.clicked, 0),
    replied: totals?.replied ?? 0,
    won: totals?.won ?? 0, revenue: Number(totals?.revenue ?? 0),
  }];
  for (const s of perStep) {
    rows.push({
      step_id: s.step_id, span, enrolled: 0, sent: s.sent, opened: s.opened,
      clicked: s.clicked, replied: s.replied, won: 0, revenue: 0,
    });
  }
  return rows;
}

export async function store(tx: Tx, orgId: string, sequenceId: string, rows: Row[]): Promise<void> {
  for (const r of rows) {
    await tx`
      INSERT INTO sequence_stats (id, org_id, sequence_id, step_id, span, enrolled, sent,
                                  opened, clicked, replied, won, revenue, computed_at)
      VALUES (${ulid()}, ${orgId}, ${sequenceId}, ${r.step_id}, ${r.span}, ${r.enrolled},
              ${r.sent}, ${r.opened}, ${r.clicked}, ${r.replied}, ${r.won}, ${r.revenue}, now())
      ON CONFLICT (sequence_id, COALESCE(step_id, ''), span) DO UPDATE
        SET enrolled = EXCLUDED.enrolled, sent = EXCLUDED.sent, opened = EXCLUDED.opened,
            clicked = EXCLUDED.clicked, replied = EXCLUDED.replied, won = EXCLUDED.won,
            revenue = EXCLUDED.revenue, computed_at = now()`;
  }
}

/**
 * One plain sentence about which step earns replies.
 *
 * Written from the numbers rather than by the model inventing them, and skipped entirely
 * when there is too little to say — a confident sentence about four sends is worse than
 * silence.
 */
export async function read(env: Env, rows: Row[], labels: Map<string, string>): Promise<string | null> {
  const steps = rows.filter((r) => r.step_id && r.sent >= 5);
  if (steps.length < 2) return null;

  const table = steps.map((s) => {
    const open = s.sent ? Math.round((s.opened / s.sent) * 100) : 0;
    return `${labels.get(s.step_id!) ?? 'step'}: ${s.sent} sent, ${open}% opened, ${s.replied} replies`;
  }).join('; ');

  try {
    const r = await env.AI.run(env.AI_MODEL ?? '@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
      messages: [
        { role: 'system', content: 'You advise a print shop on email follow-ups. One sentence, plain English, under 30 words. Say which step earns replies and what to try. No preamble, no markdown.' },
        { role: 'user', content: table },
      ],
      max_tokens: 90,
    } as never) as { response?: string };
    return r.response?.trim().slice(0, 240) ?? null;
  } catch {
    return null;   // a missing sentence must never fail the rollup
  }
}

/** Nightly: every sequence, every span. */
export async function rollUp(env: Env, sql: Sql): Promise<number> {
  const seqs = await sql<{ id: string; org_id: string }[]>`SELECT id, org_id FROM sequences`;
  let n = 0;
  for (const s of seqs) {
    await withOrg(sql, s.org_id, async (tx) => {
      const steps = await tx<{ id: string; position: number; subject: string | null }[]>`
        SELECT id, position, subject FROM sequence_steps WHERE sequence_id = ${s.id} ORDER BY position`;
      const labels = new Map(steps.map((x) => [x.id, x.subject || `step ${x.position}`]));
      for (const span of SPANS) {
        const rows = await compute(tx, s.id, span);
        await store(tx, s.org_id, s.id, rows);
        if (span === '90d') {
          const sentence = await read(env, rows, labels);
          if (sentence) {
            await tx`UPDATE sequence_stats SET read = ${sentence}
                      WHERE sequence_id = ${s.id} AND step_id IS NULL AND span = '90d'`;
          }
        }
      }
      n++;
    });
  }
  return n;
}
