/**
 * log panel — the unified action log (spec §7.1). A plain reverse-chronological
 * list of attributed outcomes:
 *
 *   <time ago> · <outcome> · <actor> · <scores chips> · [open post →]
 *
 * Purely textual. No post titles or bodies (we don't persist them — a click
 * goes to Reddit for the human-readable content). This IS the undo surface: a
 * mistakenly-dismissed post is found here and reopened on Reddit (spec §1.2).
 */

import { useState, useEffect, useCallback } from 'preact/hooks';
import type { LogEntry, LogOutcome } from '../../core/dashboard/types.js';
import { signalMeta } from '../../core/dashboard/types.js';
import type { SignalName } from '../../core/signals/types.js';
import { bridge } from './bridge.js';
import { openPostById } from './nav.js';

const signals: SignalName[] = ['tea', 'time', 'clown', 'slop'];
const pageLimit = 100;

function formatAge(ms: number): string {
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

const outcomeMeta: Record<LogOutcome, { label: string; color: string }> = {
  'passed-through': { label: 'passed through', color: 'var(--fg-muted)' },
  'dismissed':      { label: 'dismissed',      color: '#6b7280' },
  'approved':       { label: 'approved',       color: 'var(--success)' },
  'actioned':       { label: 'actioned',       color: 'var(--clown)' },
  'rule-fired':     { label: 'rule fired',     color: 'var(--accent)' },
  'config-change':  { label: 'config change',  color: '#3b82f6' },
};

function ScoreChips({ scores }: { scores: Record<SignalName, number> | null }) {
  if (!scores) return null;
  const chips = signals
    .map((s) => ({ s, v: scores[s] ?? 0 }))
    .filter(({ v }) => v > 0);
  if (chips.length === 0) return <span style={{ fontSize: '11px', color: 'var(--fg-muted)' }}>no signals</span>;
  return (
    <span style={{ display: 'inline-flex', gap: '6px' }}>
      {chips.map(({ s, v }) => (
        <span key={s} style={{ fontSize: '11px', color: signalMeta[s].color, fontWeight: 600 }}>
          {signalMeta[s].emoji}{v}
        </span>
      ))}
    </span>
  );
}

export function LogPanel() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exhausted, setExhausted] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { entries: fresh } = await bridge.readLog({ limit: pageLimit });
      setEntries(fresh);
      setExhausted(fresh.length < pageLimit);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function loadMore() {
    const last = entries[entries.length - 1];
    if (!last) return;
    setLoadingMore(true);
    try {
      const { entries: older } = await bridge.readLog({ limit: pageLimit, before: last.ts });
      setEntries((prev) => [...prev, ...older]);
      if (older.length < pageLimit) setExhausted(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoadingMore(false);
    }
  }

  if (loading) {
    return <div style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--fg-muted)', fontSize: '13px' }}>loading log…</div>;
  }

  if (error) {
    return (
      <div style={{ padding: '24px 16px', textAlign: 'center', color: 'var(--fg-muted)', fontSize: '13px' }}>
        <div style={{ marginBottom: '8px' }}>couldn't load the log: {error}</div>
        <button onClick={() => void load()} style={{ fontSize: '12px', padding: '4px 10px', border: '1px solid var(--border)', borderRadius: 'var(--radius)', background: 'var(--surface)', color: 'var(--fg)', cursor: 'pointer' }}>retry</button>
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--fg-muted)', fontSize: '13px' }}>
        nothing logged yet — dismissals, hand-offs, rule fires, and config changes will appear here
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1px' }}>
      {entries.map((entry, idx) => {
        const meta = outcomeMeta[entry.outcome];
        return (
          <div
            key={entry.id}
            style={{
              display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap',
              padding: '8px 12px', borderBottom: '1px solid var(--border)',
              background: idx % 2 === 0 ? 'var(--surface)' : 'var(--surface-2)', fontSize: '12px',
            }}
          >
            <span style={{ color: 'var(--fg-muted)', whiteSpace: 'nowrap', minWidth: '64px' }}>
              {formatAge(Date.now() - entry.ts)}
            </span>
            <span style={{ fontWeight: 600, color: meta.color, whiteSpace: 'nowrap' }}>
              {meta.label}
            </span>
            <span style={{ color: 'var(--fg-muted)', whiteSpace: 'nowrap' }}>
              {entry.actor}
            </span>
            <ScoreChips scores={entry.scores} />
            {entry.detail && (
              <span style={{ color: 'var(--fg-muted)', fontStyle: 'italic', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {entry.detail}
              </span>
            )}
            <span style={{ flex: 1 }} />
            {entry.postId && (
              <button
                onClick={() => openPostById(entry.postId as string)}
                style={{ fontSize: '11px', border: 'none', background: 'transparent', color: 'var(--accent)', cursor: 'pointer', whiteSpace: 'nowrap' }}
              >
                open post →
              </button>
            )}
          </div>
        );
      })}

      {!exhausted && (
        <div style={{ padding: '10px', textAlign: 'center' }}>
          <button
            onClick={loadMore}
            disabled={loadingMore}
            style={{ fontSize: '12px', padding: '4px 12px', border: '1px solid var(--border)', borderRadius: 'var(--radius)', background: 'var(--surface)', color: 'var(--fg)', cursor: loadingMore ? 'wait' : 'pointer' }}
          >
            {loadingMore ? 'loading…' : 'load older'}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Reconstruct the flair-variation a post received, from its scores. Mirrors the
 * digit-suffix form the engine writes in composeFlair() — "☕4 ⏰2 🤖3", with
 * signals scoring 0 omitted. The log deliberately stores scores, not the flair
 * string (§12: "the log carries scores, not explanations"), and it doesn't
 * record which signals were public at scoring time — so this is the visible
 * SHAPE a post got, derived from what the log keeps, not a separate score dump.
 */
function flairVariation(scores: Record<SignalName, number> | null): string {
  if (!scores) return '(no flair)';
  const parts = signals
    .filter((s) => (scores[s] ?? 0) > 0)
    .map((s) => `${signalMeta[s].emoji}${scores[s]}`);
  return parts.length > 0 ? parts.join(' ') : '(no flair)';
}

/**
 * "N posts passed through in the last 24h" — a quiet line for the Queue tab
 * (spec §7.2). Collapsed: just the tally. Expandable to the list of
 * flair-variations applied + a click-to-redirect per post. Nothing else — no
 * titles, no bodies, no raw score dumps.
 */
export function PassedThroughLine() {
  const [passed, setPassed] = useState<LogEntry[] | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        // Pull a generous slice and keep passed-through entries within the window.
        const { entries } = await bridge.readLog({ limit: 500 });
        if (cancelled) return;
        setPassed(entries.filter((e) => e.outcome === 'passed-through' && e.ts >= cutoff));
      } catch {
        if (!cancelled) setPassed(null);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (passed === null) return null;
  const count = passed.length;

  return (
    <div style={{ fontSize: '11px', color: 'var(--fg-muted)', padding: '6px 0' }}>
      <button
        onClick={() => setExpanded((e) => !e)}
        disabled={count === 0}
        style={{
          display: 'block', width: '100%', textAlign: 'center', border: 'none',
          background: 'transparent', color: 'var(--fg-muted)', fontSize: '11px',
          cursor: count === 0 ? 'default' : 'pointer', padding: 0,
        }}
      >
        {count === 0 ? (
          <>no posts passed through in the last 24h</>
        ) : (
          <>{expanded ? '▾' : '▸'} {count} {count === 1 ? 'post' : 'posts'} passed through in the last 24h</>
        )}
      </button>

      {expanded && count > 0 && (
        <div style={{ marginTop: '6px', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
          {passed.map((e, idx) => (
            <div
              key={e.id}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px',
                padding: '5px 10px', background: idx % 2 === 0 ? 'var(--surface)' : 'var(--surface-2)',
              }}
            >
              <span style={{ fontSize: '11px' }}>{flairVariation(e.scores)}</span>
              {e.postId && (
                <button
                  onClick={() => openPostById(e.postId as string)}
                  style={{ fontSize: '11px', border: 'none', background: 'transparent', color: 'var(--accent)', cursor: 'pointer', whiteSpace: 'nowrap' }}
                >
                  open →
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
