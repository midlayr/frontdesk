import type { Env } from '../env';

/**
 * One object per org inbox: fans new leads and status changes out to every open queue.
 *
 * Stub — realtime ships after the SMS loop (GETTING-STARTED §5).
 */
export class InboxRoom implements DurableObject {
  constructor(private state: DurableObjectState, private env: Env) {}

  async fetch(_req: Request): Promise<Response> {
    return new Response('InboxRoom not implemented', { status: 501 });
  }
}
