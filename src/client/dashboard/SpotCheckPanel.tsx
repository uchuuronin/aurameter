/**
 * spot-check panel (Block 2) — per-sub opt-in surface for labeling posts
 * AI / not-AI. Those explicit labels feed the global Slop corpus and nudge this
 * sub's Slop threshold so its 2↔3 boundary self-sharpens.
 *
 * Rendered INSIDE the Settings tab (not a 6th always-on tab). The opt-in toggle
 * always shows; the cadence picker, reset button, and review list only appear
 * once opted in.
 *
 * Style matches SettingsPanel (the Toggle, the divider, section headers) and
 * LogPanel/QueuePanel (ScoreChips, openPost via the verified nav.ts effect).
 */

import { useState, useEffect, useCallback } from 'preact/hooks';
import type { SignalName } from '../../core/signals/types.js';
import { signalMeta } from '../../core/dashboard/types.js';
import { bridge, type spotCheckItem } from './bridge.js';
import { openPost, openPostById } from './nav.js';

const signals: SignalName[] = ['tea', 'time', 'clown', 'slop'];

function Toggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      onClick={onToggle}
      style={{
        width: '44px', height: '24px', borderRadius: '12px', border: 'none',
        background: on ? 'var(--accent)' : 'var(--border)',
        cursor: 'pointer', position: 'relative', flexShrink: 0, transition: 'background .15s',
      }}
    >
      <span style={{
        position: 'absolute', top: '3px', left: on ? '22px' : '3px',
        width: '18px', height: '18px', borderRadius: '50%', background: '#fff',
        transition: 'left .15s', boxShadow: '0 1px 3px rgba(0,0,0,.3)',
      }} />
    </button>
  );
}

function ScoreChips({ scores }: { scores: Record<SignalName, number> | null }) {
  if (!scores) return null;
  const chips = signals.map((s) => ({ s, v: scores[s] ?? 0 })).filter(({ v }) => v > 0);
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

const divider = <hr style={{ border: 'none', borderTop: '1px solid var(--border)' }} />;

export function SpotCheckPanel() {
  const [optedIn, setOptedIn] = useState(false);
  const [cadence, setCadence] = useState<'weekly' | 'monthly'>('weekly');
  const [batch, setBatch] = useState<spotCheckItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await bridge.getSpotCheck();
      setOptedIn(data.optedIn);
      setCadence(data.cadence);
      setBatch(data.batch);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  function setBusyFor(postId: string, on: boolean) {
    setBusy((prev) => {
      const next = new Set(prev);
      if (on) next.add(postId); else next.delete(postId);
      return next;
    });
  }

  async function toggleOptIn() {
    setWorking(true);
    setError(null);
    try {
      await bridge.spotCheckOptIn(!optedIn, cadence);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setWorking(false);
    }
  }

  async function changeCadence(next: 'weekly' | 'monthly') {
    setCadence(next);
    if (!optedIn) return;
    try {
      await bridge.spotCheckOptIn(true, next);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function reset() {
    if (!window.confirm('Reset this sub\u2019s Slop threshold to the global default? This discards local tuning and queues a fresh batch to re-learn the boundary.')) {
      return;
    }
    setWorking(true);
    setError(null);
    try {
      await bridge.spotCheckReset();
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setWorking(false);
    }
  }

  async function verdict(item: spotCheckItem, label: 0 | 1) {
    setBusyFor(item.postId, true);
    setError(null);
    setBatch((prev) => prev.filter((b) => b.postId !== item.postId)); // optimistic
    try {
      await bridge.spotCheckVerdict(item.postId, label);
    } catch (err) {
      setError(`Couldn't record verdict: ${(err as Error).message}`);
      await load(); // resurface on failure
    } finally {
      setBusyFor(item.postId, false);
    }
  }

  function open(item: spotCheckItem) {
    if (item.permalink) openPost(item.permalink);
    else openPostById(item.postId);
  }

  return (
    <>
      {divider}

      {/* opt-in row */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontWeight: 600 }}>Slop spot-check</div>
          <div style={{ fontSize: '12px', color: 'var(--fg-muted)' }}>
            {optedIn
              ? 'label a few posts AI / not-AI to sharpen this sub\u2019s detector'
              : 'opt in to label posts and improve Slop detection for your sub'}
          </div>
        </div>
        <Toggle on={optedIn} onToggle={() => void toggleOptIn()} />
      </div>

      {optedIn && (
        <>
          {/* cadence + reset */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '12px', color: 'var(--fg-muted)' }}>New batch:</span>
            {(['weekly', 'monthly'] as const).map((cad) => (
              <button
                key={cad}
                onClick={() => void changeCadence(cad)}
                style={{
                  fontSize: '12px', padding: '4px 10px',
                  border: '1px solid var(--border)', borderRadius: 'var(--radius)',
                  background: cadence === cad ? 'var(--accent)' : 'var(--surface-2)',
                  color: cadence === cad ? '#fff' : 'var(--fg)',
                  cursor: 'pointer', fontWeight: cadence === cad ? 600 : 400,
                }}
              >
                {cad}
              </button>
            ))}
            <span style={{ flex: 1 }} />
            <button
              onClick={() => void reset()}
              disabled={working}
              title="Reset this sub's Slop threshold to the global default"
              style={{
                fontSize: '12px', padding: '4px 10px',
                border: '1px solid var(--clown)', borderRadius: 'var(--radius)',
                background: 'var(--surface)', color: 'var(--clown)',
                cursor: working ? 'wait' : 'pointer', fontWeight: 500,
              }}
            >
              Reset AI Slop
            </button>
          </div>

          {error && <div style={{ fontSize: '12px', color: 'var(--clown)' }}>{error}</div>}

          {/* review list */}
          {loading ? (
            <div style={{ padding: '24px', textAlign: 'center', color: 'var(--fg-muted)', fontSize: '13px' }}>loading batch…</div>
          ) : batch.length === 0 ? (
            <div style={{ padding: '24px', textAlign: 'center', color: 'var(--fg-muted)', fontSize: '13px' }}>
              nothing to review right now — a new batch arrives on your {cadence} cadence
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1px', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
              {batch.map((item, idx) => {
                const scores = item.result?.scores ?? null;
                const isBusy = busy.has(item.postId);
                return (
                  <div
                    key={item.postId}
                    style={{
                      display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap',
                      padding: '8px 12px',
                      background: idx % 2 === 0 ? 'var(--surface)' : 'var(--surface-2)',
                      opacity: isBusy ? 0.6 : 1,
                    }}
                  >
                    <span style={{ fontSize: '11px', color: 'var(--slop)', fontWeight: 700, minWidth: '32px' }}>
                      🤖{scores?.slop ?? 0}
                    </span>
                    <ScoreChips scores={scores} />
                    <button
                      onClick={() => open(item)}
                      style={{ fontSize: '11px', border: 'none', background: 'transparent', color: 'var(--accent)', cursor: 'pointer', whiteSpace: 'nowrap' }}
                    >
                      open post →
                    </button>
                    <span style={{ flex: 1 }} />
                    <button
                      onClick={() => void verdict(item, 0)}
                      disabled={isBusy}
                      title="Not AI — human-written"
                      style={{
                        fontSize: '11px', padding: '4px 10px', cursor: isBusy ? 'wait' : 'pointer',
                        border: '1px solid var(--border)', borderRadius: 'var(--radius)',
                        background: 'var(--surface-2)', color: 'var(--fg)', fontWeight: 500, whiteSpace: 'nowrap',
                      }}
                    >
                      not AI
                    </button>
                    <button
                      onClick={() => void verdict(item, 1)}
                      disabled={isBusy}
                      title="AI — synthetic text"
                      style={{
                        fontSize: '11px', padding: '4px 10px', cursor: isBusy ? 'wait' : 'pointer',
                        border: '1px solid var(--slop)', borderRadius: 'var(--radius)',
                        background: 'var(--slop)', color: '#fff', fontWeight: 700, whiteSpace: 'nowrap',
                      }}
                    >
                      AI 🤖
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </>
  );
}
