/**
 * signal card — shows one signal's trend sparkline + visibility toggle.
 */

import type { SignalName } from '../../core/signals/types.js';
import type { SignalConfig, SignalVisibility } from '../../core/config/types.js';
import type { trendSeries } from '../../core/dashboard/types.js';
import { signalMeta, visibilityOptions } from '../../core/dashboard/types.js';
import { bridge } from './bridge.js';
import { Sparkline } from './Sparkline.js';

interface Props {
  signal: SignalName;
  config: SignalConfig;
  trend: trendSeries | undefined;
  trendDays: number;
  /** Called with the updated single-signal config after a successful patch.
   *  Parent (App.tsx) merges it into the full SubConfig. */
  onUpdate: (signal: SignalName, config: SignalConfig) => void;
}

export function SignalCard({ signal, config, trend, trendDays, onUpdate }: Props) {
  const meta = signalMeta[signal];
  const todayCount = trend?.points[trend.points.length - 1]?.count ?? 0;
  const totalCount = trend?.points.reduce((s, p) => s + p.count, 0) ?? 0;

  async function setVisibility(v: SignalVisibility) {
    try {
      const { config: updatedSignal } = await bridge.patchSignal(signal, { visibility: v });
      onUpdate(signal, updatedSignal);
    } catch (err) {
      console.error('patchSignal failed:', err);
    }
  }

  const pillColor =
    config.visibility === 'public'   ? { bg: 'rgba(70,209,96,.15)',   fg: 'var(--success)', border: 'var(--success)' } :
    config.visibility === 'mod-only' ? { bg: 'rgba(255,214,53,.15)',   fg: '#b8930f',        border: '#b8930f'       } :
                                       { bg: 'var(--surface-2)',       fg: 'var(--fg-muted)', border: 'var(--fg-muted)' };

  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '8px' }}>

      {/* header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontWeight: 600, fontSize: '15px' }}>{meta.emoji} {meta.label}</span>
        <span style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '999px', background: pillColor.bg, color: pillColor.fg, border: `1px solid ${pillColor.border}`, fontWeight: 500 }}>
          {config.visibility}
        </span>
      </div>

      {/* sparkline + stats */}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: '10px' }}>
        <Sparkline points={trend?.points ?? []} color={meta.color} width={100} height={36} />
        <div style={{ fontSize: '12px', color: 'var(--fg-muted)', lineHeight: '1.5' }}>
          <div>{totalCount} posts / {trendDays}d</div>
          <div>{todayCount} today</div>
        </div>
      </div>

      {/* visibility toggle */}
      <div style={{ display: 'flex', gap: '4px' }}>
        {visibilityOptions.map(({ value, label }) => (
          <button
            key={value}
            onClick={() => setVisibility(value)}
            style={{
              flex: 1, padding: '4px 0', fontSize: '12px',
              border: '1px solid var(--border)', borderRadius: 'var(--radius)',
              background: config.visibility === value ? meta.color : 'var(--surface-2)',
              color: config.visibility === value ? '#fff' : 'var(--fg)',
              cursor: 'pointer', fontWeight: config.visibility === value ? 600 : 400,
              transition: 'background .1s',
            }}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
