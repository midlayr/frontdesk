import type { Env, Org } from '../env';

/**
 * The sender a tenant's mail goes out as.
 *
 * Derived rather than stored so a shop that has not configured anything still sends from a
 * working address on our own domain. replyTo is the tenant's intake address when they have
 * one, so a customer hitting Reply lands back in their queue instead of in a void.
 */
export function mailFrom(org: Org, env: Env) {
  const sender = org.comms.email_sender || `${org.slug}@${env.MAILGUN_DOMAIN}`;
  return { from: `${org.name} <${sender}>`, replyTo: org.comms.email_inbound ?? sender };
}
