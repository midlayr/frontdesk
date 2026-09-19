// Bindings and job shapes. Shared by the fetch, queue and scheduled handlers.

export interface Env {
  HYPERDRIVE: Hyperdrive;
  FILES: R2Bucket;
  CONFIG: KVNamespace;
  JOBS: Queue<Job>;
  AI: Ai;
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
export interface Org {
  id: string;
  slug: string;
  name: string;
  brand: Record<string, unknown>;
  comms: { email_from?: string; sms_number?: string; voice_number?: string; signature?: string };
  widget: Record<string, unknown>;
  features: Record<string, boolean>;
}
