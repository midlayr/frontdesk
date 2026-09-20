import { useEffect, useState } from 'react';
import { SCALES, applyBrand, applyScale, currentScale, orgSlug, type ScaleId } from './api';

/**
 * How Front Desk looks.
 *
 * Two settings that behave differently on purpose. The palette belongs to the tenant — one
 * shop, one set of colours, everyone sees it, and only an admin may change it. Text size
 * belongs to whoever is reading: it never leaves the browser, so a rep on a shop-floor
 * screen can size it up without imposing that on a colleague on a laptop.
 */

interface Brand { color: string; ink: string; paper: string; app_name: string }

/** Starting points, not a cage — each one is still editable as a hex value afterwards. */
const PRESETS: { name: string; color: string; ink: string; paper: string }[] = [
  { name: 'Dumont teal', color: '#1CA3B6', ink: '#14161A', paper: '#FBFAF8' },
  { name: 'Press blue', color: '#0B7FA8', ink: '#14161A', paper: '#FBFAF8' },
  { name: 'Ink black', color: '#2B2B2B', ink: '#111111', paper: '#FAFAF9' },
  { name: 'Forest', color: '#1F7A4D', ink: '#14201A', paper: '#FAFBF9' },
  { name: 'Oxblood', color: '#8E2B34', ink: '#1A1416', paper: '#FCFAF9' },
  { name: 'Slate', color: '#3A4F66', ink: '#12171C', paper: '#FAFBFC' },
];

const headers = () => {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  const u = localStorage.getItem('fd_user'); if (u) h['x-dev-user'] = u;
  const t = sessionStorage.getItem('fd_token'); if (t) h['x-admin-token'] = t;
  return h;
};
const url = (p: string) => `${p}${p.includes('?') ? '&' : '?'}org=${encodeURIComponent(orgSlug)}`;

export function Appearance({ me, org }: {
  me: { id: string; role: string } | null;
  org: { id: string; slug: string; name: string } | null;
}) {
  const [brand, setBrand] = useState<Brand | null>(null);
  const [saved, setSaved] = useState<string>('');
  const [scale, setScale] = useState<ScaleId>(currentScale());
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [error, setError] = useState('');

  const isAdmin = me?.role === 'admin';
  const dirty = !!brand && JSON.stringify(brand) !== saved;

  useEffect(() => {
    fetch(url('/api/settings/brand'), { headers: headers() })
      .then((r) => r.json())
      .then((d) => { setBrand(d.brand); setSaved(JSON.stringify(d.brand)); })
      .catch((e) => setError(String(e)));
  }, []);

  // Preview live. The palette is applied as you pick it rather than on save, because judging
  // a colour from a swatch is guesswork — you want to see it on the real interface.
  useEffect(() => {
    if (brand && org) applyBrand({ ...org, brand: brand as never, features: {} } as never);
  }, [brand, org]);

  const pick = (id: ScaleId) => { setScale(id); applyScale(id); };

  async function save() {
    if (!brand) return;
    setState('saving'); setError('');
    try {
      const r = await fetch(url('/api/settings/brand'), {
        method: 'PUT', headers: headers(), body: JSON.stringify(brand),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `${r.status}`);
      setSaved(JSON.stringify(brand));
      setState('saved');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setState('idle'); }
  }

  function revert() {
    if (!saved) return;
    const b = JSON.parse(saved) as Brand;
    setBrand(b);
    setState('idle');
  }

  return (
    <div className="appear">
      <div className="section">Text size</div>
      <p className="appear-note">
        Yours only. Stored in this browser and never shared with the rest of the shop.
      </p>
      <div className="fb-view appear-scale">
        {SCALES.map((s) => (
          <button key={s.id} data-on={scale === s.id} onClick={() => pick(s.id)}>{s.label}</button>
        ))}
      </div>
      <p className="appear-sample">
        The quick brown fox — DL-2046 · 500 business cards, 16pt matte
      </p>

      <div className="section">Palette</div>
      {!isAdmin && (
        <p className="appear-note">Only an admin can change the shop's colours.</p>
      )}

      {brand && (
        <>
          <div className="appear-presets">
            {PRESETS.map((p) => (
              <button key={p.name} disabled={!isAdmin} title={p.name}
                      onClick={() => setBrand({ ...brand, color: p.color, ink: p.ink, paper: p.paper })}>
                <i style={{ background: p.color }} />
                <i style={{ background: p.ink }} />
                <i style={{ background: p.paper, border: '1px solid var(--line)' }} />
                <span>{p.name}</span>
              </button>
            ))}
          </div>

          <div className="appear-fields">
            <Swatch label="Accent" hint="buttons, links, the chat launcher"
                    value={brand.color} disabled={!isAdmin}
                    onChange={(v) => setBrand({ ...brand, color: v })} />
            <Swatch label="Ink" hint="text and dark bars"
                    value={brand.ink} disabled={!isAdmin}
                    onChange={(v) => setBrand({ ...brand, ink: v })} />
            <Swatch label="Paper" hint="page and card backgrounds"
                    value={brand.paper} disabled={!isAdmin}
                    onChange={(v) => setBrand({ ...brand, paper: v })} />
            <label className="fb-field">
              <span className="label">App name <i>· the browser tab</i></span>
              <input value={brand.app_name} disabled={!isAdmin}
                     onChange={(e) => setBrand({ ...brand, app_name: e.target.value })} />
            </label>
          </div>

          {isAdmin && (
            <div className="appear-actions">
              <button className="btn-primary" onClick={save} disabled={!dirty || state === 'saving'}>
                {state === 'saving' ? 'Saving…' : dirty ? 'Save palette' : 'Saved'}
              </button>
              {dirty && <button className="btn-ghost" onClick={revert}>Discard</button>}
              <span className="appear-live">Previewing — nothing is saved until you press Save.</span>
            </div>
          )}
        </>
      )}

      {error && <p className="team-err">{error}</p>}
    </div>
  );
}

function Swatch({ label, hint, value, disabled, onChange }: {
  label: string; hint: string; value: string; disabled: boolean; onChange: (v: string) => void;
}) {
  const valid = /^#[0-9a-fA-F]{6}$/.test(value);
  return (
    <label className="fb-field">
      <span className="label">{label} <i>· {hint}</i></span>
      <span className="appear-swatch">
        <input type="color" value={valid ? value : '#000000'} disabled={disabled}
               onChange={(e) => onChange(e.target.value)} aria-label={`${label} colour`} />
        <input className="appear-hex" value={value} disabled={disabled} spellCheck={false}
               onChange={(e) => onChange(e.target.value.trim())} />
        {!valid && <em>needs a 6-digit hex, like #1CA3B6</em>}
      </span>
    </label>
  );
}
