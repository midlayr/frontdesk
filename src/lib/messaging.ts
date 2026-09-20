import type { Org } from '../env';

/**
 * Everything the system says to a customer on voice and SMS.
 *
 * Defaults live here rather than at each call site, so the settings screen and the webhooks
 * cannot drift — what the editor shows as the current value is literally what would be said.
 * Nothing here is Dumont-specific: the fallbacks are written in terms of the org's own name.
 */

/**
 * Voices Twilio's <Say> accepts, curated rather than exhaustive.
 *
 * The -Neural variants are Amazon Polly's neural engine and sound markedly less synthetic
 * than the standard ones; the old hardcoded Polly.Joanna was a standard voice, which is why
 * it sounded like a robot. Standard voices are kept at the bottom because they cost less per
 * character, which matters to a shop taking a lot of calls.
 */
export const TTS_VOICES = [
  { id: 'Polly.Joanna-Neural',   label: 'Joanna · US female · neural',     neural: true },
  { id: 'Polly.Danielle-Neural', label: 'Danielle · US female · neural',   neural: true },
  { id: 'Polly.Ruth-Neural',     label: 'Ruth · US female · neural',       neural: true },
  { id: 'Polly.Kendra-Neural',   label: 'Kendra · US female · neural',     neural: true },
  { id: 'Polly.Matthew-Neural',  label: 'Matthew · US male · neural',      neural: true },
  { id: 'Polly.Stephen-Neural',  label: 'Stephen · US male · neural',      neural: true },
  { id: 'Polly.Gregory-Neural',  label: 'Gregory · US male · neural',      neural: true },
  { id: 'Polly.Joey-Neural',     label: 'Joey · US male · neural',         neural: true },
  { id: 'Polly.Amy-Neural',      label: 'Amy · UK female · neural',        neural: true },
  { id: 'Polly.Brian-Neural',    label: 'Brian · UK male · neural',        neural: true },
  { id: 'Polly.Joanna',          label: 'Joanna · US female · standard',   neural: false },
  { id: 'Polly.Matthew',         label: 'Matthew · US male · standard',    neural: false },
  { id: 'alice',                 label: 'Alice · Twilio classic',          neural: false },
] as const;

export type TtsVoice = (typeof TTS_VOICES)[number]['id'];
export const isTtsVoice = (v: unknown): v is TtsVoice =>
  typeof v === 'string' && TTS_VOICES.some((x) => x.id === v);

export interface VoiceMessaging {
  greeting: string;
  after_record: string;
  no_input: string;
  max_seconds: number;
  tts_voice: string;
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
      tts_voice: 'Polly.Joanna-Neural',
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
    voice: {
      ...d.voice,
      ...(legacyGreeting ? { greeting: legacyGreeting } : {}),
      ...(saved.voice ?? {}),
      // a tenant saved before the picker existed has no voice stored
      tts_voice: isTtsVoice(saved.voice?.tts_voice) ? saved.voice.tts_voice : d.voice.tts_voice,
    },
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
