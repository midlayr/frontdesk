import type { Env } from '../env';

/**
 * One JSON-returning model call, from whichever provider this deployment has.
 *
 * Claude when ANTHROPIC_API_KEY is set, the Workers AI binding otherwise. The fallback is
 * not a lesser path kept for politeness — it is what every existing deployment runs on, and
 * it has to keep working for a shop that never adds a key.
 *
 * Both providers are coaxed into JSON differently and both sometimes wrap it in prose, so
 * the extraction of the object is shared and deliberately forgiving.
 */

const CLAUDE_DEFAULT = 'claude-haiku-5-5';
const WORKERS_DEFAULT = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

/** The first balanced {...} in a string, for a model that fenced or prefaced its JSON. */
export function firstObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

async function viaClaude(env: Env, system: string, user: string, schema: unknown): Promise<unknown> {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY as string,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: env.ANTHROPIC_MODEL || CLAUDE_DEFAULT,
      max_tokens: 1500,
      system: `${system} Reply with JSON only, matching this schema: ${JSON.stringify(schema)}`,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!r.ok) throw new Error(`anthropic ${r.status} ${(await r.text()).slice(0, 200)}`);
  const body = await r.json() as { content?: { type: string; text?: string }[] };
  return (body.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
}

async function viaWorkersAI(env: Env, system: string, user: string, schema: unknown): Promise<unknown> {
  const model = (env.AI_MODEL || WORKERS_DEFAULT) as never;
  const call = async (structured: boolean) => {
    const body: Record<string, unknown> = {
      messages: [
        { role: 'system', content: structured ? system
            : `${system} Reply with JSON only, matching this schema: ${JSON.stringify(schema)}` },
        { role: 'user', content: user },
      ],
      max_tokens: 1500,
    };
    if (structured) body.response_format = { type: 'json_schema', json_schema: schema };
    return (await env.AI.run(model, body as never)) as { response?: unknown };
  };
  // Structured output is model-dependent on Workers AI; one that rejects response_format
  // gets a second pass with the schema described in the prompt instead.
  try {
    const res = await call(true);
    if (res?.response !== undefined) return res.response;
  } catch { /* fall through */ }
  return (await call(false))?.response;
}

/** The model's answer as a parsed object, or null when nothing usable came back. */
export async function runJson(
  env: Env, system: string, user: string, schema: unknown,
): Promise<Record<string, unknown> | null> {
  const raw = env.ANTHROPIC_API_KEY
    ? await viaClaude(env, system, user, schema)
    : await viaWorkersAI(env, system, user, schema);

  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return null;
  const json = firstObject(raw);
  if (!json) return null;
  try { return JSON.parse(json) as Record<string, unknown>; } catch { return null; }
}

/** Which provider a call would use, for the health panel and for logs. */
export const aiProvider = (env: Env) =>
  env.ANTHROPIC_API_KEY ? (env.ANTHROPIC_MODEL || CLAUDE_DEFAULT) : (env.AI_MODEL || WORKERS_DEFAULT);
