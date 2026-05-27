// src/client/dashboard/RuleBuilderDrawer.tsx
/**
 * rule builder drawer — compose a single custom rule (1–3 AND conditions + one action).
 * Add + delete only (no edit). Comparators restricted to >= and <= here; the engine
 * still supports = for preset rules, which are shown read-in-list elsewhere.
 *
 * Block 3: a dry-run preview panel sits below the conditions — "this rule would have
 * fired on N posts in the last 7 days," expandable to sample matches. Debounced; replays
 * the candidate conditions over the action log server-side. Lets a mod see what a rule
 * would catch BEFORE saving it.
 */

import { useState, useEffect, useRef } from 'preact/hooks';
import type { SubConfig, RuleCondition, RuleAction } from '../../core/config/types.js';
import type { SignalName } from '../../core/signals/types.js';
import { signalMeta } from '../../core/dashboard/types.js';
import { bridge, type dryRunResult } from './bridge.js';
import { openPostById } from './nav.js';

interface Props {
  onAdded: (config: SubConfig) => void;
  onClose: () => void;
}

type DraftCondition = { signal: SignalName; comparator: '>=' | '<='; threshold: number };
type ActionType = RuleAction['type'];

const SIGNALS: SignalName[] = ['tea', 'time', 'clown', 'slop'];
const ACTION_LABELS: Record<ActionType, string> = {
  send_to_modqueue: 'Send to mod queue',
  set_flair: 'Set flair',
  ping_modmail: 'Ping modmail',
  require_manual_review: 'Require manual review',
};

const inputStyle = {
  padding: '6px 8px', fontSize: '13px', border: '1px solid var(--border)',
  borderRadius: 'var(--radius)', background: 'var(--surface-2)', color: 'var(--fg)',
} as const;

function truncateTitle(title: string, max = 50): string {
  const t = title.trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1).trimEnd() + '…';
}

/** Debounced dry-run preview of the current draft conditions. */
function DryRunPreview({ conditions }: { conditions: DraftCondition[] }) {
  const [result, setResult] = useState<dryRunResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (conditions.length === 0) { setResult(null); return; }
    setLoading(true);
    setError(null);
    timer.current = setTimeout(async () => {
      try {
        const r = await bridge.dryRunRule(conditions as RuleCondition[]);
        setResult(r);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    }, 500);
    return () => { if (timer.current) clearTimeout(timer.current); };
    // Re-run whenever the conditions change (signal/comparator/threshold).
  }, [JSON.stringify(conditions)]);

  return (
    <div style={{
      marginTop: '4px', padding: '10px 12px', borderRadius: 'var(--radius)',
      border: '1px solid var(--border)', background: 'var(--surface-2)', fontSize: '12px',
    }}>
      {loading && <span style={{ color: 'var(--fg-muted)' }}>checking the last 7 days…</span>}

      {!loading && error && (
        <span style={{ color: 'var(--fg-muted)' }}>couldn't preview: {error}</span>
      )}

      {!loading && !error && result && (
        <>
          {result.poolSize === 0 ? (
            <span style={{ color: 'var(--fg-muted)' }}>
              no recent history to preview against yet — the preview sharpens as posts are scored.
            </span>
          ) : (
            <>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                <span>
                  This rule would have fired on{' '}
                  <strong style={{ color: result.count > 0 ? 'var(--accent)' : 'var(--fg-muted)' }}>
                    {result.count}
                  </strong>{' '}
                  {result.count === 1 ? 'post' : 'posts'} in the last {result.windowDays} days
                  <span style={{ color: 'var(--fg-muted)' }}> (of {result.poolSize} seen)</span>
                </span>
                {result.count > 0 && (
                  <button
                    onClick={() => setExpanded((e) => !e)}
                    style={{ border: 'none', background: 'transparent', color: 'var(--accent)', cursor: 'pointer', fontSize: '12px', whiteSpace: 'nowrap' }}
                  >
                    {expanded ? 'hide' : 'show me →'}
                  </button>
                )}
              </div>

              {result.tooBroad && (
                <div style={{ marginTop: '6px', color: '#b8930f' }}>
                  ⚠ {result.count}+ matches — this rule may be too broad. Tighten thresholds before saving.
                </div>
              )}

              {expanded && result.count > 0 && (
                <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '1px', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
                  {result.sample.map((m, idx) => (
                    <div
                      key={m.postId}
                      style={{
                        display: 'flex', alignItems: 'center', gap: '8px',
                        padding: '5px 8px', background: idx % 2 === 0 ? 'var(--surface)' : 'var(--surface-2)',
                      }}
                    >
                      <span style={{ display: 'inline-flex', gap: '5px', flexShrink: 0 }}>
                        {SIGNALS.filter((s) => (m.scores[s] ?? 0) > 0).map((s) => (
                          <span key={s} style={{ color: signalMeta[s].color, fontWeight: 600 }}>
                            {signalMeta[s].emoji}{m.scores[s]}
                          </span>
                        ))}
                      </span>
                      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--fg-muted)' }}>
                        {m.title ? truncateTitle(m.title) : m.postId}
                      </span>
                      <button
                        onClick={() => openPostById(m.postId)}
                        style={{ border: 'none', background: 'transparent', color: 'var(--accent)', cursor: 'pointer', fontSize: '11px', whiteSpace: 'nowrap' }}
                      >
                        open →
                      </button>
                    </div>
                  ))}
                  {result.count > result.sample.length && (
                    <div style={{ padding: '5px 8px', color: 'var(--fg-muted)', background: 'var(--surface)' }}>
                      …and {result.count - result.sample.length} more
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

export function RuleBuilderDrawer({ onAdded, onClose }: Props) {
  const [label, setLabel] = useState('');
  const [conditions, setConditions] = useState<DraftCondition[]>([
    { signal: 'slop', comparator: '>=', threshold: 2 },
  ]);
  const [actionType, setActionType] = useState<ActionType>('send_to_modqueue');
  const [reason, setReason] = useState('');
  const [flairText, setFlairText] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function setCondition(i: number, patch: Partial<DraftCondition>) {
    setConditions((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  }
  function addCondition() {
    setConditions((cs) => (cs.length >= 3 ? cs : [...cs, { signal: 'tea', comparator: '>=', threshold: 1 }]));
  }
  function removeCondition(i: number) {
    setConditions((cs) => (cs.length <= 1 ? cs : cs.filter((_, j) => j !== i)));
  }

  function buildAction(): RuleAction {
    switch (actionType) {
      case 'send_to_modqueue': return { type: 'send_to_modqueue', reason: reason.trim() };
      case 'set_flair': return { type: 'set_flair', flairText: flairText.trim() };
      case 'ping_modmail': return { type: 'ping_modmail', subject: subject.trim(), body: body.trim() };
      case 'require_manual_review': return { type: 'require_manual_review' };
    }
  }

  async function submit() {
    setError(null);
    if (!label.trim()) { setError('give the rule a label'); return; }
    setSubmitting(true);
    try {
      const { config } = await bridge.addRule({
        label: label.trim(),
        conditions: conditions as RuleCondition[],
        action: buildAction(),
      });
      onAdded(config);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)', display: 'flex', justifyContent: 'flex-end', zIndex: 50 }}>
      <div style={{ width: 'min(420px, 100%)', height: '100%', background: 'var(--surface)', borderLeft: '1px solid var(--border)', display: 'flex', flexDirection: 'column' }}>

        {/* header */}
        <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontWeight: 700, fontSize: '15px' }}>New rule</div>
          <button onClick={onClose} style={{ border: 'none', background: 'transparent', fontSize: '18px', cursor: 'pointer', color: 'var(--fg-muted)' }}>✕</button>
        </div>

        {/* body (scrolls) */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '14px', display: 'flex', flexDirection: 'column', gap: '14px' }}>

          {/* label */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <label style={{ fontSize: '12px', fontWeight: 600 }}>Label</label>
            <input value={label} onInput={(e) => setLabel((e.target as HTMLInputElement).value)} placeholder="e.g. Queue likely-synthetic posts" style={inputStyle} />
          </div>

          {/* conditions */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <label style={{ fontSize: '12px', fontWeight: 600 }}>Conditions (all must match)</label>
              <button onClick={addCondition} disabled={conditions.length >= 3} style={{ fontSize: '12px', padding: '2px 8px', border: '1px solid var(--border)', borderRadius: 'var(--radius)', background: 'var(--surface-2)', color: 'var(--fg)', cursor: conditions.length >= 3 ? 'not-allowed' : 'pointer', opacity: conditions.length >= 3 ? 0.5 : 1 }}>+ add</button>
            </div>
            {conditions.map((cond, i) => (
              <div key={i} style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                <select value={cond.signal} onChange={(e) => setCondition(i, { signal: (e.target as HTMLSelectElement).value as SignalName })} style={{ ...inputStyle, flex: 1 }}>
                  {SIGNALS.map((s) => <option key={s} value={s}>{signalMeta[s].emoji} {signalMeta[s].label}</option>)}
                </select>
                <select value={cond.comparator} onChange={(e) => setCondition(i, { comparator: (e.target as HTMLSelectElement).value as '>=' | '<=' })} style={{ ...inputStyle, width: '56px' }}>
                  <option value=">=">≥</option>
                  <option value="<=">≤</option>
                </select>
                <select value={cond.threshold} onChange={(e) => setCondition(i, { threshold: Number((e.target as HTMLSelectElement).value) })} style={{ ...inputStyle, width: '56px' }}>
                  {[0, 1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
                <button onClick={() => removeCondition(i)} disabled={conditions.length <= 1} style={{ border: 'none', background: 'transparent', cursor: conditions.length <= 1 ? 'not-allowed' : 'pointer', color: 'var(--fg-muted)', opacity: conditions.length <= 1 ? 0.4 : 1, fontSize: '16px' }}>✕</button>
              </div>
            ))}

            {/* Block 3: dry-run preview of the current conditions */}
            <DryRunPreview conditions={conditions} />
          </div>

          {/* action */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label style={{ fontSize: '12px', fontWeight: 600 }}>Action</label>
            <select value={actionType} onChange={(e) => setActionType((e.target as HTMLSelectElement).value as ActionType)} style={inputStyle}>
              {(Object.keys(ACTION_LABELS) as ActionType[]).map((t) => <option key={t} value={t}>{ACTION_LABELS[t]}</option>)}
            </select>

            {actionType === 'send_to_modqueue' && (
              <input value={reason} onInput={(e) => setReason((e.target as HTMLInputElement).value)} placeholder="reason shown to mods" style={inputStyle} />
            )}
            {actionType === 'set_flair' && (
              <input value={flairText} onInput={(e) => setFlairText((e.target as HTMLInputElement).value)} placeholder="flair text to set" style={inputStyle} />
            )}
            {actionType === 'ping_modmail' && (
              <>
                <input value={subject} onInput={(e) => setSubject((e.target as HTMLInputElement).value)} placeholder="modmail subject" style={inputStyle} />
                <input value={body} onInput={(e) => setBody((e.target as HTMLInputElement).value)} placeholder="modmail body" style={inputStyle} />
              </>
            )}
            {actionType === 'require_manual_review' && (
              <div style={{ fontSize: '12px', color: 'var(--fg-muted)' }}>No extra fields — flags the post for manual review.</div>
            )}
          </div>

          {error && <div style={{ fontSize: '12px', color: 'var(--clown)' }}>{error}</div>}
        </div>

        {/* footer */}
        <div style={{ padding: '12px 14px', borderTop: '1px solid var(--border)', display: 'flex', gap: '8px' }}>
          <button onClick={onClose} style={{ flex: 1, padding: '8px', fontSize: '13px', border: '1px solid var(--border)', borderRadius: 'var(--radius)', background: 'var(--surface-2)', color: 'var(--fg)', cursor: 'pointer' }}>Cancel</button>
          <button onClick={submit} disabled={submitting} style={{ flex: 2, padding: '8px', fontSize: '13px', border: 'none', borderRadius: 'var(--radius)', background: 'var(--accent)', color: '#fff', fontWeight: 600, cursor: submitting ? 'wait' : 'pointer', opacity: submitting ? 0.7 : 1 }}>{submitting ? 'adding…' : 'Add rule'}</button>
        </div>
      </div>
    </div>
  );
}
