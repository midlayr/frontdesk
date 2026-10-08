/**
 * What a shop can change about one bot without touching its questions.
 *
 * chat_flows.settings has existed since the first migration and nothing ever wrote to it:
 * the widget read launcher and nudge off the org row, so every bot on the site said the same
 * thing. That was fine while there was one bot. Now that a shop can run several — one on the
 * quotes page, one for reorders — a single shared button label is wrong: "Get a quote" is the
 * wrong words on a reorder page.
 *
 * These are presentation only. Deliberately NOT here: allowed_domains, which gates CORS for
 * both /widget/config and /hooks/form. That belongs to the org, and a per-bot copy would let
 * whoever edits a bot widen the shop's own allowlist from inside the bot editor.
 */
export interface FlowSettings {
  /** The launcher button's label on the shop's site. */
  launcher?: string;
  /** The bubble that appears beside the launcher for a visitor who has not opened it. */
  nudge?: string;
}

export const SETTING_KEYS = ['launcher', 'nudge'] as const;

/**
 * Keep only the keys above, dropping blanks.
 *
 * Applied on the way in AND on the way out: on the way in so nothing else can be stored,
 * on the way out because the column is jsonb and a row written by hand, by a migration or
 * by a future version of this file could hold anything. A blank is dropped rather than
 * stored as '' so that clearing a field falls back to the org's wording instead of
 * rendering an empty button.
 */
export function presentation(raw: unknown): FlowSettings {
  const src = (raw ?? {}) as Record<string, unknown>;
  const out: FlowSettings = {};
  for (const k of SETTING_KEYS) {
    const v = src[k];
    if (typeof v === 'string' && v.trim()) out[k] = v.trim();
  }
  return out;
}
