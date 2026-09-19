import { ulid } from 'ulid';
import type { Env, Job } from '../env';
import { withOrg, type Sql } from '../db';

const MODEL = '@cf/openai/whisper';

/**
 * transcribe: voicemail audio in R2 → text on the message → spec extraction.
 *
 * The lead already exists and is visible in the queue before this runs, so a failure here
 * costs the rep a transcript, not the enquiry. That is why a bad transcription marks the
 * message 'failed' and logs it rather than throwing the job away into the DLQ.
 */
export async function transcribe(env: Env, sql: Sql, orgId: string, messageId: string): Promise<void> {
  const row = await withOrg(sql, orgId, async (tx) => {
    const [m] = await tx<{ lead_id: string; audio_r2_key: string | null; transcript_status: string | null }[]>`
      SELECT lead_id, audio_r2_key, transcript_status FROM messages WHERE id = ${messageId}`;
    return m ?? null;
  });

  if (!row?.audio_r2_key) {
    console.warn(`transcribe: no audio for message ${messageId}`);
    return;
  }
  if (row.transcript_status === 'done') return;   // queue retries should not re-bill Whisper

  const obj = await env.FILES.get(row.audio_r2_key);
  if (!obj) {
    console.warn(`transcribe: R2 object missing: ${row.audio_r2_key}`);
    return;
  }

  let text = '';
  try {
    const bytes = new Uint8Array(await obj.arrayBuffer());
    const res = (await env.AI.run(MODEL as never, { audio: [...bytes] } as never)) as { text?: string };
    text = (res?.text ?? '').trim();
  } catch (err) {
    console.error(`transcribe: model failed for ${messageId}`, err);
  }

  const ok = text.length > 0;

  await withOrg(sql, orgId, async (tx) => {
    await tx`UPDATE messages
                SET body = ${ok ? text : null},
                    transcript_status = ${ok ? 'done' : 'failed'}
              WHERE id = ${messageId}`;

    await tx`INSERT INTO activity (id, org_id, lead_id, actor, kind, detail)
             VALUES (${ulid()}, ${orgId}, ${row.lead_id}, 'system',
                     ${ok ? 'voicemail_transcribed' : 'voicemail_unreadable'},
                     ${tx.json(ok ? { chars: text.length } : { reason: 'audio unclear' })})`;

    if (!ok) {
      // Surfaces in the queue as needing a human rather than looking like a quiet lead.
      await tx`UPDATE leads SET status = CASE WHEN status = 'new' THEN 'needs_info'::lead_status ELSE status END
                WHERE id = ${row.lead_id}`;
    }
  });

  if (ok) {
    const job: Job = { kind: 'extract_specs', orgId, leadId: row.lead_id };
    await env.JOBS.send(job);
  }
}
