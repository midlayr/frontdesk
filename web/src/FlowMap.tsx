import { Fragment } from 'react';
import { FIELDS, KIND, ROUTES, type Step } from './flows-api';

/**
 * The flow as a diagram.
 *
 * Deliberately draws what src/flow-engine.ts actually does, not what the three-column list
 * implies. Two things only become visible here:
 *
 *  - the questions are one straight line. Quick replies are canned answers, not branches:
 *    every one of them lands on the same next question.
 *  - the handoff rule is not a step that runs in ninth place. It is tested against every
 *    reply from the first one on, which is why it is drawn as a rail beside the whole
 *    column rather than as a card inside it.
 *
 * Every node is a button: clicking one opens that step in the editor, so the map doubles as
 * the table of contents for a long flow.
 */

type Ask = Extract<Step, { kind: 'ask' }>;

const isAsk = (s: Step): s is Ask => s.kind === 'ask';
const chipsOf = (s: Ask) => (s.chips ?? '').split(',').map((c) => c.trim()).filter(Boolean);

export function FlowMap({ steps, accent, onPick }: {
  steps: Step[];
  accent: string;
  onPick: (index: number) => void;
}) {
  // Indices are into the unfiltered array, so a click opens the right card in the editor.
  const asks = steps.flatMap((s, i) => (isAsk(s) ? [{ s, i }] : []));
  const ruleAt = steps.findIndex((s) => s.kind === 'rule');
  const ticketAt = steps.findIndex((s) => s.kind === 'ticket');
  const rule = ruleAt >= 0 ? (steps[ruleAt] as Extract<Step, { kind: 'rule' }>) : null;
  const ticket = ticketAt >= 0 ? (steps[ticketAt] as Extract<Step, { kind: 'ticket' }>) : null;
  const words = rule ? rule.words.split(',').map((w) => w.trim()).filter(Boolean) : [];

  return (
    <div className="fm">
      <div className="fm-scroll">
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
              </button>
            )}
          </div>

          {/* ── the questions ── */}
          {asks.map(({ s, i }, n) => {
            const chips = chipsOf(s);
            const last = n === asks.length - 1;
            return (
              <Fragment key={i}>
                <div className="fm-cell">
                  <button className="fm-node fm-ask" onClick={() => onPick(i)}
                          style={{ borderLeftColor: KIND.ask.color }}>
                    <span className="fm-top">
                      <span className="fm-n">{String(n + 1).padStart(2, '0')}</span>
                      <span className="fm-kind" style={{ color: KIND.ask.color }}>{KIND.ask.label}</span>
                      <span className="fm-field">→ {FIELDS[s.field] ?? s.field}</span>
                    </span>
                    <span className="fm-prompt">{s.prompt}</span>
                    <span className="fm-chips">
                      {chips.map((c) => (
                        <i key={c} className="fm-chip" style={{ borderColor: accent, color: accent }}>{c}</i>
                      ))}
                      {s.skippable && <i className="fm-chip fm-skip">Skip</i>}
                      {!chips.length && !s.skippable && <i className="fm-chip fm-free">free text</i>}
                    </span>
                  </button>
                  <Join label={chips.length > 1 ? 'any of these · one next step' : 'any answer'} />
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
            <button className="fm-node fm-ticket" onClick={() => ticketAt >= 0 && onPick(ticketAt)}
                    style={{ borderLeftColor: KIND.ticket.color }}>
              <span className="fm-kind" style={{ color: KIND.ticket.color }}>{KIND.ticket.label}</span>
              <span className="fm-prompt">{ticket?.text ?? 'Thanks — your request is in.'}</span>
              <span className="fm-note">Flow ends · the ticket lands in the inbox</span>
            </button>
          </div>
          <div className="fm-rail" />

        </div>

        <p className="fm-foot">
          {asks.length} question{asks.length === 1 ? '' : 's'}, one straight line. Quick
          replies are canned answers rather than branches — every one of them leads to the
          same next question.
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
