import type { Env } from '../env';

/**
 * One object per live Midlayr Chat conversation: holds the visitor socket, runs the
 * published flow, and hands off to a rep on takeover.
 *
 * Stub — the widget ships after the SMS loop (GETTING-STARTED §5).
 */
export class ChatSession implements DurableObject {
  constructor(private state: DurableObjectState, private env: Env) {}

  async fetch(_req: Request): Promise<Response> {
    return new Response('ChatSession not implemented', { status: 501 });
  }
}
