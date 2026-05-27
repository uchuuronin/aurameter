/**
 * queue panel — shows the top N posts by composite priority score, and lets a
 * mod work the queue: dismiss the easy ones in place (safe, reversible) or hand
 * the real ones off to Reddit's native mod UI (deliberate escalation).
 *
 * The two actions are intentionally asymmetric (spec §5.2): Dismiss is the calm
 * secondary button, Take action is the emphatic primary-danger button. The
 * asymmetry IS the safety feature — they must never look mistakable.
 *
 * Navigation goes through openPost() using a server-provided canonical
 * permalink (spec §6). There is no whole-card onClick and no client-side
 * /comments/<id> string-building.
 */

import { useState } from 'preact/hooks';
import type { queueEntry } from '../../core/dashboard/types.js';
import { signalMeta } from '../../core/dashboard/types.js';
import type { SignalName } from '../../core/signals/types.js';
import { bridge } from './bridge.js';
import { openPost } from './nav.js';

interface Props {
  queue: queueEntry[];
  onRefresh: () => void;
}

const signals: SignalName[] = ['tea', 'time', 'clown', 'slop'];
const maxScores: Record<SignalName, number> = { tea: 5, time: 5, clown: 5, slop: 5 };

/** Truncate a title for the queue row. Full title is stored; this is display-only. */
function truncateTitle(title: string, max = 60): string {
  const t = title.trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1).trimEnd() + '…';
}

function ScoreBar({ score, max, color }: { score: number; max: number; color: string }) {
  const pct = max > 0 ? (score / max) * 100 : 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', flex: 1 }}>
      <div style={{ width: `${pct}%`, minWidth: score > 0 ? '8px' : '0', height: '6px', borderRadius: '3px', background: color, transition: 'width .2s' }} />
    </div>
  );
}

function priorityColor(p: number): string {
  if (p >= 12) return '#ef4444';
  if (p >= 8)  return '#f97316';
  if (p >= 4)  return '#eab308';
  return '#6b7280';
}

function formatAge(ms: number): string {
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

export function QueuePanel({ queue, onRefresh }: Props) {
  // Local working copy so dismiss/handoff can optimistically remove a row
  // before the server round-trip resolves. Seeded from props; when the parent
  // refreshes and passes a new array, we re-seed via the key on each entry.
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const visible = queue.filter((e) => !removed.has(e.postId));

  function markRemoved(postId: string) {
    setRemoved((prev) => new Set(prev).add(postId));
  }
  function restore(postId: string) {
    setRemoved((prev) => {
      const next = new Set(prev);
      next.delete(postId);
      return next;
    });
  }
  function setBusyFor(postId: string, on: boolean) {
    setBusy((prev) => {
      const next = new Set(prev);
      if (on) next.add(postId); else next.delete(postId);
      return next;
    });
  }

  async function dismiss(postId: string) {
    setError(null);
    setBusyFor(postId, true);
    markRemoved(postId); // optimistic
    try {
      await bridge.dismiss(postId);
    } catch (err) {
      restore(postId); // surface the failure: put the row back
      setError(`Couldn't dismiss: ${(err as Error).message}`);
    } finally {
      setBusyFor(postId, false);
    }
  }

  async function takeAction(entry: queueEntry) {
    setError(null);
    setBusyFor(entry.postId, true);
    try {
      // Hand off first so it's logged + removed from the queue server-side,
      // THEN navigate to the post. navigateTo() replaces the current view with
      // the post (the Devvit host effect — the only navigation that works from
      // inside the web view), so anything after it won't be seen anyway.
      const { permalink } = await bridge.handoff(entry.postId);
      const target = permalink || entry.permalink || '';
      if (!target) {
        setError("Couldn't open the post: no link was returned.");
        setBusyFor(entry.postId, false);
        return;
      }
      markRemoved(entry.postId);
      openPost(target); // navigates away — view changes to the post
    } catch (err) {
      setError(`Couldn't hand off: ${(err as Error).message}`);
      setBusyFor(entry.postId, false);
    }
  }

  if (visible.length === 0) {
    return (
      <div style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--fg-muted)', fontSize: '13px' }}>
        queue is empty — nobody's wedding is tomorrow. yet.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1px' }}>
      {error && (
        <div style={{ padding: '8px 12px', marginBottom: '6px', fontSize: '12px', color: '#fff', background: 'var(--clown)', borderRadius: 'var(--radius)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>{error}</span>
          <button onClick={() => { setError(null); onRefresh(); }} style={{ border: 'none', background: 'transparent', color: '#fff', textDecoration: 'underline', cursor: 'pointer', fontSize: '12px' }}>refresh</button>
        </div>
      )}
      {visible.map((entry, idx) => {
        const scores = entry.result?.scores ?? { tea: 0, time: 0, clown: 0, slop: 0 };
        const age = entry.result?.ts ? formatAge(Date.now() - entry.result.ts) : null;
        const title = entry.result?.title ? truncateTitle(entry.result.title) : null;
        const isBusy = busy.has(entry.postId);

        return (
          <div
            key={entry.postId}
            style={{
              display: 'grid', gridTemplateColumns: '28px 1fr auto', alignItems: 'center', gap: '8px',
              padding: '8px 12px', borderBottom: '1px solid var(--border)',
              background: idx % 2 === 0 ? 'var(--surface)' : 'var(--surface-2)',
              opacity: isBusy ? 0.6 : 1,
            }}
          >
            {/* priority badge */}
            <div style={{ width: '24px', height: '24px', borderRadius: '50%', background: priorityColor(entry.priority), color: '#fff', fontSize: '10px', fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {entry.priority}
            </div>

            {/* title + signal bars + faint age line */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0 }}>
              {title && (
                <span
                  title={entry.result?.title}
                  style={{ fontSize: '12px', fontWeight: 600, color: 'var(--fg)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginBottom: '1px' }}
                >
                  {title}
                </span>
              )}
              {signals.map((sig) => (
                <div key={sig} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <span style={{ fontSize: '10px', width: '14px', textAlign: 'center' }}>{signalMeta[sig].emoji}</span>
                  <ScoreBar score={scores[sig] ?? 0} max={maxScores[sig]} color={signalMeta[sig].color} />
                </div>
              ))}
              {age && (
                <span style={{ fontSize: '10px', color: 'var(--fg-muted)', fontWeight: 400, marginTop: '1px' }}>
                  posted {age} ago
                </span>
              )}
            </div>

            {/* asymmetric actions: quiet Dismiss, emphatic Take action */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', alignItems: 'stretch' }}>
              <button
                onClick={() => dismiss(entry.postId)}
                disabled={isBusy}
                title="Clear this post from the queue"
                style={{
                  fontSize: '11px', padding: '4px 10px', cursor: isBusy ? 'wait' : 'pointer',
                  border: '1px solid var(--border)', borderRadius: 'var(--radius)',
                  background: 'var(--surface-2)', color: 'var(--fg-muted)', fontWeight: 400,
                  whiteSpace: 'nowrap',
                }}
              >
                Dismiss
              </button>
              <button
                onClick={() => takeAction(entry)}
                disabled={isBusy}
                title="Open this post in Reddit's mod tools to remove/approve"
                style={{
                  fontSize: '11px', padding: '4px 10px', cursor: isBusy ? 'wait' : 'pointer',
                  border: '1px solid var(--clown)', borderRadius: 'var(--radius)',
                  background: 'var(--clown)', color: '#fff', fontWeight: 700,
                  whiteSpace: 'nowrap',
                }}
              >
                Take action →
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
