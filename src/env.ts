// Bindings and job shapes. Shared by the fetch, queue and scheduled handlers.

export interface Env {
  HYPERDRIVE: Hyperdrive;
  FILES: R2Bucket;
  CONFIG: KVNamespace;
  JOBS: Queue<Job>;
  AI: Ai;
  ASSETS: Fetcher;            // the built rep app in web/dist
  INTERNAL: Fetcher;          // self service-binding, so DOs can call Worker routes
  CHAT_SESSION: DurableObjectNamespace;
  INBOX_ROOM: DurableObjectNamespace;
  TWILIO_SID: string;
  TWILIO_AUTH_TOKEN: string;
  RESEND_API_KEY: string;
  SESSION_SECRET: string;
  PLATFORM_DOMAIN: string;
  AI_MODEL?: string;
  WIDGET_ORIGIN: string;
}

// Every job carries orgId: the consumer has no request to resolve a tenant from.
export type Job =
  | { kind: 'transcribe';   orgId: string; messageId: string }
  | { kind: 'extract_specs'; orgId: string; leadId: string }
  | { kind: 'score_intent';  orgId: string; leadId: string }
  | { kind: 'enrich';        orgId: string; contactId: string }
  | { kind: 'import_rows';   orgId: string; importId: string; offset: number }
  | { kind: 'drip_send';     orgId: string; enrollmentId: string };

// The tenant, as resolved once per request and carried on the context.
/** A published chat flow, as stored in KV under flow:<orgId>:<slug>. */
export type Step =
  | {
      kind: 'ask';
      /**
       * Stable identity, so a branch keeps pointing at the same question after a reorder.
       * Optional because flows authored before branching have none; the engine falls back
       * to position for those, and the API backfills on the next save.
       */
      id?: string;
      prompt: string;
      field: string;
      chips?: string;
      skippable?: boolean;
      /**
       * Quick reply → where that answer goes. The key is the chip label exactly as shown
       * (or 'Skip'); the value is an ask id, or 'ticket' to finish the flow there. Answers
       * with no entry — including anything free-typed — fall through to the next question
       * in order, which is what every flow did before branching existed.
       */
      next?: Record<string, string>;
    }
  | { kind: 'rule'; words: string; handoff: string; route: string }
  | { kind: 'ticket'; text: string };

export interface PublishedFlow {
  id: string;
  version: number;
  steps: Step[];
}

export interface Org {
  id: string;
  slug: string;
  name: string;
  brand: Record<string, unknown>;
  comms: { email_from?: string; sms_number?: string; voice_number?: string; signature?: string };
  widget: Record<string, unknown>;
  features: Record<string, boolean>;
}
