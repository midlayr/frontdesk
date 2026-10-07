import { useEffect, useState } from 'react';
import { flowsApi, ago, type FlowSummary } from './flows-api';

/**
 * Every bot this shop has, and whether each is answering customers.
 *
 * chat_flows has always been keyed per slug and the widget has always taken data-flow, so
 * several bots were always possible — one on the quotes page, one for reorders, one behind
 * a campaign link. There was no way to see or make them, and the nav went straight to a
 * hardcoded 'quote-intake'. This is that missing way in.
 *
 * LIVE is read from the published copy in KV, not from published_at on the row. KV is what
 * the widget actually fetches, so it is the only honest answer to "is this bot running" —
 * a row can say published while the key is gone and the bubble never appears.
 */

/** "Reorder enquiries" → "reorder-enquiries". Editable, because it ends up in their HTML. */
const slugify = (s: string) =>
  s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

export function FlowList({ go }: { go: (to: string) => void }) {
  const [flows, setFlows] = useState<FlowSummary[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  const load = () => flowsApi.list().then(setFlows).catch((e) => setErr(String(e)));
  useEffect(() => { load(); }, []);

  async function run(key: string, what: () => Promise<unknown>) {
    setBusy(key); setErr('');
    try { await what(); await load(); }
    catch (e) { setErr(e instanceof Error ? e.message.replace(/^\d+\s*/, '') : String(e)); }
    finally { setBusy(''); }
  }

  const create = () => run('new', async () => {
    const s = slug.trim() || slugify(name);
    if (!name.trim()) throw new Error('Give it a name');
    if (!s) throw new Error('Give it an address');
    await flowsApi.create(name.trim(), s);
    setName(''); setSlug(''); setSlugEdited(false); setAdding(false);
    go(`/chat/flows/${s}`);
  });

  return (
    <div className="fb">
      <header className="fb-head">
        <div>
          <span className="label">Chat</span>
          <h2 className="fb-name">Your bots</h2>
        </div>
        {!adding && (
          <button className="btn-primary" onClick={() => { setAdding(true); setErr(''); }}>
            New bot
          </button>
        )}
      </header>

      <div className="set-scroll">
        <div className="flowlist">
          {adding && (
            <div className="invite-card">
              <div className="label">New bot</div>
              <p className="invite-sub">
                It starts as a draft with one question. Nothing appears on the website until
                you publish it.
              </p>
              <div className="invite-grid">
                <label className="fb-field">
                  <span className="label">Name</span>
                  <input value={name} autoFocus placeholder="Reorder enquiries"
                         onChange={(e) => {
                           setName(e.target.value);
                           if (!slugEdited) setSlug(slugify(e.target.value));
                         }} />
                </label>
                <label className="fb-field">
                  <span className="label">Address <i>· goes in the script tag</i></span>
                  <input value={slug} placeholder="reorder-enquiries"
                         onChange={(e) => { setSlugEdited(true); setSlug(slugify(e.target.value)); }} />
                </label>
              </div>
              {slug && (
                <p className="flow-embed">
                  {`<script src="/w.js" data-org="…" data-flow="${slug}" async></script>`}
                </p>
              )}
              <div className="invite-acts">
                <button className="btn-primary" disabled={busy === 'new'} onClick={create}>
                  {busy === 'new' ? 'Creating…' : 'Create and edit'}
                </button>
                <button className="btn-ghost" onClick={() => { setAdding(false); setName(''); setSlug(''); }}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          {err && <p className="team-err">{err}</p>}
          {!flows && !err && <p className="team-note">Loading…</p>}

          {flows?.length === 0 && !adding && (
            <p className="team-note">
              No bots yet. A bot is the chat bubble on a page of the shop's site — you can have
              one per page, each asking its own questions.
            </p>
          )}

          <ul className="people">
            {flows?.map((f) => (
              <li key={f.slug} className="person">
                <div className="person-who">
                  <div className="person-name">
                    <button className="flow-open" onClick={() => go(`/chat/flows/${f.slug}`)}>
                      {f.name}
                    </button>
                    <span className={`pill ${f.live ? 'ok' : 'off'}`}>{f.live ? 'Live' : 'Paused'}</span>
                  </div>
                  <div className="person-mail">data-flow="{f.slug}"</div>
                  <div className="person-why">
                    {f.questions} question{f.questions === 1 ? '' : 's'} · v{f.version} ·
                    {' '}edited {ago(f.updated_at)}
                    {!f.live && f.published_at === null && f.version > 1 && ' · taken down'}
                  </div>
                </div>

                <div className="person-acts">
                  <button onClick={() => go(`/chat/flows/${f.slug}`)}>Edit</button>
                  {f.live ? (
                    <button className="danger" disabled={busy === f.slug}
                            onClick={() => run(f.slug, () => flowsApi.pause(f.slug))}>
                      {busy === f.slug ? 'Pausing…' : 'Pause'}
                    </button>
                  ) : (
                    <button disabled={busy === f.slug}
                            onClick={() => run(f.slug, () => flowsApi.publish(f.slug))}>
                      {busy === f.slug ? 'Publishing…' : 'Publish'}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>

          {flows && flows.length > 0 && (
            <p className="team-note" style={{ marginTop: 18 }}>
              Pausing takes the bubble off the website within a minute. A visitor already
              part-way through a conversation keeps theirs — cutting off the one person who
              was engaging would be a strange way to treat them.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
