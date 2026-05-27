/**
 * dashboard app — root component for the aurameter mod dashboard.
 *
 * tab layout:
 *   queue    : triage queue (default)
 *   signals  : per-signal cards with sparklines + visibility toggles
 *   log      : the unified action log (history + undo surface)
 *   settings : aggressiveness, observe-only, preset picker, automod export,
 *              the custom-rule builder (folded in from the old Rules tab),
 *              and the Slop spot-check opt-in (Block 2)
 *
 * Rules used to be its own tab; it's now a section of Settings (roadmap
 * "Rules → Settings merge"). Settings already owns the consequences of signals
 * (flair impact / visibility), so rule creation belongs where you tune what
 * signals *do*. Removes a tab — the on-brand anti-bloat move. The full builder
 * (RuleBuilderDrawer) is unchanged; only its entry point relocated.
 */

import { useState, useEffect, useCallback } from 'preact/hooks';
import type { dashboardPayload, trendSeries } from '../../core/dashboard/types.js';
import { signalMeta } from '../../core/dashboard/types.js';
import type { SignalName } from '../../core/signals/types.js';
import { bridge } from './bridge.js';
import { QueuePanel } from './QueuePanel.js';
import { SignalCard } from './SignalCard.js';
import { SettingsPanel } from './SettingsPanel.js';
import { RulesPanel } from './RulesPanel.js';
import { LogPanel, PassedThroughLine } from './LogPanel.js';
import { SpotCheckPanel } from './SpotCheckPanel.js';

type Tab = 'queue' | 'signals' | 'log' | 'settings';

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
  const [showAbout, setShowAbout] = useState(false);

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

  const tabs: Tab[] = ['queue', 'signals', 'log', 'settings'];
  function tabLabel(t: Tab): string {
    switch (t) {
      case 'queue':    return `Queue (${data!.queue.length})`;
      case 'signals':  return 'Signals';
      case 'log':      return 'Log';
      case 'settings': return 'Settings';
    }
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--bg)', overflow: 'hidden' }}>

      {/* header + tab bar */}
      <div style={{ padding: '10px 14px 0', background: 'var(--surface)', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div style={{ fontWeight: 700, fontSize: '16px' }}>📊 aurameter</div>
            <button
              onClick={() => setShowAbout((s) => !s)}
              title={showAbout ? 'Hide info' : 'What is aurameter?'}
              aria-label="What is aurameter?"
              style={{
                width: '20px', height: '20px', borderRadius: '50%',
                border: '1px solid var(--border)', background: showAbout ? 'var(--accent)' : 'var(--surface-2)',
                color: showAbout ? '#fff' : 'var(--fg-muted)',
                fontSize: '11px', fontWeight: 700, cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                lineHeight: 1, padding: 0,
              }}
            >
              ?
            </button>
          </div>
          {data.config.observeOnly && (
            <span style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '999px', background: 'rgba(255,214,53,.15)', color: '#b8930f', border: '1px solid #b8930f', fontWeight: 500 }}>
              observe-only
            </span>
          )}
        </div>

        <div style={{ display: 'flex' }}>
          {tabs.map((t) => (
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
              {tabLabel(t)}
            </button>
          ))}
        </div>
      </div>

      {/* About panel — opt-in orientation, opens via the "?" in the header */}
      {showAbout && (
        <div style={{
          padding: '12px 14px', background: 'var(--surface-2)',
          borderBottom: '1px solid var(--border)', flexShrink: 0,
          fontSize: '12px', lineHeight: 1.5, color: 'var(--fg)',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '6px' }}>
            <div style={{ fontWeight: 700, fontSize: '13px' }}>What is aurameter?</div>
            <button
              onClick={() => setShowAbout(false)}
              aria-label="Close"
              style={{ border: 'none', background: 'transparent', color: 'var(--fg-muted)', cursor: 'pointer', fontSize: '14px', padding: 0, lineHeight: 1 }}
            >
              ✕
            </button>
          </div>
          <div style={{ color: 'var(--fg-muted)', marginBottom: '6px' }}>
            Scores every new post on four signals and sends drama to triage, so you can work the queue here instead of scrolling Reddit.
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px 18px', marginBottom: '6px' }}>
            <span><span style={{ color: signalMeta.tea.color, fontWeight: 600 }}>☕ Tea</span> — drama / stakes</span>
            <span><span style={{ color: signalMeta.time.color, fontWeight: 600 }}>⏰ Time</span> — urgency</span>
            <span><span style={{ color: signalMeta.clown.color, fontWeight: 600 }}>🤡 Bias</span> — one-sided framing</span>
            <span><span style={{ color: signalMeta.slop.color, fontWeight: 600 }}>🤖 Slop</span> — likely AI</span>
          </div>
          <div style={{ color: 'var(--fg-muted)', marginBottom: '6px' }}>
            On a queued post: <strong style={{ color: 'var(--fg)' }}>Dismiss</strong> clears it from triage; <strong style={{ color: 'var(--fg)' }}>Take action</strong> hands it off to Reddit's native mod tools to remove/ban — aurameter never removes posts itself.
          </div>
          <div style={{ color: 'var(--fg-muted)', fontSize: '11px' }}>
            Privacy: scores + post titles are stored for the queue and log; post body and author identity are never stored. Anonymous Slop labels improve the shared detector.
          </div>
        </div>
      )}

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
            <PassedThroughLine />
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

        {activeTab === 'log' && (
          <LogPanel />
        )}

        {activeTab === 'settings' && (
          <div style={{ background: 'var(--surface)', borderRadius: 'var(--radius-lg)', padding: '14px', border: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <SettingsPanel
              config={data.config}
              presets={data.presets}
              onConfigUpdate={(config) => setData((prev) => prev ? { ...prev, config } : prev)}
            />
            <RulesPanel
              config={data.config}
              onConfigUpdate={(config) => setData((prev) => prev ? { ...prev, config } : prev)}
            />
            <SpotCheckPanel />
          </div>
        )}
      </div>
    </div>
  );
}
