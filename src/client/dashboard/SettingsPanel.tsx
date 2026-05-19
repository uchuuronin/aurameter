/**
 * settings panel — aggressiveness, observe-only, preset picker, automod export.
 */

import { useState } from 'preact/hooks';
import type { SubConfig, Aggressiveness } from '../../core/config/types.js';
import { bridge } from './bridge.js';

interface Props {
  config: SubConfig;
  presets: Array<{ name: string; label: string; description: string }>;
  automodYaml: string | null;
}

const aggressivenessOptions: Array<{ value: Aggressiveness; label: string; description: string }> = [
  { value: 'conservative', label: 'Conservative', description: 'fewer flags, higher precision'  },
  { value: 'balanced',     label: 'Balanced',     description: 'recommended for most subs'      },
  { value: 'aggressive',   label: 'Aggressive',   description: 'more flags, lower precision'    },
];

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

const divider = <hr style={{ border: 'none', borderTop: '1px solid var(--border)' }} />;

export function SettingsPanel({ config, presets, automodYaml }: Props) {
  const [copied, setCopied] = useState(false);
  const [showPresets, setShowPresets] = useState(false);

  function setAggressiveness(a: Aggressiveness) {
    bridge.send({ type: 'patch_config', patch: { aggressiveness: a } });
  }

  function toggleObserveOnly() {
    bridge.send({ type: 'patch_config', patch: { observeOnly: !config.observeOnly } });
  }

  function applyPreset(name: string) {
    bridge.send({ type: 'apply_preset', preset: name });
    setShowPresets(false);
  }

  function copyAutomod() {
    bridge.send({ type: 'copy_automod' });
    if (automodYaml) {
      void navigator.clipboard.writeText(automodYaml).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      });
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>

      {/* observe-only */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontWeight: 600 }}>Observe-only mode</div>
          <div style={{ fontSize: '12px', color: 'var(--fg-muted)' }}>
            {config.observeOnly
              ? 'scoring runs silently — no flair, no rules'
              : 'live — flair is set and rules fire on every new post'}
          </div>
        </div>
        <Toggle on={config.observeOnly} onToggle={toggleObserveOnly} />
      </div>

      {divider}

      {/* aggressiveness */}
      <div>
        <div style={{ fontWeight: 600, marginBottom: '8px' }}>Scoring aggressiveness</div>
        <div style={{ display: 'flex', gap: '6px' }}>
          {aggressivenessOptions.map(({ value, label, description }) => (
            <button
              key={value}
              onClick={() => setAggressiveness(value)}
              title={description}
              style={{
                flex: 1, padding: '8px 6px', fontSize: '12px',
                border: '1px solid var(--border)', borderRadius: 'var(--radius)',
                background: config.aggressiveness === value ? 'var(--accent)' : 'var(--surface-2)',
                color: config.aggressiveness === value ? '#fff' : 'var(--fg)',
                cursor: 'pointer', fontWeight: config.aggressiveness === value ? 600 : 400,
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {divider}

      {/* preset picker */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
          <div style={{ fontWeight: 600 }}>Presets</div>
          <span style={{ fontSize: '12px', color: 'var(--fg-muted)' }}>current: {config.presetName}</span>
        </div>
        <button
          onClick={() => setShowPresets(!showPresets)}
          style={{ width: '100%', padding: '8px', fontSize: '13px', border: '1px solid var(--border)', borderRadius: 'var(--radius)', background: 'var(--surface-2)', color: 'var(--fg)', cursor: 'pointer', textAlign: 'left' }}
        >
          {showPresets ? '▲ hide presets' : '▼ switch preset'}
        </button>
        {showPresets && (
          <div style={{ marginTop: '6px', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
            {presets.map(({ name, label, description }) => (
              <div
                key={name}
                onClick={() => applyPreset(name)}
                style={{
                  padding: '10px 12px', cursor: 'pointer', borderBottom: '1px solid var(--border)',
                  background: name === config.presetName ? 'rgba(255,69,0,.08)' : 'var(--surface)',
                }}
              >
                <div style={{ fontWeight: 600, fontSize: '13px' }}>{label}</div>
                <div style={{ fontSize: '11px', color: 'var(--fg-muted)' }}>{description}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {divider}

      {/* automod export */}
      <div>
        <div style={{ fontWeight: 600, marginBottom: '6px' }}>AutoMod export</div>
        <div style={{ fontSize: '12px', color: 'var(--fg-muted)', marginBottom: '8px' }}>
          copies your enabled rules as AutoMod YAML so they survive uninstall
        </div>
        <button
          onClick={copyAutomod}
          style={{
            width: '100%', padding: '8px', fontSize: '13px',
            border: '1px solid var(--border)', borderRadius: 'var(--radius)',
            background: copied ? 'var(--success)' : 'var(--surface-2)',
            color: copied ? '#fff' : 'var(--fg)',
            cursor: 'pointer', fontWeight: 500, transition: 'background .15s',
          }}
        >
          {copied ? '✓ copied!' : '📋 copy AutoMod YAML'}
        </button>
      </div>
    </div>
  );
}
