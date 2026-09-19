// Runtime theming: platform tokens + per-tenant overrides from GET /api/org → orgs.brand
// Usage (React root): useEffect(() => applyTheme(org.brand), [org])
export interface Brand {
  app_name?: string;           // "Dumont Front Desk" — header wordmark, <title>
  color?: string;              // hex accent, e.g. "#0B7FA8"
  logo_r2_key?: string;        // horizontal logo, shown at 22px tall in the header
  mark_r2_key?: string;        // square mark, favicon + collapsed rail
  show_powered_by?: boolean;   // "powered by Midlayr" after the wordmark
}

export function applyTheme(brand: Brand) {
  const r = document.documentElement.style;
  if (brand.color) {
    const c = parseHex(brand.color);
    r.setProperty('--accent', brand.color);
    r.setProperty('--accent-deep', mix(c, [0, 0, 0], .28));       // darker for hover/borders
    r.setProperty('--accent-wash', mix(c, [251, 250, 248], .88)); // toward paper for selection/chips
    r.setProperty('--accent-text', mix(c, [251, 250, 248], .78));
  }
  if (brand.app_name) document.title = brand.app_name;
}

function parseHex(h: string): [number, number, number] {
  const s = h.replace('#', ''); const n = parseInt(s.length === 3 ? s.split('').map((x) => x + x).join('') : s, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function mix(a: [number, number, number], b: [number, number, number], t: number) {
  return '#' + a.map((v, i) => Math.round(v + (b[i] - v) * t).toString(16).padStart(2, '0')).join('');
}

// Google Fonts, loaded once in index.html:
// <link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@125,500;125,600;125,700&family=Inter+Tight:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
