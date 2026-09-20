import { Fragment, useCallback, useLayoutEffect, useRef, useState } from 'react';
import { FIELDS, KIND, ROUTES, TO_TICKET, labelsOf, type Step } from './flows-api';

/**
 * The flow as a diagram.
 *
 * Draws what src/flow-engine.ts actually does, not what the step list implies:
 *
 *  - questions run top to bottom in document order, and an answer with no destination of
 *    its own falls through to the next one. That includes anything typed rather than
 *    tapped, which is why the straight spine is always a real path.
 *  - a quick reply with a destination is drawn as a curve in the left gutter, so a branch
 *    is visible as a branch rather than as a line of small print.
 *  - the handoff rule is not the ninth step. It is tested against every reply from the
 *    first one on, so it is a rail beside the whole column.
 *
 * Curves need real geometry, so node positions are measured after layout rather than
 * guessed; a ResizeObserver redraws them when the column reflows.
 */

type Ask = Extract<Step, { kind: 'ask' }>;

const isAsk = (s: Step): s is Ask => s.kind === 'ask';
const chipsOf = (s: Ask) => (s.chips ?? '').split(',').map((c) => c.trim()).filter(Boolean);

interface Edge { from: string; to: string | null; label: string; }
interface Box { top: number; bottom: number; left: number; }

export function FlowMap({ steps, accent, onPick, loops }: {
  steps: Step[];
  accent: string;
  loops: Set<string>;
  onPick: (index: number) => void;
}) {
  const asks = steps.flatMap((s, i) => (isAsk(s) ? [{ s, i }] : []));
  const ruleAt = steps.findIndex((s) => s.kind === 'rule');
  const ticketAt = steps.findIndex((s) => s.kind === 'ticket');
  const rule = ruleAt >= 0 ? (steps[ruleAt] as Extract<Step, { kind: 'rule' }>) : null;
  const ticket = ticketAt >= 0 ? (steps[ticketAt] as Extract<Step, { kind: 'ticket' }>) : null;
  const words = rule ? rule.words.split(',').map((w) => w.trim()).filter(Boolean) : [];

  // Only answers pinned somewhere else are edges; the rest are the spine.
  const edges: Edge[] = asks.flatMap(({ s }) =>
    labelsOf(s)
      .filter((l) => s.next?.[l])
      .map((l) => ({ from: s.id!, to: s.next![l] === TO_TICKET ? null : s.next![l], label: l })));

  const wrap = useRef<HTMLDivElement>(null);
  const nodes = useRef(new Map<string, HTMLElement>());
  const [boxes, setBoxes] = useState<Record<string, Box>>({});
  const [size, setSize] = useState({ w: 0, h: 0 });

  const measure = useCallback(() => {
    const root = wrap.current;
    if (!root) return;
    const base = root.getBoundingClientRect();
    const next: Record<string, Box> = {};
    for (const [id, el] of nodes.current) {
      if (!el.isConnected) continue;
      const r = el.getBoundingClientRect();
      next[id] = { top: r.top - base.top, bottom: r.bottom - base.top, left: r.left - base.left };
    }
    setBoxes(next);
    setSize({ w: base.width, h: base.height });
  }, []);

  useLayoutEffect(() => {
    measure();
    const ro = new ResizeObserver(measure);
    if (wrap.current) ro.observe(wrap.current);
    for (const el of nodes.current.values()) ro.observe(el);
    return () => ro.disconnect();
  }, [measure, steps]);

  const hold = (id: string) => (el: HTMLElement | null) => {
    if (el) nodes.current.set(id, el); else nodes.current.delete(id);
  };

  return (
    <div className="fm">
      <div className="fm-scroll">
        <div className="fm-wrap" ref={wrap}>

          {/* Branch curves, behind the nodes. Drawn in the gutter the grid leaves free. */}
          <svg className="fm-edges" width={size.w} height={size.h} aria-hidden="true">
            {edges.map((e, n) => {
              const a = boxes[e.from];
              const b = e.to ? boxes[e.to] : boxes['__ticket__'];
              if (!a || !b) return null;
              const back = b.top < a.top;
              const x0 = a.left;
              const y0 = a.bottom - 14;
              const y1 = back ? b.top + 14 : b.top + 6;
              // Deeper jumps bow further out, so parallel branches stay distinguishable.
              const reach = Math.min(20 + Math.abs(y1 - y0) / 7, 64);
              const cx = x0 - reach;
              return (
                <g key={`${e.from}-${e.label}-${n}`}>
                  <path d={`M ${x0} ${y0} C ${cx} ${y0}, ${cx} ${y1}, ${x0 - 4} ${y1}`}
                        fill="none" stroke={back ? 'var(--rush)' : accent} strokeWidth="1.5"
                        strokeDasharray={back ? '4 3' : undefined} opacity=".75" />
                  <circle cx={x0} cy={y0} r="2.5" fill={back ? 'var(--rush)' : accent} />
                  <path d={`M ${x0 - 9} ${y1 - 3.5} L ${x0 - 3} ${y1} L ${x0 - 9} ${y1 + 3.5} Z`}
                        fill={back ? 'var(--rush)' : accent} />
                </g>
              );
            })}
          </svg>

          {/* Edge labels are HTML, so they wrap and stay legible over the curve. */}
          {edges.map((e, n) => {
            const a = boxes[e.from];
            const b = e.to ? boxes[e.to] : boxes['__ticket__'];
            if (!a || !b) return null;
            const y0 = a.bottom - 14;
            const y1 = (b.top) + 6;
            const reach = Math.min(20 + Math.abs(y1 - y0) / 7, 64);
            // Sat on the curve's apex rather than beyond it: a long jump bows out furthest,
            // and a label hung off the end of that was landing outside the gutter.
            return (
              <span key={`l-${e.from}-${e.label}-${n}`} className="fm-edge-label"
                    style={{ top: (y0 + y1) / 2, left: a.left - reach * 0.78 }}>
                {e.label}
              </span>
            );
          })}

          <div className="fm-grid">
            {/* ── start ── */}
            <div className="fm-cell">
              <span className="fm-terminus">
                <span className="fm-dot" style={{ background: accent }} />
                Visitor opens the chat
              </span>
              <Join label="greeting" />
            </div>
            <div className={`fm-rail${rule ? ' on' : ''}`}>
              {rule && (
                <button className="fm-node fm-rule" onClick={() => onPick(ruleAt)}
                        style={{ borderLeftColor: KIND.rule.color }}>
                  <span className="fm-kind" style={{ color: KIND.rule.color }}>{KIND.rule.label}</span>
                  <span className="fm-note">Tested against every reply, from the first</span>
                  <span className="fm-chips">
                    {words.length
                      ? words.map((w) => <i key={w} className="fm-word">{w}</i>)
                      : <i className="fm-word fm-none">no keywords — never fires</i>}
                  </span>
                  {/* Shown only when the column is too narrow for the rail, where the
                      separate LIVE REP node would land eight questions away from its
                      cause and the rule would read as the step before question 01. */}
                  <span className="fm-rule-outcome">
                    → a rep takes over: “{rule.handoff || '—'}”
                  </span>
                </button>
              )}
            </div>

            {/* ── the questions ── */}
            {asks.map(({ s, i }, n) => {
              const chips = chipsOf(s);
              const pinned = new Set(labelsOf(s).filter((l) => s.next?.[l]));
              const last = n === asks.length - 1;
              const loop = loops.has(s.id ?? `#${n}`);
              return (
                <Fragment key={s.id ?? i}>
                  <div className="fm-cell">
                    <button ref={hold(s.id!)} className="fm-node fm-ask" onClick={() => onPick(i)}
                            style={{ borderLeftColor: KIND.ask.color }}>
                      <span className="fm-top">
                        <span className="fm-n">{String(n + 1).padStart(2, '0')}</span>
                        <span className="fm-kind" style={{ color: KIND.ask.color }}>{KIND.ask.label}</span>
                        <span className="fm-field">→ {FIELDS[s.field] ?? s.field}</span>
                      </span>
                      <span className="fm-prompt">{s.prompt}</span>
                      <span className="fm-chips">
                        {chips.map((c) => (
                          <i key={c} className={`fm-chip${pinned.has(c) ? ' pinned' : ''}`}
                             style={pinned.has(c)
                               ? { borderColor: accent, background: 'var(--accent-tint)', color: 'var(--accent-tint-fg)' }
                               : { borderColor: 'var(--line)', color: 'var(--ink-2)' }}>
                            {c}
                          </i>
                        ))}
                        {s.skippable && (
                          <i className={`fm-chip fm-skip${pinned.has('Skip') ? ' pinned' : ''}`}>Skip</i>
                        )}
                        {!chips.length && !s.skippable && <i className="fm-chip fm-free">free text</i>}
                      </span>
                      {loop && <span className="fm-loop">A branch here can come back to this question</span>}
                    </button>
                    <Join label={pinned.size ? 'anything else' : 'any answer'} />
                  </div>

                  <div className={`fm-rail${rule ? ' on' : ''}`}>
                    {rule && <span className="fm-tick" />}
                    {last && rule && (
                      <button className="fm-node fm-live" onClick={() => onPick(ruleAt)}
                              style={{ borderLeftColor: 'var(--ok)' }}>
                        <span className="fm-kind" style={{ color: 'var(--ok)' }}>LIVE REP</span>
                        <span className="fm-prompt">{rule.handoff || '—'}</span>
                        <span className="fm-note">
                          {rule.route && rule.route !== 'live'
                            ? `Set to “${ROUTES[rule.route] ?? rule.route}” — but a rep is brought in regardless.`
                            : 'The bot stops asking and a rep takes over.'}
                        </span>
                      </button>
                    )}
                  </div>
                </Fragment>
              );
            })}

            {/* ── end ── */}
            <div className="fm-cell">
              <button ref={hold('__ticket__')} className="fm-node fm-ticket"
                      onClick={() => ticketAt >= 0 && onPick(ticketAt)}
                      style={{ borderLeftColor: KIND.ticket.color }}>
                <span className="fm-kind" style={{ color: KIND.ticket.color }}>{KIND.ticket.label}</span>
                <span className="fm-prompt">{ticket?.text ?? 'Thanks — your request is in.'}</span>
                <span className="fm-note">Flow ends · the ticket lands in the inbox</span>
              </button>
            </div>
            <div className="fm-rail" />
          </div>
        </div>

        <p className="fm-foot">
          {asks.length} question{asks.length === 1 ? '' : 's'}
          {edges.length
            ? `, ${edges.length} branch${edges.length === 1 ? '' : 'es'}. A reply with no branch of its own — including anything typed rather than tapped — carries on down the column.`
            : ', one straight line. Give a quick reply its own destination in the Steps editor and it will appear here as a branch.'}
        </p>
      </div>
    </div>
  );
}

function Join({ label }: { label: string }) {
  return (
    <span className="fm-join">
      <span className="fm-join-line" />
      <span className="fm-join-label">{label}</span>
    </span>
  );
}
