/**
 * queue panel — shows the top N posts by composite priority score.
 */

import type { queueEntry } from '../../core/dashboard/types.js';
import { signalMeta } from '../../core/dashboard/types.js';
import type { SignalName } from '../../core/signals/types.js';

interface Props {
  queue: queueEntry[];
  onRefresh: () => void;
}

const signals: SignalName[] = ['tea', 'time', 'clown', 'slop'];
const maxScores: Record<SignalName, number> = { tea: 5, time: 3, clown: 3, slop: 3 };

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

export function QueuePanel({ queue }: Props) {
  if (queue.length === 0) {
    return (
      <div style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--fg-muted)', fontSize: '13px' }}>
        queue is empty — posts will appear here as they are scored
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1px' }}>
      {queue.map((entry, idx) => {
        const scores = entry.result?.scores ?? { tea: 0, time: 0, clown: 0, slop: 0 };
        const age = entry.result?.ts ? formatAge(Date.now() - entry.result.ts) : '—';
        const shortId = entry.postId.replace('t3_', '');

        return (
          <div
            key={entry.postId}
            onClick={() => window.open(`https://reddit.com/comments/${shortId}`, '_blank')}
            style={{
              display: 'grid', gridTemplateColumns: '28px 1fr auto', alignItems: 'center', gap: '8px',
              padding: '8px 12px', cursor: 'pointer', borderBottom: '1px solid var(--border)',
              background: idx % 2 === 0 ? 'var(--surface)' : 'var(--surface-2)',
            }}
          >
            {/* priority badge */}
            <div style={{ width: '24px', height: '24px', borderRadius: '50%', background: priorityColor(entry.priority), color: '#fff', fontSize: '10px', fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {entry.priority}
            </div>

            {/* signal bars */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
              {signals.map((sig) => (
                <div key={sig} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <span style={{ fontSize: '10px', width: '14px', textAlign: 'center' }}>{signalMeta[sig].emoji}</span>
                  <ScoreBar score={scores[sig] ?? 0} max={maxScores[sig]} color={signalMeta[sig].color} />
                </div>
              ))}
            </div>

            {/* age */}
            <span style={{ fontSize: '11px', color: 'var(--fg-muted)', whiteSpace: 'nowrap' }}>{age}</span>
          </div>
        );
      })}
    </div>
  );
}
