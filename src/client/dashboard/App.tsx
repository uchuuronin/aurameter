/**
 * dashboard app — root component for the aurameter mod dashboard.
 *
 * tab layout:
 *   queue    : triage queue (default)
 *   signals  : per-signal cards with sparklines + visibility toggles
 *   settings : aggressiveness, observe-only, preset picker, automod export
 */

import { useState, useEffect, useCallback } from 'preact/hooks';
import type { dashboardPayload, trendSeries } from '../../core/dashboard/types.js';
import type { SignalName } from '../../core/signals/types.js';
import { bridge } from './bridge.js';
import { QueuePanel } from './QueuePanel.js';
import { SignalCard } from './SignalCard.js';
import { SettingsPanel } from './SettingsPanel.js';

type Tab = 'queue' | 'signals' | 'settings';

const signals: SignalName[] = ['tea', 'time', 'clown', 'slop'];
const trendDays = 14;

function Spinner() {
  return (
    <span style={{
      display: 'inline-block', width: '16px', height: '16px',
      border: '2px solid var(--border)', borderTopColor: 'var(--accent)',
      borderRadius: '50%', animation: 'spin 0.7s linear infinite',
    }} />
  );
}

export function App() {
  const [data, setData] = useState<dashboardPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>('queue');
  const [refreshing, setRefreshing] = useState(false);

  // Initial load
  useEffect(() => {
    let cancelled = false;
    bridge.init()
      .then((payload) => { if (!cancelled) setData(payload); })
      .catch((err: Error) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, []);

  const refreshQueue = useCallback(async () => {
    setRefreshing(true);
    try {
      const { queue } = await bridge.refreshQueue();
      setData((prev) => prev ? { ...prev, queue } : prev);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRefreshing(false);
    }
  }, []);

  if (error) {
    return (
      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: '12px', color: 'var(--fg-muted)', padding: '24px', textAlign: 'center' }}>
        <div style={{ fontSize: '32px' }}>⚠️</div>
        <div style={{ fontWeight: 600 }}>something went wrong</div>
        <div style={{ fontSize: '13px' }}>{error}</div>
      </div>
    );
  }

  if (!data) {
    return (
      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px', color: 'var(--fg-muted)' }}>
        <Spinner /> loading aurameter…
      </div>
    );
  }

  const trendBySignal = Object.fromEntries(
    data.trends.map((t: trendSeries) => [t.signal, t])
  ) as Partial<Record<SignalName, trendSeries>>;

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--bg)', overflow: 'hidden' }}>

      {/* header + tab bar */}
      <div style={{ padding: '10px 14px 0', background: 'var(--surface)', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
          <div style={{ fontWeight: 700, fontSize: '16px' }}>📊 aurameter</div>
          {data.config.observeOnly && (
            <span style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '999px', background: 'rgba(255,214,53,.15)', color: '#b8930f', border: '1px solid #b8930f', fontWeight: 500 }}>
              observe-only
            </span>
          )}
        </div>

        <div style={{ display: 'flex' }}>
          {(['queue', 'signals', 'settings'] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setActiveTab(t)}
              style={{
                flex: 1, padding: '8px 4px', border: 'none',
                borderBottom: activeTab === t ? '2px solid var(--accent)' : '2px solid transparent',
                background: 'transparent',
                color: activeTab === t ? 'var(--accent)' : 'var(--fg-muted)',
                fontWeight: activeTab === t ? 600 : 400, fontSize: '13px', cursor: 'pointer',
              }}
            >
              {t === 'queue' ? `Queue (${data.queue.length})` : t === 'signals' ? 'Signals' : 'Settings'}
            </button>
          ))}
        </div>
      </div>

      {/* scrollable content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px' }}>

        {activeTab === 'queue' && (
          <>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '8px' }}>
              <button
                onClick={refreshQueue}
                disabled={refreshing}
                style={{
                  fontSize: '12px', padding: '4px 10px', border: '1px solid var(--border)',
                  borderRadius: 'var(--radius)', background: 'var(--surface)', color: 'var(--fg)',
                  cursor: refreshing ? 'wait' : 'pointer', opacity: refreshing ? 0.6 : 1,
                }}
              >
                {refreshing ? 'refreshing…' : '↻ refresh'}
              </button>
            </div>
            <QueuePanel queue={data.queue} onRefresh={refreshQueue} />
          </>
        )}

        {activeTab === 'signals' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {signals.map((sig) => (
              <SignalCard
                key={sig}
                signal={sig}
                config={data.config.signals[sig]}
                trend={trendBySignal[sig]}
                trendDays={trendDays}
                onUpdate={(signalName, signalConfig) => {
                  setData((prev) => prev ? {
                    ...prev,
                    config: {
                      ...prev.config,
                      signals: { ...prev.config.signals, [signalName]: signalConfig },
                    },
                  } : prev);
                }}
              />
            ))}
          </div>
        )}

        {activeTab === 'settings' && (
          <div style={{ background: 'var(--surface)', borderRadius: 'var(--radius-lg)', padding: '14px', border: '1px solid var(--border)' }}>
            <SettingsPanel
              config={data.config}
              presets={data.presets}
              onConfigUpdate={(config) => setData((prev) => prev ? { ...prev, config } : prev)}
            />
          </div>
        )}
      </div>
    </div>
  );
}
