// Queue job: read every inbound message on a lead → structured print specs with confidence
import type { Env } from '../index';
import { connect, withOrg } from '../db';

const FIELDS = ['product', 'qty', 'size', 'stock', 'color', 'finish', 'deadline'] as const;
const REQUIRED = ['product', 'qty', 'deadline'];

const SYSTEM = `You read messages sent to a commercial print shop and extract job specs.
Return ONLY JSON: {"product":str|null,"qty":int|null,"size":str|null,"stock":str|null,"color":str|null,"finish":str|null,
"deadline":ISO-8601 date|null,"rush":bool,"notes":str,"confidence":{"product":0-1,"qty":0-1,"size":0-1,"stock":0-1,"color":0-1,"finish":0-1,"deadline":0-1}}.
Use print vernacular (14pt C1S, 4/4, saddle stitch, aqueous). Unknown → null with low confidence. rush=true if needed within 3 business days. Today is {{today}}.`;

export async function extractSpecs(env: Env, orgId: string, leadId: string) {
  const sql = connect(env);
  await withOrg(sql, orgId, async (tx) => {
    const msgs = await tx`SELECT body FROM messages WHERE lead_id = ${leadId} AND direction = 'in' AND body IS NOT NULL ORDER BY sent_at`;
    if (!msgs.length) return;
    const text = msgs.map((m: any) => m.body).join('\n---\n');

    const out = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
      messages: [{ role: 'system', content: SYSTEM.replace('{{today}}', new Date().toISOString().slice(0, 10)) }, { role: 'user', content: text }],
      response_format: { type: 'json_object' }, max_tokens: 400,
    } as any);
    const j = safeJson((out as any).response);
    if (!j) return;

    const missing = REQUIRED.filter((f) => j[f] == null || (j.confidence?.[f] ?? 0) < 0.5);
    const status = missing.length ? 'needs_info' : 'new';
    await tx`UPDATE leads SET
      product = ${j.product}, qty = ${j.qty}, size = ${j.size}, stock = ${j.stock}, color = ${j.color}, finish = ${j.finish},
      deadline_at = ${j.deadline ? new Date(j.deadline) : null}, rush = ${!!j.rush},
      spec = spec || ${tx.json({ notes: j.notes ?? '' })}, confidence = ${tx.json(j.confidence ?? {})},
      missing_fields = ${missing}, status = CASE WHEN status IN ('new','needs_info') THEN ${status}::lead_status ELSE status END
      WHERE id = ${leadId}`;
    await tx`INSERT INTO activity (id, org_id, lead_id, actor, kind, detail) VALUES (${crypto.randomUUID()}, ${orgId}, ${leadId}, 'system', 'specs.extracted', ${tx.json({ missing, low: FIELDS.filter((f) => (j.confidence?.[f] ?? 1) < 0.6) })})`;
    // TODO: notify InboxRoom DO for this org so open queues refresh
  });
  await env.JOBS.send({ kind: 'score_intent', orgId, leadId });
}

function safeJson(s: string) { try { return JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1)); } catch { return null; } }
