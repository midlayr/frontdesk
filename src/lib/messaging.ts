import type { Org } from '../env';

/**
 * Everything the system says to a customer on voice and SMS.
 *
 * Defaults live here rather than at each call site, so the settings screen and the webhooks
 * cannot drift — what the editor shows as the current value is literally what would be said.
 * Nothing here is Dumont-specific: the fallbacks are written in terms of the org's own name.
 */

export interface VoiceMessaging {
  greeting: string;
  after_record: string;
  no_input: string;
  max_seconds: number;
}

export interface SmsMessaging {
  auto_reply_enabled: boolean;
  auto_reply: string;
  signature: string;
}

export interface Messaging { voice: VoiceMessaging; sms: SmsMessaging }

export function defaults(orgName: string): Messaging {
  return {
    voice: {
      greeting: `Thanks for calling ${orgName}. Nobody is free right now — leave the details of your job after the tone and we'll come straight back to you.`,
      after_record: `Got it — thanks. We'll be in touch shortly. Goodbye.`,
      no_input: `We didn't catch that. Please call back or text us. Goodbye.`,
      max_seconds: 180,
    },
    sms: {
      auto_reply_enabled: false,
      auto_reply: `Thanks — we've got your message and someone will reply shortly.`,
      signature: '',
    },
  };
}

/**
 * Merge a tenant's saved values over the defaults.
 *
 * Also honours the older comms.voice_greeting, which was the only configurable line before
 * this existed, so nobody's greeting silently reverts.
 */
export function messagingFor(org: Org): Messaging {
  const d = defaults(org.name);
  const comms = org.comms as Record<string, unknown>;
  const saved = (comms.messaging ?? {}) as Partial<Messaging>;
  const legacyGreeting = typeof comms.voice_greeting === 'string' ? comms.voice_greeting : undefined;

  return {
    voice: { ...d.voice, ...(legacyGreeting ? { greeting: legacyGreeting } : {}), ...(saved.voice ?? {}) },
    sms: { ...d.sms, ...(saved.sms ?? {}) },
  };
}

/** {org} and {ticket} are the only tokens; anything else is left alone rather than blanked. */
export function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => vars[key] ?? whole);
}

/** TwiML is XML: an unescaped & or < in a greeting breaks the whole call. */
export function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
