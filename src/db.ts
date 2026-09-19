import postgres from 'postgres';
import type { Env } from './env';

export type Sql = postgres.Sql<{}>;
export type Tx = postgres.TransactionSql<{}>;

// Cloudflare's guidance for Hyperdrive: build the client per request, never share one
// across requests (a socket belongs to the I/O context that opened it), and close it
// with ctx.waitUntil so the response isn't held up.
export function connect(env: Env): Sql {
  return postgres(env.HYPERDRIVE.connectionString, {
    max: 5,
    fetch_types: false, // saves a round trip per connection; Hyperdrive pools upstream
  });
}

/**
 * The only way to touch tenant data.
 *
 * Opens a transaction, pins app.org_id to it, and hands the caller a transaction handle.
 * Every RLS policy in schema.sql reads that setting, so a query run outside withOrg()
 * sees zero rows rather than another tenant's.
 *
 * Note `set_config(..., true)` rather than `SET LOCAL app.org_id = ${orgId}`: SET does not
 * accept bind parameters, so the literal form would mean interpolating into SQL by hand.
 */
export async function withOrg<T>(sql: Sql, orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`SELECT set_config('app.org_id', ${orgId}, true)`;
    return fn(tx as Tx);
  }) as Promise<T>;
}
