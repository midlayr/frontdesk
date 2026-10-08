import { useState } from 'react';
import { flowsApi, installSnippet, type Flow } from './flows-api';

/**
 * Everything about a bot that is not a question: what it is called, what it says on the
 * website, and the line of HTML that puts it there.
 *
 * All of this existed in the database and none of it could be changed. `name` was writable
 * through PUT /api/flows/:slug and had no field anywhere. `settings` had been in the schema
 * since the first migration with nothing ever writing to it, so every bot on a site shared
 * one launcher label — fine with one bot, wrong the moment a shop runs a quotes bot and a
 * reorder bot. And the script tag was shown once, while creating a bot, then never again:
 * to install a bot a second time you had to retype the tag from memory.
 *
 * Two different kinds of change live on this panel and the saving reflects that, because
 * pretending otherwise is how people end up not trusting a Save button:
 *
 *   name, launcher, nudge   save and apply at once, to the live bot included
 *   the questions           stay a draft until Publish, over on the Steps tab
 *
 * The address (data-flow) is shown and cannot be edited. It is in the KV key, in the unique
 * index, and — the reason that settles it — in the <script> tag already pasted into the
 * shop's website. Renaming it from here would take their chat bubble off their own site with
 * nothing to explain why.
 */

const COPY_FEEDBACK_MS = 1600;

/** The hostname somebody would have to allow for a given origin, for the hint below. */
function hostOf(origin: string): string {
  try { return new URL(origin).hostname; } catch { return origin; }
}

/**
 * The flow is owned by the builder and handed down, with every save reported back through
 * onChange rather than written into the prop. The header shows the name too, and a panel
 * quietly mutating the object it was passed is how two copies of a name get out of step.
 */
export function BotSetup({ flow, onChange }: { flow: Flow; onChange: (next: Flow) => void }) {
  const [name, setName] = useState(flow.name);
  const [launcher, setLauncher] = useState(flow.settings.launcher ?? '');
  const [nudge, setNudge] = useState(flow.settings.nudge ?? '');
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [err, setErr] = useState('');

  // One textarea, one domain per line. A chip editor looks tidier and is worse here: people
  // arrive with a list pasted from an email, and this takes it as-is.
  const [domains, setDomains] = useState(flow.install.domains.join('\n'));
  const [domainState, setDomainState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [rejected, setRejected] = useState<string[]>([]);

  const [copied, setCopied] = useState(false);

  const snippet = installSnippet(flow.install, flow.slug);
  const dirty =
    name.trim() !== flow.name ||
    launcher.trim() !== (flow.settings.launcher ?? '') ||
    nudge.trim() !== (flow.settings.nudge ?? '');

  async function save() {
    setState('saving'); setErr('');
    try {
      const r = await flowsApi.settings(flow.slug, { name: name.trim(), launcher, nudge });
      // Back up to the builder, which shows the name in its header and has no other reason
      // to re-fetch the flow.
      onChange({ ...flow, name: r.name, settings: r.settings });
      setState('saved');
    } catch (e) {
      setErr(e instanceof Error ? e.message.replace(/^\d+\s*/, '') : String(e));
      setState('idle');
    }
  }

  async function saveDomains() {
    setDomainState('saving'); setErr(''); setRejected([]);
    try {
      const r = await flowsApi.saveDomains(domains.split('\n').map((d) => d.trim()).filter(Boolean));
      setDomains(r.allowed_domains.join('\n'));
      setRejected(r.rejected);
      onChange({ ...flow, install: { ...flow.install, domains: r.allowed_domains } });
      setDomainState('saved');
    } catch (e) {
      setErr(e instanceof Error ? e.message.replace(/^\d+\s*/, '') : String(e));
      setDomainState('idle');
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    } catch {
      // Clipboard access needs a secure context and a permission; when it is refused, say so
      // rather than flashing "Copied" over a clipboard that never changed.
      setErr('Could not reach the clipboard — select the snippet and copy it by hand.');
    }
  }

  return (
    <div className="set-scroll">
      {/* ── what it is called, and what it says ── */}
      <div className="set-card">
        <div className="label">This bot</div>
        <p className="invite-sub">
          The name is for your team. The next two are the words a visitor sees on your website,
          and they apply as soon as you save — including to the bot that is running now.
        </p>

        <div className="setup-fields">
          <label className="fb-field">
            <span className="label">Name <i>· only your team sees this</i></span>
            <input value={name} onChange={(e) => { setName(e.target.value); setState('idle'); }}
                   placeholder="Reorder enquiries" maxLength={80} />
          </label>

          <label className="fb-field">
            <span className="label">Address <i>· fixed once installed</i></span>
            <input value={flow.slug} readOnly disabled />
            <span className="setup-hint">
              This is the <code>data-flow</code> in the snippet below. It cannot be changed,
              because it is already in the HTML on your site — changing it here would take
              this bot off your pages. Need a different address? Make a new bot and swap the
              snippet over.
            </span>
          </label>

          <label className="fb-field">
            <span className="label">Button label <i>· on your website</i></span>
            <input value={launcher} onChange={(e) => { setLauncher(e.target.value); setState('idle'); }}
                   placeholder="Get a quote" maxLength={40} />
            <span className="setup-hint">
              Leave it empty to use the same wording as your other bots. Give each bot its own
              when they sit on different pages — "Get a quote" is the wrong words on a reorder
              page.
            </span>
          </label>

          <label className="fb-field">
            <span className="label">Nudge <i>· appears after a few seconds</i></span>
            <textarea rows={2} value={nudge} maxLength={160}
                      onChange={(e) => { setNudge(e.target.value); setState('idle'); }}
                      placeholder="Need a price? Tell me what you're printing." />
          </label>
        </div>

        <div className="invite-acts">
          <button className="btn-primary" onClick={save} disabled={!dirty || state === 'saving'}>
            {state === 'saving' ? 'Saving…' : 'Save'}
          </button>
          <span className="team-note" style={{ margin: 0, alignSelf: 'center' }}>
            {state === 'saved'
              ? flow.live ? 'Saved — live on your site now.' : 'Saved. This bot is paused, so nothing has changed on your site yet.'
              : dirty ? 'Unsaved changes.' : ''}
          </span>
        </div>
        {err && <p className="team-err">{err}</p>}
      </div>

      {/* ── the one line of HTML ── */}
      <div className="set-card">
        <div className="label">Install on your website</div>
        <p className="invite-sub">
          Paste this once, just before <code>&lt;/body&gt;</code>, on every page the bot should
          appear on. Nothing else to add — it brings its own styling and loads after your page,
          so it cannot slow it down.
        </p>

        <pre className="setup-snippet"><code>{snippet}</code></pre>
        <div className="invite-acts">
          <button className="btn-primary" onClick={copy}>{copied ? 'Copied' : 'Copy snippet'}</button>
        </div>

        {!flow.install.origin && (
          <p className="team-err">
            This install address is not configured on the server, so the snippet above is
            incomplete. PUBLIC_ORIGIN needs setting before it will work.
          </p>
        )}

        {!flow.live && (
          <p className="setup-warn">
            This bot is paused, so the snippet is safe to install but nothing will appear until
            you publish it.
          </p>
        )}

        <p className="setup-hint" style={{ marginTop: 14 }}>
          Several bots on one site: paste the same line with each bot's own address. One per
          page — two on the same page would give a visitor two bubbles.
        </p>
      </div>

      {/* ── the allowlist, which is the usual reason a correct snippet does nothing ── */}
      <div className="set-card">
        <div className="label">Where it is allowed to run</div>
        <p className="invite-sub">
          The bot only loads on these sites, and so do your website quote forms. If your
          address is missing here the snippet is ignored with no visible error — this is the
          first thing to check when a bot "isn't appearing".
        </p>

        <label className="fb-field">
          <span className="label">Your domains <i>· one per line</i></span>
          <textarea rows={Math.max(3, domains.split('\n').length + 1)} value={domains}
                    onChange={(e) => { setDomains(e.target.value); setDomainState('idle'); }}
                    placeholder={'dumontprinting.com\nshop.dumontprinting.com'} />
          <span className="setup-hint">
            Paste a full web address if that is easier — only the domain is kept. Subdomains of
            anything listed are covered, so <code>dumontprinting.com</code> also allows{' '}
            <code>www.dumontprinting.com</code>.
          </span>
        </label>

        {domains.trim() === '' && (
          <p className="setup-warn">
            Nothing is listed, so the bot will not load anywhere. Add the shop's domain.
          </p>
        )}

        <div className="invite-acts">
          <button className="btn-primary" onClick={saveDomains} disabled={domainState === 'saving'}>
            {domainState === 'saving' ? 'Saving…' : 'Save domains'}
          </button>
          <span className="team-note" style={{ margin: 0, alignSelf: 'center' }}>
            {domainState === 'saved' && !rejected.length ? 'Saved. Live within a minute.' : ''}
          </span>
        </div>

        {rejected.length > 0 && (
          <p className="team-err">
            Not a domain, so not saved: {rejected.join(', ')}
          </p>
        )}

        <p className="setup-hint" style={{ marginTop: 14 }}>
          Testing on your own machine? Add <code>localhost</code>. The admin app at{' '}
          <code>{hostOf(flow.install.origin) || 'this address'}</code> does not need listing —
          this list is about your public website.
        </p>
      </div>
    </div>
  );
}
